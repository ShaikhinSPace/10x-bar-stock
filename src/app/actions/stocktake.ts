"use server";

import { refresh } from "next/cache";
import { sql, type Loc } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { attempt, partial, isLoc, knownLocs, type Result } from "./_shared";

// Every export here is reachable by direct POST, so each one re-checks auth itself.

/**
 * Submit a whole count for one location in a single statement.
 *
 * There is no separate "stocktake" — the manager counts open and close, the
 * system takes the difference. Counting bottle-by-bottle through the item sheet
 * is six interactions per bottle across ~45 bottles, which is how counts end up
 * not happening. Here the counter walks the list once and submits.
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
    const u = await requireOwner();
    const locs = await knownLocs();
    if (!isLoc(loc, locs)) throw new Error("Unknown location");
    if (!Array.isArray(lines) || !lines.length) throw new Error("Nothing counted yet");
    if (lines.length > 1000) throw new Error("That's too many lines for one count");

    const seen = new Map<number, number>();
    for (const l of lines) {
      const id = Number(l.itemId);
      if (!Number.isInteger(id)) throw new Error("Unknown bottle in the count");
      seen.set(id, partial(l.value, "Count")); // bars are counted to 2dp

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
