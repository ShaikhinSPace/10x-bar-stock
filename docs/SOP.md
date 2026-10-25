# 10X Bar Stock — How it works

A practical guide to the app, who does what, and the daily routine. If
something here contradicts the actual UI, the UI wins — it is the source of
truth. Flag the drift and this file gets updated.

---

## 1. What the system is

A storeroom and bar stock-control app for 10X Bar. It replaces the old
spreadsheet with per-location tracking (Store · Patio Bar · Back Bar), an
append-only move log, and an opening count each shift; the difference
between consecutive counts is what each bar used.

**Business day ends at 3 AM Central.** Any move 00:00-02:59 belongs to
the shift that was still open. Toast is set to the same closeout so both
systems agree on what "Friday" is.

The point: catching leakage between what leaves the storeroom and what each
bar actually has. Everything is per-location rather than one combined total.

Every bottle's headline number is its total across all three locations, with
the per-location split shown below it. Reorder alerts are measured against the
**storeroom only** — you reorder from the supplier into the store, not into a
bar.

- **Store** counts whole, unopened bottles. Beer counts whole cases (default
  24 bottles per case; configurable per item).
- **Patio Bar** and **Back Bar** count partials for spirits (`0.25`, `0.5`,
  `0.75`) and whole bottles for beer (never partials on beer). The bar total
  is summed automatically from the per-bottle fill levels you type.
- **Case-sized items** (beer by default) display as cases on the store screen
  and in the single-bottle Count form. The database still stores bottles —
  only the UI switches units.

---

## 2. Roles

Two roles, decided when the user is created.

### Owner (manager)
- Sees every tab: Dashboard · Stock · Delivery · Activity · Manage.
- Lands on Dashboard after login.
- Can do everything a barback can, **plus**: Count (bars and store), Record
  wastage, book Deliveries, add/edit/archive bottles, add/disable staff,
  manage categories, generate the Reports PDF, undo any entry.

### Staff (barback)
- Sees only the Stock tab in the nav.
- Lands on `/stock/run` (the bulk give-to-bar flow) after login.
- Primary actions on the Stock tab's bottle sheet: **Give · Receive ·
  Transfer stock**.
- Can **undo** only their own entries.
- Cannot: Count, Record wastage, book Deliveries, see Reports or Manage,
  touch other users' entries.

The role gates are enforced server-side (not just hidden in the UI). A staff
user POSTing directly to a count/waste/delivery server action is refused with
"Owners only".

---

## 3. The daily routine (SOP)

### Shift open (owner, every shift)
1. **Open the app → Dashboard.**
2. **Glance at the Today strip** at the top: given out, deliveries,
   poured, wasted — all scoped to today's business day. Underneath, the
   "Last count — Patio Nh ago · Back Nh ago · Store Nh ago" line tells you
   whether a count has been done today.
3. **Tap "Count today →"** on the right side of the Today strip. This runs
   a chained Count sweep: Patio Bar → Back Bar → Store, with a "1 of 3"
   progress indicator at the top of each step.
   - For each step, walk the list and type what you count. The Expected
     column shows what the system thinks is there; the fourth column
     differs by location:
     - **Bars** show **Used since last count** (neutral grey) — the gap
       is what got poured, not an error.
     - **Store** shows **Variance** (green/red) — the storeroom only
       changes through logged entries, so any gap is unlogged and worth
       looking at.
   - Partial bottles on a bar: enter the fill level per open bottle
     (0.25, 0.5, 0.75, 1.00). An empty bottle is `0` — it logs as an
     Emptied event in Activity. Beer bars show one integer input per
     brand (no partials — beer bottles are either there or not).
   - **Store counts beer as cases + loose bottles.** The row has two
     inputs: cases on the stepper, and a loose field beside it (type
     `2` and `7` for two cases and seven loose). The system stores it as
     `2 × 24 + 7 = 55` bottles.
   - At the bottom: `Save & continue (N)` saves variances and advances;
     `No changes — continue` advances without saving if everything matched.
   - **Cancel** at any step exits the sweep. Steps already saved stay
     saved; nothing is rolled back.
4. **Count before the barback runs stock if possible.** Not required —
   gives are logged either way — but it keeps the numbers easier to read.
5. **Check the Reorder table** on the Dashboard — anything flagged OUT or
   LOW is a candidate for the next supplier order.

### When a number is off
After the sweep, scan the saved steps for anything that looked wrong.
A rule of thumb (adjust as you learn what's normal here):
- **Store:** any variance of 1 bottle (or 1 case for beer) or more.
- **Bars vs Toast:** used is noticeably higher than Toast sold for that
  shift (fill in your own threshold after a few weeks of data).

**What to do, in order:**
1. **Recount that bottle.** Most variances are a miscount.
2. **Check that bottle's Activity.** Look for a give, transfer, or
   receive that looks wrong or is missing.
3. **Ask whoever was on.** Usually it's "oh, I grabbed one and forgot to
   log it." That's fine. Log it with **Add entry** in Activity, picking
   the time it actually happened — the system won't double-dip against
   today's count.
4. **If it's still unexplained,** leave it. It shows in Reports under
   Store corrections. Patterns matter more than one bad day: the same
   bottle, the same shift, or the same person, over and over.

### During the shift (barback)
Primary surface: the Stock tab.

- **Give out** (store → bar): tap a bottle → **Give** → pick Patio/Back →
  pick quantity → **Give out**. For a quick full-case load, use "Run stock
  to a bar" (the big CTA on the Store view) which lets you add several
  lines in one pass.
- **Receive** (into store or a bar): tap a bottle → **Receive** → pick
  location → pick quantity → **Receive**. Used for miscellaneous arrivals
  (returned stock, a case brought from upstairs). Full invoiced deliveries
  are owner-only via the Delivery tab.
- **Transfer stock** (bar ↔ store, bar ↔ bar): tap a bottle → **Transfer
  stock** → pick from/to → pick quantity → **Transfer**.
- **Record wastage (bars only)**: tap a bottle → **Record wastage** →
  Patio or Back → pick quantity → reason → confirm. Barbacks log their
  own spills and breakage when it happens. Unlogged spills show up as
  unexplained usage against Toast and look the same as loss, so log
  them. Storeroom waste stays owner-only.
- **Undo**: on each bottle's sheet, "Recent on this bottle" lists the last
  few moves with an **Undo** button on your own entries.

### When a delivery arrives (owner, Delivery tab)
1. **Delivery tab → fill in Invoice # and Supplier.** Supplier auto-suggests
   from past suppliers; invoice duplicates are flagged inline.
2. **Add each line** by searching the bottle name. For case-sized items
   (beer), the row shows two inputs: `cases` on the stepper and `× NN` for
   bottles-per-case (editable per line — a 24-pack today, a 30-pack
   tomorrow). The subline shows "N bottles" totalled.
3. **Type the unit price** (per bottle) in the `$ / bottle` field. The
   footer sums `qty × unit price` for every line into a running total.
4. **Book delivery.** Everything lands as one atomic SQL batch — stock
   goes up and the moves log is written in a single statement, so a
   delivery is never half-recorded.
5. **Paperwork-only** mode (checkbox): tick if you already added the
   bottles manually via Receive and only need to record the invoice. The
   storeroom is not touched a second time.

Past deliveries are listed below, grouped by day. Expand one to see its
lines; **Edit delivery** (owner).

### Recording waste (owner, storeroom)
For storeroom breakage: tap a bottle → **Record wastage** → Store → pick
quantity → reason → confirm. Bar waste is logged by whoever was on shift
(see barback section). Waste is a distinct `waste` move so Reports can
tell breakage from pours.

---

## 4. The tabs

### Dashboard
What you see at open. Today strip (given/deliveries/poured/wasted +
last-count status + the Count-today button), rolling 7-day KPI tiles
(total bottles, out of stock, reorder, 7d gives/pours/waste), the Reorder
table, Store by category, trend lines, bar cards, wastage card, top movers.

### Stock
The working surface for all per-bottle actions. Location switcher at the
top (Store · Patio · Back), "Run stock to a bar" bulk give CTA (visible on
the Store view, for both roles), stats row, search, category chips, and
the bottle list. Tapping any bottle opens the sheet with the action tabs
appropriate to your role.

### Delivery
Owner-only. Draft a delivery (search → add lines → qty, case size, unit
price), see running total, book it in one go. Past deliveries list below.

### Activity
Everything that ever happened, newest first, grouped by day. Filter chips:
All moves · Give · Receive · Transfer · Waste · Count · Emptied. An
emptied-out bar bottle (a count that lands at 0) is tagged distinctly in
red with a ∅ icon. "Copy log (CSV)" exports every move.

Owner-only: **Add entry** to log a move the barback forgot to put in.
Pick what happened (give / receive / count), when it happened (any day in
the past), the bottle and quantity. If a count has already run on that
bottle *after* the time you pick, Add entry writes the row for history —
so Reports and the Toast tally come out right — without touching current
stock a second time. The physical count is already the truth.

### Manage (owner only)
- **Add a bottle**: name, category, in-store opening count, reorder level,
  bottles-per-case. Default case size is 24 when the category is Beer, 1
  otherwise.
- **Staff**: add new users (owner or staff role), disable leavers.
- **Reports**: generate the PDF comparing day/week/month against the prior
  period.
- **Categories**: create, rename, reorder, merge, delete-into-fallback.
- **All bottles**: searchable table; per-row reorder level editing,
  ignore-reorder toggle, edit sheet for name/category/bottles-per-case.

---

## 5. Rules the system enforces

- **Store stays whole.** CHECK constraint: `store = trunc(store)`. The
  storeroom cannot hold half a bottle.
- **Nothing goes negative.** CHECK constraints on `store`, `patio`, `back`.
  A give that would take the storeroom below zero is refused by the SQL.
- **Give and transfer only shuffle.** They never change the combined total
  across all three locations. Only receive, waste, and counts move the
  grand total.
- **Deliveries are atomic.** Every line in a delivery is written in one SQL
  statement. All of it lands or none of it does.
- **Duplicate invoices refused.** A `pg_advisory_xact_lock` on the invoice
  number stops two owners racing a double-booking.
- **Undo only works on the newest entry for a bottle.** A count is an entry
  too, so once a bottle's been counted, everything before it is locked.
  To fix something older, use **Add entry** in Activity or recount.
  Staff can undo their own entries; owners can undo any.
- **Role gates server-side.** Even if a staff user crafts a POST to a
  server action gated for owners, the server throws "Owners only".

---

## 6. Reports (PDF)

Owner-only. Dashboard → Manage → Reports → pick `vs yesterday`, `vs last
week`, or `vs last month` → **Generate report**. The PDF renders in-browser.

Contents, in order:
1. **What to order now** — the current reorder list, each item with the
   quantity below its line.
2. **Movement by category** — gives, receives, wastage, net change per
   category, compared to the prior period.
3. **Biggest movers** — the bottles that moved the most.
4. **Count corrections** — where the counted number disagreed with the
   system (the leakage signal).
5. **Wastage** — breakdown by reason.
6. **Deliveries** — by supplier.
7. **Stock sitting untouched** — bottles with no movement in the period.

Everything is quantity-based (no money anywhere in this layer — the
delivery cost column is separate). Pour cost and inventory value are
deliberately not computed.

The `/api/report` endpoint re-checks the session role itself, so a staff
account hitting it directly gets a 403 regardless of UI gating.

---

## 7. Tallying against Toast

The app tells you how much each bar *used*. Toast tells you how much it
*sold*. The gap is the real variance — leakage, pour overs, or missed
rings.

**Business day ends at 3 AM Central** in both the app and Toast. Set
Toast's closeout hour to 3 AM so both systems agree on what "Friday" is.

**Window:** each opening count covers the previous open shift.

| Count at | Covers |
|---|---|
| Thu 4 PM | Wed shift |
| Fri 4 PM | Thu shift |
| Sat 4 PM | Fri shift |
| Sun 4 PM | Sat shift |
| Wed 6 PM | Sun shift (Mon/Tue closed — nothing else should have moved) |

The Wednesday count is the cleanest leakage check of the week: any usage
beyond Sunday's Toast sales happened while the bar was closed.

**Units:** convert Toast usage to bottles before comparing
(`oz sold ÷ bottle size in oz`).

**What to look at:** bottles where *used* is noticeably higher than
*sold*. Check that bottle's Activity first — a missed give or transfer
is the usual cause — before treating it as loss.

- Toast report pulled: _____ (fill in).
- Threshold for "noticeably higher": _____ (fill in after a few weeks).

---

## 8. Setup (first time)

Local development:
```bash
npm install
cp .env.example .env.local            # fill in DATABASE_URL and SESSION_SECRET
node --env-file=.env.local scripts/setup.mjs      # schema + 124 items
node --env-file=.env.local scripts/setup.mjs <user> <pass> "<Name>"  # first owner
npm run dev
```

`setup.mjs` is idempotent — re-running it won't duplicate items or users.

Add staff from Manage once an owner exists. To reset a forgotten
password: **Manage → Staff → Reset password** on their row, type the new
one. The user's existing sessions are invalidated — they re-sign in with
the new password next time they open the app. The same row is kept, so
their history stays intact.

### Schema migrations
When new columns are added to the schema (e.g. `items.case_size`,
`moves.cost`, `moves.line_case_size`), the running app on Vercel will fail
until the prod DB is migrated:
```bash
node --env-file=.env.local.prod-backup scripts/setup.mjs --schema-only
```
Run this **before** pushing to main. The schema is `if not exists` so it is
safe to re-run; the `--schema-only` flag skips re-seeding items.

---

## 9. Known gaps / design decisions

- **Mixers raise no reorder alerts** — juices, syrups, salt and Tajin are
  consumables, not leakage risks. They still show OUT in the stock list
  but don't appear in dashboard alerts. Change `NO_REORDER_ALERTS` in
  `src/lib/model.ts` to undo this.
- **Reorder levels want a yearly tuning pass.** Seeded at 24 for beer,
  1 for everything else. After 2–3 weeks of real counts, walk Manage →
  All bottles and set each to roughly one week's usage plus a small
  buffer. Record the date here: last tuned on _____.
- **No "reset all"** — intentionally. Archive bottles in Manage; the
  activity log keeps every history row.
- **Historical bar numbers were unreliable** — the original workbook had
  double-counted rows in Patio Bar vs Back Bar. Bars started at zero in
  this app; the first few real counts are the truth.
- **Early Reports will show large positive "corrections".** Bars started at
  zero, so Reports from before the first full week of counts will exaggerate
  how much was found. Ignore the first week.

---

## 10. Troubleshooting

- **"Enter the invoice number for this delivery"** — the Book button stays
  disabled until an invoice number is typed.
- **"Invoice NNNN is already on a past delivery"** — inline warning while
  typing. Pick a different number or edit the existing delivery instead.
- **"That bottle is no longer in the list"** — the bottle got archived
  between you loading the screen and submitting. Reload.
- **Vercel deploy failed after a schema change** — the prod DB wasn't
  migrated. Run `scripts/setup.mjs --schema-only` with
  `.env.local.prod-backup` and the deploy will pick up on the next retry.
- **"Not authorized" on `vercel --prod`** — expected; Vercel auto-deploys
  from main pushes. Don't run `vercel --prod` directly.
