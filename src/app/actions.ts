"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { sql, CATS, LOCS, type Cat, type DeliveryLine, type Loc } from "@/lib/db";
import {
  endSession, hashPassword, requireOwner, requireUser, startSession, verifyPassword,
} from "@/lib/auth";

// Every export here is reachable by direct POST, so each one re-checks auth itself.

// Next masks thrown Server Action errors in production, so anything the user needs to
// read ("not enough in the storeroom") is returned rather than thrown.
export type Result = { ok: true; moveId?: number } | { ok: false; error: string };

async function attempt(fn: () => Promise<number | void>): Promise<Result> {
  try {
    const moveId = await fn();
    return typeof moveId === "number" ? { ok: true, moveId } : { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Something went wrong";
    console.error("[action]", e);
    return { ok: false, error };
  }
}

const isLoc = (v: unknown): v is Loc => LOCS.includes(v as Loc);
const isCat = (v: unknown): v is Cat => CATS.includes(v as Cat);

/** Whole bottles only — used for store counts and for every give/receive. */
function whole(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be a whole number`);
  return n;
}

/** Bars are counted to 2dp (0.25, 1.87). */
function partial(v: unknown, what: string): number {
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be zero or more`);
  return n;
}

export async function login(_prev: string | null, form: FormData): Promise<string | null> {
  const username = String(form.get("username") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!username || !password) return "Enter your username and password.";

  const rows = await sql`
    select id, password_hash from users where lower(username) = ${username} and active`;
  // Same message either way — don't leak which usernames exist.
  if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
    return "That username and password don't match.";
  }
  await startSession(rows[0].id);
  redirect("/"); // throws a control-flow exception — must stay outside any try/catch
}

export async function logout() {
  await endSession();
  redirect("/login");
}

export async function giveOut(itemId: number, qty: number, to: Loc): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();
    const q = whole(qty, "Quantity");
    if (q < 1) throw new Error("Give out at least 1 bottle");
    if (!isLoc(to) || to === "store") throw new Error("Pick a bar");

    const rows = await sql`
      with prev as (
        select id, name, cat from items where id = ${itemId} and not archived
      ), upd as (
        update items set
          store = store - ${q},
          patio = patio + case when ${to}::text = 'patio' then ${q} else 0 end,
          back  = back  + case when ${to}::text = 'back'  then ${q} else 0 end
        where id = ${itemId} and not archived and store >= ${q}
        returning id
      )
      insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name)
      select 'give', prev.id, prev.name, prev.cat, ${q}, ${to}::text, ${u.id}, ${u.name}
      from prev join upd on upd.id = prev.id
      returning id`;

    if (!rows.length) throw new Error("Not enough in the storeroom — receive stock first.");
    refresh();
  });
}

export async function receive(itemId: number, qty: number): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();
    const q = whole(qty, "Quantity");
    if (q < 1) throw new Error("Receive at least 1 bottle");

    const rows = await sql`
      with prev as (
        select id, name, cat from items where id = ${itemId} and not archived
      ), upd as (
        update items set store = store + ${q}
        where id = ${itemId} and not archived returning id
      )
      insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name)
      select 'receive', prev.id, prev.name, prev.cat, ${q}, 'store', ${u.id}, ${u.name}
      from prev join upd on upd.id = prev.id
      returning id`;

    if (!rows.length) throw new Error("That bottle is no longer in the list.");
    refresh();
  });
}

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

/** Set the exact count at one location. This is how bar counts get entered. */
export async function setCount(itemId: number, loc: Loc, value: number): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();
    if (!isLoc(loc)) throw new Error("Unknown location");
    const v = loc === "store"
      ? whole(value, "Store count")   // storeroom is whole bottles
      : partial(value, "Bar count");  // bars count partials

    const rows = await sql`
      with prev as (
        select id, name, cat,
               case ${loc}::text when 'store' then store when 'patio' then patio else back end as v
        from items where id = ${itemId} and not archived
      ), upd as (
        update items set
          store = case when ${loc}::text = 'store' then ${v} else store end,
          patio = case when ${loc}::text = 'patio' then ${v} else patio end,
          back  = case when ${loc}::text = 'back'  then ${v} else back  end
        where id = ${itemId} and not archived returning id
      )
      insert into moves (type, item_id, item_name, cat, loc, from_val, to_val, user_id, user_name)
      select 'count', prev.id, prev.name, prev.cat, ${loc}::text, prev.v, ${v}, ${u.id}, ${u.name}
      from prev join upd on upd.id = prev.id
      returning id`;

    if (!rows.length) throw new Error("That bottle is no longer in the list.");
    refresh();
  });
}

/**
 * Reverse a move. Only the newest move for that item can be undone — reversing an
 * older one would silently clobber whatever was logged after it.
 */
export async function undoMove(moveId: number): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();

    const rows = await sql`select * from moves where id = ${moveId}`;
    const m = rows[0];
    if (!m) throw new Error("That entry is already gone.");
    if (u.role !== "owner" && m.user_id !== u.id) {
      throw new Error("You can only undo your own entries.");
    }

    const [newest] = await sql`
      select id from moves where item_id = ${m.item_id} order by ts desc, id desc limit 1`;
    if (Number(newest.id) !== Number(moveId)) {
      throw new Error("Something else was logged for this bottle since — use Count instead.");
    }

    if (m.type === "give") {
      await sql`
        update items set
          store = store + ${m.qty},
          patio = patio - case when ${m.loc}::text = 'patio' then ${m.qty} else 0 end,
          back  = back  - case when ${m.loc}::text = 'back'  then ${m.qty} else 0 end
        where id = ${m.item_id}`;
    } else if (m.type === "receive") {
      await sql`update items set store = store - ${m.qty} where id = ${m.item_id}`;
    } else {
      await sql`
        update items set
          store = case when ${m.loc}::text = 'store' then ${m.from_val} else store end,
          patio = case when ${m.loc}::text = 'patio' then ${m.from_val} else patio end,
          back  = case when ${m.loc}::text = 'back'  then ${m.from_val} else back  end
        where id = ${m.item_id}`;
    }
    await sql`delete from moves where id = ${moveId}`;
    refresh();
  });
}

/* ---------------- Manage (owner only) ---------------- */

export async function addItem(
  name: string, cat: Cat, store: number, rl: number
): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    const n = name.trim();
    if (!n) throw new Error("Give the bottle a name");
    if (!isCat(cat)) throw new Error("Pick a category");

    const rows = await sql`
      insert into items (name, cat, store, rl)
      values (${n}, ${cat}, ${whole(store, "Opening stock")}, ${partial(rl, "Reorder level")})
      on conflict (name) do nothing returning id`;
    if (!rows.length) throw new Error(`"${n}" is already on the list.`);
    refresh();
  });
}

export async function setReorderLevel(itemId: number, rl: number): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    await sql`update items set rl = ${partial(rl, "Reorder level")} where id = ${itemId}`;
    refresh();
  });
}

/** Archive, never delete — the activity log references the row. */
export async function archiveItem(itemId: number): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    await sql`update items set archived = true where id = ${itemId}`;
    refresh();
  });
}

export async function addUser(
  username: string, name: string, password: string, role: "owner" | "staff"
): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    const un = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(un)) {
      throw new Error("Username: 3-32 characters, letters/numbers/._- only");
    }
    if (!name.trim()) throw new Error("Enter their name");
    if (password.length < 8) throw new Error("Password must be at least 8 characters");
    if (role !== "owner" && role !== "staff") throw new Error("Unknown role");

    const rows = await sql`
      insert into users (username, name, password_hash, role)
      values (${un}, ${name.trim()}, ${hashPassword(password)}, ${role})
      on conflict (username) do nothing returning id`;
    if (!rows.length) throw new Error("That username is taken.");
    refresh();
  });
}

export async function setUserActive(userId: number, active: boolean): Promise<Result> {
  return attempt(async () => {
    const me = await requireOwner();
    if (userId === me.id && !active) throw new Error("You can't deactivate yourself.");
    await sql`update users set active = ${active} where id = ${userId}`;
    refresh();
  });
}
