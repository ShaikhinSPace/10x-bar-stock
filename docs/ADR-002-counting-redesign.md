# ADR-002: Counting System Redesign — Blind Count with Variance Report

**Status:** Proposed
**Date:** 2026-11-07
**Deciders:** Sameer (owner)

## Context

The counting system works mechanically — `submitStocktake` writes correct
SQL, the sweep chains Patio → Back → Store — but it fails the job it exists
for: catching leakage.

Problems in daily use:

1. **Expected values bias the counter.** The Stocktake screen shows "Expected"
   next to every row. A busy barback sees "12" and types "12" without actually
   counting. The count confirms the system's belief, not reality.

2. **No summary after counting.** The count saves and the sweep advances.
   Nobody sees a page that says "you're 3 bottles of Hennessy short this week."
   The variance signal is buried in Activity, where nobody looks.

3. **Per-bottle levels are correct but the expected column biases them.**
   A brand with 4 open bottles gets 4 rows — this matches what the owner
   actually does (walks the bar, measures every bottle). The problem isn't
   the per-bottle rows, it's that showing expected values next to them
   anchors the count.

4. **The sweep is all-or-nothing mindset.** Patio → Back → Store in one
   sitting. A bar manager who only has time to count the store skips the whole
   thing because the UI presents it as a 3-step obligation.

## Decision

Replace the counting UI and flow with a **blind count → variance report**
pattern. The server actions (`submitStocktake`, `countStore`,
`countBarBottles`) stay mostly the same — this is primarily a UI and
workflow change.

## The new flow

### 1. Start a count (owner only, any location, any time)

Dashboard shows three cards: Patio · Back · Store, each with "last counted"
timestamp. Tap one to start counting that location. No forced sweep order.
Staff never see or touch the counting flow — this is the owner/manager
module only (enforced server-side by `requireOwner()`).

### 2. Blind entry — add bottles as you find them

The count screen starts **empty**. No pre-populated list. The counter
walks the bar or storeroom and adds each bottle as they physically
encounter it:

1. **Search / tap to add** a bottle to the count.
2. **Type the count** — fill level for bars (0.25, 0.5, 0.75, 1.00 per
   open bottle), whole bottles for store.
3. **On bars**: if you see multiple open bottles of the same brand, add
   it again — each tap adds another row for that brand. The total is
   the sum of all rows for that item.
4. Move to the next bottle on the shelf.

This is a true "count from zero" — you build the list from what's
physically there, not from what the system thinks is there. A bottle
you don't add is counted as **zero** (not "not counted"). This is the
key difference from today: today a blank row means "skipped", in the
new flow absence means "it's not on the bar."

- **Store**: whole bottles per brand. Beer shows case-size hint ("× 24").
- **Bars**: per-bottle fill levels. Each add is one physical bottle.

The count draft persists in localStorage so a dropped connection or
accidental close doesn't lose a 20-minute count.

### 3. Submit → Variance report

After tapping Save, the system does two things:

1. **Writes the count** — same `submitStocktake` SQL. Unchanged rows are
   skipped (same as today).
2. **Returns the variance report** — a screen that shows, for every item
   where counted ≠ expected:

   | Bottle | Expected | Counted | Diff | Notes |
   |--------|----------|---------|------|-------|
   | Hennessy VS | 14 | 11 | **−3** | ⚠ 2nd time this week |

   Colour-coded: green = gained (probably a missed receive), red = short
   (leakage signal). Items with repeated shortages flagged.

   The report stays on screen until dismissed. It is also accessible later
   from Activity (filter: Count) with the same batch id grouping.

### 4. Dashboard surfaces the signal

The "Count today" strip on Dashboard changes:

- Shows **top 3 variances** from the last count inline, not just "last
  counted 2h ago".
- Colour: green when the last count had no significant variances, amber
  when there were corrections, red when large corrections repeated.

## Options Considered

### Option A: Blind count + variance report (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — UI rewrite of Stocktake, small action change for report data |
| Risk | Low — server SQL barely changes, variance math is simple subtraction |
| Real-world fit | High — matches how bars actually count |

**Pros:**
- Honest counts (no anchoring bias)
- Leakage visible immediately, not buried in Activity
- Per-bottle fill levels preserved (owner counts every bottle daily)
- Each location counted independently

**Cons:**
- If you forget to add a bottle, it counts as zero (big variance).
  Mitigated by showing "X bottles not in this count" before submit.
- Slightly different muscle memory (add then type, vs scroll and type)

### Option B: Keep current UI, add variance summary page

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Risk | Low |
| Real-world fit | Low — the anchoring bias is the core problem |

**Pros:** Smallest change
**Cons:** Doesn't fix the bias. Counts keep confirming the system.

### Option C: Full stocktake with sign-off workflow

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — needs stocktake sessions, approval flow, possibly two counters |
| Risk | Medium |
| Real-world fit | Overkill for a single bar |

**Pros:** Audit-grade
**Cons:** Way too heavy. This is one bar with 2-3 staff.

## What changes in code

### UI (`stock.tsx` — `Stocktake` component)

- Replace pre-populated list with an empty-start, add-as-you-go flow
- Search bar at top to find and add bottles to the count
- On bars: each add = one physical bottle row (fill level input)
- On store: each add = one brand row (whole bottle count)
- Show "X bottles not in this count" warning before submit
- After submit: render a variance report overlay instead of silently closing

### Server (`stocktake.ts` — `submitStocktake`)

- Accept the full list of counted items. Items the system knows about but
  NOT in the list are counted as zero — the server writes a count move
  setting them to 0 (they weren't on the shelf).
- Return variance data (from_val, to_val, diff) per item in the response
  instead of just `returning id`. Small SQL change.
- Add a `repeat_short` flag: query the last 7 days of count moves for the
  same items and mark any that were also short.

### Dashboard (`dashboard.tsx`)

- Replace the plain "last counted" timestamps with variance summaries
- Change "Count today →" to three independent location buttons

### Data model

- **No schema changes.** The moves table already stores `from_val` /
  `to_val` which is the variance. The `batch` column already groups a
  count session.
- `patio_levels[]` / `back_levels[]` continue to be written on every bar
  count (same as today). The give-to-bar flow appends full bottles, and
  the count replaces the array with the freshly entered levels.

## Consequences

- **Easier:** Counting is bias-free and surfaces problems on the spot
- **Easier:** Dashboard tells the owner "something is off" without digging
- **Easier:** Per-bottle fill levels still tracked, giving accurate bar data
- **Revisit:** If the variance report needs more detail (e.g. trend charts),
  add that as a second iteration

## Action Items

1. [ ] Agree on this design
2. [ ] Rewrite `Stocktake` component (blind entry, one row per item on bars)
3. [ ] Update `submitStocktake` to return variance + repeat-short data
4. [ ] Build variance report overlay
5. [ ] Update dashboard count cards with variance summaries
6. [ ] Update docs/APP.md counting sections
