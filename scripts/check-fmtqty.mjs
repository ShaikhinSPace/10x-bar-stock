// Checks fmtQty's case-grouping math (beer only, 24 bottles/case, remainder handling).
//
//   node --experimental-strip-types scripts/check-fmtqty.mjs

import assert from "node:assert/strict";
import { fmtQty } from "../src/lib/model.ts";

assert.equal(fmtQty("BEER", 0), "0", "zero stays a plain number");
assert.equal(fmtQty("BEER", 18), "18", "under a case stays plain bottles");
assert.equal(fmtQty("BEER", 24), "1 case", "exactly one case, singular");
assert.equal(fmtQty("BEER", 48), "2 cases", "exact multiple, plural");
assert.equal(fmtQty("BEER", 50), "2 cases + 2", "a case count plus the leftover bottles");
assert.equal(fmtQty("BEER", 192), "8 cases", "Corona's real stock level");

// non-beer never groups into cases, regardless of quantity
assert.equal(fmtQty("WHISKEY", 48), "48", "whiskey has no case unit");
assert.equal(fmtQty("WINE", 1.5), "1.5", "non-beer keeps fractional bottles as-is");

console.log("fmtQty ok");
