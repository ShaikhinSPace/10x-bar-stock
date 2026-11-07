# 10X Bar Stock — App Documentation

The single reference for how the app works, who does what, and how the
code is organised. If something here contradicts the actual UI, the UI
wins — flag the drift and this file gets updated.

---

## 1. What it is

A storeroom and bar stock-control app for a single bar. It replaces the
spreadsheet with per-location tracking (Store · Patio Bar · Back Bar),
an append-only move log, and daily counts. The difference between
consecutive counts is what each bar used.

**Business day ends at 3 AM Central.** Any move between midnight and
2:59 AM belongs to the previous shift. Toast is set to the same
closeout hour so both systems agree on what "Friday" means.

### Locations

- **Store** — whole, unopened bottles. Beer counts as cases (default
  24 per case; configurable per item via `items.case_size`).
- **Patio Bar** and **Back Bar** — partials for spirits (0.25, 0.5,
  0.75, 1.00 per open bottle). Beer stays whole on bars (no partials).
  The database stores everything in bottles; the UI switches units.

Each bottle's headline number is the total across all three locations.
Reorder alerts measure against the **storeroom only**.

---

## 2. Roles

Two roles, set when the user is created. Gates are enforced server-side
(`requireOwner()` / `requireUser()` in every action), not just hidden.

### Owner

- Sees every tab: Dashboard · Stock · Delivery · Activity · Manage.
- Lands on **Dashboard** after login.
- Can do everything staff can, **plus**: Count (bars and store), Record
  storeroom waste, book Deliveries, add/edit/archive bottles, manage
  staff and categories, generate the Reports PDF, undo any entry.

### Staff (barback)

- Sees only the **Stock** tab.
- Lands on `/stock/run` (bulk give-to-bar flow) after login.
- Actions: **Give** · **Receive** · **Transfer** · **Record wastage**
  (bars only, not storeroom).
- Can **undo** only their own entries.
- Cannot: Count, book Deliveries, see Dashboard / Activity / Manage,
  undo other people's entries.

---

## 3. Daily routine

### Shift open (owner)

1. Open the app → **Dashboard**.
2. The **Today strip** shows: given out, deliveries, poured, wasted.
   Below it: when each location was last counted.
3. Tap **Count today →** to run the chained sweep: Patio → Back →
   Store, with a progress indicator. Each step starts with an empty
   list — add bottles as you physically find them:
   - Search / tap to add a bottle to the count.
   - Bars: each add is one physical bottle. Type its fill level
     (0.25, 0.5, 0.75, 1.00). Multiple opens of the same brand =
     add it multiple times.
   - Store: each add is one brand. Type whole bottles.
   - A bottle you don't add counts as zero (it's not on the shelf).
   - **Save & continue** saves, shows a variance report, and
     advances. **Cancel** exits; saved steps stay saved.
4. Check the **Reorder table** — anything flagged OUT or LOW needs
   ordering.

### During the shift (barback)

Primary surface: the **Stock** tab.

- **Give out** (store → bar): tap bottle → Give → pick bar → qty →
  Give out. For a full shift load, use **Run stock to a bar** (bulk
  give, adds many lines in one pass — all-or-nothing).
- **Receive** (into store or bar): tap bottle → Receive → pick
  location → qty → Receive. For miscellaneous arrivals — invoiced
  deliveries go through the Delivery tab.
- **Transfer** (bar ↔ store, bar ↔ bar): tap bottle → Transfer stock
  → from/to → qty → Transfer.
- **Record wastage** (bars only): tap bottle → Record wastage → pick
  bar → qty → reason → confirm. Storeroom waste is owner-only.
- **Undo**: on the bottle's sheet, "Recent on this bottle" lists moves
  with an Undo button on your own entries.

### Deliveries (owner)

1. **Delivery tab** → fill Invoice # and Supplier (autocomplete from
   past suppliers; duplicate invoices flagged inline).
2. Add lines by searching bottle names. Beer rows show cases × size
   (editable per line). Type the unit price per bottle.
3. **Book delivery** — one atomic SQL batch. Stock goes up and the
   log is written together.
4. **Paperwork-only** mode: tick if bottles were already received
   manually and you only need the invoice record. Stock is not
   touched a second time.

Past deliveries listed below, grouped by day. Expand → Edit.

### When a number is off

1. Recount that bottle.
2. Check Activity for a missed or wrong entry.
3. Ask whoever was on shift.
4. If still unexplained, leave it. Patterns in Reports matter more
   than one bad day.

### Tallying against Toast

The app tells you how much each bar **used**. Toast tells you how much
it **sold**. The gap is leakage, over-pours, or missed rings.

Convert Toast oz to bottles before comparing. Bottles where used is
much higher than sold: check Activity first — a missed give is the
usual cause.

---

## 4. The tabs

### Dashboard

Today strip (given / deliveries / poured / wasted + last-count status +
Count-today button). Rolling 7-day KPI tiles. Reorder table. Store by
category chart. Trend lines. Bar cards. Wastage card. Top movers.

### Stock

Location switcher (Store · Patio · Back). Run stock to a bar (bulk
give). Stats row. Search bar. Category chips. Bottle list → tap to
open the action sheet (tabs depend on role).

### Delivery (owner)

Draft a delivery (search → add lines → qty, case size, unit price).
Running total. Book. Past deliveries list below with edit.

### Activity

Every move, newest first, grouped by business day. Filter chips: All ·
Give · Receive · Transfer · Waste · Count · Emptied. CSV export.

Owner-only **Add entry**: log a move a barback forgot. Pick type
(give / receive / count), date, bottle, quantity. If a count ran after
the chosen time, the entry is logged for history without touching
current stock (the count is already the truth).

### Manage (owner)

- **Add a bottle**: name, category, opening count, reorder level,
  case size.
- **Staff**: add / disable users, reset passwords.
- **Categories**: create, rename, reorder, delete (into fallback).
- **All bottles**: searchable table, per-row reorder editing,
  ignore-reorder toggle, edit sheet.
- **Reports**: PDF comparing day / week / month against the prior
  period. Contents: what to order, movement by category, biggest
  movers, count corrections (the leakage signal), wastage, deliveries
  by supplier, stock sitting untouched. Quantity-based — no money.

---

## 5. Rules the system enforces

- **Store stays whole.** `CHECK (store = trunc(store))`.
- **Nothing goes negative.** `CHECK` on store, patio, back.
- **Give and transfer only shuffle.** Combined total is unchanged.
  Only receive, waste, and counts change the grand total.
- **Deliveries are atomic.** All lines land or none do.
- **Duplicate invoices refused.** Advisory lock on the invoice number.
- **Undo only the newest entry per bottle.** Once counted, everything
  before it is locked. Fix older mistakes with Add entry or recount.
- **Role gates server-side.** A staff POST to an owner action is
  refused regardless of the UI.

---

## 6. Architecture

```
Next.js 16 App Router (React 19, TypeScript)
  │
  ├── /login                      → signed cookie (scrypt, brute-force throttle)
  ├── /(app)                      → authenticated shell
  │     ├── /dashboard            → overview + Count-today sweep
  │     ├── /stock                → per-bottle action sheet
  │     ├── /stock/run            → bulk give-to-bar
  │     ├── /delivery             → draft, book, edit (owner)
  │     ├── /activity             → append-only log, CSV export
  │     └── /manage               → items, staff, categories, reports
  │
  └── /api/report                 → PDF, owner-gated, built in-memory
```

- **Postgres** via Neon serverless (`@neondatabase/serverless`).
  Separate prod and dev branches; migrate prod with
  `setup.mjs --schema-only`.
- **No ORM** — raw SQL via tagged template literals.
- **No component library** — custom CSS in `globals.css`.
- **Deployed on Vercel** — `main` auto-deploys to prod.

---

## 7. Data model

### Tables

```
users           id, username, name, password_hash, role, active, session_version
categories      id, name, color, bar_color, raises_reorder_alerts, sort
items           id, name, cat, store, patio, back, rl, case_size,
                patio_levels[], back_levels[], ignore_reorder, archived
item_tags       item_id, cat  (extra categories for filtering)
moves           id, ts, type, item_id, item_name, cat, qty, loc, to_loc,
                from_val, to_val, batch, invoice, supplier, delivery_date,
                cost, line_case_size, notes, affects_stock, user_id, user_name
settings        key, value  (bar_name, business_day_cutoff_hour, business_tz, etc.)
locations       slug, label, short, color, mark_color, sort
roles           slug, label, description, sort
wastage_reasons id, label, sort
login_attempts  username, fails, locked_until, updated_at
```

### Key relationships

- `items.cat → categories.name ON UPDATE CASCADE` — renaming a
  category flows to every item automatically.
- `item_tags.cat → categories.name ON UPDATE CASCADE` — same for tags.
- `moves.item_id → items.id` — every move references its item.
- `items.store/patio/back` are the authoritative stock figures.
  `patio_levels[]` / `back_levels[]` are the per-bottle breakdown
  behind the bar scalars.
- A delivery is the set of `receive` moves sharing a `batch` id. No
  separate deliveries table — `editDelivery` rewrites atomically via
  arithmetic deltas.

### Move types

| Type | What happens | Key columns |
|------|-------------|-------------|
| `give` | Store → bar (or unknown bar if `loc` is null) | qty, loc |
| `receive` | Into store or bar | qty, loc |
| `count` | Set a location to the counted figure | loc, from_val, to_val |
| `waste` | Remove from a location | qty, loc, notes |
| `transfer` | Move between locations | qty, loc (from), to_loc (to) |

---

## 8. Code map

### Server actions (`src/app/actions/`)

| File | Functions | Who |
|------|-----------|-----|
| `stock.ts` | `giveOut`, `giveRun`, `receive`, `countBarBottles`, `countStore`, `logWaste`, `transferBar`, `undoMove`, `addEntry` | user / owner varies |
| `stocktake.ts` | `submitStocktake` | owner |
| `deliveries.ts` | `receiveDelivery`, `editDelivery` | owner |
| `items.ts` | `addItem`, `editItem`, `setCaseSize`, `setReorderLevel`, `setReorderIgnore`, `batchSetReorderLevels`, `archiveItem` | owner |
| `categories.ts` | `createCategory`, `renameCategory`, `deleteCategory`, `mergeCategories`, `moveCategory` | owner |
| `users.ts` | `addUser`, `setUserActive`, `resetPassword` | owner |
| `settings.ts` | `updateSetting` | owner |
| `auth.ts` | `login`, `logout` | anyone |

### Shared modules (`src/lib/`)

| File | Purpose |
|------|---------|
| `model.ts` | Types (`Item`, `Move`, `Category`, `Loc`, etc.) and pure helpers (`stockAt`, `fmt`, `fmtQty`, `needsReorder`, `bizDayKey`, `levelsAt`, etc.) |
| `db.ts` | Database connection + read queries (`getItems`, `getMoves`, `getDeliveries`, `getCategories`, `getLocations`, etc.). Re-exports `model.ts`. |
| `stock-move.ts` | Core SQL for stock mutations: `applyGive`, `applyReceive`, `applyStoreCount`, `logMoveOnly`. Each CTE pattern lives here once. |
| `give-run.ts` | `applyGiveRun` — all-or-nothing multi-bottle give to a bar. |
| `undo-move.ts` | `applyUndo` — reverse a move with guards (counted, superseded, short, gone). |
| `auth.ts` | Session cookie management, `requireUser`, `requireOwner`, password hashing (scrypt). |
| `pdf.ts` | Direct PDF generation (objects + content streams, no library). |
| `report.ts` | Report data assembly — period stats, reconciliation, on-hand reconstruction. |
| `schema.sql` | Idempotent schema (`CREATE IF NOT EXISTS` + `ALTER ADD COLUMN IF NOT EXISTS`). |

### UI (`src/app/(app)/ui/`)

| File | What it renders |
|------|----------------|
| `dashboard.tsx` | Dashboard: Today strip, KPI tiles, reorder table, charts |
| `stock.tsx` | Stock tab: bottle list, location switcher, Run mode |
| `bottle-sheet.tsx` | Per-bottle action sheet (Give / Receive / Count / Waste / Transfer / Undo) |
| `delivery.tsx` | Delivery tab: draft basket, line editor, past deliveries |
| `activity.tsx` | Activity log with filters, Add entry (owner), CSV export |
| `manage.tsx` | Manage tab: bottles CRUD, staff, categories, reports |
| `shared.tsx` | Shared UI helpers: sort, column headers, day formatting, popover |

### Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `setup.mjs` | Schema migration + item seeding. `--schema-only` for prod. |
| `check.mjs` | SQL semantics tests against real DB. |
| `check-report.mjs` | Proves report reconciliation math. |
| `zero-stock.mjs` | Reset stock to zero (untracked). |

---

## 9. Setup

```bash
npm install
cp .env.example .env.local            # fill in DATABASE_URL and SESSION_SECRET
node --env-file=.env.local scripts/setup.mjs                        # schema + seed
node --env-file=.env.local scripts/setup.mjs <user> <pass> "<Name>" # first owner
npm run dev
```

`SESSION_SECRET` signs the cookie — generate with `openssl rand -hex 32`.
Use a different value on Vercel than locally.

`setup.mjs` is idempotent. Add staff from Manage once an owner exists.
Reset a forgotten password from Manage → Staff → Reset password.

### Schema migrations

When columns are added to schema.sql, migrate prod **before** pushing:

```bash
node --env-file=.env.local.prod-backup scripts/setup.mjs --schema-only
```

### Deploying

Push to `main` → Vercel auto-deploys. Do not run `vercel --prod`
(team-account block, always "Not authorized").

Prod DB: Neon branch `ep-calm-mode` (connection in `.env.local.prod-backup`).
Dev DB: Neon branch `ep-lively-wave` (connection in `.env.local`).
