// Proves that managing categories cannot corrupt the category totals.
//
// A bottle carries ONE main category plus any number of tags, and the report's
// per-category figures are only correct while no bottle counts under two categories
// at once. Folding one category into another is the operation that can break that,
// in two ways at the same time:
//
//   - a bottle tagged INTO whose main category becomes INTO (counted twice), and
//   - a bottle tagged FROM that already carried INTO (primary key collision).
//
// Renaming has its own trap: items.cat and item_tags.cat are foreign keys, so the
// new name has to reach every bottle rather than the rename being refused.
//
// Runs the real merge statements - the same ones the Server Action hands to
// sql.transaction - against the real database.
//
//   node --env-file=.env.local --experimental-strip-types scripts/check-categories.mjs

import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { mergeCategorySteps } from "../src/lib/category-merge.ts";

const sql = neon(process.env.DATABASE_URL);
const TAG = `__cat_${Date.now()}__`;
const A = `${TAG}A`, B = `${TAG}B`;
const made = [];

async function cat(name) {
  await sql`insert into categories (name, sort)
            select ${name}, coalesce(max(sort), 0) + 1 from categories`;
}
async function bottle(name, c, tags = []) {
  const [r] = await sql`
    insert into items (name, cat, store, rl) values (${`${TAG}${name}`}, ${c}, 3, 1)
    returning id`;
  made.push(r.id);
  for (const t of tags) await sql`insert into item_tags (item_id, cat) values (${r.id}, ${t})`;
  return r.id;
}
const mainCat = async (id) => (await sql`select cat from items where id = ${id}`)[0].cat;
const tagsOf = async (id) =>
  (await sql`select cat from item_tags where item_id = ${id} order by cat`).map((r) => r.cat);
const catExists = async (n) =>
  (await sql`select 1 from categories where name = ${n}`).length > 0;

/** The invariant the report depends on, measured across the WHOLE database. */
async function assertNoDoubleCounting(where) {
  const [{ n }] = await sql`
    select count(*) n from item_tags t join items i on i.id = t.item_id and i.cat = t.cat`;
  assert.equal(Number(n), 0, `${where}: a bottle is counted under its main category AND as a tag`);

  const [{ t: real }] = await sql`
    select coalesce(sum(store + patio + back), 0) t from items where not archived`;
  const per = await sql`
    select coalesce(sum(store + patio + back), 0) q from items where not archived group by cat`;
  const summed = Math.round(per.reduce((a, r) => a + Number(r.q), 0) * 100) / 100;
  assert.equal(summed, Math.round(Number(real) * 100) / 100,
    `${where}: per-category totals no longer add up to real stock`);
}

try {
  await cat(A);
  await cat(B);

  // Four shapes, chosen to hit every branch of the fold at once.
  const plain   = await bottle("plain",   A);          // main A, no tags
  const dual    = await bottle("dual",    A, [B]);     // main A, already tagged B  <- double-count trap
  const tagged  = await bottle("tagged",  B, [A]);     // main B, tagged A          <- retarget
  const collide = await bottle("collide", `${TAG}A`);  // another main A
  await sql`update items set cat = ${B} where id = ${collide}`;
  await sql`insert into item_tags (item_id, cat) values (${collide}, ${A})`;
  // collide: main B, tagged A — same shape as `tagged`, kept to prove it is not
  // an accident of ordering.

  await assertNoDoubleCounting("before the merge");

  /* ---- fold A into B ---- */
  await sql.transaction(mergeCategorySteps(sql, A, B));

  assert.equal(await catExists(A), false, "the folded category must be gone");
  assert.equal(await catExists(B), true, "the surviving category must still be there");

  assert.equal(await mainCat(plain), B, "a bottle whose main category was folded moves across");
  assert.deepEqual(await tagsOf(plain), [], "and gains no stray tag");

  assert.equal(await mainCat(dual), B, "the double-count case moves across too");
  assert.deepEqual(await tagsOf(dual), [],
    "and its B tag must be dropped — main category B plus tag B would count it twice");

  assert.equal(await mainCat(tagged), B, "a bottle already in B stays in B");
  assert.deepEqual(await tagsOf(tagged), [],
    "and its A tag, now also B, must be dropped rather than duplicated");

  assert.equal(await mainCat(collide), B);
  assert.deepEqual(await tagsOf(collide), []);

  await assertNoDoubleCounting("after the merge");

  /* ---- rename has to reach the bottles, not be refused by the foreign key ---- */
  const renamed = `${TAG}R`;
  await sql`update categories set name = ${renamed} where name = ${B}`;
  assert.equal(await mainCat(plain), renamed,
    "on update cascade must carry a rename out to every bottle");
  const [{ n: stale }] = await sql`select count(*) n from items where cat = ${B}`;
  assert.equal(Number(stale), 0, "no bottle may be left pointing at the old name");

  // And a tag follows a rename as well.
  await sql`insert into item_tags (item_id, cat) values (${plain}, ${renamed})
            on conflict do nothing`;
  await sql`delete from item_tags where item_id = ${plain} and cat = ${renamed}`;

  await assertNoDoubleCounting("after the rename");

  /* ---- a category still in use cannot simply vanish ---- */
  await assert.rejects(
    () => sql`delete from categories where name = ${renamed}`,
    /foreign key|violates/i,
    "deleting a category bottles still point at must be refused by the database"
  );

  console.log(
    "categories ok - folding one into another moves bottles and tags across, drops the "
    + "tag that would double-count, and survives a bottle already carrying both; a rename "
    + "cascades to every bottle; a category still in use cannot be deleted"
  );
} finally {
  if (made.length) {
    await sql`delete from item_tags where item_id = any(${made})`;
    await sql`delete from moves where item_id = any(${made})`;
    await sql`delete from items where id = any(${made})`;
  }
  await sql`delete from categories where name like ${TAG + "%"}`;
}
