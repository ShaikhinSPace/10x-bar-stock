// Proves the owner's "add a past entry" applies stock correctly and backdates the move.
//
// A correction is a real move: a backdated receive raises the store, a backdated give
// lowers it and can't drive it negative (same guard as giveOut), and both stamp the
// chosen timestamp so the entry buckets on the night it belongs to. Replicates the two
// statements addEntry runs (they're inline in the action) against the real database.
//
//   node --env-file=.env.local scripts/check-add-entry.mjs

import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);
const TAG = `__addentry_${Date.now()}__`;
const round = (n) => Math.round(Number(n) * 100) / 100;
const [{ id: uid, name: uname }] = await sql`select id, name from users limit 1`;
const made = [];

async function bottle(name, store, patio = 0) {
  const [r] = await sql`insert into items (name, cat, store, patio, back, rl, patio_levels)
    values (${TAG + name}, 'WHISKEY', ${store}, ${patio}, 0, 2, ${patio > 0 ? [patio] : []}::numeric[])
    returning id`;
  made.push(r.id);
  return r.id;
}
async function at(id) {
  const [r] = await sql`select store, patio, back, patio_levels from items where id = ${id}`;
  return { store: round(r.store), patio: round(r.patio), levels: (r.patio_levels ?? []).map(Number) };
}
async function lastMove(id) {
  const [r] = await sql`select type, qty, loc, ts from moves where item_id = ${id} order by id desc limit 1`;
  return r;
}

async function receiveEntry(id, q, tsIso) {
  return sql`with prev as (select id,name,cat from items where id=${id} and not archived), upd as (
      update items set store = store + ${q} where id=${id} and not archived returning id)
    insert into moves (type,item_id,item_name,cat,qty,loc,user_id,user_name,ts)
    select 'receive',prev.id,prev.name,prev.cat,${q},'store',${uid},${uname},${tsIso}
    from prev join upd on upd.id=prev.id returning id`;
}
// A STORE count records NOW (ts defaults to now()); it's absolute, so it isn't backdated.
async function countEntry(id, v) {
  return sql`with prev as (select id,name,cat, store as v from items where id=${id} and not archived), upd as (
      update items set store = ${v}::numeric where id=${id} and not archived returning id)
    insert into moves (type,item_id,item_name,cat,loc,from_val,to_val,user_id,user_name)
    select 'count',prev.id,prev.name,prev.cat,'store',prev.v,${v},${uid},${uname}
    from prev join upd on upd.id=prev.id returning id`;
}
async function giveEntry(id, q, to, tsIso) {
  return sql`with prev as (select id,name,cat from items where id=${id} and not archived), upd as (
      update items set store = store - ${q},
        patio = patio + case when ${to}::text='patio' then ${q}::numeric else 0 end,
        back  = back  + case when ${to}::text='back'  then ${q}::numeric else 0 end,
        patio_levels = case when ${to}::text='patio' then '{}'::numeric[] else patio_levels end,
        back_levels  = case when ${to}::text='back'  then '{}'::numeric[] else back_levels  end
      where id=${id} and not archived and store >= ${q} returning id)
    insert into moves (type,item_id,item_name,cat,qty,loc,user_id,user_name,ts)
    select 'give',prev.id,prev.name,prev.cat,${q},${to}::text,${uid},${uname},${tsIso}
    from prev join upd on upd.id=prev.id returning id`;
}

let fails = 0;
const check = (label, fn) => fn().then(
  () => console.log("  ok   " + label),
  (e) => { fails++; console.error(`  FAIL ${label}\n       ${e.message}`); });

const PAST = new Date("2026-03-14T20:00:00").toISOString();
try {
  await check("backdated receive raises the store and stamps the date", async () => {
    const a = await bottle("recv", 5);
    const rows = await receiveEntry(a, 3, PAST);
    assert.equal(rows.length, 1);
    assert.equal((await at(a)).store, 8);
    const m = await lastMove(a);
    assert.equal(m.type, "receive");
    assert.equal(new Date(m.ts).toISOString(), PAST, "ts backdated");
  });

  await check("backdated give lowers store, raises bar, drops the breakdown", async () => {
    const a = await bottle("give", 6, 1.5); // patio starts with a known open bottle
    const rows = await giveEntry(a, 2, "patio", PAST);
    assert.equal(rows.length, 1);
    const s = await at(a);
    assert.deepEqual({ store: s.store, patio: s.patio }, { store: 4, patio: 3.5 });
    assert.deepEqual(s.levels, [], "breakdown dropped to unknown");
    assert.equal((await lastMove(a)).type, "give");
  });

  await check("backdated give can't oversell the storeroom", async () => {
    const a = await bottle("short", 1);
    const rows = await giveEntry(a, 5, "patio", PAST);
    assert.equal(rows.length, 0, "refused");
    assert.deepEqual(await at(a), { store: 1, patio: 0, levels: [] }, "untouched");
  });

  await check("store count sets the store and records the drop (consumed)", async () => {
    const a = await bottle("count", 8); // store starts at 8
    const rows = await countEntry(a, 5);
    assert.equal(rows.length, 1);
    assert.equal((await at(a)).store, 5, "store set to the count");
    const [m] = await sql`select type, loc, from_val, to_val from moves where item_id=${a} order by id desc limit 1`;
    assert.equal(m.type, "count");
    assert.equal(m.loc, "store");
    assert.equal(round(m.from_val) - round(m.to_val), 3, "consumed = from - to = 3");
  });

  console.log(fails ? `\n${fails} failed` : "\nall add-entry checks passed");
} finally {
  if (made.length) {
    await sql`delete from moves where item_id = any(${made}::int[])`;
    await sql`delete from items where id = any(${made}::int[])`;
  }
}
process.exit(fails ? 1 : 0);
