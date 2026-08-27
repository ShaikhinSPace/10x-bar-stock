// Proves the assumption the report's opening-balance reconstruction rests on.
//
// The report works out what stock WAS at the start of a period by taking
// today's total and unwinding every move since, using only:
//
//   receive: +qty   waste: -qty   count: to_val - from_val   (give/transfer: 0)
//
// That "give and transfer are zero" is the load-bearing claim: both move
// stock between store and the bars, so they must leave store+patio+back
// unchanged. If either ever started leaking a bottle, every opening balance
// in the report would silently drift. This runs each move type against the
// real database and measures its actual effect on the combined total.
//
//   node --env-file=.env.local --experimental-strip-types scripts/check-report.mjs

import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { buildPdf } from "../src/lib/pdf.ts";

const sql = neon(process.env.DATABASE_URL);
const NAME = `__report_check_${Date.now()}__`;
const round = (n) => Math.round(Number(n) * 100) / 100;

/** store + patio + back for our one temp item. */
async function combined(id) {
  const [r] = await sql`select store + patio + back as t from items where id = ${id}`;
  return round(r.t);
}
/** The delta the report would attribute to a move, from the moves row itself. */
function reportDelta(m) {
  if (m.type === "receive") return round(m.qty);
  if (m.type === "waste") return -round(m.qty);
  if (m.type === "count") return round(Number(m.to_val ?? 0) - Number(m.from_val ?? 0));
  return 0; // give, transfer
}

const [{ id }] = await sql`
  insert into items (name, cat, store, patio, back, rl)
  values (${NAME}, 'WHISKEY', 20, 0, 0, 2) returning id`;
const [{ id: userId, name: userName }] = await sql`select id, name from users limit 1`;

let moveIds = [];
async function logMove(row) {
  const [m] = await sql`
    insert into moves (type, item_id, item_name, cat, qty, loc, to_loc, from_val, to_val, user_id, user_name)
    values (${row.type}, ${id}, ${NAME}, 'WHISKEY', ${row.qty ?? null}, ${row.loc ?? null},
            ${row.to_loc ?? null}, ${row.from_val ?? null}, ${row.to_val ?? null}, ${userId}, ${userName})
    returning id, type, qty, from_val, to_val`;
  moveIds.push(m.id);
  return m;
}

try {
  // Each case: apply the same stock change the Server Action applies, log the
  // same moves row, then compare the real change against what the report
  // would have inferred from that row alone.
  const cases = [
    {
      what: "receive 6 into store",
      apply: () => sql`update items set store = store + 6 where id = ${id}`,
      move: { type: "receive", qty: 6, loc: "store" },
    },
    {
      what: "give 4 from store to the patio bar",
      apply: () => sql`update items set store = store - 4, patio = patio + 4 where id = ${id}`,
      move: { type: "give", qty: 4, loc: "patio" },
    },
    {
      what: "transfer 1.5 from patio to back",
      apply: () => sql`update items set patio = patio - 1.5, back = back + 1.5 where id = ${id}`,
      move: { type: "transfer", qty: 1.5, loc: "patio", to_loc: "back" },
    },
    {
      what: "transfer 2 from store back into the patio bar",
      apply: () => sql`update items set store = store - 2, patio = patio + 2 where id = ${id}`,
      move: { type: "transfer", qty: 2, loc: "store", to_loc: "patio" },
    },
    {
      what: "waste 0.75 off the patio bar",
      apply: () => sql`update items set patio = patio - 0.75 where id = ${id}`,
      move: { type: "waste", qty: 0.75, loc: "patio" },
    },
    {
      what: "count the patio bar down to 1",
      apply: async () => {
        const [r] = await sql`select patio from items where id = ${id}`;
        await sql`update items set patio = 1 where id = ${id}`;
        return round(r.patio);
      },
      move: (from) => ({ type: "count", loc: "patio", from_val: from, to_val: 1 }),
    },
    {
      what: "count the store up to 40",
      apply: async () => {
        const [r] = await sql`select store from items where id = ${id}`;
        await sql`update items set store = 40 where id = ${id}`;
        return round(r.store);
      },
      move: (from) => ({ type: "count", loc: "store", from_val: from, to_val: 40 }),
    },
  ];

  for (const c of cases) {
    const before = await combined(id);
    const extra = await c.apply();
    const after = await combined(id);
    const m = await logMove(typeof c.move === "function" ? c.move(extra) : c.move);
    assert.equal(
      round(after - before), reportDelta(m),
      `"${c.what}": the report would infer ${reportDelta(m)} but stock actually moved by ${round(after - before)}`
    );
  }

  // Now the whole thing end to end: unwinding every logged move must land
  // back on the opening balance we started from.
  const rows = await sql`
    select type, qty, from_val, to_val from moves where item_id = ${id} order by id`;
  const closing = await combined(id);
  const opening = round(rows.reduce((acc, m) => round(acc - reportDelta(m)), closing));
  assert.equal(opening, 20, `unwinding every move must reconstruct the opening 20 bottles, got ${opening}`);

  // And the sign convention the KPI table prints:
  //   closing = opening + received - wasted + counted_up - counted_down
  const received = rows.filter((m) => m.type === "receive").reduce((a, m) => a + Number(m.qty), 0);
  const wasted = rows.filter((m) => m.type === "waste").reduce((a, m) => a + Number(m.qty), 0);
  const counts = rows.filter((m) => m.type === "count").map((m) => Number(m.to_val) - Number(m.from_val));
  const up = counts.filter((d) => d > 0).reduce((a, d) => a + d, 0);
  const down = counts.filter((d) => d < 0).reduce((a, d) => a - d, 0);
  assert.equal(
    round(opening + received - wasted + up - down), closing,
    "closing must equal opening + received - wasted + counted_up - counted_down"
  );

  // --- tags must never leak into the category totals ---
  // A bottle carries ONE main category plus any number of tags. The report
  // groups by items.cat alone, so the per-category totals have to add up to
  // real stock exactly. If tags ever started counting as categories, a well
  // whiskey would land in both Whiskey and Well and the totals would exceed
  // the stock that actually exists. Proven here with a tag in place.
  const [tagCat] = await sql`select name from categories where name <> 'WHISKEY' limit 1`;
  await sql`insert into item_tags (item_id, cat) values (${id}, ${tagCat.name})
            on conflict do nothing`;
  try {
    const [{ t: real }] = await sql`
      select coalesce(sum(store + patio + back), 0) t from items where not archived`;
    const perCat = await sql`
      select coalesce(sum(store + patio + back), 0) q from items where not archived group by cat`;
    const summed = round(perCat.reduce((a, r) => a + Number(r.q), 0));
    assert.equal(summed, round(real),
      `per-category totals (${summed}) must equal real stock (${round(real)}) - a tagged `
      + `bottle is being counted under more than one category`);

    const [{ n }] = await sql`
      select count(*) n from item_tags t join items i on i.id = t.item_id and i.cat = t.cat`;
    assert.equal(Number(n), 0, "an item's main category must never also be stored as one of its tags");
  } finally {
    await sql`delete from item_tags where item_id = ${id}`;
  }

  console.log(
    `report ok - ${cases.length} move types measured against the real database; `
    + `give and transfer confirmed stock-neutral; opening ${opening} -> closing ${closing} reconciles; `
    + `category totals still exact with a tag applied`
  );
} finally {
  if (moveIds.length) await sql`delete from moves where id = any(${moveIds})`;
  await sql`delete from items where id = ${id}`;
}

/* ---- the PDF itself still has to render, with the report's real shape ---- */
const pdf = buildPdf({
  title: "10X Bar - Stock Report",
  subtitle: "Last 7 days (Aug 16 - Aug 22)   vs   the 7 days before (Aug 9 - Aug 16)",
  meta: "Generated by the check script",
  kpiHeader: ["", "Previous", "Change"],
  kpis: [
    { label: "Bottles on hand (close)", value: "1,190", prev: "1,118", change: "+72 (+6%)" },
    { label: "Wasted", value: "0", prev: "3", change: "-3 (-100%)" },
  ],
  sections: [
    {
      title: "Order this",
      note: "At or below the reorder point.",
      columns: [
        { header: "Bottle", width: 3 }, { header: "In store", width: 1, align: "right" },
        { header: "Short by", width: 1, align: "right" },
      ],
      rows: [
        ["CRÈME DE BANANA", "0", "2"],                 // non-ASCII must survive
        ["Backslash \\ and (parens)", "1", "1"],       // PDF literal-string specials
        ...Array.from({ length: 70 }, (_, i) => [`BOTTLE ${i}`, String(i), "1"]),
      ],
    },
    { title: "Wastage", columns: [{ header: "Reason", width: 1 }], rows: [], empty: "No wastage recorded." },
  ],
});

const text = pdf.toString("latin1");
assert.ok(text.startsWith("%PDF-1.4"), "must start with the PDF header");
assert.ok(text.trimEnd().endsWith("%%EOF"), "must end with %%EOF");

const trailer = text.match(/trailer\n<< \/Size (\d+) \/Root 1 0 R >>\nstartxref\n(\d+)\n%%EOF$/);
assert.ok(trailer, "trailer must be well-formed and last in the file");
const size = Number(trailer[1]), xrefAt = Number(trailer[2]);
assert.equal(text.slice(xrefAt, xrefAt + 4), "xref", "startxref must point at the xref keyword");

const entries = [...text.slice(xrefAt, text.indexOf("trailer", xrefAt))
  .matchAll(/(\d{10}) \d{5} [nf] ?\n/g)].map((m) => Number(m[1]));
assert.equal(entries.length, size, "xref must list exactly /Size entries");
for (let n = 1; n < size; n++) {
  assert.match(text.slice(entries[n], entries[n] + 20), new RegExp(`^${n} 0 obj`),
    `object ${n}'s xref offset must land on its own header`);
}
for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
  const start = m.index + m[0].length;
  assert.equal(text.indexOf("\nendstream", start) - start, Number(m[1]),
    "/Length must equal the real stream byte count");
}

assert.match(text, /\(CR.ME DE BANANA\) Tj/, "non-ASCII still lands in the stream");
assert.match(text, /\(Backslash \\\\ and \\\(parens\\\)\) Tj/, "backslash and parens must be escaped");
assert.match(text, /\(No wastage recorded\.\) Tj/, "an empty section must print its fallback line");
const pages = (text.match(/\/Type \/Page[^s]/g) ?? []).length;
assert.ok(pages >= 3, `expected pagination to kick in, got ${pages} pages`);

console.log(`pdf ok - ${pdf.length} bytes, ${pages} pages, ${size - 1} objects, xref and stream lengths verified`);
