// Core stock-move SQL, extracted from server actions. Each operation lives
// here once; the actions validate, call, and translate empty results into
// user-facing errors.
//
// Free of "server-only" so scripts can import the same SQL — see give-run.ts
// and undo-move.ts for the precedent.

type Sql = (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<Record<string, unknown>[]>;

type Base = {
  itemId: number;
  userId: number;
  userName: string;
  /** ISO timestamp; omit to use the database's now(). */
  ts?: string | null;
};

/**
 * Move qty whole bottles from the storeroom to a bar (or unknown bar when
 * `to` is null). Returns the inserted move rows; empty means the store was
 * short or the item is gone.
 *
 * `extendLevels` true appends full bottles to the bar's breakdown (real-time
 * give); false/omitted clears it (backdated give where composition is unknown).
 */
export function applyGive(
  sql: Sql,
  p: Base & { qty: number; to: string | null; extendLevels?: boolean },
) {
  const { itemId, qty, to, userId, userName, ts = null } = p;
  if (p.extendLevels) {
    return sql`
      with prev as (
        select id, name, cat from items where id = ${itemId} and not archived
      ), upd as (
        update items set
          store = store - ${qty},
          patio = patio + case when ${to}::text = 'patio' then ${qty}::numeric else 0 end,
          back  = back  + case when ${to}::text = 'back'  then ${qty}::numeric else 0 end,
          patio_levels = case when ${to}::text = 'patio' and cardinality(patio_levels) > 0
                              then patio_levels || array_fill(1::numeric, array[${qty}::int])
                              else patio_levels end,
          back_levels  = case when ${to}::text = 'back'  and cardinality(back_levels) > 0
                              then back_levels  || array_fill(1::numeric, array[${qty}::int])
                              else back_levels end
        where id = ${itemId} and not archived and store >= ${qty}
        returning id
      )
      insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name, ts)
      select 'give', prev.id, prev.name, prev.cat, ${qty}, ${to}::text, ${userId}, ${userName},
             coalesce(${ts}::timestamptz, now())
      from prev join upd on upd.id = prev.id
      returning id`;
  }
  return sql`
    with prev as (
      select id, name, cat from items where id = ${itemId} and not archived
    ), upd as (
      update items set
        store = store - ${qty},
        patio = patio + case when ${to}::text = 'patio' then ${qty}::numeric else 0 end,
        back  = back  + case when ${to}::text = 'back'  then ${qty}::numeric else 0 end,
        patio_levels = case when ${to}::text = 'patio' then '{}'::numeric[] else patio_levels end,
        back_levels  = case when ${to}::text = 'back'  then '{}'::numeric[] else back_levels  end
      where id = ${itemId} and not archived and store >= ${qty}
      returning id
    )
    insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name, ts)
    select 'give', prev.id, prev.name, prev.cat, ${qty}, ${to}::text, ${userId}, ${userName},
           coalesce(${ts}::timestamptz, now())
    from prev join upd on upd.id = prev.id
    returning id`;
}

/**
 * Receive qty whole bottles into a location. Returns the inserted move rows;
 * empty means the item is gone. A bar receive clears that bar's bottle
 * breakdown (new bottles' composition is unknown).
 */
export function applyReceive(sql: Sql, p: Base & { qty: number; loc: string }) {
  const { itemId, qty, loc, userId, userName, ts = null } = p;
  return sql`
    with prev as (
      select id, name, cat from items where id = ${itemId} and not archived
    ), upd as (
      update items set
        store = store + case when ${loc}::text = 'store' then ${qty}::numeric else 0 end,
        patio = patio + case when ${loc}::text = 'patio' then ${qty}::numeric else 0 end,
        back  = back  + case when ${loc}::text = 'back'  then ${qty}::numeric else 0 end,
        patio_levels = case when ${loc}::text = 'patio' then '{}'::numeric[] else patio_levels end,
        back_levels  = case when ${loc}::text = 'back'  then '{}'::numeric[] else back_levels  end
      where id = ${itemId} and not archived returning id
    )
    insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name, ts)
    select 'receive', prev.id, prev.name, prev.cat, ${qty}, ${loc}::text, ${userId}, ${userName},
           coalesce(${ts}::timestamptz, now())
    from prev join upd on upd.id = prev.id
    returning id`;
}

/**
 * Reconcile the storeroom to the counted figure. Returns the inserted move
 * rows (with from_val/to_val for the variance); empty means the item is gone.
 */
export function applyStoreCount(sql: Sql, p: Base & { value: number }) {
  const { itemId, value, userId, userName, ts = null } = p;
  return sql`
    with prev as (
      select id, name, cat, store as v from items where id = ${itemId} and not archived
    ), upd as (
      update items set store = ${value}::numeric where id = ${itemId} and not archived returning id
    )
    insert into moves (type, item_id, item_name, cat, loc, from_val, to_val, user_id, user_name, ts)
    select 'count', prev.id, prev.name, prev.cat, 'store', prev.v, ${value}, ${userId}, ${userName},
           coalesce(${ts}::timestamptz, now())
    from prev join upd on upd.id = prev.id
    returning id`;
}

/**
 * Log a move without touching stock. Used for backdated entries that predate
 * the latest count — the count already captured the reality; this records the
 * shift the move belongs to. A count log-only still reads the current store
 * for from_val so the variance figure makes sense in the activity log.
 */
export function logMoveOnly(sql: Sql, p: {
  type: "give" | "receive" | "count";
  itemId: number;
  qty?: number;
  loc: string | null;
  value?: number;
  userId: number;
  userName: string;
  ts: string;
}) {
  if (p.type === "count") {
    return sql`
      with prev as (select id, name, cat, store as v from items where id = ${p.itemId} and not archived)
      insert into moves (type, item_id, item_name, cat, loc, from_val, to_val, user_id, user_name, ts)
      select 'count', prev.id, prev.name, prev.cat, 'store', prev.v, ${p.value}, ${p.userId}, ${p.userName}, ${p.ts}
      from prev returning id`;
  }
  return sql`
    with prev as (select id, name, cat from items where id = ${p.itemId} and not archived)
    insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name, ts)
    select ${p.type}, prev.id, prev.name, prev.cat, ${p.qty}, ${p.loc}::text, ${p.userId}, ${p.userName}, ${p.ts}
    from prev returning id`;
}
