# BUGS.md — static sweep, no files edited

Scope: `src/**`, `scripts/**`, schema. Read directly; nothing was run.
Format: `file:line` — what's wrong — **severity** — fix idea.

Scope notes:
- **No Supabase.** The app uses Neon (`@neondatabase/serverless`), so the "Supabase without error handling" check became "`sql` calls outside `attempt()`". Every Server Action is wrapped in `attempt()` (`_shared.ts:8`). The exceptions are in the list below.
- **No setState/provider-after-dispose bugs found.** The toast timer in `shell.tsx:82-87` is cleaned up, and every `addEventListener` has a matching remove.
- Findings marked (carried over) came from an earlier code-review agent's report. I re-read the cited code and they hold.

## High

- [x] `src/lib/db.ts:122-134` — `getDeliveries` groups on `batch is not null` with no `type = 'receive'` filter. `submitStocktake` stamps `S…` batches on its `count` moves (`stocktake.ts:44,71`). Every stocktake therefore shows up on the Delivery tab as a 0-bottle "delivery" with invoice "—", and it can be opened in the editor. `editDelivery` would then delete the count moves and insert `receive` moves. The report's "deliveries" KPI is inflated the same way (`report.ts:66,311`). **high** — add `and type = 'receive'` here and in both report queries. (`applyDeliveryEdit`'s `old`/`del` CTEs also need the filter.)
- [x] `src/lib/undo-move.ts:73-77` — the undo `receive` branch always does `store = store - qty`. `addEntry` can now receive onto `patio` or `back` (`stock.ts:315-337`). Undoing that entry takes stock out of the store and leaves the bar inflated. It silently corrupts counts, or is refused as "short" if the store is low. **high** — branch on `m.loc` (subtract from the loc it landed in, and reset that bar's `*_levels`).
- [x] `src/app/actions/deliveries.ts:66-78` and `src/lib/give-run.ts:52` / `stock.ts:95-97` — partial commit followed by an error. If one bottle was archived mid-flow, the single statement still commits the other lines (stock moved, moves logged). `rows.length !== ids.length` then throws "Some bottles are no longer on the list". The user sees a failure, the cart stays, and retrying either double-gives or hits "Invoice already booked". **high** — add an `ok`/`missing` CTE like `applyDeliveryEdit` uses, so any archived or missing id makes the whole statement a no-op.
- [x] `src/lib/undo-move.ts:44-126` — `applyUndo` runs 3-4 separate statements (check, stock update, levels reset, `delete from moves`) with no transaction. Two quick taps on Undo (or owner and barback) both pass the check, both update stock, and both delete the move, so the reversal is applied twice. A failure between the update and the delete leaves stock changed with the move still in the log (a second undo then double-reverses). **high** — do `delete from moves where id = … returning *` first inside `sql.transaction([...])`, and apply the delta only if a row came back.

## Medium

- [x] `src/app/actions/deliveries.ts:45-50` — the "can't both get through" claim about the `guard` CTE is false under READ COMMITTED. Two concurrent bookings of the same invoice both see no existing row. There is no unique index on `invoice`, and can't be one because lines share it. **med** — `pg_advisory_xact_lock(hashtext(inv))` in a transaction, or a small `invoices(invoice primary key)` table inserted in the same statement.
- [x] `src/app/(app)/shell.tsx:90-98` — `run()` does `await fn()` inside `startTransition` with no try/catch. Any network failure or 500 rejects the action promise, so no toast appears, `pending` ends, and the user can't tell whether the give saved. This hits every button in the app. **med** — wrap in try/catch, `setToast({msg:"Network error — check and retry", error:true})`.
- [x] `src/app/(app)/ui/dashboard.tsx:34-36` — (carried over) `poured7` sums every `count` move with no `loc` check. `addEntry`'s store count (`loc='store'`) is counted as bar "poured". A 50→40 storeroom correction reports 10 poured. **med** — `&& m.loc !== "store"`.
- [x] `src/app/actions/stock.ts:363` / `undo-move.ts:46-48` — (carried over) a backdated store count has an old `ts`, so it is never the newest move for its bottle. It is always "superseded" and the Undo button is never offered. The `addEntry` doc comment and UI hint say "undo reverses it". A mistyped store count can't be undone. **med** — allow undo of a count when no later move exists, ignoring the `ts` backdating (compare `id`, not `(ts, id)`), or fix the copy.
- [x] `src/lib/report.ts:~82-93` (`onHandAt`) — the comment says give/transfer "net to zero", but an unknown-bar give (`loc` null, `store - q`, no bar credit) removes stock from the total. Reconstructed opening/closing on-hand is then off by those quantities until a bar count absorbs them. **med** — treat `give` with null `loc` as `-qty` in the unwind.
- [x] `src/app/(app)/ui/manage.tsx:19` — (carried over) `useState<Cat>("WHISKEY")` is hardcoded and never reconciled with `cats`. After WHISKEY is renamed or deleted, the select shows blank and `addItem` throws "Pick a category". **med** — default to `cats[0]?.name ?? ""`.
- [x] `src/app/(app)/ui/activity.tsx:186-189` — (carried over) an empty qty gives `Number("") === 0`, which passes `n >= 0` for count. "Add entry" with a blank field zeroes the storeroom. **med** — require `qty.trim() !== ""`.
- [x] `src/app/(app)/ui/manage.tsx:318-322` — the reorder input is uncontrolled (`defaultValue`) and `onBlur` does `Number(e.target.value)`. Clearing it sends `0`. Typing `abc` sends NaN, which `partial` rejects with a toast, but the field keeps the garbage. After a server refresh the field doesn't follow `i.rl`. **med** — skip blank/NaN, and key the input on `i.rl` so it resets.

## Low

- `src/lib/undo-move.ts:48` — `newest.id`. If the count was just deleted by a concurrent undo, `newest` is undefined and this throws a TypeError ("Cannot read properties of undefined"). It is caught by `attempt` but the toast is nonsense. **low** — `if (!newest || …)`.
- `src/app/(app)/ui/shared.tsx:432,434` and `ui/stock.tsx:272` — (carried over) `LOC_SHORT[m.loc!]` with a null `loc` (unknown-bar give) renders "Gave 1 to undefined" or an empty arrow target. **low** — `m.loc ? LOC_SHORT[m.loc] : "unknown bar"` (the Activity tab already does this).
- `src/app/actions/auth.ts:24` / `src/lib/auth.ts:32` — `verifyPassword` calls `scryptSync` with `expected.length`. A malformed `password_hash` (e.g. `"x:"` or odd hex) throws a RangeError. `login` has no try/catch, so it is an uncaught 500 rather than a "don't match" message. **low** — wrap in try/catch and return false.
- `src/app/actions/auth.ts:24` — unknown usernames skip scrypt, so response time reveals whether a username exists. The code's own comment says that isn't leaked. **low** — run a dummy `verifyPassword` against a constant hash when no row matches.
- `src/app/api/report/route.ts:18` — `buildReport`/`buildPdf` are not in a try/catch. A DB error returns Next's generic 500 with no message. **low** — catch and return `new Response("Report failed", {status: 500})`.
- `src/app/(app)/ui/activity.tsx:47` — `navigator.clipboard` is undefined on non-HTTPS origins and some webviews. `.writeText` then throws synchronously, before `.catch` can run. **low** — guard `navigator.clipboard?.writeText` and fall back to the error toast.
- `src/app/(app)/ui/activity.tsx:201` — `el.showPicker()` can throw `NotAllowedError`/`SecurityError` (iframe, no user activation). It isn't caught. **low** — try/catch, fall back to `el.focus()`.
- `src/app/(app)/ui/activity.tsx:48-53` — the CSV export doesn't neutralise cells starting with `= + - @`. Notes or invoice text pasted into Sheets would run as a formula. **low** — prefix with `'`.
- `src/app/actions/items.ts:65-70` — `editItem` runs the rename, tag delete and tag insert as separate statements. A failure after the rename leaves tags wiped. **low** — use `sql.transaction([...])` like `mergeCategory`.
- `src/app/actions/items.ts:75-90,104-108` — `setReorderLevel`, `setReorderIgnore` and `archiveItem` never check that a row matched. A stale id reports success. **low** — `returning id` and throw if empty.
- `src/app/(app)/ui/stock.tsx:259` — "Just ran" filters on `m.user_name === user.name`, not `user_id`, so two staff with the same display name see each other's runs. `Move` has no `user_id`. **low** — add `user_id` to `Move`/`toMove` and compare ids.

## Dead code

- `src/app/actions/categories.ts:100` — `mergeCategories` is exported and never called. `deleteCategory(name, into)` covers the UI path. **low** — delete it, or wire up a Merge button.
- `src/app/actions/items.ts:92-101` — `batchSetReorderLevels` is never called. It is also a non-atomic loop with no archived check. **low** — delete it.
- `src/lib/model.ts:87` (`catsOf`) and `:190` (`totalOf`) — exported, zero references. **low** — delete.
- `src/lib/report.ts` — `periodStats` is exported but only used inside the file. **low** — drop the `export`.
- `public/{file,globe,next,vercel,window}.svg` — create-next-app leftovers, unreferenced. **low** — delete.
- `10x-bar-stock.html` and `10X_Bar_Stock_Management (1) (1).xlsx` (repo root, tracked) — legacy prototype and spreadsheet, not imported by anything. **low** — delete or move out of the repo.
- `src/app/(app)/ui/manage.tsx:222` — a comment says "Capped so 136 bottles don't run the page on forever", but there is no cap. **low** — remove the comment or add the `.slice`.
- `scripts/export-bottles.mjs:2` — refers to `scripts/import-bottles.mjs`, which doesn't exist. **low** — remove the reference or write the script.
- `scripts/check-add-entry.mjs:47` — (carried over) the "replica" of the `addEntry` count statement omits the `ts` column, so it can't catch a backdating regression. **low** — pass `ts` as the real action does.

---

# Round 2 — Next.js-specific sweep (no files edited)

Format: `file:line` — issue — **severity** — one-line fix.

Checked and clean:
- `searchParams` (`app/page.tsx:15`) and `cookies()` (`lib/auth.ts:40,50,54`) are awaited.
- `headers()`/`params` aren't used anywhere.
- No `fetch()` calls, and no `useEffect` data fetching. The three effects are the toast timer and key/click listeners.
- No client component imports `@/lib/db` or `@/lib/auth`. They only import `@/lib/model` and the actions barrel, so no secrets or server-only code reach the bundle.
- Every `"use client"` file really uses hooks.
- Every action except `login` calls `requireUser`/`requireOwner`. The report route checks the session and the role. There is no `proxy.ts`/middleware, so the page and action checks are the only gate.
- No caching surprises. Every page reads `cookies()`, which makes it dynamic. The route handler is `force-dynamic` with `no-store`, and there is no `fetch` cache or `revalidate`.

## Medium

- [x] `src/app/(app)/ui/shared.tsx:90-110`, `ui/dashboard.tsx:40,248,278`, `ui/delivery.tsx:98,219`, `ui/activity.tsx:91,134` and `ui/stock.tsx:88,274` — hydration mismatch. These client components are server-rendered, and they bucket days with `bizDayKey` (local `setHours`) and print `toLocaleDateString`/`toLocaleTimeString` with no `timeZone`. Vercel renders in UTC, and the bar's browser is in another zone. Times, "Today"/"Yesterday" headings and the 7-day chart then differ between server HTML and client, giving a React hydration error plus a flash of wrong day-buckets. **med** — make the zone explicit (pass one `tz` string from the server and use `timeZone: tz` plus a tz-aware `bizDayKey`), or render these via a `mounted` flag / `suppressHydrationWarning` on the text.
- [x] `src/app/` (no `error.tsx`, `global-error.tsx`, `loading.tsx` or `not-found.tsx` anywhere) — every page awaits 2-3 unguarded DB queries (`getItems`, `getMoves`, `getSession` in the layout). A Neon hiccup or cold-start timeout shows Next's bare default error page with no retry and no way back, which on a barback's phone mid-shift is a dead end. **med** — add `app/(app)/error.tsx` (reset button) and `app/global-error.tsx`.
- [x] `src/app/(app)/*/page.tsx` — no `loading.tsx`. Navigation blocks on all queries with no skeleton, and the full 500-move Activity fetch is the slowest. **med** — add `app/(app)/loading.tsx` (a simple placeholder is enough).

## Low

- `src/app/actions/auth.ts:10` — `username` is unbounded. Every distinct junk username writes a `login_attempts` row (`auth.ts:118`), so a bot can bloat the table up to the 1-day sweep. **low** — reject `username.length > 64` before the throttle lookup.
- `src/app/actions/stock.ts:12,102,137,174,209,262` and `items.ts:75-107` — `itemId`/`moveId`/`id` are never validated as integers. A bad value produces a Postgres cast error that surfaces as a raw toast message. Not exploitable (parameterised), but noisy. **low** — a shared `id(v)` helper using `Number.isInteger`.
- `src/app/actions/stock.ts:182`, `deliveries.ts:43` and `users.ts:19` — free-text fields (`reason`, `supplier`, `name`) have no length cap. Invoice is capped at 60 and item name at 80, so these are inconsistent. **low** — cap at ~120 chars.
- `src/app/(app)/ui/stock.tsx:451-458` — `localStorage.getItem` runs inside a `useState` initializer, which is a hydration hazard if `Stocktake` is ever rendered on the server. It is safe today because it only mounts after a click. **low** — keep the existing comment, or read it in an effect.
- `src/app/(app)/layout.tsx:10` and `src/app/(app)/guard.ts:20` — the session lookup hits the DB on every layout render and again on every page render, so there are two identical `users` queries per navigation. **low** — wrap `getSession` in `React.cache()`.

---

# Round 3 — /code-review on PR #6 (deferred, logged for later)

Correctness bugs from this round (undo semantics for paperwork + backdated counts, plus
the misleading rename error) were fixed in the same branch. These are the lower-severity
items the reviewer surfaced that are not yet addressed.

## Low

- `src/app/actions/deliveries.ts:54` — the paperwork path still acquires row locks on every bottle via the UPDATE (just to add 0 to `store`), which can briefly serialize concurrent paperwork bookings against the barback's `giveOut` on hot items. **low** — guard the UPDATE under `and ${affects}::boolean` and source the INSERT via a `union all` CTE for the paperwork case.
- `src/lib/undo-move.ts:47` — the leading `select 1 from moves where id = m.id` pre-check is redundant with the post-check that already distinguishes `short` from `gone`, and adds one round-trip per undo. **low** — drop the pre-check; keep the post-check.
- `src/lib/auth.ts:48` — `recordLoginFailure` reads-then-writes without a transaction, so two simultaneous fails can both read `fails=4` and both UPSERT `fails=5` — under-counts by one. Known/accepted for the 10-staff bar; the comment calls it harmless. **low** — if this ever faces the open internet, rewrite as one atomic `insert … on conflict do update set fails = login_attempts.fails + 1`.
- `src/app/actions/categories.ts:25` — `createCategory` picks `coalesce(max(sort), 0) + 1`, which can collide if two owners create a category at the same moment. **low** — add a unique index on sort or do the insert inside an advisory lock; harmless for a single owner.
- `src/app/actions/categories.ts:85` — `deleteCategory` reads `inUse` outside a transaction, so a concurrent action on `from` could change what gets folded into `into`. **low** — wrap the preflight read, inUse count, and merge in one `sql.transaction` (and keep the FK-check inUse read inside it).
- `src/app/actions/categories.ts:109` — `moveCategory` returns ok at the ends-of-list edges without calling `refresh()`. Minor UX: a user tapping the arrow at the top may think nothing is happening (because nothing is). **low** — return an explicit "nothing to do" signal or refresh unconditionally.
- `src/lib/schema.sql:32` — `sort` has no default and no NOT NULL; a future direct `insert into categories (name) …` would leave sort NULL and sort last/first unpredictably. **low** — add `default (select coalesce(max(sort), 0) + 1 from categories)` or `not null` after the backfill runs.
- `src/app/(app)/ui/activity.tsx:219` — client caps `atMs` with its own `Date.now()`, server enforces its own `Date.now() + 5min` — a far-skewed client clock can land a same-day entry in the server's "future" and get refused. **low** — not worth fixing until clock skew is reported in practice.
- `src/lib/report.ts:90` — `onHandAt`'s unknown-bar give branch treats every `loc IS NULL` give as "unknown", including any legacy nulls that predate the feature. On this database, every give before the feature was `patio`/`back`, so no legacy nulls exist, but worth noting if an import ever lands rows with null loc. **low** — if it matters, scope by `created_at > <feature date>` or by a schema version.
