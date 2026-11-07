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

| | Give / Receive / Transfer / Waste | Count | Deliveries | Undo | Manage |
|---|---|---|---|---|---|
| **staff** | yes (bar waste only) | no | no | own entries | no |
| **owner** | yes (incl. store waste) | yes | yes | any entry | yes |

Only the newest entry for a bottle can be undone — reversing an older one would
clobber whatever was logged after it. Correct an older mistake with a **Count**.

## Documentation

See **[docs/APP.md](docs/APP.md)** for the full reference: how to use the
app (by role, daily workflows, each tab), the data model, every server
action, and the code map.
