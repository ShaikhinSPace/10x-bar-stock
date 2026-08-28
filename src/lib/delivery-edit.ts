// The one statement that rewrites a booked delivery.
//
// Kept out of db.ts (and so free of "server-only") purely so scripts/check-delivery-edit.mjs
// can run this exact SQL against a real database. Duplicating it into the test would
// mean testing a copy, and this is the part where the risk actually lives.

/** Just enough of the neon tagged-template to type this file with no dependency on it. */
type Sql = (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<Record<string, unknown>[]>;

export type DeliveryEdit = {
  batch: string;
  /** Item ids, deduped, aligned with `qtys`. */
  ids: number[];
  qtys: number[];
  invoice: string;
  supplier: string | null;
};

/**
 * Rewrite the lines of one delivery and move the storeroom by the difference.
 *
 * A delivery is the set of `receive` moves sharing a batch id, and each already added
 * its qty to the storeroom. So the correction is arithmetic: per bottle, store shifts
 * by (new qty - old qty). A dropped line contributes -old, a new line +new, and an
 * untouched number contributes nothing.
 *
 * Everything hangs off the `ok` CTE, which is empty unless the whole edit is legal.
 * Filtering the UPDATE instead would let some bottles move while others were rejected
 * while the DELETE still fired - losing the delivery outright. This way an illegal
 * edit writes nothing at all.
 *
 * Returns the rewritten rows; fewer than `ids.length` means it was rejected and
 * nothing was written.
 */
export function applyDeliveryEdit(sql: Sql, e: DeliveryEdit) {
  return sql`
    with fresh as (
      select * from unnest(${e.ids}::int[], ${e.qtys}::numeric[]) as t(item_id, qty)
    ), old as (
      select item_id, sum(qty) as qty from moves where batch = ${e.batch} group by item_id
    ), delta as (
      select coalesce(f.item_id, o.item_id) as item_id,
             coalesce(f.qty, 0) - coalesce(o.qty, 0) as d
      from fresh f full outer join old o on o.item_id = f.item_id
    ), ok as (
      select 1 where
        -- the invoice belongs to no other delivery
        not exists (
          select 1 from moves where invoice = ${e.invoice} and batch is distinct from ${e.batch}
        )
        -- and every bottle still exists, is unarchived, and stays at or above zero
        and not exists (
          select 1 from delta d
          left join items i on i.id = d.item_id and not i.archived
          where i.id is null or i.store + d.d < 0
        )
    ), orig as (
      select min(ts) as ts, min(user_id) as user_id, min(user_name) as user_name
      from moves where batch = ${e.batch}
    ), upd as (
      update items i set store = i.store + d.d
      from delta d, ok
      where i.id = d.item_id
      returning i.id
    ), del as (
      delete from moves m using ok, upd where m.batch = ${e.batch} returning m.id
    )
    insert into moves
      (type, item_id, item_name, cat, qty, loc, user_id, user_name, batch, invoice, supplier, ts)
    select 'receive', i.id, i.name, i.cat, f.qty, 'store',
           orig.user_id, orig.user_name, ${e.batch}, ${e.invoice}, ${e.supplier}, orig.ts
    from fresh f
    join items i on i.id = f.item_id
    cross join orig
    cross join ok
    returning id`;
}
