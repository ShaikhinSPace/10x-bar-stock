"use server";

import { refresh } from "next/cache";
import { sql, type Loc } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { partial, isLoc, knownLocs } from "./_shared";

export type Variance = { name: string; cat: string; was: number; counted: number };
export type StocktakeResult =
  | { ok: true; variances: Variance[] }
  | { ok: false; error: string };

/**
 * Submit a blind count for one location.
 *
 * The caller sends one line per physical bottle found:
 *  - Store: one line per brand (value = whole bottles).
 *  - Bars:  one line per open bottle (value = fill level). Multiple lines
 *           for the same item are summed and the individual values become
 *           the levels array.
 *
 * Items at this location that are NOT in the list are treated as absent
 * (counted to zero). This is a true "count from zero" — you build the
 * list from what's physically there.
 */
export async function submitStocktake(
  loc: Loc, lines: { itemId: number; value: number }[]
): Promise<StocktakeResult> {
  try {
    const u = await requireOwner();
    const locs = await knownLocs();
    if (!isLoc(loc, locs)) throw new Error("Unknown location");
    if (lines.length > 2000) throw new Error("Too many lines for one count");

    // Group by item: sum values, collect individual values as bar levels
    const byItem = new Map<number, { total: number; levels: number[] }>();
    for (const l of lines) {
      const id = Number(l.itemId);
      if (!Number.isInteger(id)) throw new Error("Unknown bottle in the count");
      const v = partial(l.value, "Count");
      const prev = byItem.get(id);
      if (prev) { prev.total += v; prev.levels.push(v); }
      else byItem.set(id, { total: v, levels: [v] });
    }
    for (const v of byItem.values()) v.total = Math.round(v.total * 100) / 100;

    // Items at this location with stock > 0 that the user did NOT count → zero
    const existing = await sql`
      select id from items where not archived and
        case ${loc}::text when 'store' then store when 'patio' then patio else back end > 0`;
    for (const r of existing) {
      const id = r.id as number;
      if (!byItem.has(id)) byItem.set(id, { total: 0, levels: [] });
    }

    const ids = [...byItem.keys()];
    const vals = [...byItem.values()].map(v => v.total);

    if (!ids.length) return { ok: true, variances: [] };

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
          patio_levels = case when ${loc}::text = 'patio' then '{}'::numeric[] else i.patio_levels end,
          back_levels  = case when ${loc}::text = 'back'  then '{}'::numeric[] else i.back_levels  end
        from changed c where i.id = c.id
        returning i.id
      )
      insert into moves
        (type, item_id, item_name, cat, loc, from_val, to_val, user_id, user_name, batch)
      select 'count', c.id, c.name, c.cat, ${loc}::text, c.was, c.val, ${u.id}, ${u.name}, ${batch}
      from changed c join upd on upd.id = c.id
      returning item_name as name, cat, from_val::numeric as was, to_val::numeric as counted`;

    // Write per-bottle levels for bar counts (after CTE cleared them)
    if (loc !== "store") {
      for (const [id, v] of byItem) {
        const clean = v.levels.filter(n => n > 0);
        if (!clean.length) continue;
        await sql`update items set
          patio_levels = case when ${loc}::text = 'patio' then ${clean}::numeric[] else patio_levels end,
          back_levels  = case when ${loc}::text = 'back'  then ${clean}::numeric[] else back_levels  end
        where id = ${id}`;
      }
    }

    refresh();
    return {
      ok: true,
      variances: rows.map(r => ({
        name: r.name as string,
        cat: r.cat as string,
        was: Number(r.was),
        counted: Number(r.counted),
      })),
    };
  } catch (e) {
    console.error("[action]", e);
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
  }
}
