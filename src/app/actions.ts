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
          patio = patio + case when ${to}::text = 'patio' then ${q}::numeric else 0 end,
          back  = back  + case when ${to}::text = 'back'  then ${q}::numeric else 0 end,
          -- Whole unopened bottles, so they join the breakdown as full ones -
          -- but only where a breakdown already exists, or its sum would stop
          -- matching the total. Empty stays empty until someone counts.
          -- The ::int cast below is load-bearing: a bound parameter arrives
          -- as text, so without it this is array_fill(numeric, text[]) and
          -- fails at runtime. (Never interpolate into a SQL comment either -
          -- the driver still binds it, leaving a parameter nothing uses.)
          patio_levels = case when ${to}::text = 'patio' and cardinality(patio_levels) > 0
                              then patio_levels || array_fill(1::numeric, array[${q}::int])
                              else patio_levels end,
          back_levels  = case when ${to}::text = 'back'  and cardinality(back_levels) > 0
                              then back_levels  || array_fill(1::numeric, array[${q}::int])
                              else back_levels end
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

/**
 * Submit a whole stocktake for one location in a single statement.
 *
 * Counting a bar bottle-by-bottle through the item sheet is six interactions per
 * bottle across ~45 bottles, which is how stocktakes end up not happening. Here the
 * counter walks the list once and submits.
 *
 * Only rows whose count actually moved are written: a no-change row updates nothing
 * and logs nothing, so a `count` entry in the log always means something shifted.
 * Rows the counter never filled in are simply absent - a blank is "not counted",
 * never zero.
 */
export async function submitStocktake(
  loc: Loc, lines: { itemId: number; value: number }[]
): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();
    if (!isLoc(loc)) throw new Error("Unknown location");
    if (!Array.isArray(lines) || !lines.length) throw new Error("Nothing counted yet");
    if (lines.length > 1000) throw new Error("That's too many lines for one stocktake");

    const seen = new Map<number, number>();
    for (const l of lines) {
      const id = Number(l.itemId);
      if (!Number.isInteger(id)) throw new Error("Unknown bottle in the count");
      // store is whole bottles; the bars are counted to 2dp
      seen.set(id, loc === "store"
        ? whole(l.value, "Count")
        : partial(l.value, "Count"));
    }

    const ids = [...seen.keys()];
    const vals = [...seen.values()];
    const batch = `S${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    const rows = await sql`
      with lines as (
        select * from unnest(${ids}::int[], ${vals}::numeric[]) as t(item_id, val)
      ), prev as (
        select i.id, i.name, i.cat, l.val,
               case ${loc}::text
                 when 'store' then i.store when 'patio' then i.patio else i.back
               end as was
        from items i join lines l on l.item_id = i.id
        where not i.archived
      ), changed as (
        select * from prev where val <> was
      ), upd as (
        update items i set
          store = case when ${loc}::text = 'store' then c.val else i.store end,
          patio = case when ${loc}::text = 'patio' then c.val else i.patio end,
          back  = case when ${loc}::text = 'back'  then c.val else i.back  end,
          -- A stocktake row is one total per bottle, not a bottle-by-bottle
          -- breakdown, so it replaces any breakdown with "unknown".
          patio_levels = case when ${loc}::text = 'patio' then '{}'::numeric[] else i.patio_levels end,
          back_levels  = case when ${loc}::text = 'back'  then '{}'::numeric[] else i.back_levels  end
        from changed c where i.id = c.id
        returning i.id
      )
      insert into moves
        (type, item_id, item_name, cat, loc, from_val, to_val, user_id, user_name, batch)
      select 'count', c.id, c.name, c.cat, ${loc}::text, c.was, c.val, ${u.id}, ${u.name}, ${batch}
      from changed c join upd on upd.id = c.id
      returning id`;

    if (!rows.length) throw new Error("Every count matched what was already recorded.");
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
          back  = case when ${loc}::text = 'back'  then ${v} else back  end,
          -- A plain total overrides whatever the bottle breakdown said, and
          -- nothing here says how that total splits across bottles - so the
          -- breakdown is dropped rather than left stale. Same everywhere
          -- below: only countBarBottles() can establish one.
          patio_levels = case when ${loc}::text = 'patio' then '{}'::numeric[] else patio_levels end,
          back_levels  = case when ${loc}::text = 'back'  then '{}'::numeric[] else back_levels  end
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
 * Count a bar bottle by bottle.
 *
 * A bar can have several open bottles of the same thing at different levels;
 * adding them up in your head at the bar is where counts go wrong, and the
 * total alone can't tell you three bottles are open. The levels are stored
 * alongside the total, which the database computes from them so the two can
 * never disagree.
 *
 * Logged as an ordinary 'count' move, so undo, the activity log and the
 * report's variance figures all keep working untouched.
 */
export async function countBarBottles(
  itemId: number, loc: Loc, levels: number[]
): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();
    if (loc !== "patio" && loc !== "back") throw new Error("Only the bars are counted bottle by bottle");
    if (!Array.isArray(levels)) throw new Error("Enter at least one bottle");
    if (levels.length > 60) throw new Error("That's more open bottles than a bar can hold");

    // An empty row is "no bottle", not a zero - drop it before validating.
    const clean = levels.map((n) => partial(n, "Bottle level")).filter((n) => n > 0);
    for (const n of clean) if (n > 1) throw new Error("A bottle can't be more than full - use one row per bottle");
    const total = Math.round(clean.reduce((a, n) => a + n, 0) * 100) / 100;

    const rows = await sql`
      with prev as (
        select id, name, cat, case when ${loc}::text = 'patio' then patio else back end as v
        from items where id = ${itemId} and not archived
      ), upd as (
        update items set
          patio        = case when ${loc}::text = 'patio' then ${total}::numeric else patio end,
          back         = case when ${loc}::text = 'back'  then ${total}::numeric else back  end,
          patio_levels = case when ${loc}::text = 'patio' then ${clean}::numeric[] else patio_levels end,
          back_levels  = case when ${loc}::text = 'back'  then ${clean}::numeric[] else back_levels  end
        where id = ${itemId} and not archived returning id
      )
      insert into moves (type, item_id, item_name, cat, loc, from_val, to_val, user_id, user_name)
      select 'count', prev.id, prev.name, prev.cat, ${loc}::text, prev.v, ${total}, ${u.id}, ${u.name}
      from prev join upd on upd.id = prev.id
      returning id`;

    if (!rows.length) throw new Error("That bottle is no longer in the list.");
    refresh();
  });
}

/** Log a wasted, broken, or spilled bottle. */
export async function logWaste(
  itemId: number, qty: number, loc: Loc, reason: string
): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();
    if (!isLoc(loc)) throw new Error("Unknown location");
    const q = loc === "store" ? whole(qty, "Waste quantity") : partial(qty, "Waste quantity");
    if (q <= 0) throw new Error("Quantity must be greater than zero");
    const r = reason.trim() || "Spill / Breakage";

    const rows = await sql`
      with prev as (
        select id, name, cat from items where id = ${itemId} and not archived
      ), upd as (
        update items set
          store = store - case when ${loc}::text = 'store' then ${q}::numeric else 0 end,
          patio = patio - case when ${loc}::text = 'patio' then ${q}::numeric else 0 end,
          back  = back  - case when ${loc}::text = 'back'  then ${q}::numeric else 0 end,
          patio_levels = case when ${loc}::text = 'patio' then '{}'::numeric[] else patio_levels end,
          back_levels  = case when ${loc}::text = 'back'  then '{}'::numeric[] else back_levels  end
        where id = ${itemId} and not archived and
          (case ${loc}::text when 'store' then store when 'patio' then patio else back end) >= ${q}
        returning id
      )
      insert into moves (type, item_id, item_name, cat, qty, loc, notes, user_id, user_name)
      select 'waste', prev.id, prev.name, prev.cat, ${q}, ${loc}::text, ${r}, ${u.id}, ${u.name}
      from prev join upd on upd.id = prev.id
      returning id`;

    if (!rows.length) throw new Error("Not enough stock in that location to record this waste.");
    refresh();
  });
}

/** Transfer stock directly between locations (e.g. Patio Bar <-> Back Bar). */
export async function transferBar(
  itemId: number, qty: number, fromLoc: Loc, toLoc: Loc
): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();
    if (!isLoc(fromLoc) || !isLoc(toLoc)) throw new Error("Invalid location selection");
    if (fromLoc === toLoc) throw new Error("Source and destination bars must be different");

    const isWhole = fromLoc === "store" || toLoc === "store";
    const q = isWhole ? whole(qty, "Transfer quantity") : partial(qty, "Transfer quantity");
    if (q <= 0) throw new Error("Transfer quantity must be greater than zero");

    const rows = await sql`
      with prev as (
        select id, name, cat from items where id = ${itemId} and not archived
      ), upd as (
        update items set
          store = store - case when ${fromLoc}::text = 'store' then ${q}::numeric else 0 end
                        + case when ${toLoc}::text   = 'store' then ${q}::numeric else 0 end,
          patio = patio - case when ${fromLoc}::text = 'patio' then ${q}::numeric else 0 end
                        + case when ${toLoc}::text   = 'patio' then ${q}::numeric else 0 end,
          back  = back  - case when ${fromLoc}::text = 'back'  then ${q}::numeric else 0 end
                        + case when ${toLoc}::text   = 'back'  then ${q}::numeric else 0 end,
          -- Which physical bottle a partial transfer came out of (or landed
          -- in) isn't recorded, so any bar either end of it loses its
          -- breakdown until the next count.
          patio_levels = case when 'patio' in (${fromLoc}::text, ${toLoc}::text)
                              then '{}'::numeric[] else patio_levels end,
          back_levels  = case when 'back'  in (${fromLoc}::text, ${toLoc}::text)
                              then '{}'::numeric[] else back_levels end
        where id = ${itemId} and not archived and
          (case ${fromLoc}::text when 'store' then store when 'patio' then patio else back end) >= ${q}
        returning id
      )
      insert into moves (type, item_id, item_name, cat, qty, loc, to_loc, user_id, user_name)
      select 'transfer', prev.id, prev.name, prev.cat, ${q}, ${fromLoc}::text, ${toLoc}::text, ${u.id}, ${u.name}
      from prev join upd on upd.id = prev.id
      returning id`;

    if (!rows.length) throw new Error("Not enough stock in the source location to complete transfer.");
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
          patio = patio - case when ${m.loc}::text = 'patio' then ${m.qty}::numeric else 0 end,
          back  = back  - case when ${m.loc}::text = 'back'  then ${m.qty}::numeric else 0 end
        where id = ${m.item_id}`;
    } else if (m.type === "receive") {
      await sql`update items set store = store - ${m.qty} where id = ${m.item_id}`;
    } else if (m.type === "waste") {
      await sql`
        update items set
          store = store + case when ${m.loc}::text = 'store' then ${m.qty}::numeric else 0 end,
          patio = patio + case when ${m.loc}::text = 'patio' then ${m.qty}::numeric else 0 end,
          back  = back  + case when ${m.loc}::text = 'back'  then ${m.qty}::numeric else 0 end
        where id = ${m.item_id}`;
    } else if (m.type === "transfer") {
      await sql`
        update items set
          store = store + case when ${m.loc}::text = 'store' then ${m.qty}::numeric else 0 end
                        - case when ${m.to_loc}::text = 'store' then ${m.qty}::numeric else 0 end,
          patio = patio + case when ${m.loc}::text = 'patio' then ${m.qty}::numeric else 0 end
                        - case when ${m.to_loc}::text = 'patio' then ${m.qty}::numeric else 0 end,
          back  = back  + case when ${m.loc}::text = 'back'  then ${m.qty}::numeric else 0 end
                        - case when ${m.to_loc}::text = 'back'  then ${m.qty}::numeric else 0 end
        where id = ${m.item_id}`;
    } else {
      await sql`
        update items set
          store = case when ${m.loc}::text = 'store' then ${m.from_val} else store end,
          patio = case when ${m.loc}::text = 'patio' then ${m.from_val} else patio end,
          back  = case when ${m.loc}::text = 'back'  then ${m.from_val} else back  end
        where id = ${m.item_id}`;
    }

    // Reversing a bar's total says nothing about how it splits across
    // bottles - even undoing a bottle-by-bottle count only restores the
    // scalar - so any bar this move touched loses its breakdown. Done once
    // here rather than in all five branches above.
    await sql`
      update items set
        patio_levels = case when 'patio' in (coalesce(${m.loc}::text, ''), coalesce(${m.to_loc}::text, ''))
                            then '{}'::numeric[] else patio_levels end,
        back_levels  = case when 'back'  in (coalesce(${m.loc}::text, ''), coalesce(${m.to_loc}::text, ''))
                            then '{}'::numeric[] else back_levels end
      where id = ${m.item_id}`;

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

/**
 * Rename a bottle and set its categories.
 *
 * `cat` is the single main category - it drives every total, colour and the
 * beer cases rule - and `tags` are extra categories it can also be filtered
 * under, so a well whiskey counts once under Whiskey but still turns up under
 * Well. The main category is never duplicated into tags.
 *
 * Past moves keep the old name on purpose: item_name is denormalised into
 * `moves` precisely so the activity log stays readable after a rename.
 */
export async function editItem(
  itemId: number, name: string, cat: Cat, tags: Cat[]
): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    const n = name.trim();
    if (!n) throw new Error("Give the bottle a name");
    if (n.length > 80) throw new Error("That name is too long");
    if (!isCat(cat)) throw new Error("Pick a main category");

    const extra = [...new Set((Array.isArray(tags) ? tags : []).filter(isCat))].filter((t) => t !== cat);
    if (extra.length > CATS.length) throw new Error("Too many categories");

    const renamed = await sql`
      update items set name = ${n}, cat = ${cat}
      where id = ${itemId} and not archived
        and not exists (select 1 from items o where o.name = ${n} and o.id <> ${itemId})
      returning id`;
    if (!renamed.length) {
      const [clash] = await sql`select id from items where name = ${n} and id <> ${itemId}`;
      throw new Error(clash ? `"${n}" is already on the list.` : "That bottle is no longer in the list.");
    }

    // Replace the tag set wholesale - simpler than diffing, and the table is
    // at most a handful of rows per item.
    await sql`delete from item_tags where item_id = ${itemId}`;
    if (extra.length) {
      await sql`
        insert into item_tags (item_id, cat)
        select ${itemId}, c from unnest(${extra}::text[]) as c`;
    }
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

/** Silences one item's reorder alert without touching its reorder level. */
export async function setReorderIgnore(itemId: number, ignore: boolean): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    await sql`update items set ignore_reorder = ${ignore} where id = ${itemId}`;
    refresh();
  });
}

export async function batchSetReorderLevels(updates: { id: number; rl: number }[]): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    if (!Array.isArray(updates) || !updates.length) throw new Error("No updates provided");
    for (const u of updates) {
      await sql`update items set rl = ${partial(u.rl, "Reorder level")} where id = ${u.id}`;
    }
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
