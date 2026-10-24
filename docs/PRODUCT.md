# 10X Bar Stock

An honest stock-control app for a single bar — bottle in, bottle out,
counted in minutes, variance surfaced before the next shift. Built as a
replacement for the spreadsheet that was already running the business, and
designed around what the owner actually does, not what a POS vendor
imagines they do.

Reading time: 10 minutes. For another developer or founder weighing whether
this is interesting, forkable, or something they want to help ship further.

---

## The problem

Every bar is a small warehouse with staff who are not warehousemen. The
owner knows exactly which bottles are hemorrhaging and which aren't — until
they try to prove it. The usual options:

- **A real POS** (Toast, Square for Restaurants, Lightspeed). Fine for
  front-of-house, but inventory is a bolt-on module priced for a chain. For
  a single bar it is $200+/month of software to replace a $0 spreadsheet.
- **A big inventory stack** (BevSpot, Partender, WISK). Sold around
  photographing bottle levels or scanning labels — real, impressive tech
  that assumes a thirty-SKU neighbourhood wine bar. For a bar with 140
  liquor SKUs and a 24-pack of Modelo rotation, it is overkill in surface
  area and underkill in flow: the owner still ends up with a Google Sheet
  that reconciles against it.
- **The spreadsheet.** What everyone actually uses. One tab per bar,
  weekly counts, formulas that break the first time someone types a word
  into a number cell. 10X Bar's original workbook had rows 35–45 of Patio
  Bar identical to rows 37–47 of Back Bar — a copy-paste from six months
  back, carried forward every week.

The common pattern is that **the bar's own numbers are wrong, and nobody
knows which numbers are wrong, and the cost of finding out is a Sunday
afternoon with a clipboard**. The system that would catch leakage ends up
being the thing that permits it.

---

## The thesis

Three claims the product rests on:

1. **Per-location, or you're guessing.** A combined total hides the
   leakage. Stock lives in three places (Store, Patio Bar, Back Bar) and
   the only interesting number is the delta between what the storeroom
   released and what the bars still hold. A spreadsheet with one column
   per bottle cannot answer this.
2. **A count is a stocktake.** Nothing more. The industry pretends these
   are two different ceremonies — a "stocktake" is a quarterly
   accountant-visiting event, counts are a daily chore. In reality,
   `today's count − yesterday's count + received − given = used`. The
   stocktake is a view of the move log, not a parallel system. Build it
   that way and the question "what disappeared" has a one-screen answer at
   the end of every shift.
3. **The owner is the audit trail.** Append-only `moves`. Every give,
   receive, count, waste, transfer is a row with who, when, what, where.
   Undo is a reverse-move the system computes, not an actual delete. This
   is the one thing POS vendors do that spreadsheets cannot, and it is
   the whole value.

Everything else in the app is in service of these three.

---

## How it works, from the owner's chair

### A day

9:00 AM. Owner opens the app on their phone. Dashboard shows:
- A "Today" strip: zero given, zero deliveries, zero poured, zero wasted,
  and the critical line: `Last count — Patio never · Back not today ·
  Store never`.
- A rolling 7-day KPI strip underneath.
- A Reorder table with 29 items flagged.
- Store-by-category chart; trend lines; per-bar cards.

9:02. Tap **Count today →**. The sweep walks them through Patio Bar
(bottle-by-bottle fill levels: 0.75, 0.5, 1.00 per open bottle), then Back
Bar, then Store (whole bottles for spirits, cases for beer). Each step
shows an Expected column and a Variance column that colours as they type.
Each step is one atomic save; cancelling mid-sweep keeps completed steps.
About eight minutes end-to-end at a 140-SKU bar.

11:00 AM. Delivery arrives from Republic National: 54 bottles across 12
SKUs plus a case of beer. Owner opens the Delivery tab, types the invoice
number (duplicates caught inline), picks the supplier from an autocomplete,
adds each line (`+1 case` for beer with a `× 24` input per line because
beer cases vary by brand), types the unit price per bottle. Running total
sums every line. One tap: **Book delivery**. Lands as one atomic SQL
batch — storeroom goes up, every move row is written, done.

2:30 PM. A barback runs out of Grey Goose on the patio. Tap the bottle on
the Stock tab → **Give** → Patio → 1 → Give out. Store minus one, patio
plus one. The combined total hasn't changed; the leakage ledger is clean
because every move is logged.

4:45 PM. Barback knocks over a bottle of Jameson. Owner (barbacks can't do
this) taps the bottle → **Record wastage** → Patio → 0.75 → Spill. Patio
drops by 0.75; the Wasted tile ticks up.

11:30 PM. Owner runs **Count today** again on their way out — same sweep,
chained Patio → Back → Store. The system records the end-of-day numbers.
The "stocktake" (what was used) is the delta between these counts plus
receives minus gives minus waste, and it's already in the move log; the
Reports PDF will surface it per-category and per-bottle.

### A barback's day

Lands on `/stock/run` after login — the bulk-give flow for stocking a bar
at shift start. Nav tabs are reduced to just Stock. Bottle sheet shows
only Give / Receive / Transfer stock. Can't count, can't waste, can't book
deliveries, can't see Reports or Manage. Can only undo their own entries.

### The weekly reconciliation

Owner → Manage → Reports → `vs last week` → PDF. Contents in this order:
what to order now, movement by category, biggest movers, count corrections
(the leakage signal), wastage, deliveries by supplier, stock sitting
untouched. All quantity-based. No prices, pour costs, or inventory value
anywhere — those would be guesses the data cannot support.

---

## Opinionated decisions

Choices made that another dev looking at this should see as deliberate:

- **No money inside the stock ledger.** Delivery lines carry a cost column
  (owner tracks spend), but nothing propagates to pour cost, inventory
  value, or margins. The real sell price is at the POS and depends on
  cocktail recipes the app does not model. Faking those numbers would
  make the Reports PDF less honest, not more useful.
- **Store counts as whole bottles. Beer counts as cases. Bars count as
  partials.** Enforced in both the CHECK constraint on `items.store` and
  the UI. Case size is per-item (`items.case_size`, default 1, beer
  seeded 24) and overridable per delivery line
  (`moves.line_case_size`) so a 30-pack today is recorded as what it
  actually was.
- **Daily count is the primary ritual, not weekly.** The sweep is on the
  Dashboard, titled with the day. If you want the weekly variance, it is
  derived from the daily counts, not a separate task.
- **Append-only moves.** Edits to deliveries are atomic rewrites in place
  (the delivery is the set of receive moves sharing a batch id). Undo is
  an explicit rule, not a time machine: only the newest entry for a
  bottle is undoable, because reversing an older one would clobber what
  was logged after.
- **Role gates server-side, not just hidden.** `requireOwner()` in every
  server action that writes beyond the barback's remit. A staff cookie
  POSTing to `/api/...` is refused regardless of the UI.
- **Session cookie, not a third-party auth service.** `SESSION_SECRET`
  signs it; a brute-force throttle is keyed by attempted username so a
  guessed name is throttled the same as a real one. ~150 LOC in
  `src/lib/auth.ts` and that is the whole auth system.
- **Custom PDF.** `src/lib/pdf.ts` writes PDF bytes directly (objects +
  one content stream per page, indexed by a xref table). No rendering
  library. Boring, deterministic, 250 LOC. Runs in a serverless function
  with no headless Chrome.
- **One table for the audit trail.** `moves` is append-only;
  `items` holds current scalars that are the sum of their move history.
  You could rebuild `items` from `moves` if you had to. (The report
  checker does exactly this to prove reconciliation.)
- **No bar-code scanner.** Shipped briefly, removed because it was a
  camera-less text filter dressed up as one. The honest surface is
  tapping the bottle; a real scanner is deferred until the bar actually
  owns scannable barcodes on every bottle.

---

## Architecture (brief)

```
Next.js 16 App Router (React 19, server actions)
   │
   ├── /login                       → signed cookie
   ├── /(app)                       → authenticated shell
   │     ├── /dashboard             → overview + Count-today sweep
   │     ├── /stock                 → per-bottle action sheet
   │     ├── /stock/run             → bulk give-to-bar
   │     ├── /delivery              → draft, book, edit (owner)
   │     ├── /activity              → append-only log, CSV export
   │     └── /manage                → items, staff, categories, reports
   │
   └── /api/report                  → PDF, owner-gated, built in-memory
```

- **Postgres** via Neon (prod and dev on separate branches).
- **Server actions** for every write: `giveOut`, `giveRun`,
  `receive`, `receiveDelivery`, `editDelivery`, `countBarBottles`,
  `countStore`, `submitStocktake`, `logWaste`, `transferBar`, `undoMove`,
  `addItem`, `editItem`, `setCaseSize`, `setReorderLevel`,
  `setReorderIgnore`, `batchSetReorderLevels`, `archiveItem`,
  `createCategory`, `renameCategory`, `deleteCategory`, `mergeCategories`,
  `moveCategory`, `addUser`, `setUserActive`.
- **Deployed on Vercel.** `main` auto-deploys to prod. No preview-to-prod
  dance; schema migrations are run by hand before pushing a column change
  (`node --env-file=.env.local.prod-backup scripts/setup.mjs
  --schema-only`).
- **No build-time tests gating deploy.** Instead, a `scripts/check.mjs`
  that runs against a real database and proves the SQL semantics
  (read-before-write CTEs, CHECK constraints, duplicate-invoice refusal,
  undo's not-the-latest guard). A `scripts/check-report.mjs` proves every
  move type by running it against the DB and measuring what actually
  changed. These are run manually before a risky change.

---

## Data model

Four tables and one view-equivalent in SQL:

```sql
users         (id, username, name, password_hash, role, active)
items         (id, name, cat, store, patio, back, rl,
               patio_levels numeric[], back_levels numeric[],
               case_size, ignore_reorder, archived)
item_tags    (item_id, cat)   -- extra categories a bottle filters under
categories   (id, name, sort)

moves        (id, type, item_id, item_name, cat,
              qty, loc, to_loc,
              from_val, to_val,
              batch, invoice, supplier, affects_stock,
              cost, line_case_size,
              notes, user_id, user_name, ts)
```

Everything else — reorder lists, variances, deliveries — is a query over
these. A delivery has no table of its own; it is the set of `receive` moves
sharing a `batch` id, which lets `editDelivery` rewrite one as a single
atomic SQL statement operating on arithmetic deltas per bottle.

The scalar `items.store/patio/back` are authoritative for the UI and for
every CHECK constraint; `patio_levels` / `back_levels` are the per-bottle
breakdown behind the bar scalars (empty when nobody has counted
bottle-by-bottle yet).

Store counts are whole bottles. Bar counts can be partial. Beer counts as
cases on the store screen and the single-bottle Count UI, and as integer
bottles on the bar — the DB stores bottles throughout; only the UI shifts
units.

---

## What's shipped

Everything in `docs/SOP.md`:
- Role-split UI (owner / staff) with server-side gates.
- Dashboard with Today strip, Count-today sweep, rolling 7d tiles,
  reorder table, trend/bar/wastage/top-mover cards.
- Stock tab with location switcher, per-bottle action sheet,
  bulk give-run.
- Delivery tab with inline validation, supplier autocomplete, per-line
  unit price + case size, auto-summed total, paperwork-only mode,
  atomic edit of past deliveries.
- Activity log with filter chips, Emptied-flag for drained bar bottles,
  CSV export.
- Manage with bottle CRUD, staff admin, categories, Reports PDF.
- Append-only moves with undo rules, duplicate-invoice guard,
  atomic deliveries, CHECK constraints, business-day logic for counts
  near midnight.

Running in production at a single bar. ~150 bottles, two users (one owner,
one barback), ~15 moves/day typical, deliveries weekly. Costs: Vercel Hobby
tier + Neon free tier. $0/month until it outgrows one of them.

---

## Where this could go

Either as this bar's internal tool or as something broader:

- **Multi-bar.** Nothing in the data model is wedded to one bar — add a
  `tenant_id` on every table, scope every query, and the architecture
  carries. The honest work is the operational layer (billing, onboarding,
  per-tenant isolation).
- **Recipe & pour cost.** The pour-size dataset doesn't exist here; add it
  and the Reports PDF can start carrying margin per category. This was
  deliberately out of scope — adding it means asking the bar to maintain
  recipes, which is a different kind of commitment.
- **A real barcode scan.** When bottle vendors ship with scannable UPCs
  the bar actually trusts, the fake scanner we removed earns its place
  back. Point the camera at a bottle, the sheet opens on that item.
- **Supplier integrations.** Republic National, Southern Glazer et al.
  send invoices as PDFs. OCR them into delivery drafts and the owner's
  slowest manual task vanishes.
- **A B2B SaaS, if anyone wants that.** Everything in here was built for
  one owner and would need the usual polish, support surface, and
  pricing instinct. The product thesis holds either way: per-location,
  daily counts, append-only, no money inside the ledger.

---

## What it is not, and never will be

- A POS.
- A payroll system.
- A COGS calculator (needs sell prices).
- A supplier marketplace.
- A compliance tool.
- A recipe book.

The product line it holds: inventory for a bar that is already running on
a spreadsheet. Everything else is other people's problem.

---

## For a developer picking this up

- Stack: Next.js 16 App Router, React 19, TypeScript, Neon Postgres,
  Vercel. No ORM — raw SQL via `@neondatabase/serverless`. No component
  library — ~2000 lines of CSS in `src/app/globals.css`.
- Entrypoints to read first, in order: `src/app/(app)/shell.tsx`
  (layout + nav), `src/lib/model.ts` (types + helpers), `src/lib/db.ts`
  (queries), `src/app/actions/` (writes). Then whichever UI matches
  your interest.
- Tests: `scripts/check*.mjs` run against a real database. There is no
  Vitest / Jest / Playwright. Deliberate.
- Not-the-Next.js-you-know: the project is pinned to a cutting-edge Next
  with breaking changes vs. the training cutoff; `AGENTS.md` points
  future contributors at `node_modules/next/dist/docs` before writing
  anything.

That's the shape of it.
