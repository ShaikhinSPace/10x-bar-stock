"use server";

import { refresh } from "next/cache";
import { sql, type DeliveryLine } from "@/lib/db";
import { applyDeliveryEdit } from "@/lib/delivery-edit";
import { requireOwner, requireUser } from "@/lib/auth";
import { attempt, whole, type Result } from "./_shared";

// Every export here is reachable by direct POST, so each one re-checks auth itself.

/** A "YYYY-MM-DD" that is a real calendar day, or null when none was given. */
function parseDay(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))
      || new Date(v).toISOString().slice(0, 10) !== v) {
    throw new Error("That delivery date isn't valid");
  }
  return v;
}

/**
 * Book a whole delivery in one go — deliveries arrive as one drop with many lines,
 * and tapping Receive on thirty bottles individually is how counts get skipped.
 *
 * Every line lands in a single statement, so a delivery is all-or-nothing: the
 * stock rises and its log entries appear together or neither happens.
 *
 * `affectsStock = false` books a paperwork-only delivery: the owner already added the
 * bottles to the storeroom manually (then counted the bar) and only later gets around
 * to recording the invoice. Logging the moves still happens — the delivery shows up on
 * the Delivery tab and in the activity log — but the storeroom isn't touched a second
 * time, and reports exclude these from the "received" totals so the manual receives
 * aren't double-counted.
 */
export async function receiveDelivery(
  lines: DeliveryLine[], invoice: string, supplier: string, affectsStock = true, deliveryDate?: string,
): Promise<Result> {
  return attempt(async () => {
    const u = await requireOwner();
    if (!Array.isArray(lines) || !lines.length) throw new Error("Add at least one bottle");
    if (lines.length > 300) throw new Error("That's too many lines for one delivery");

    // Merge duplicates so the same bottle scanned twice doesn't double-update.
    // Costs for the same bottle sum. Case size: the later line wins when they
    // disagree (realistic: owner is correcting rather than deliberately mixing).
    const merged = new Map<number, { qty: number; cost: number | null; caseSize: number | null }>();
    for (const l of lines) {
      const id = Number(l.itemId);
      if (!Number.isInteger(id)) throw new Error("Unknown bottle in the delivery");
      const q = whole(l.qty, "Quantity");
      if (q < 1) throw new Error("Every line needs at least 1 bottle");
      const c = l.cost == null ? null : Number(l.cost);
      if (c !== null && (!Number.isFinite(c) || c < 0)) throw new Error("Cost must be zero or more");
      const cs = l.caseSize == null ? null : Math.max(1, Math.floor(Number(l.caseSize)));
      const prev = merged.get(id);
      const sumCost = prev && prev.cost !== null && c !== null ? Math.round((prev.cost + c) * 100) / 100
        : c !== null ? c
        : prev?.cost ?? null;
      merged.set(id, { qty: (prev?.qty ?? 0) + q, cost: sumCost, caseSize: cs ?? prev?.caseSize ?? null });
    }

    const inv = invoice.trim();
    if (!inv) throw new Error("Enter the invoice number for this delivery");
    if (inv.length > 60) throw new Error("That invoice number is too long");

    const dDate = parseDay(deliveryDate);

    const ids = [...merged.keys()];
    const qtys = [...merged.values()].map((v) => v.qty);
    const costs = [...merged.values()].map((v) => v.cost);
    const caseSizes = [...merged.values()].map((v) => v.caseSize);
    const batch = `D${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const sup = supplier.trim() || null;
    const affects = Boolean(affectsStock);

    // Booking one invoice twice is the one mistake that silently inflates stock, and a
    // single statement alone can't stop two people racing (each sees a snapshot without
    // the other's rows). So the statement runs in a transaction behind an advisory lock
    // on the invoice: the second booking waits, then sees the first's rows and is refused.
    // The `guard` CTE also refuses the whole delivery if any bottle is archived or gone,
    // so a delivery is never half-booked. The `case when ${affects}` lets paperwork-only
    // deliveries log without moving stock.
    const [, rows] = await sql.transaction([
      sql`select pg_advisory_xact_lock(hashtext(${inv}))`,
      sql`
        with guard as (
          select 1 where not exists (select 1 from moves where invoice = ${inv})
            and not exists (
              select 1 from unnest(${ids}::int[]) as t(item_id)
              left join items i on i.id = t.item_id and not i.archived
              where i.id is null)
        ), lines as (
          select * from unnest(${ids}::int[], ${qtys}::numeric[], ${costs}::numeric[], ${caseSizes}::int[])
            as t(item_id, qty, cost, case_size)
        ), upd as (
          update items i set
            store = i.store + case when ${affects}::boolean then l.qty else 0 end
          from lines l, guard
          where i.id = l.item_id and not i.archived
          returning i.id, i.name, i.cat, l.qty, l.cost, l.case_size
        )
        insert into moves
          (type, item_id, item_name, cat, qty, loc, user_id, user_name,
           batch, invoice, supplier, affects_stock, cost, line_case_size, delivery_date)
        select 'receive', upd.id, upd.name, upd.cat, upd.qty, 'store',
               ${u.id}, ${u.name}, ${batch}, ${inv}, ${sup}, ${affects}, upd.cost, upd.case_size, ${dDate}::date
        from upd
        returning id`,
    ]);

    if (!rows.length) {
      const [dupe] = await sql`
        select min(ts) as ts from moves where invoice = ${inv} group by invoice`;
      if (dupe) {
        throw new Error(
          `Invoice ${inv} was already booked on ${new Date(dupe.ts).toLocaleDateString()}.`
        );
      }
      throw new Error("Some bottles are no longer on the list — reload and try again.");
    }
    refresh();
  });
}

/**
 * Correct a delivery that was booked wrong.
 *
 * A delivery is not a row - it is the set of `receive` moves sharing one batch id,
 * and each of those already added its qty to the storeroom. So editing one is not
 * a rewrite, it is arithmetic: for every bottle, store moves by (new qty - old qty).
 * A line that vanished contributes -old, a line that appeared contributes +new, and
 * a line whose number did not change contributes nothing.
 *
 * This deliberately edits history in place rather than logging compensating moves,
 * matching undoMove: the log is meant to show what was actually delivered, not the
 * owner's typing. Undo is still the way to remove a delivery entirely.
 */
export async function editDelivery(
  batch: string, lines: DeliveryLine[], invoice: string, supplier: string, deliveryDate?: string,
): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();
    if (typeof batch !== "string" || !batch) throw new Error("Unknown delivery");
    if (!Array.isArray(lines) || !lines.length) {
      throw new Error("A delivery needs at least one bottle — undo it instead to remove it");
    }
    if (lines.length > 300) throw new Error("That's too many lines for one delivery");

    const merged = new Map<number, { qty: number; cost: number | null; caseSize: number | null }>();
    for (const l of lines) {
      const id = Number(l.itemId);
      if (!Number.isInteger(id)) throw new Error("Unknown bottle in the delivery");
      const q = whole(l.qty, "Quantity");
      if (q < 1) throw new Error("Every line needs at least 1 bottle");
      const c = l.cost == null ? null : Number(l.cost);
      if (c !== null && (!Number.isFinite(c) || c < 0)) throw new Error("Cost must be zero or more");
      const cs = l.caseSize == null ? null : Math.max(1, Math.floor(Number(l.caseSize)));
      const prev = merged.get(id);
      const sumCost = prev && prev.cost !== null && c !== null ? Math.round((prev.cost + c) * 100) / 100
        : c !== null ? c
        : prev?.cost ?? null;
      merged.set(id, { qty: (prev?.qty ?? 0) + q, cost: sumCost, caseSize: cs ?? prev?.caseSize ?? null });
    }

    const inv = invoice.trim();
    if (!inv) throw new Error("Enter the invoice number for this delivery");
    if (inv.length > 60) throw new Error("That invoice number is too long");

    // Same rule undo uses: your own entries, or anything if you own the place.
    // Every move in a batch shares the same affects_stock, so bool_and == the flag.
    const [existing] = await sql`
      select min(user_id) as user_id, count(*) as n,
             bool_and(affects_stock) as affects_stock
      from moves where batch = ${batch} and type = 'receive'`;
    if (!existing || Number(existing.n) === 0) throw new Error("That delivery is already gone.");
    if (u.role !== "owner" && Number(existing.user_id) !== u.id) {
      throw new Error("You can only edit your own deliveries.");
    }
    // A paperwork-only delivery stays paperwork-only on edit: changing its qty would
    // move the storeroom by a delta the stock never saw, so the edit tracks the figure
    // on paper and leaves the stock alone, exactly as the original booking did.
    const affects = existing.affects_stock !== false;

    const ids = [...merged.keys()];
    const qtys = [...merged.values()].map((v) => v.qty);
    const costs = [...merged.values()].map((v) => v.cost);
    const caseSizes = [...merged.values()].map((v) => v.caseSize);
    const sup = supplier.trim() || null;

    // Shared with scripts/check-delivery-edit.mjs, which runs this exact statement
    // against a real database — see the module for why it is all-or-nothing.
    const rows = await applyDeliveryEdit(sql, {
      batch, ids, qtys, costs, caseSizes, invoice: inv, supplier: sup, affectsStock: affects,
      deliveryDate: parseDay(deliveryDate),
    });

    if (rows.length !== ids.length) {
      const [dupe] = await sql`
        select min(ts) as ts from moves
        where invoice = ${inv} and batch is distinct from ${batch} group by invoice`;
      if (dupe) {
        throw new Error(
          `Invoice ${inv} is already on the delivery booked ${new Date(dupe.ts).toLocaleDateString()}.`
        );
      }
      throw new Error(
        "That edit would take a bottle below zero in the storeroom, or a bottle is no "
        + "longer on the list. Reload and check the numbers."
      );
    }
    refresh();
  });
}
