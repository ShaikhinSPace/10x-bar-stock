// Reversing one logged move.
//
// Kept out of db.ts (and so free of "server-only") purely so
// scripts/check-undo.mjs can run this exact logic against a real database.
// The Server Action adds auth and the refresh; the arithmetic lives here.

/** Just enough of the neon tagged-template to type this file with no dependency on it. */
type Sql = (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<Record<string, unknown>[]>;

/** The moves row being reversed, as it comes back from `select * from moves`. */
export type MoveRow = Record<string, unknown> & {
  id: string | number;
  type: string;
  item_id: number;
  ts: string | Date;
  qty: string | number | null;
  loc: string | null;
  to_loc: string | null;
  from_val: string | number | null;
};

/** null means it worked; anything else is why it was refused. */
export type UndoRefusal =
  | { reason: "counted" }
  | { reason: "superseded" }
  | { reason: "short" }
  | null;

/**
 * Undo one move, or explain why it cannot be undone.
 *
 * give, receive, waste and transfer are deltas, and deltas commute: pulling an older
 * one back out stays exact however much was logged after it. That is what lets a
 * barback fix the give they got wrong three entries ago instead of recounting the bar.
 *
 * A count is not a delta - it sets an absolute figure. So nothing from before a count
 * can be pulled out from under it ("counted"), and a count itself only reverses while
 * it is still the last word on that bottle ("superseded").
 *
 * Anything that would drive a location below zero is refused outright ("short") rather
 * than clamped: the stock has genuinely moved on, and silently absorbing the shortfall
 * would put a number in the system that nobody counted.
 */
export async function applyUndo(sql: Sql, m: MoveRow): Promise<UndoRefusal> {
  if (m.type === "count") {
    const [newest] = await sql`
      select id from moves where item_id = ${m.item_id} order by ts desc, id desc limit 1`;
    if (Number(newest.id) !== Number(m.id)) return { reason: "superseded" };
  } else {
    const [counted] = await sql`
      select id from moves
      where item_id = ${m.item_id} and type = 'count'
        and (ts, id) > (${m.ts}::timestamptz, ${m.id}::bigint)
      limit 1`;
    if (counted) return { reason: "counted" };
  }

  // Each branch refuses rather than going negative; `returning id` coming back
  // empty is how that surfaces. The `else ${qty}` fallbacks make the guard
  // trivially true for the locations a given move type never subtracts from.
  let applied;
  if (m.type === "give") {
    applied = await sql`
      update items set
        store = store + ${m.qty},
        patio = patio - case when ${m.loc}::text = 'patio' then ${m.qty}::numeric else 0 end,
        back  = back  - case when ${m.loc}::text = 'back'  then ${m.qty}::numeric else 0 end
      where id = ${m.item_id}
        and case ${m.loc}::text
              when 'patio' then patio when 'back' then back else ${m.qty}::numeric
            end >= ${m.qty}
      returning id`;
  } else if (m.type === "receive") {
    applied = await sql`
      update items set store = store - ${m.qty}
      where id = ${m.item_id} and store >= ${m.qty}
      returning id`;
  } else if (m.type === "waste") {
    // Putting wasted stock back can never go negative.
    applied = await sql`
      update items set
        store = store + case when ${m.loc}::text = 'store' then ${m.qty}::numeric else 0 end,
        patio = patio + case when ${m.loc}::text = 'patio' then ${m.qty}::numeric else 0 end,
        back  = back  + case when ${m.loc}::text = 'back'  then ${m.qty}::numeric else 0 end
      where id = ${m.item_id}
      returning id`;
  } else if (m.type === "transfer") {
    applied = await sql`
      update items set
        store = store + case when ${m.loc}::text = 'store' then ${m.qty}::numeric else 0 end
                      - case when ${m.to_loc}::text = 'store' then ${m.qty}::numeric else 0 end,
        patio = patio + case when ${m.loc}::text = 'patio' then ${m.qty}::numeric else 0 end
                      - case when ${m.to_loc}::text = 'patio' then ${m.qty}::numeric else 0 end,
        back  = back  + case when ${m.loc}::text = 'back'  then ${m.qty}::numeric else 0 end
                      - case when ${m.to_loc}::text = 'back'  then ${m.qty}::numeric else 0 end
      where id = ${m.item_id}
        and case ${m.to_loc}::text
              when 'store' then store when 'patio' then patio when 'back' then back
              else ${m.qty}::numeric
            end >= ${m.qty}
      returning id`;
  } else {
    // A count restores the figure that was true before it, so it is always safe.
    applied = await sql`
      update items set
        store = case when ${m.loc}::text = 'store' then ${m.from_val} else store end,
        patio = case when ${m.loc}::text = 'patio' then ${m.from_val} else patio end,
        back  = case when ${m.loc}::text = 'back'  then ${m.from_val} else back  end
      where id = ${m.item_id}
      returning id`;
  }

  if (!applied.length) return { reason: "short" };

  // Reversing a bar's total says nothing about how it splits across bottles - even
  // undoing a bottle-by-bottle count only restores the scalar - so any bar this move
  // touched loses its breakdown. Done once here rather than in all five branches.
  await sql`
    update items set
      patio_levels = case when 'patio' in (coalesce(${m.loc}::text, ''), coalesce(${m.to_loc}::text, ''))
                          then '{}'::numeric[] else patio_levels end,
      back_levels  = case when 'back'  in (coalesce(${m.loc}::text, ''), coalesce(${m.to_loc}::text, ''))
                          then '{}'::numeric[] else back_levels end
    where id = ${m.item_id}`;

  await sql`delete from moves where id = ${m.id}`;
  return null;
}
