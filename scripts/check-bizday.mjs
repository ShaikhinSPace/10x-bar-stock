// Proves the business-day bucket boundary.
//
// A bar's night runs from noon to roughly 6am the next morning, so a move logged at
// 2am belongs to the PREVIOUS date's shift, not "today". bizDayKey folds that whole
// span into one bucket keyed by the shift's opening date. Pure function, no DB.
//
//   node --experimental-strip-types scripts/check-bizday.mjs

import assert from "node:assert/strict";
import { bizDayKey, DAY_START_HOUR } from "../src/lib/model.ts";

assert.equal(DAY_START_HOUR, 12, "cutoff is noon");

const at = (y, mo, d, h, mi = 0) => new Date(y, mo, d, h, mi).getTime();
const midnight = (y, mo, d) => new Date(y, mo, d).getTime();

// Jan 2 2026 is a Friday, Jan 3 a Saturday.
const FRI = [2026, 0, 2], SAT = [2026, 0, 3];

const cases = [
  ["Fri 8pm  -> Fri night",  at(2026, 0, 2, 20), midnight(...FRI)],
  ["Fri 1pm  -> Fri (just after open)", at(2026, 0, 2, 13), midnight(...FRI)],
  ["Sat 1am  -> Fri night (past midnight)", at(2026, 0, 3, 1), midnight(...FRI)],
  ["Sat 5am  -> Fri night (last call tail)", at(2026, 0, 3, 5), midnight(...FRI)],
  ["Sat 11am -> Fri (still before noon)", at(2026, 0, 3, 11), midnight(...FRI)],
  ["Sat noon -> Sat (shift opens)", at(2026, 0, 3, 12), midnight(...SAT)],
  ["Sat 1pm  -> Sat", at(2026, 0, 3, 13), midnight(...SAT)],
];

let fails = 0;
for (const [label, ts, want] of cases) {
  try {
    assert.equal(bizDayKey(ts), want);
    console.log("  ok   " + label);
  } catch {
    fails++;
    console.error(`  FAIL ${label}\n       got ${new Date(bizDayKey(ts))}, want ${new Date(want)}`);
  }
}
console.log(fails ? `\n${fails} failed` : "\nall business-day checks passed");
process.exit(fails ? 1 : 0);
