# 10X Bar — Stock Control

Storeroom and bar stock control for 10X Bar. Replaces the
`10X_Bar_Stock_Management.xlsx` workbook.

The point is catching leakage between what leaves the storeroom and what each bar
actually has — so everything is tracked per location (Store / Patio Bar / Back Bar)
rather than as one total.

Each bottle's headline figure on the Stock tab is its **total across all three
locations**, with the Store / Patio / Back split shown underneath. Reorder is measured
against the **storeroom only** — you reorder from the supplier into the store, not into
a bar.

- **Store** counts whole, unopened bottles.
- **Patio Bar** and **Back Bar** count partials (`0.25`, `1.87`), matching how the
  bar sheets in the workbook were kept.

Next.js 16 (App Router) · React 19 · Neon Postgres · deployed on Vercel.

## Running it locally

```bash
npm install
cp .env.example .env.local     # then fill in both values
node --env-file=.env.local scripts/setup.mjs            # schema + 124 items
node --env-file=.env.local scripts/setup.mjs <username> <password> "<Full Name>"   # first owner
npm run dev
```

`SESSION_SECRET` signs the login cookie — generate one with `openssl rand -hex 32`.
Use a **different** value in Vercel than locally.

`scripts/setup.mjs` is safe to re-run: the schema is `if not exists`, items are
`on conflict do nothing`, and an existing username is left alone.

## Checks

```bash
node --env-file=.env.local scripts/check.mjs   # SQL semantics + DB constraints
npx tsc --noEmit && npx eslint . && npx next build
```

`check.mjs` runs against the real database and cleans up after itself. It covers the
parts that would silently corrupt stock: the read-before-write CTEs, the refusal to
give out more than the storeroom holds, partials surviving a bar count, and the
CHECK constraints (store stays whole, nothing goes negative).

## Deploying to Vercel

1. Push to GitHub.
2. Import the repo in Vercel.
3. Add `DATABASE_URL` and `SESSION_SECRET` under Settings → Environment Variables.
4. Deploy. The schema and seed only need running once, against the same Neon
   database, from your machine.

## Deliveries

A delivery arrives as one drop with many lines, so the **Delivery** tab is a draft
basket: search, add lines, adjust quantities, then book the lot in one action.
Beer adds by the case (24), everything else a bottle at a time.

Every line of one delivery shares a `batch` id and carries the optional invoice and
supplier the workbook's `Stock In` sheet used to record. The whole delivery lands in
a single SQL statement, so it is all-or-nothing — stock and its log entries appear
together or not at all. Duplicate lines for the same bottle are merged before
booking.

## Reports

Owners get a **Reports** card on the Manage tab. It answers "what changed,
and what do I do about it" — every figure is shown against the period
before, picked as **vs yesterday / vs last week / vs last month**
(`/api/report?period=day|week|month`, which re-checks the session itself, so
a staff account gets a 403 whether or not the button is on screen).

The front page reconciles as a stock account:

```
closing = opening + received - wasted + counted_up - counted_down
```

`opening` is not stored anywhere — it is reconstructed by taking today's
total and unwinding every move since. That works because **give** and
**transfer** only shuffle stock between the storeroom and the two bars, so
they leave the combined total untouched; only receive, waste and counts
change it. `scripts/check-report.mjs` proves exactly that, by running each
move type against the real database and measuring what it actually did.

Then, in order: what to **order** now, movement **by category**, the
**biggest movers**, **count corrections** (where a physical count disagreed
with the system — the leakage signal this app exists for), **wastage**,
**deliveries** by supplier, and stock **sitting untouched**.

Everything is quantity-based. There is no cost or price anywhere in this
database, so pour cost, inventory value and COGS are not computable and are
deliberately absent rather than guessed at. For the same reason a count
coming down cannot be split into "sold" versus "walked off" — the report
labels that figure honestly instead of implying it is shrinkage.

`src/lib/pdf.ts` writes the PDF directly (objects plus one content stream
per page, indexed by a byte-offset xref table) rather than pulling in a
rendering library. Run the checks after touching either file:

```bash
node --env-file=.env.local --experimental-strip-types scripts/check-report.mjs
```

## Roles

| | Give out / Receive / Count | Undo own entry | Manage bottles, staff & reports |
|---|---|---|---|
| **staff** | yes (incl. deliveries) | yes | no |
| **owner** | yes (incl. deliveries) | any entry | yes |

Only the newest entry for a bottle can be undone — reversing an older one would
clobber whatever was logged after it. Correct an older mistake with a **Count**.

## Where the data came from

`src/lib/seed-items.json` is generated from the workbook's `Inventory` sheet
(the *Current Stock* column, which nets opening + in − out), plus five SKUs that
only ever appeared on the bar sheets:

`TAAKA`, `KENTUCKY GENTLEMAN`, `BLUE ICE`, `BARTON NATURALS`, `CALYPSO SILVER` —
seeded at store 0, since the storeroom is simply out of them.

Three bar-sheet names were merged as misspellings of storeroom items:
`JAGERMEISTER`→`JAEGERMEISTER`, `SCREWBALL`→`SKREWBALL`, `BUCANA`→`BUCHANAN`.

Bars start at zero. Staff enter real bar counts with the **Count** action.

## Known gaps

- **Reorder levels are still estimates.** The workbook left the column blank for all
  119 items. Seeded at one case (24) for beer and 1 for everything else, which gives
  28 day-one alerts (15 of them genuinely at zero) rather than the 55 that a blanket
  rl=2 produced. Editable per item in Manage — worth confirming with the owner.
- **Mixers raise no reorder alerts.** Juices, syrups, salt and Tajin are consumables,
  not leakage risks, and were 11 of the original 55 alerts. They still show OUT on the
  Stock tab, but never appear in the dashboard alert list or the "Need reorder" count.
  Change `NO_REORDER_ALERTS` in `src/lib/model.ts` to undo this.
- **Two bar SKUs were left out**: the bar sheets list a bare `CASAMIGOS` and a bare
  `DON JULIO`, but the storeroom carries two Casamigos and five Don Julio variants.
  Rather than guess a merge, neither was added — add them in Manage if the bars
  genuinely hold an unlabelled bottle.
- **The bar sheets double-counted.** Rows 35–45 of `Patio Bar` are identical to rows
  37–47 of `Back Bar`, and 8 of those 11 already appear higher up the Patio sheet.
  Since bars start at zero, none of it was imported — but it is worth knowing the
  old bar numbers were unreliable.
- **No "reset all".** The old single-file version had one. Against a shared database
  with a real audit trail, it is a footgun; archive bottles in Manage instead.
