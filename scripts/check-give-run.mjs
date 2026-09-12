// Proves a give-run is all-or-nothing.
//
// A barback loads several bottles and runs them out to one bar in a single tap. The
// risk is a partial run: if one bottle is short in the storeroom, the others must NOT
// move either — a half-applied run silently inflates a bar against stock that was
// never there. This measures that, plus the happy path and the bottle-breakdown
// append, against the real database using the same applyGiveRun the action calls.
//
//   node --env-file=.env.local --experimental-strip-types scripts/check-give-run.mjs

import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { applyGiveRun } from "../src/lib/give-run.ts";

const sql = neon(process.env.DATABASE_URL);
const TAG = `__giverun_${Date.now()}__`;
const round = (n) => Math.round(Number(n) * 100) / 100;

const [{ id: userId, name: userName }] = await sql`select id, name from users limit 1`;
const made = [];

async function bottle(name, store, { patioLevels } = {}) {
  // Keep the patio scalar and its breakdown consistent, the way countBarBottles does.
  const patio = round((patioLevels ?? []).reduce((a, n) => a + n, 0));
  const [r] = await sql`
    insert into items (name, cat, store, patio, back, rl, patio_levels)
    values (${`${TAG}${name}`}, 'WHISKEY', ${store}, ${patio}, 0, 2,
            ${patioLevels ?? []}::numeric[])
    returning id`;
  made.push(r.id);
  return r.id;
}
async function at(id) {
  const [r] = await sql`select store, patio, back, patio_levels from items where id = ${id}`;
  return {
    store: round(r.store), patio: round(r.patio), back: round(r.back),
    levels: (r.patio_levels ?? []).map(Number),
  };
}
async function moveCount(id) {
  const [r] = await sql`select count(*)::int as n from moves where item_id = ${id} and type = 'give'`;
  return r.n;
}

let failures = 0;
function check(label, fn) {
  return fn().then(
    () => console.log(`  ok   ${label}`),
    (e) => { failures++; console.error(`  FAIL ${label}\n       ${e.message}`); },
  );
}

try {
  // 1. Happy path: two bottles with enough store, both run out to Patio in one call.
  await check("runs every line and logs one give each", async () => {
    const a = await bottle("hp-a", 5);
    const b = await bottle("hp-b", 3);
    const rows = await applyGiveRun(sql, { ids: [a, b], qtys: [2, 1], to: "patio", userId, userName });
    assert.equal(rows.length, 2, "both lines written");
    assert.deepEqual(await at(a), { store: 3, patio: 2, back: 0, levels: [] });
    assert.deepEqual(await at(b), { store: 2, patio: 1, back: 0, levels: [] });
    assert.equal(await moveCount(a), 1);
    assert.equal(await moveCount(b), 1);
  });

  // 2. All-or-nothing: one line short → the whole run is refused, the OTHER line
  //    (which had plenty) is left untouched, and nothing is logged.
  await check("one short line refuses the entire run", async () => {
    const a = await bottle("an-a", 5); // plenty
    const b = await bottle("an-b", 1); // short for qty 4
    const rows = await applyGiveRun(sql, { ids: [a, b], qtys: [2, 4], to: "back", userId, userName });
    assert.equal(rows.length, 0, "nothing written");
    assert.deepEqual(await at(a), { store: 5, patio: 0, back: 0, levels: [] }, "sufficient line untouched");
    assert.deepEqual(await at(b), { store: 1, patio: 0, back: 0, levels: [] }, "short line untouched");
    assert.equal(await moveCount(a), 0);
    assert.equal(await moveCount(b), 0);
  });

  // 3. Exact-stock boundary: store === qty is allowed (>= guard), goes to zero.
  await check("running the whole storeroom out is allowed", async () => {
    const a = await bottle("bd-a", 4);
    const rows = await applyGiveRun(sql, { ids: [a], qtys: [4], to: "patio", userId, userName });
    assert.equal(rows.length, 1);
    assert.deepEqual(await at(a), { store: 0, patio: 4, back: 0, levels: [] });
  });

  // 4. Breakdown append: a bar with a known bottle-by-bottle count gains full bottles;
  //    a bar with no breakdown stays unknown (empty), same rule as giveOut.
  await check("full bottles join an existing breakdown only", async () => {
    const known = await bottle("lv-known", 5, { patioLevels: [0.5] }); // one half-bottle open
    const unknown = await bottle("lv-unknown", 5); // no breakdown
    await applyGiveRun(sql, { ids: [known, unknown], qtys: [2, 2], to: "patio", userId, userName });
    assert.deepEqual((await at(known)).levels, [0.5, 1, 1], "two full bottles appended");
    assert.deepEqual((await at(known)).patio, 2.5);
    assert.deepEqual((await at(unknown)).levels, [], "no breakdown stays empty");
    assert.deepEqual((await at(unknown)).patio, 2);
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nall give-run checks passed");
} finally {
  // Clean up every row this run created, moves first (FK on item_id).
  if (made.length) {
    await sql`delete from moves where item_id = any(${made}::int[])`;
    await sql`delete from items where id = any(${made}::int[])`;
  }
}

process.exit(failures ? 1 : 0);
