// Exercises the SQL the Server Actions rely on, against the real database, then cleans up.
// It checks database semantics (the CTE read-before-write pattern and the CHECK
// constraints), not the action wrappers — those need a Next request context.
//
//   node --env-file=.env.local scripts/check.mjs

import { neon } from "@neondatabase/serverless";
import assert from "node:assert/strict";

const sql = neon(process.env.DATABASE_URL);
const NAME  = `__check_${Date.now()}`;
const NAME2 = `${NAME}_a`;
const NAME3 = `${NAME}_b`;
const BATCH = `${NAME}_batch`;
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
  const countRows = await sql`
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
  assert.equal(countRows.length, 1, "count should log one move");
  assert.equal(Number(countRows[0].from_val), 3, "count must log the value from BEFORE the update");
  assert.equal(await val(id, "patio"), 1.75, "bars must keep partial bottles");

  // --- waste: subtracts from specified location and logs notes ---
  rows = await sql`
    with prev as (select id, name, cat from items where id = ${id} and not archived),
    upd as (
      update items set patio = patio - 0.5
      where id = ${id} and not archived and patio >= 0.5 returning id
    )
    insert into moves (type, item_id, item_name, cat, qty, loc, notes, user_id, user_name)
    select 'waste', prev.id, prev.name, prev.cat, 0.5, 'patio', 'Spill / Breakage', ${userId}, 'Check Runner'
    from prev join upd on upd.id = prev.id returning id`;
  assert.equal(rows.length, 1, "waste should log one move");
  assert.equal(await val(id, "patio"), 1.25, "patio should drop to 1.25 after 0.5 waste");

  // --- transfer: moves stock between patio and back bar ---
  rows = await sql`
    with prev as (select id, name, cat from items where id = ${id} and not archived),
    upd as (
      update items set patio = patio - 0.25, back = back + 0.25
      where id = ${id} and not archived and patio >= 0.25 returning id
    )
    insert into moves (type, item_id, item_name, cat, qty, loc, to_loc, user_id, user_name)
    select 'transfer', prev.id, prev.name, prev.cat, 0.25, 'patio', 'back', ${userId}, 'Check Runner'
    from prev join upd on upd.id = prev.id returning id`;
  assert.equal(rows.length, 1, "transfer should log one move");
  assert.equal(await val(id, "patio"), 1.0, "patio should drop to 1.0");
  assert.equal(await val(id, "back"), 0.25, "back should rise to 0.25");

  // --- getMoves query check for to_loc and notes ---
  const [latestMove] = await sql`
    select id, type, loc, to_loc, notes from moves where item_id = ${id} order by id desc limit 1`;
  assert.equal(latestMove.type, "transfer");
  assert.equal(latestMove.to_loc, "back");

  // --- undo that count puts the bar back ---
  await sql`update items set patio = ${countRows[0].from_val}, back = 0 where id = ${id}`;
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
    /violates foreign key constraint/, "category must exist in the categories table"
  );

  // --- a delivery books every line in one atomic statement ---
  const [{ id: d1 }] = await sql`
    insert into items (name, cat, store) values (${NAME2}, 'GIN', 1) returning id`;
  const [{ id: d2 }] = await sql`
    insert into items (name, cat, store) values (${NAME3}, 'BEER', 10) returning id`;

  const ids = [d1, d2, d1];            // d1 twice — the action merges duplicates
  const qtys = [3, 24, 2];
  const merged = new Map();
  ids.forEach((id, n) => merged.set(id, (merged.get(id) ?? 0) + qtys[n]));

  const booked = await sql`
    with lines as (
      select * from unnest(${[...merged.keys()]}::int[], ${[...merged.values()]}::numeric[])
        as t(item_id, qty)
    ), upd as (
      update items i set store = i.store + l.qty
      from lines l where i.id = l.item_id and not i.archived
      returning i.id, i.name, i.cat, l.qty
    )
    insert into moves
      (type, item_id, item_name, cat, qty, loc, user_id, user_name, batch, invoice, supplier)
    select 'receive', upd.id, upd.name, upd.cat, upd.qty, 'store',
           ${userId}, 'Check Runner', ${BATCH}, 'INV-1', 'Acme'
    from upd returning id`;

  assert.equal(booked.length, 2, "a duplicated line must merge, not double-insert");
  assert.equal(await val(d1, "store"), 6, "1 + 3 + 2 = 6 after merging duplicate lines");
  assert.equal(await val(d2, "store"), 34, "10 + 24 = 34");
  const tagged = await sql`select count(*) c from moves where batch = ${BATCH}`;
  assert.equal(Number(tagged[0].c), 2, "every line of a delivery shares one batch id");

  // --- the same invoice cannot be booked twice (that would inflate stock silently) ---
  const before = await val(d2, "store");
  const second = await sql`
    with guard as (
      select 1 where not exists (select 1 from moves where invoice = ${"INV-1"})
    ), lines as (
      select * from unnest(${[d2]}::int[], ${[99]}::numeric[]) as t(item_id, qty)
    ), upd as (
      update items i set store = i.store + l.qty
      from lines l, guard
      where i.id = l.item_id and not i.archived
      returning i.id, i.name, i.cat, l.qty
    )
    insert into moves
      (type, item_id, item_name, cat, qty, loc, user_id, user_name, batch, invoice)
    select 'receive', upd.id, upd.name, upd.cat, upd.qty, 'store',
           ${userId}, 'Check Runner', ${BATCH + "_dupe"}, ${"INV-1"}
    from upd returning id`;
  assert.equal(second.length, 0, "re-booking a used invoice must insert nothing");
  assert.equal(await val(d2, "store"), before, "a rejected re-book must not change stock");

  // --- a delivery rebuilds from its batch, lines and all ---
  const [grouped] = await sql`
    select invoice, supplier, sum(qty) as bottles, count(*) as n,
           json_agg(json_build_object('item', item_name, 'qty', qty) order by item_name) as lines
    from moves where batch = ${BATCH} group by invoice, supplier`;
  assert.equal(grouped.invoice, "INV-1", "the delivery keeps its invoice number");
  assert.equal(Number(grouped.bottles), 29, "3 + 2 merged, plus 24 = 29 bottles");
  assert.equal(grouped.lines.length, 2, "both lines come back with the delivery");

  // --- a stocktake writes only what moved, and never touches uncounted rows ---
  await sql`update items set patio = 4 where id = ${d1}`;   // expected 4
  await sql`update items set patio = 9 where id = ${d2}`;   // expected 9, will be left uncounted
  const STK = `${NAME}_stk`;
  const stk = await sql`
    with lines as (
      select * from unnest(${[d1]}::int[], ${[2.5]}::numeric[]) as t(item_id, val)
    ), prev as (
      select i.id, i.name, i.cat, l.val,
             case 'patio'::text when 'store' then i.store when 'patio' then i.patio else i.back end as was
      from items i join lines l on l.item_id = i.id where not i.archived
    ), changed as (
      select * from prev where val <> was
    ), upd as (
      update items i set patio = c.val from changed c where i.id = c.id returning i.id
    )
    insert into moves (type, item_id, item_name, cat, loc, from_val, to_val, user_id, user_name, batch)
    select 'count', c.id, c.name, c.cat, 'patio', c.was, c.val, ${userId}, 'Check Runner', ${STK}
    from changed c join upd on upd.id = c.id
    returning id`;
  assert.equal(stk.length, 1, "only the counted row is written");
  assert.equal(await val(d1, "patio"), 2.5, "a counted row takes the counted value");
  assert.equal(await val(d2, "patio"), 9, "an UNCOUNTED row must be left completely alone");
  const [logged] = await sql`select from_val, to_val from moves where batch = ${STK}`;
  assert.equal(Number(logged.from_val), 4, "variance is logged against the pre-count value");
  assert.equal(Number(logged.to_val), 2.5, "bars keep partials through a stocktake");

  // a count that matches expected writes nothing at all
  const noop = await sql`
    with lines as (
      select * from unnest(${[d1]}::int[], ${[2.5]}::numeric[]) as t(item_id, val)
    ), prev as (
      select i.id, i.name, i.cat, l.val, i.patio as was
      from items i join lines l on l.item_id = i.id where not i.archived
    ), changed as (
      select * from prev where val <> was
    ), upd as (
      update items i set patio = c.val from changed c where i.id = c.id returning i.id
    )
    insert into moves (type, item_id, item_name, cat, loc, from_val, to_val, user_id, user_name, batch)
    select 'count', c.id, c.name, c.cat, 'patio', c.was, c.val, ${userId}, 'Check Runner', ${STK + "_2"}
    from changed c join upd on upd.id = c.id
    returning id`;
  assert.equal(noop.length, 0, "a count matching expected logs nothing");

  // --- hashes written by the scripts must verify the way src/lib/auth.ts verifies ---
  // Mirrors verifyPassword() exactly; if the two drift apart, logins break silently.
  const { hashPassword } = await import("./hash.mjs");
  const { scryptSync, timingSafeEqual } = await import("node:crypto");
  const authVerify = (pw, stored) => {
    const [saltHex, keyHex] = stored.split(":");
    if (!saltHex || !keyHex) return false;
    const expected = Buffer.from(keyHex, "hex");
    return timingSafeEqual(expected, scryptSync(pw, Buffer.from(saltHex, "hex"), expected.length));
  };
  const stored = hashPassword("correct horse battery");
  assert.ok(authVerify("correct horse battery", stored), "auth.ts must accept a script-written hash");
  assert.ok(!authVerify("wrong password", stored), "a wrong password must be rejected");
  assert.notEqual(stored, hashPassword("correct horse battery"), "each hash needs its own salt");

  console.log("all checks passed");
} finally {
  const names = [NAME, NAME2, NAME3];
  await sql`delete from moves where item_name = any(${names}::text[])`;
  await sql`delete from moves where batch = any(${[BATCH, BATCH + "_dupe", `${NAME}_stk`, `${NAME}_stk_2`]}::text[])`;
  await sql`delete from items where name = any(${names}::text[])`;
  if (userId) await sql`delete from users where id = ${userId}`;
}
