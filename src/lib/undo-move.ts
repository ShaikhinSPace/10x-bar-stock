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
  /** false only on paperwork-only delivery receives; everything else is a real stock move. */
  affects_stock?: boolean | null;
};

/** null means it worked; anything else is why it was refused. */
export type UndoRefusal =
  | { reason: "counted" }
  | { reason: "superseded" }
  | { reason: "short" }
  | { reason: "gone" }
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
 * nothing was logged after it on that bottle ("superseded"). Both checks are by id —
 * logging order — not by ts: the day editor backdates `ts` to a chosen business day,
 * so a count logged after a give has the newer id but may have the older ts. Judging
 * by ts there would let a backdated count sit silently on top of a give and let its
 * undo pass this guard, leaving the stock at a figure nobody counted.
 *
 * A paperwork-only receive (affects_stock = false) never moved stock, so no later
 * count depends on its figure — the counted-guard is skipped and it stays undoable.
 *
 * Anything that would drive a location below zero is refused outright ("short") rather
 * than clamped: the stock has genuinely moved on, and silently absorbing the shortfall
 * would put a number in the system that nobody counted.
 *
 * Atomic: the move is deleted and the stock reversed in ONE statement. The delete
 * carries the guard, the update runs only if the delete took a row, and a second
 * concurrent undo of the same move blocks on the row lock, finds it gone, and does
 * nothing - so a double tap can never reverse a move twice.
 */
export async function applyUndo(sql: Sql, m: MoveRow): Promise<UndoRefusal> {
  if (m.type === "count") {
    const [later] = await sql`
      select 1 as ok from moves where item_id = ${m.item_id} and id > ${m.id}::bigint limit 1`;
    if (later) return { reason: "superseded" };
  } else if (m.affects_stock !== false) {
    const [counted] = await sql`
      select id from moves
      where item_id = ${m.item_id} and type = 'count' and id > ${m.id}::bigint
      limit 1`;
    if (counted) return { reason: "counted" };
  }

  // Each branch refuses rather than going negative: its delete's guard fails, nothing is
  // deleted, the update sees an empty `del`, and `returning id` comes back empty. The
  // `else ${qty}` fallbacks make a guard trivially true for locations a move never
  // subtracts from. Reversing a bar's total says nothing about how it splits across
  // bottles, so any bar the move touched also loses its breakdown, in the same update.
  let applied;
  if (m.type === "give") {
    applied = await sql`
      with del as (
        delete from moves where id = ${m.id}::bigint
          and exists (select 1 from items where id = ${m.item_id}
            and case ${m.loc}::text
                  when 'patio' then patio when 'back' then back else ${m.qty}::numeric
                end >= ${m.qty})
        returning id
      )
      update items set
        store = store + ${m.qty},
        patio = patio - case when ${m.loc}::text = 'patio' then ${m.qty}::numeric else 0 end,
        back  = back  - case when ${m.loc}::text = 'back'  then ${m.qty}::numeric else 0 end,
        patio_levels = case when ${m.loc}::text = 'patio' then '{}'::numeric[] else patio_levels end,
        back_levels  = case when ${m.loc}::text = 'back'  then '{}'::numeric[] else back_levels  end
      where id = ${m.item_id} and exists (select 1 from del)
      returning id`;
  } else if (m.type === "receive") {
    // A receive lands where m.loc says: the storeroom (a delivery, or loc null on old
    // rows) or, via the owner's day editor, straight onto a bar. Take it back from there.
    // Paperwork-only delivery lines (affects_stock = false) never moved stock in the
    // first place, so the undo just deletes the row — the item stays untouched, and
    // the guard that stops a real undo going negative has nothing to check.
    if (m.affects_stock === false) {
      applied = await sql`delete from moves where id = ${m.id}::bigint returning id`;
    } else {
      applied = await sql`
        with del as (
          delete from moves where id = ${m.id}::bigint
            and exists (select 1 from items where id = ${m.item_id}
              and case coalesce(${m.loc}::text, 'store')
                    when 'patio' then patio when 'back' then back else store
                  end >= ${m.qty})
          returning id
        )
        update items set
          store = store - case when coalesce(${m.loc}::text, 'store') = 'store' then ${m.qty}::numeric else 0 end,
          patio = patio - case when ${m.loc}::text = 'patio' then ${m.qty}::numeric else 0 end,
          back  = back  - case when ${m.loc}::text = 'back'  then ${m.qty}::numeric else 0 end,
          patio_levels = case when ${m.loc}::text = 'patio' then '{}'::numeric[] else patio_levels end,
          back_levels  = case when ${m.loc}::text = 'back'  then '{}'::numeric[] else back_levels  end
        where id = ${m.item_id} and exists (select 1 from del)
        returning id`;
    }
  } else if (m.type === "waste") {
    // Putting wasted stock back can never go negative.
    applied = await sql`
      with del as (delete from moves where id = ${m.id}::bigint returning id)
      update items set
        store = store + case when ${m.loc}::text = 'store' then ${m.qty}::numeric else 0 end,
        patio = patio + case when ${m.loc}::text = 'patio' then ${m.qty}::numeric else 0 end,
        back  = back  + case when ${m.loc}::text = 'back'  then ${m.qty}::numeric else 0 end,
        patio_levels = case when ${m.loc}::text = 'patio' then '{}'::numeric[] else patio_levels end,
        back_levels  = case when ${m.loc}::text = 'back'  then '{}'::numeric[] else back_levels  end
      where id = ${m.item_id} and exists (select 1 from del)
      returning id`;
  } else if (m.type === "transfer") {
    applied = await sql`
      with del as (
        delete from moves where id = ${m.id}::bigint
          and exists (select 1 from items where id = ${m.item_id}
            and case ${m.to_loc}::text
                  when 'store' then store when 'patio' then patio when 'back' then back
                  else ${m.qty}::numeric
                end >= ${m.qty})
        returning id
      )
      update items set
        store = store + case when ${m.loc}::text = 'store' then ${m.qty}::numeric else 0 end
                      - case when ${m.to_loc}::text = 'store' then ${m.qty}::numeric else 0 end,
        patio = patio + case when ${m.loc}::text = 'patio' then ${m.qty}::numeric else 0 end
                      - case when ${m.to_loc}::text = 'patio' then ${m.qty}::numeric else 0 end,
        back  = back  + case when ${m.loc}::text = 'back'  then ${m.qty}::numeric else 0 end
                      - case when ${m.to_loc}::text = 'back'  then ${m.qty}::numeric else 0 end,
        patio_levels = case when 'patio' in (coalesce(${m.loc}::text, ''), coalesce(${m.to_loc}::text, ''))
                            then '{}'::numeric[] else patio_levels end,
        back_levels  = case when 'back'  in (coalesce(${m.loc}::text, ''), coalesce(${m.to_loc}::text, ''))
                            then '{}'::numeric[] else back_levels end
      where id = ${m.item_id} and exists (select 1 from del)
      returning id`;
  } else {
    // A count restores the figure that was true before it, so it is always safe.
    applied = await sql`
      with del as (delete from moves where id = ${m.id}::bigint returning id)
      update items set
        store = case when ${m.loc}::text = 'store' then ${m.from_val} else store end,
        patio = case when ${m.loc}::text = 'patio' then ${m.from_val} else patio end,
        back  = case when ${m.loc}::text = 'back'  then ${m.from_val} else back  end,
        patio_levels = case when ${m.loc}::text = 'patio' then '{}'::numeric[] else patio_levels end,
        back_levels  = case when ${m.loc}::text = 'back'  then '{}'::numeric[] else back_levels  end
      where id = ${m.item_id} and exists (select 1 from del)
      returning id`;
  }

  if (applied.length) return null;
  // Nothing applied: either the guard refused, or a concurrent undo got there first.
  const [left] = await sql`select 1 as ok from moves where id = ${m.id}::bigint`;
  return left ? { reason: "short" } : { reason: "gone" };
}
