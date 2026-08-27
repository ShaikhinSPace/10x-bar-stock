// Guards the one rule that makes the bottle breakdown trustworthy:
//
//   either the breakdown is EMPTY (nobody has counted bottle-by-bottle),
//   or it sums EXACTLY to that bar's total.
//
// A bar holds several open bottles of the same thing at different levels, so
// patio_levels/back_levels record them individually while patio/back stay the
// scalar totals every other query relies on. Two places to store one fact is
// a standing invitation to drift, so every action that moves bar stock is run
// here against the real database and the invariant re-checked afterwards.
//
//   node --env-file=.env.local --experimental-strip-types scripts/check-bottles.mjs

import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
const NAME = `__bottle_check_${Date.now()}__`;
const round = (n) => Math.round(Number(n) * 100) / 100;

const [{ id }] = await sql`
  insert into items (name, cat, store, patio, back, rl)
  values (${NAME}, 'WHISKEY', 10, 0, 0, 2) returning id`;
const [{ id: userId, name: userName }] = await sql`select id, name from users limit 1`;
const moveIds = [];

async function row() {
  const [r] = await sql`
    select patio, back, patio_levels, back_levels from items where id = ${id}`;
  return {
    patio: round(r.patio), back: round(r.back),
    patioLevels: (r.patio_levels ?? []).map(Number),
    backLevels: (r.back_levels ?? []).map(Number),
  };
}

/** The invariant, checked for both bars. */
async function assertInvariant(what) {
  const r = await row();
  for (const [loc, total, levels] of [
    ["patio", r.patio, r.patioLevels], ["back", r.back, r.backLevels],
  ]) {
    if (!levels.length) continue; // empty = "not counted bottle by bottle", always legal
    const sum = round(levels.reduce((a, n) => a + n, 0));
    assert.equal(sum, total,
      `after ${what}: ${loc} breakdown [${levels}] sums to ${sum} but the total says ${total}`);
    for (const n of levels) {
      assert.ok(n > 0 && n <= 1, `after ${what}: ${loc} has a bottle at ${n} - must be >0 and <=1`);
    }
  }
  return r;
}

const logMove = async (m) => {
  const [x] = await sql`
    insert into moves (type, item_id, item_name, cat, qty, loc, to_loc, from_val, to_val, user_id, user_name)
    values (${m.type}, ${id}, ${NAME}, 'WHISKEY', ${m.qty ?? null}, ${m.loc ?? null}, ${m.to_loc ?? null},
            ${m.from_val ?? null}, ${m.to_val ?? null}, ${userId}, ${userName}) returning id`;
  moveIds.push(x.id);
};

try {
  // --- a bottle-by-bottle count establishes the breakdown ---
  const levels = [1, 0.75, 0.25];
  const total = round(levels.reduce((a, n) => a + n, 0));
  await sql`
    update items set patio = ${total}::numeric, patio_levels = ${levels}::numeric[] where id = ${id}`;
  await logMove({ type: "count", loc: "patio", from_val: 0, to_val: total });
  let r = await assertInvariant("a bottle-by-bottle count");
  assert.deepEqual(r.patioLevels, levels, "the counted levels must be stored as entered");
  assert.equal(r.patio, 2, "1 + 0.75 + 0.25 must total 2");
  assert.equal(r.patioLevels.length, 3, "three open bottles must stay three rows, not collapse to 2");

  // --- giving whole bottles appends full ones, keeping the sum honest ---
  // The quantity goes through a BOUND PARAMETER exactly as giveOut() does.
  // Written as a literal array[2] this passes while the real action throws
  // "array_fill(numeric, text[]) does not exist", because a bound parameter
  // arrives as text - so the cast has to be exercised here too.
  const giveQty = 2;
  await sql`
    update items set
      store = store - ${giveQty},
      patio = patio + ${giveQty},
      patio_levels = case when cardinality(patio_levels) > 0
                          then patio_levels || array_fill(1::numeric, array[${giveQty}::int])
                          else patio_levels end
    where id = ${id}`;
  await logMove({ type: "give", qty: 2, loc: "patio" });
  r = await assertInvariant("giving out 2 bottles");
  assert.equal(r.patio, 4, "2 + 2 given = 4");
  assert.equal(r.patioLevels.length, 5, "two whole bottles must arrive as two more rows");

  // --- a plain total count drops the breakdown rather than leaving it stale ---
  await sql`
    update items set patio = 3.5::numeric, patio_levels = '{}'::numeric[] where id = ${id}`;
  await logMove({ type: "count", loc: "patio", from_val: 4, to_val: 3.5 });
  r = await assertInvariant("a plain total count");
  assert.equal(r.patioLevels.length, 0,
    "a total-only count says nothing about how it splits, so the breakdown must be cleared");

  // --- giving into a bar with NO breakdown must not invent one ---
  await sql`
    update items set
      store = store - 1, patio = patio + 1,
      patio_levels = case when cardinality(patio_levels) > 0
                          then patio_levels || array_fill(1::numeric, array[1]) else patio_levels end
    where id = ${id}`;
  await logMove({ type: "give", qty: 1, loc: "patio" });
  r = await assertInvariant("giving into a bar with no breakdown");
  assert.equal(r.patio, 4.5, "3.5 + 1 = 4.5");
  assert.equal(r.patioLevels.length, 0,
    "appending to an empty breakdown would make it sum to 1 against a total of 4.5 - it must stay empty");

  // --- a transfer touching a bar clears that bar's breakdown ---
  await sql`
    update items set patio = 2::numeric, patio_levels = ${[1, 1]}::numeric[] where id = ${id}`;
  await assertInvariant("re-counting before the transfer");
  await sql`
    update items set
      patio = patio - 0.5, back = back + 0.5,
      patio_levels = case when 'patio' in ('patio', 'back') then '{}'::numeric[] else patio_levels end,
      back_levels  = case when 'back'  in ('patio', 'back') then '{}'::numeric[] else back_levels end
    where id = ${id}`;
  await logMove({ type: "transfer", qty: 0.5, loc: "patio", to_loc: "back" });
  r = await assertInvariant("a partial bar-to-bar transfer");
  assert.equal(r.patioLevels.length, 0, "which bottle a partial transfer came out of is unrecorded");
  assert.equal(r.backLevels.length, 0, "and which bottle it landed in is equally unrecorded");

  // --- levels round-trip through pg's numeric[] without precision loss ---
  const fussy = [0.05, 0.33, 0.87, 1];
  await sql`
    update items set back = ${round(fussy.reduce((a, n) => a + n, 0))}::numeric,
                     back_levels = ${fussy}::numeric[] where id = ${id}`;
  r = await assertInvariant("awkward two-decimal levels");
  assert.deepEqual(r.backLevels, fussy, "2dp levels must survive the round trip exactly");

  console.log(
    `bottles ok - breakdown/total invariant held across count, give, total-count, `
    + `give-into-empty, transfer and 2dp round-trip (${moveIds.length} moves exercised)`
  );
} finally {
  if (moveIds.length) await sql`delete from moves where id = any(${moveIds})`;
  await sql`delete from items where id = ${id}`;
}
