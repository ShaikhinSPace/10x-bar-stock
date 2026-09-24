// Export bottles and categories to CSV for editing in Excel, then re-import with
// scripts/import-bottles.mjs.
//
//   node --env-file=.env.local.prod-backup scripts/export-bottles.mjs [outDir]
//
// CSV rather than .xlsx on purpose: this is a ROUND TRIP, and the edited file has to
// be readable again. Excel opens and edits CSV natively, and keeping it as CSV means
// the import side stays a few lines instead of an XLSX parser. Keep the format when
// you save — if Excel offers to convert to .xlsx, decline.
//
// `id` is the join key and must never be edited. Everything else is fair game;
// blank out nothing, delete no rows (deleting a row is ignored, not a delete).

import { neon } from "@neondatabase/serverless";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set — pass --env-file");
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);
const outDir = process.argv[2] || join(homedir(), "Desktop", "10x-bar-export");

/** RFC4180: quote anything containing a comma, quote, CR or LF; double inner quotes. */
const cell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header, rows) =>
  // Leading BOM so Excel reads it as UTF-8 — without it "CRÈME DE BANANA" arrives mangled.
  "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

/** numeric(10,2) comes back as a string; write whole numbers without the .00 tail. */
const num = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
};

const items = await sql`
  select i.id, i.name, i.cat, i.store, i.patio, i.back, i.rl,
         i.ignore_reorder, i.archived,
         coalesce(
           (select string_agg(t.cat, '; ' order by t.cat) from item_tags t where t.item_id = i.id),
           ''
         ) as tags
  from items i
  order by i.cat, i.name`;

const cats = await sql`
  select c.name, c.sort,
         (select count(*) from items i where i.cat = c.name and not i.archived) as bottles
  from categories c
  order by c.sort, c.name`;

mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(outDir, "bottles.csv"),
  toCsv(
    ["id", "name", "category", "also_tagged", "store", "patio", "back",
     "reorder_at", "ignore_reorder", "archived"],
    items.map((i) => [
      i.id, i.name, i.cat, i.tags,
      num(i.store), num(i.patio), num(i.back), num(i.rl),
      i.ignore_reorder ? "yes" : "no",
      i.archived ? "yes" : "no",
    ])
  ),
  "utf8"
);

writeFileSync(
  join(outDir, "categories.csv"),
  toCsv(
    ["name", "order", "bottles"],
    cats.map((c) => [c.name, c.sort, c.bottles])
  ),
  "utf8"
);

const host = process.env.DATABASE_URL.match(/@([^/]+)/)?.[1] ?? "?";
console.log(`from   ${host}`);
console.log(`wrote  ${join(outDir, "bottles.csv")}    ${items.length} bottles`);
console.log(`wrote  ${join(outDir, "categories.csv")}  ${cats.length} categories`);
