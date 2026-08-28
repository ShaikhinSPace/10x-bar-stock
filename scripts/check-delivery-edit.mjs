// Proves the arithmetic behind editing a booked delivery.
//
// A delivery is not a row - it is the `receive` moves sharing a batch id, and each
// already added its qty to the storeroom. So a correction has to move store by the
// DIFFERENCE, never the whole amount. Get that wrong and every edit silently inflates
// or drains stock, which is the one failure this app cannot afford.
//
// The rewrite also has to be all-or-nothing. It deletes the old lines and inserts new
// ones in the same statement; if the guard let it half-apply, a rejected edit would
// delete a delivery and put nothing back.
//
// This runs the real statement - imported from src/lib/delivery-edit.ts, the same one
// the Server Action calls - against the real database.
//
//   node --env-file=.env.local --experimental-strip-types scripts/check-delivery-edit.mjs

import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { applyDeliveryEdit } from "../src/lib/delivery-edit.ts";

const sql = neon(process.env.DATABASE_URL);
const TAG = `__deliv_${Date.now()}__`;
const round = (n) => Math.round(Number(n) * 100) / 100;

const [{ id: userId, name: userName }] = await sql`select id, name from users limit 1`;

/** store for one of our temp bottles. */
async function store(id) {
  const [r] = await sql`select store from items where id = ${id}`;
  return round(r.store);
}
/** the delivery as the UI rebuilds it: item_id -> qty, plus its paperwork. */
async function delivery(batch) {
  const rows = await sql`
    select item_id, qty, invoice, supplier, ts, user_name
    from moves where batch = ${batch} order by item_id`;
  return {
    lines: Object.fromEntries(rows.map((r) => [r.item_id, round(r.qty)])),
    invoice: rows[0]?.invoice ?? null,
    supplier: rows[0]?.supplier ?? null,
    ts: rows[0]?.ts ?? null,
    user_name: rows[0]?.user_name ?? null,
    rows: rows.length,
  };
}

const made = [];
async function bottle(name, opening) {
  const [r] = await sql`
    insert into items (name, cat, store, patio, back, rl)
    values (${`${TAG}${name}`}, 'WHISKEY', ${opening}, 0, 0, 2) returning id`;
  made.push(r.id);
  return r.id;
}

const batch = `D${TAG}`;
const otherBatch = `D${TAG}other`;

try {
  /* ---- book a delivery the way receiveDelivery does ---- */
  const a = await bottle("A", 10);
  const b = await bottle("B", 10);
  const c = await bottle("C", 10); // not in the delivery yet

  const booked = { [a]: 6, [b]: 4 };
  for (const [id, qty] of Object.entries(booked)) {
    await sql`update items set store = store + ${qty} where id = ${Number(id)}`;
    await sql`
      insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name,
                         batch, invoice, supplier)
      select 'receive', id, name, cat, ${qty}, 'store', ${userId}, ${userName},
             ${batch}, ${"INV-" + TAG}, 'Southern Glazer'
      from items where id = ${Number(id)}`;
  }
  assert.equal(await store(a), 16, "booking must add to the storeroom");
  assert.equal(await store(b), 14);
  const before = await delivery(batch);

  // A second delivery, so the duplicate-invoice guard has something to collide with.
  await sql`
    insert into moves (type, item_id, item_name, cat, qty, loc, user_id, user_name,
                       batch, invoice)
    select 'receive', id, name, cat, 1, 'store', ${userId}, ${userName},
           ${otherBatch}, ${"INV-OTHER-" + TAG}
    from items where id = ${c}`;
  await sql`update items set store = store + 1 where id = ${c}`;

  /* ---- 1. the edit moves store by the difference, not the whole amount ---- */
  // A: 6 -> 9 (+3).  B: 4 -> 4 (unchanged).  C: absent -> 5 (+5).
  let rows = await applyDeliveryEdit(sql, {
    batch, ids: [a, b, c], qtys: [9, 4, 5],
    invoice: `INV-${TAG}`, supplier: "Southern Glazer",
  });
  assert.equal(rows.length, 3, "every line should have been rewritten");
  assert.equal(await store(a), 19, "A moved by the difference (+3), not by the new total");
  assert.equal(await store(b), 14, "B did not change, so its stock must not move");
  assert.equal(await store(c), 16, "C was added to the delivery, so it gains its full qty");

  /* ---- 2. dropping a line gives its bottles back ---- */
  // A: 9 -> 9.  B: 4 -> gone (-4).  C: 5 -> 2 (-3).
  rows = await applyDeliveryEdit(sql, {
    batch, ids: [a, c], qtys: [9, 2],
    invoice: `INV-${TAG}`, supplier: null,
  });
  assert.equal(rows.length, 2);
  assert.equal(await store(a), 19, "untouched line stays put");
  assert.equal(await store(b), 10, "a dropped line must hand back exactly what it added");
  assert.equal(await store(c), 13, "a reduced line hands back the difference");

  const after = await delivery(batch);
  assert.equal(after.rows, 2, "the batch must hold exactly the lines it was left with");
  assert.deepEqual(after.lines, { [a]: 9, [c]: 2 });
  assert.equal(after.supplier, null, "clearing the supplier must stick");
  assert.equal(+new Date(after.ts), +new Date(before.ts),
    "the delivery keeps the date it was booked, not the date it was corrected");
  assert.equal(after.user_name, before.user_name, "and who booked it");

  /* ---- 3. an edit that would drive a bottle negative writes NOTHING ---- */
  // C is at 13 with 2 on this delivery; asking for 2 is fine, but drop C entirely
  // after spending it and the give-back would be legal. Instead force the failure:
  // take A from 9 down to 0 while the storeroom only has 19 - it is fine - so use a
  // bottle whose stock has since been spent.
  await sql`update items set store = 1 where id = ${c}`; // sold almost all of it
  const snapshot = { a: await store(a), c: await store(c), deliv: await delivery(batch) };

  rows = await applyDeliveryEdit(sql, {
    batch, ids: [a], qtys: [9], // dropping C would need to claw back 2 from a store of 1
    invoice: `INV-${TAG}`, supplier: null,
  });
  assert.equal(rows.length, 0, "an impossible edit must be refused");
  assert.equal(await store(a), snapshot.a, "a refused edit must not move any stock");
  assert.equal(await store(c), snapshot.c, "not even the bottle that would have gone negative");
  const untouched = await delivery(batch);
  assert.equal(untouched.rows, snapshot.deliv.rows,
    "a refused edit must leave the delivery's lines exactly as they were");
  assert.deepEqual(untouched.lines, snapshot.deliv.lines,
    "the delete and the insert must stand or fall together");

  /* ---- 4. an invoice already used by another delivery is refused, atomically ---- */
  await sql`update items set store = 20 where id = ${c}`;
  const beforeDupe = await delivery(batch);
  rows = await applyDeliveryEdit(sql, {
    batch, ids: [a], qtys: [9],
    invoice: `INV-OTHER-${TAG}`, supplier: null,
  });
  assert.equal(rows.length, 0, "a duplicate invoice must be refused");
  assert.deepEqual((await delivery(batch)).lines, beforeDupe.lines,
    "and must leave the delivery untouched");

  /* ---- 5. keeping its own invoice is not a duplicate ---- */
  rows = await applyDeliveryEdit(sql, {
    batch, ids: [a, c], qtys: [9, 2],
    invoice: `INV-${TAG}`, supplier: "Republic National",
  });
  assert.equal(rows.length, 2, "a delivery must be allowed to keep its own invoice number");
  assert.equal((await delivery(batch)).supplier, "Republic National",
    "editing only the paperwork must still save");
  assert.equal(await store(a), 19, "a paperwork-only edit must not move stock at all");

  console.log(
    "delivery edit ok - store moves by the difference on raise, drop and add; "
    + "date and booker survive a correction; refused edits (negative stock, duplicate "
    + "invoice) leave both the stock and the delivery completely untouched"
  );
} finally {
  await sql`delete from moves where batch in (${batch}, ${otherBatch})`;
  if (made.length) {
    await sql`delete from moves where item_id = any(${made})`;
    await sql`delete from items where id = any(${made})`;
  }
}
