// The one statement that runs several bottles out to a bar at once.
//
// Kept out of db.ts (and so free of "server-only") purely so scripts/check-give-run.mjs
// can run this exact SQL against a real database. The all-or-nothing store guard is
// where the risk lives — a partial run would silently inflate a bar — so the check
// exercises this statement, not a copy.

/** Just enough of the neon tagged-template to type this file with no dependency on it. */
type Sql = (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<Record<string, unknown>[]>;

export type GiveRun = {
  /** Item ids, deduped, aligned with `qtys`. */
  ids: number[];
  qtys: number[];
  to: "patio" | "back";
  userId: number;
  userName: string;
};

/**
 * Give every line out to one bar in a single all-or-nothing statement.
 *
 * The `short` CTE is the same store guard giveOut uses, checked across every line
 * before a row is touched: if any bottle is short in the storeroom the UPDATE's
 * `not exists (select 1 from short)` is false for all of them, so nothing moves and
 * nothing is logged. Full unopened bottles join a bar's breakdown only where one
 * already exists, matching giveOut — the ::int cast on the count is load-bearing
 * because a bound parameter arrives as text.
 *
 * Returns one row per line written; fewer than `ids.length` means it was rejected
 * (something short, or a bottle gone) and nothing was written.
 */
export function applyGiveRun(sql: Sql, r: GiveRun) {
  return sql`
    with lines as (
      select * from unnest(${r.ids}::int[], ${r.qtys}::numeric[]) as t(item_id, qty)
    ), short as (
      select 1 from lines l join items i on i.id = l.item_id
      where not i.archived and i.store < l.qty limit 1
    ), upd as (
      update items i set
        store = i.store - l.qty,
        patio = i.patio + case when ${r.to}::text = 'patio' then l.qty else 0 end,
        back  = i.back  + case when ${r.to}::text = 'back'  then l.qty else 0 end,
        patio_levels = case when ${r.to}::text = 'patio' and cardinality(i.patio_levels) > 0
                            then i.patio_levels || array_fill(1::numeric, array[l.qty::int])
                            else i.patio_levels end,
        back_levels  = case when ${r.to}::text = 'back'  and cardinality(i.back_levels) > 0
                            then i.back_levels  || array_fill(1::numeric, array[l.qty::int])
                            else i.back_levels end
      from lines l
      where i.id = l.item_id and not i.archived and not exists (select 1 from short)
      returning i.id, i.name, i.cat, l.qty
    )
    insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name)
    select 'give', upd.id, upd.name, upd.cat, upd.qty, ${r.to}::text, ${r.userId}, ${r.userName}
    from upd
    returning id`;
}
