// Exercises the SQL the Server Actions rely on, against the real database, then cleans up.
// It checks database semantics (the CTE read-before-write pattern and the CHECK
// constraints), not the action wrappers — those need a Next request context.
//
//   node --env-file=.env.local scripts/check.mjs

import { neon } from "@neondatabase/serverless";
import assert from "node:assert/strict";

const sql = neon(process.env.DATABASE_URL);
const NAME = `__check_${Date.now()}`;
let userId;

const val = async (id, loc) => {
  const [r] = await sql`select store, patio, back from items where id = ${id}`;
  return Number(r[loc]);
};

try {
  [{ id: userId }] = await sql`
    insert into users (username, name, password_hash, role)
    values (${NAME}, 'Check Runner', 'x', 'staff') returning id`;
  const [{ id }] = await sql`
    insert into items (name, cat, store, rl) values (${NAME}, 'WHISKEY', 10, 2) returning id`;

  // --- give out: store down, bar up, one move logged, all in one statement ---
  let rows = await sql`
    with prev as (select id, name, cat from items where id = ${id} and not archived),
    upd as (
      update items set
        store = store - 3,
        patio = patio + case when 'patio'::text = 'patio' then 3 else 0 end
      where id = ${id} and not archived and store >= 3 returning id
    )
    insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name)
    select 'give', prev.id, prev.name, prev.cat, 3, 'patio', ${userId}, 'Check Runner'
    from prev join upd on upd.id = prev.id returning id`;
  assert.equal(rows.length, 1, "give should log exactly one move");
  assert.equal(await val(id, "store"), 7, "store should drop to 7");
  assert.equal(await val(id, "patio"), 3, "patio should rise to 3");

  // --- overdraw is refused, and logs nothing ---
  rows = await sql`
    with prev as (select id, name, cat from items where id = ${id} and not archived),
    upd as (
      update items set store = store - 99
      where id = ${id} and not archived and store >= 99 returning id
    )
    insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name)
    select 'give', prev.id, prev.name, prev.cat, 99, 'patio', ${userId}, 'Check Runner'
    from prev join upd on upd.id = prev.id returning id`;
  assert.equal(rows.length, 0, "overdraw must insert no move");
  assert.equal(await val(id, "store"), 7, "overdraw must not change store");

  // --- count at a bar keeps 2dp, and records the pre-update value ---
  rows = await sql`
    with prev as (
      select id, name, cat,
             case 'patio'::text when 'store' then store when 'patio' then patio else back end as v
      from items where id = ${id} and not archived
    ), upd as (
      update items set patio = 1.75 where id = ${id} and not archived returning id
    )
    insert into moves (type, item_id, item_name, cat, loc, from_val, to_val, user_id, user_name)
    select 'count', prev.id, prev.name, prev.cat, 'patio', prev.v, 1.75, ${userId}, 'Check Runner'
    from prev join upd on upd.id = prev.id returning id, from_val, to_val`;
  assert.equal(rows.length, 1, "count should log one move");
  assert.equal(Number(rows[0].from_val), 3, "count must log the value from BEFORE the update");
  assert.equal(await val(id, "patio"), 1.75, "bars must keep partial bottles");

  // --- undo that count puts the bar back ---
  await sql`update items set patio = ${rows[0].from_val} where id = ${id}`;
  assert.equal(await val(id, "patio"), 3, "undo should restore the previous count");

  // --- constraints: store stays whole and nothing goes negative ---
  await assert.rejects(
    () => sql`update items set store = 2.5 where id = ${id}`,
    /violates check constraint/, "store must reject a fractional count"
  );
  await assert.rejects(
    () => sql`update items set back = -1 where id = ${id}`,
    /violates check constraint/, "counts must reject negatives"
  );
  await assert.rejects(
    () => sql`insert into items (name, cat) values (${NAME + "_x"}, 'NOT_A_CAT')`,
    /violates check constraint/, "category must be one of the nine"
  );

  console.log("all checks passed");
} finally {
  await sql`delete from moves where item_name = ${NAME}`;
  await sql`delete from items where name like ${NAME + "%"}`;
  if (userId) await sql`delete from users where id = ${userId}`;
}
