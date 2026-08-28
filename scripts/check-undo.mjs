// Proves what undo will and will not reverse.
//
// The point of the loosened rule: a barback who gives out the wrong bottle should be
// able to fix THAT entry, even after logging three more, instead of recounting the
// whole bar. That only holds because give/receive/waste/transfer are deltas and
// deltas commute - so this measures it rather than assuming it.
//
// A count is the exception. It sets an absolute figure, so pulling a delta out from
// under one would corrupt the counted number, and a count itself only reverses while
// nothing else has touched that bottle.
//
// Runs the real applyUndo - the same one the Server Action calls - against the real
// database.
//
//   node --env-file=.env.local --experimental-strip-types scripts/check-undo.mjs

import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { applyUndo } from "../src/lib/undo-move.ts";

const sql = neon(process.env.DATABASE_URL);
const TAG = `__undo_${Date.now()}__`;
const round = (n) => Math.round(Number(n) * 100) / 100;

const [{ id: userId, name: userName }] = await sql`select id, name from users limit 1`;
const made = [];

async function bottle(name, store, patio = 0, back = 0) {
  const [r] = await sql`
    insert into items (name, cat, store, patio, back, rl)
    values (${`${TAG}${name}`}, 'WHISKEY', ${store}, ${patio}, ${back}, 2) returning id`;
  made.push(r.id);
  return r.id;
}
async function at(id) {
  const [r] = await sql`select store, patio, back from items where id = ${id}`;
  return { store: round(r.store), patio: round(r.patio), back: round(r.back) };
}
/** Log a move without touching stock; the caller applies the stock change itself. */
async function log(itemId, row) {
  const [m] = await sql`
    insert into moves (type, item_id, item_name, cat, qty, loc, to_loc, from_val, to_val,
                       user_id, user_name)
    select ${row.type}, id, name, cat, ${row.qty ?? null}, ${row.loc ?? null},
           ${row.to_loc ?? null}, ${row.from_val ?? null}, ${row.to_val ?? null},
           ${userId}, ${userName}
    from items where id = ${itemId}
    returning *`;
  return m;
}
const move = async (id) => (await sql`select * from moves where id = ${id}`)[0];

try {
  /* ---- 1. an OLDER give still reverses exactly, with newer gives on top ---- */
  const a = await bottle("A", 10);
  // three gives to the patio: 2, then 3, then 1
  const g = [];
  for (const q of [2, 3, 1]) {
    await sql`update items set store = store - ${q}, patio = patio + ${q} where id = ${a}`;
    g.push(await log(a, { type: "give", qty: q, loc: "patio" }));
  }
  assert.deepEqual(await at(a), { store: 4, patio: 6, back: 0 }, "three gives should land");

  // Undo the FIRST one — two newer gives sit on top of it. The old rule refused this.
  assert.equal(await applyUndo(sql, await move(g[0].id)), null,
    "an older give must still be undoable — this is the whole point of the change");
  assert.deepEqual(await at(a), { store: 6, patio: 4, back: 0 },
    "undoing the older give must move exactly its own 2 bottles, nothing else");
  assert.equal((await sql`select count(*) n from moves where item_id = ${a}`)[0].n, "2",
    "and must remove only its own log entry");

  /* ---- 2. a count freezes everything underneath it ---- */
  const b = await bottle("B", 10);
  await sql`update items set store = store - 4, patio = patio + 4 where id = ${b}`;
  const bGive = await log(b, { type: "give", qty: 4, loc: "patio" });
  const beforeCount = await at(b);
  await sql`update items set patio = 7 where id = ${b}`;
  const bCount = await log(b, { type: "count", loc: "patio", from_val: 4, to_val: 7 });

  assert.deepEqual(await applyUndo(sql, await move(bGive.id)), { reason: "counted" },
    "a give from before a count must be refused, not silently unwound");
  assert.deepEqual(await at(b), { store: 6, patio: 7, back: 0 },
    "a refused undo must not move any stock");

  // The count itself reverses while it is still the last word.
  assert.equal(await applyUndo(sql, await move(bCount.id)), null, "the newest count reverses");
  assert.deepEqual(await at(b), beforeCount, "undoing a count restores the figure before it");
  // And now the give underneath is free again.
  assert.equal(await applyUndo(sql, await move(bGive.id)), null,
    "with the count gone the give is undoable again");
  assert.deepEqual(await at(b), { store: 10, patio: 0, back: 0 });

  /* ---- 3. a count that is no longer the last word will not reverse ---- */
  const c = await bottle("C", 10);
  await sql`update items set store = 8 where id = ${c}`;
  const cCount = await log(c, { type: "count", loc: "store", from_val: 10, to_val: 8 });
  await sql`update items set store = store - 1, patio = patio + 1 where id = ${c}`;
  await log(c, { type: "give", qty: 1, loc: "patio" });

  assert.deepEqual(await applyUndo(sql, await move(cCount.id)), { reason: "superseded" },
    "a count with something logged after it must be refused");
  assert.deepEqual(await at(c), { store: 7, patio: 1, back: 0 }, "and must change nothing");

  /* ---- 4. work on ANOTHER bottle never blocks an undo ---- */
  const d = await bottle("D", 10);
  await sql`update items set store = store - 3, patio = patio + 3 where id = ${d}`;
  const dGive = await log(d, { type: "give", qty: 3, loc: "patio" });
  // plenty of unrelated activity, including a count, on a different bottle
  const e = await bottle("E", 10);
  await sql`update items set store = 5 where id = ${e}`;
  await log(e, { type: "count", loc: "store", from_val: 10, to_val: 5 });

  assert.equal(await applyUndo(sql, await move(dGive.id)), null,
    "another bottle's count must not block this one — the old UI hid the link for this");
  assert.deepEqual(await at(d), { store: 10, patio: 0, back: 0 });

  /* ---- 5. undo refuses rather than going negative ---- */
  const f = await bottle("F", 10);
  await sql`update items set store = store - 5, patio = patio + 5 where id = ${f}`;
  const fGive = await log(f, { type: "give", qty: 5, loc: "patio" });
  // the patio drank most of it before anyone noticed the mistake
  await sql`update items set patio = 1 where id = ${f}`;
  const short = await at(f);

  assert.deepEqual(await applyUndo(sql, await move(fGive.id)), { reason: "short" },
    "undo must refuse when the bar cannot hand the bottles back");
  assert.deepEqual(await at(f), short, "and must leave the stock exactly as it was");
  assert.equal((await sql`select count(*) n from moves where id = ${fGive.id}`)[0].n, "1",
    "a refused undo must not delete the entry either");

  /* ---- 6. receive, waste and transfer all reverse ---- */
  const h = await bottle("H", 10, 4, 2);

  await sql`update items set store = store + 6 where id = ${h}`;
  const rec = await log(h, { type: "receive", qty: 6, loc: "store" });
  assert.equal(await applyUndo(sql, await move(rec.id)), null);
  assert.deepEqual(await at(h), { store: 10, patio: 4, back: 2 }, "receive reverses");

  await sql`update items set patio = patio - 1.5 where id = ${h}`;
  const wst = await log(h, { type: "waste", qty: 1.5, loc: "patio" });
  assert.equal(await applyUndo(sql, await move(wst.id)), null);
  assert.deepEqual(await at(h), { store: 10, patio: 4, back: 2 }, "waste reverses");

  await sql`update items set patio = patio - 2, back = back + 2 where id = ${h}`;
  const trf = await log(h, { type: "transfer", qty: 2, loc: "patio", to_loc: "back" });
  assert.equal(await applyUndo(sql, await move(trf.id)), null);
  assert.deepEqual(await at(h), { store: 10, patio: 4, back: 2 }, "transfer reverses");

  /* ---- 7. undoing a bar move drops that bar's bottle breakdown ---- */
  const k = await bottle("K", 10);
  await sql`update items set patio = 3, patio_levels = '{1,1,1}'::numeric[] where id = ${k}`;
  await sql`update items set store = store - 1, patio = patio + 1,
                             patio_levels = patio_levels || 1::numeric where id = ${k}`;
  const kGive = await log(k, { type: "give", qty: 1, loc: "patio" });
  assert.equal(await applyUndo(sql, await move(kGive.id)), null);
  const [lv] = await sql`select patio_levels, back_levels from items where id = ${k}`;
  assert.deepEqual(lv.patio_levels, [],
    "the patio breakdown must be cleared — a reversed total says nothing about the split");
  assert.deepEqual(lv.back_levels, [], "and an untouched bar keeps its empty breakdown");

  console.log(
    "undo ok - an older give reverses exactly with newer gives on top; a count freezes "
    + "what is under it and only reverses while it is the last word; another bottle's "
    + "activity never blocks; receive/waste/transfer all reverse; refused undos move "
    + "no stock and delete no entry"
  );
} finally {
  if (made.length) {
    await sql`delete from moves where item_id = any(${made})`;
    await sql`delete from items where id = any(${made})`;
  }
}
