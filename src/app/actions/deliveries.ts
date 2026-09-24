"use server";

import { refresh } from "next/cache";
import { sql, type DeliveryLine } from "@/lib/db";
import { applyDeliveryEdit } from "@/lib/delivery-edit";
import { requireUser } from "@/lib/auth";
import { attempt, whole, type Result } from "./_shared";

// Every export here is reachable by direct POST, so each one re-checks auth itself.

/**
 * Book a whole delivery in one go — deliveries arrive as one drop with many lines,
 * and tapping Receive on thirty bottles individually is how counts get skipped.
 *
 * Every line lands in a single statement, so a delivery is all-or-nothing: the
 * stock rises and its log entries appear together or neither happens.
 */
export async function receiveDelivery(
  lines: DeliveryLine[], invoice: string, supplier: string
): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();
    if (!Array.isArray(lines) || !lines.length) throw new Error("Add at least one bottle");
    if (lines.length > 300) throw new Error("That's too many lines for one delivery");

    // Merge duplicates so the same bottle scanned twice doesn't double-update.
    const merged = new Map<number, number>();
    for (const l of lines) {
      const id = Number(l.itemId);
      if (!Number.isInteger(id)) throw new Error("Unknown bottle in the delivery");
      const q = whole(l.qty, "Quantity");
      if (q < 1) throw new Error("Every line needs at least 1 bottle");
      merged.set(id, (merged.get(id) ?? 0) + q);
    }

    const inv = invoice.trim();
    if (!inv) throw new Error("Enter the invoice number for this delivery");
    if (inv.length > 60) throw new Error("That invoice number is too long");

    const ids = [...merged.keys()];
    const qtys = [...merged.values()];
    const batch = `D${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const sup = supplier.trim() || null;

    // The `guard` CTE makes "not already booked" part of the same statement, so two
    // people booking the same invoice at once can't both get through. Booking one
    // invoice twice is the one mistake that silently inflates stock.
    const rows = await sql`
      with guard as (
        select 1 where not exists (select 1 from moves where invoice = ${inv})
      ), lines as (
        select * from unnest(${ids}::int[], ${qtys}::numeric[]) as t(item_id, qty)
      ), upd as (
        update items i set store = i.store + l.qty
        from lines l, guard
        where i.id = l.item_id and not i.archived
        returning i.id, i.name, i.cat, l.qty
      )
      insert into moves
        (type, item_id, item_name, cat, qty, loc, user_id, user_name, batch, invoice, supplier)
      select 'receive', upd.id, upd.name, upd.cat, upd.qty, 'store',
             ${u.id}, ${u.name}, ${batch}, ${inv}, ${sup}
      from upd
      returning id`;

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
    if (rows.length !== ids.length) {
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
  batch: string, lines: DeliveryLine[], invoice: string, supplier: string
): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();
    if (typeof batch !== "string" || !batch) throw new Error("Unknown delivery");
    if (!Array.isArray(lines) || !lines.length) {
      throw new Error("A delivery needs at least one bottle — undo it instead to remove it");
    }
    if (lines.length > 300) throw new Error("That's too many lines for one delivery");

    const merged = new Map<number, number>();
    for (const l of lines) {
      const id = Number(l.itemId);
      if (!Number.isInteger(id)) throw new Error("Unknown bottle in the delivery");
      const q = whole(l.qty, "Quantity");
      if (q < 1) throw new Error("Every line needs at least 1 bottle");
      merged.set(id, (merged.get(id) ?? 0) + q);
    }

    const inv = invoice.trim();
    if (!inv) throw new Error("Enter the invoice number for this delivery");
    if (inv.length > 60) throw new Error("That invoice number is too long");

    // Same rule undo uses: your own entries, or anything if you own the place.
    const [existing] = await sql`
      select min(user_id) as user_id, count(*) as n from moves where batch = ${batch}`;
    if (!existing || Number(existing.n) === 0) throw new Error("That delivery is already gone.");
    if (u.role !== "owner" && Number(existing.user_id) !== u.id) {
      throw new Error("You can only edit your own deliveries.");
    }

    const ids = [...merged.keys()];
    const qtys = [...merged.values()];
    const sup = supplier.trim() || null;

    // Shared with scripts/check-delivery-edit.mjs, which runs this exact statement
    // against a real database — see the module for why it is all-or-nothing.
    const rows = await applyDeliveryEdit(sql, {
      batch, ids, qtys, invoice: inv, supplier: sup,
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
