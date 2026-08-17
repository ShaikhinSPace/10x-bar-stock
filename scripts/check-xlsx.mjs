// Round-trips the hand-written .xlsx builder: build a workbook, unzip it, and read
// the cells back by their references. A ZIP/OOXML bug produces a file that looks
// fine here and refuses to open in Excel, so this checks structure, not just bytes.
//
//   node --experimental-strip-types scripts/check-xlsx.mjs

import assert from "node:assert/strict";
import { unzipSync } from "node:zlib";
import { buildXlsx } from "../src/lib/xlsx.ts";

const buf = buildXlsx([
  {
    name: "Stock",
    columns: [{ header: "Bottle" }, { header: "Category" }, { header: "Qty" }],
    rows: [
      ["CRÈME DE BANANA", "OTHER", 1],   // non-ASCII must survive
      ["BARTON'S LONG ISLAND", "OTHER", 6], // apostrophe
      ["Ampersand & <tag>", "MIXER", 2],  // XML specials must be escaped
      ["Gap test", null, 7],              // a null cell must be skipped, not shifted
    ],
  },
  { name: "Deliveries", columns: [{ header: "Invoice" }], rows: [["88214"]] },
]);

/* ---- parse the ZIP central directory ourselves (stored entries only) ---- */
const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
assert.notEqual(eocd, -1, "no end-of-central-directory record");
const count = buf.readUInt16LE(eocd + 10);
let p = buf.readUInt32LE(eocd + 16);

const parts = {};
for (let i = 0; i < count; i++) {
  assert.equal(buf.readUInt32LE(p), 0x02014b50, "bad central directory signature");
  const method = buf.readUInt16LE(p + 10);
  const size = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const local = buf.readUInt32LE(p + 42);
  const name = buf.subarray(p + 46, p + 46 + nameLen).toString();

  const lnLen = buf.readUInt16LE(local + 26);
  const lxLen = buf.readUInt16LE(local + 28);
  const start = local + 30 + lnLen + lxLen;
  const raw = buf.subarray(start, start + size);
  parts[name] = method === 0 ? raw.toString("utf8") : unzipSync(raw).toString("utf8");
  p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
}

for (const need of [
  "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
]) {
  assert.ok(parts[need], `missing required part: ${need}`);
}

const sheet1 = parts["xl/worksheets/sheet1.xml"];
const cells = Object.fromEntries(
  [...sheet1.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:<is><t[^>]*>(.*?)<\/t><\/is>|<v>(.*?)<\/v>)<\/c>/g)]
    .map((m) => [m[1], m[2] ?? m[3]])
);

assert.equal(cells.A1, "Bottle", "header row must be row 1");
assert.equal(cells.A2, "CRÈME DE BANANA", "non-ASCII must round-trip");
assert.equal(cells.A3, "BARTON&#39;S LONG ISLAND".replace("&#39;", "'"), "apostrophe survives");
assert.equal(cells.A4, "Ampersand &amp; &lt;tag&gt;", "XML specials must stay escaped in the file");
assert.equal(cells.C4, "2", "a numeric cell keeps its value");
assert.equal(cells.A5, "Gap test");
assert.equal(cells.B5, undefined, "a null cell is omitted, not written blank");
assert.equal(cells.C5, "7", "the cell after a gap keeps its own column reference");

assert.ok(parts["xl/workbook.xml"].includes('name="Deliveries"'), "second sheet is registered");
assert.ok(parts["[Content_Types].xml"].includes("sheet2.xml"), "second sheet has a content type");

console.log(`xlsx ok — ${count} parts, ${buf.length} bytes, cells land on their own refs`);
