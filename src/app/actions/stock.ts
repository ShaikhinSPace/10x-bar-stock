"use server";

import { refresh } from "next/cache";
import { sql, type Loc } from "@/lib/db";
import { applyGiveRun } from "@/lib/give-run";
import { applyUndo } from "@/lib/undo-move";
import { requireOwner, requireUser } from "@/lib/auth";
import { attempt, whole, partial, isLoc, type Result } from "./_shared";

// Every export here is reachable by direct POST, so each one re-checks auth itself.

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

/**
 * Run several bottles out to one bar in a single all-or-nothing statement.
 *
 * The barback's whole shift is this one loop — store to a bar, over and over —
 * and tapping Give on each bottle through the sheet is how a run ends up half
 * logged. If any bottle is short in the storeroom the entire run is refused
 * rather than partly applied: the `short` CTE is the same store guard giveOut
 * uses, checked across every line at once before a single row is touched.
 *
 * Each line is logged as its own plain `give` move (no batch), so undo, the
 * activity log and the report treat a run's lines exactly like hand-entered
 * gives — and they stay clear of getDeliveries, which groups on batch alone.
 */
export async function giveRun(
  lines: { itemId: number; qty: number }[], to: Loc
): Promise<Result> {
  return attempt(async () => {
    const u = await requireUser();
    if (!isLoc(to) || to === "store") throw new Error("Pick a bar to run to");
    if (!Array.isArray(lines) || !lines.length) throw new Error("Load at least one bottle onto the run");
    if (lines.length > 300) throw new Error("That's too many bottles for one run");

    // Merge duplicates so the same bottle added twice doesn't double-decrement.
    const merged = new Map<number, number>();
    for (const l of lines) {
      const id = Number(l.itemId);
      if (!Number.isInteger(id)) throw new Error("Unknown bottle on the run");
      const q = whole(l.qty, "Quantity");
      if (q < 1) throw new Error("Every bottle on the run needs at least 1");
      merged.set(id, (merged.get(id) ?? 0) + q);
    }

    const ids = [...merged.keys()];
    const qtys = [...merged.values()];

    // Shared with scripts/check-give-run.mjs, which runs this exact statement against
    // a real database — see the module for why the store guard is all-or-nothing.
    const rows = await applyGiveRun(sql, { ids, qtys, to, userId: u.id, userName: u.name });

    if (!rows.length) {
      throw new Error("Not enough in the storeroom for this run — receive stock or lower a quantity.");
    }
    if (rows.length !== ids.length) {
      throw new Error("Some bottles are no longer on the list — reload and try the run again.");
    }
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
 * Reverse a move.
 *
 * Gives, receives, wastage and transfers are deltas, so an older one can still be
 * pulled back out exactly — a mistake three entries ago is a mistake, not a reason
 * to recount the bar. A count sets an absolute figure instead, so it blocks undoing
 * anything underneath it and only reverses itself while nothing has touched that
 * bottle since. The arithmetic and both guards live in @/lib/undo-move.
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

    // Shared with scripts/check-undo.mjs, which runs this exact logic against a
    // real database — see the module for which moves can be reversed and why.
    const refused = await applyUndo(sql, m as Parameters<typeof applyUndo>[1]);
    if (refused?.reason === "counted") {
      throw new Error(
        "This bottle has been counted since, and the count is now the truth. "
        + "Correct it with another Count."
      );
    }
    if (refused?.reason === "superseded") {
      throw new Error("Something else was logged for this bottle since — use Count instead.");
    }
    if (refused?.reason === "short") {
      throw new Error(
        "There isn't enough left to take back — the stock has moved on since. Use Count instead."
      );
    }
    refresh();
  });
}

/**
 * Log a give, receive, or bar count for a PAST business day — the owner's tool for
 * fixing a night that was mis-recorded, whether a pour/delivery went unlogged or the
 * bar was only counted late. It applies the change now and stamps the entry with
 * `atMs`, a moment the caller places inside the target business day so it lands in
 * that day's bucket. Owner-only; a give is guarded by the same store check as giveOut,
 * and a count sets the bar's level and records the drop (from_val -> to_val) the
 * dashboard reads as poured/consumed. A correction is a real move: undo reverses it.
 */
export async function addEntry(
  atMs: number, type: "give" | "receive" | "count", itemId: number, qty: number, to: Loc | null,
): Promise<Result> {
  return attempt(async () => {
    const u = await requireOwner();
    if (type !== "give" && type !== "receive" && type !== "count") throw new Error("Pick give, receive, or count");
    if (!Number.isFinite(atMs)) throw new Error("Pick a day for the entry");
    // Allow a few minutes of client/server clock skew, so a legitimate "today" entry
    // isn't rejected as "future" just because the browser clock runs slightly ahead.
    if (atMs > Date.now() + 5 * 60 * 1000) throw new Error("Can't add an entry dated in the future");
    const tsIso = new Date(atMs).toISOString();

    if (type === "receive") {
      const q = whole(qty, "Quantity");
      if (q < 1) throw new Error("Add at least 1 bottle");
      // Receive into the storeroom (a delivery) or straight onto a bar. Whole bottles;
      // a bar receive drops that bar's open-bottle breakdown since the new bottles'
      // composition isn't known (same as a backdated give).
      if (!isLoc(to)) throw new Error("Pick where it's received");
      const rows = await sql`
        with prev as (
          select id, name, cat from items where id = ${itemId} and not archived
        ), upd as (
          update items set
            store = store + case when ${to}::text = 'store' then ${q}::numeric else 0 end,
            patio = patio + case when ${to}::text = 'patio' then ${q}::numeric else 0 end,
            back  = back  + case when ${to}::text = 'back'  then ${q}::numeric else 0 end,
            patio_levels = case when ${to}::text = 'patio' then '{}'::numeric[] else patio_levels end,
            back_levels  = case when ${to}::text = 'back'  then '{}'::numeric[] else back_levels  end
          where id = ${itemId} and not archived returning id
        )
        insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name, ts)
        select 'receive', prev.id, prev.name, prev.cat, ${q}, ${to}::text, ${u.id}, ${u.name}, ${tsIso}
        from prev join upd on upd.id = prev.id returning id`;
      if (!rows.length) throw new Error("That bottle is no longer in the list.");
    } else if (type === "give") {
      const q = whole(qty, "Quantity");
      if (q < 1) throw new Error("Add at least 1 bottle");
      // `to` is a bar, OR null for a give whose bar you don't remember. Either way the
      // bottles left the storeroom (store drops, and it's a 'give' so it counts as given
      // out); an unknown give just isn't credited to a specific bar — a later bar count
      // absorbs it. A backdated/unknown give can't know a bar's open-bottle composition,
      // so it drops that bar's breakdown rather than inventing full bottles.
      if (to != null && (!isLoc(to) || to === "store")) throw new Error("Give to a bar, or leave the bar unknown");
      const rows = await sql`
        with prev as (
          select id, name, cat from items where id = ${itemId} and not archived
        ), upd as (
          update items set
            store = store - ${q},
            patio = patio + case when ${to}::text = 'patio' then ${q}::numeric else 0 end,
            back  = back  + case when ${to}::text = 'back'  then ${q}::numeric else 0 end,
            patio_levels = case when ${to}::text = 'patio' then '{}'::numeric[] else patio_levels end,
            back_levels  = case when ${to}::text = 'back'  then '{}'::numeric[] else back_levels  end
          where id = ${itemId} and not archived and store >= ${q} returning id
        )
        insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name, ts)
        select 'give', prev.id, prev.name, prev.cat, ${q}, ${to}::text, ${u.id}, ${u.name}, ${tsIso}
        from prev join upd on upd.id = prev.id returning id`;
      if (!rows.length) throw new Error("Not enough in the storeroom for that give on that day.");
    } else {
      // count: the STORE count. It reconciles the storeroom to the counted figure now and
      // logs a count move dated to the chosen day, so its drop (from_val -> to_val) buckets
      // into that shift as consumed. Store is whole sealed bottles. Caller enters the
      // current physical count; the day just says which shift it closes.
      const v = whole(qty, "Counted amount");
      const rows = await sql`
        with prev as (
          select id, name, cat, store as v from items where id = ${itemId} and not archived
        ), upd as (
          update items set store = ${v}::numeric where id = ${itemId} and not archived returning id
        )
        insert into moves (type, item_id, item_name, cat, loc, from_val, to_val, user_id, user_name, ts)
        select 'count', prev.id, prev.name, prev.cat, 'store', prev.v, ${v}, ${u.id}, ${u.name}, ${tsIso}
        from prev join upd on upd.id = prev.id returning id`;
      if (!rows.length) throw new Error("That bottle is no longer in the list.");
    }
    refresh();
  });
}
