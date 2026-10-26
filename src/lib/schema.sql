-- 10X Bar stock control schema.
-- Store counts whole bottles; the two bars count partials (0.25, 1.87, ...).

create table if not exists users (
  id            serial primary key,
  username      text not null unique,
  name          text not null,
  password_hash text not null,
  role          text not null default 'staff' check (role in ('owner', 'staff')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Bumped by resetPassword and by deactivation so every existing session for
-- that user is invalidated. The cookie carries the version it was issued at;
-- getSession rejects a mismatch. 0 doesn't exist (default is 1) so a reset is
-- always a step up, never a reset to zero.
alter table users add column if not exists session_version int not null default 1;

-- Bottle categories. Owned by the database, not by the code: the owner creates,
-- renames, reorders, merges and deletes them from Manage, so this table is the
-- source of truth for which categories exist and what order they display in.
-- SEED_CATS in src/lib/model.ts only seeds a fresh database and supplies the
-- hand-picked colours; anything created later gets a colour derived from its name.
-- Beer's case-of-24 rule is still the one behaviour keyed to a literal name.
create table if not exists categories (
  id   serial primary key,
  name text not null unique
);
insert into categories (name) values
  ('WHISKEY'), ('VODKA'), ('TEQUILA'), ('GIN'), ('RUM'), ('BEER'), ('WINE'), ('MIXER'),
  ('WELL'), ('OTHER')
on conflict (name) do nothing;

-- Hand-picked dot colour (muted, for grouping cues) and bar-chart colour (vivid,
-- for data encoding). Both nullable — a category without one derives a colour from
-- its name via catHue(). raises_reorder_alerts defaults true; MIXER is the only
-- seed category that doesn't raise alerts (juices / syrups nobody steals).
alter table categories add column if not exists color     text;
alter table categories add column if not exists bar_color text;
alter table categories add column if not exists raises_reorder_alerts boolean not null default true;

update categories set color = '#C08A4A', bar_color = '#C75157' where name = 'WHISKEY' and color is null;
update categories set color = '#6FA8DC', bar_color = '#D67B19' where name = 'VODKA'   and color is null;
update categories set color = '#8FBF6A', bar_color = '#8F7E03' where name = 'TEQUILA' and color is null;
update categories set color = '#5FB8A8', bar_color = '#5FAB4D' where name = 'GIN'     and color is null;
update categories set color = '#C2705A', bar_color = '#069180' where name = 'RUM'     and color is null;
update categories set color = '#D6A63C', bar_color = '#00A6C9' where name = 'BEER'    and color is null;
update categories set color = '#B0607F', bar_color = '#457BD5' where name = 'WINE'    and color is null;
update categories set color = '#7E8CA8', bar_color = '#A47DE3' where name = 'MIXER'   and color is null;
update categories set color = '#9AA3B2', bar_color = '#8A93A3' where name = 'WELL'    and color is null;
update categories set color = '#8E86F2', bar_color = '#B55499' where name = 'OTHER'   and color is null;
update categories set raises_reorder_alerts = false where name = 'MIXER' and raises_reorder_alerts = true;

-- Display order, so Manage can reorder without renaming. Backfilled from id for
-- rows that predate the column, which preserves the original seed order.
alter table categories add column if not exists sort int;
update categories set sort = id where sort is null;

create table if not exists items (
  id       serial primary key,
  name     text not null unique,
  cat      text not null,
  store    numeric(10,2) not null default 0 check (store >= 0 and store = trunc(store)),
  patio    numeric(10,2) not null default 0 check (patio >= 0),
  back     numeric(10,2) not null default 0 check (back  >= 0),
  rl       numeric(10,2) not null default 2 check (rl >= 0),
  archived boolean not null default false
);

-- Not everything below its reorder point needs restocking (e.g. a discontinued
-- flavor still being sold down) - an owner can silence just that one item's
-- alert without touching its reorder level. (A whole category can already be
-- silenced via NO_REORDER_ALERTS in src/lib/model.ts - this is the per-item
-- equivalent of that.)
alter table items add column if not exists ignore_reorder boolean not null default false;

-- A bar can hold several open bottles of the same thing at different levels
-- (a full one, a half, a quarter). Summing those into one number is what the
-- scalar patio/back columns do, and it loses the fact that three bottles are
-- open - which is exactly what an owner wants to see. These hold the levels
-- of the individual bottles, newest count wins.
--
-- The scalars stay authoritative for all stock arithmetic so nothing else
-- has to change; these are the breakdown behind that number, and
-- setBarLevels()/countBar() write both together in one statement. Store is
-- whole unopened bottles only, so it has no equivalent.
alter table items add column if not exists patio_levels numeric(10,2)[] not null default '{}';
alter table items add column if not exists back_levels  numeric(10,2)[] not null default '{}';

-- How many bottles make up a case for this bottle. Default 1 (no case concept).
-- Beer is seeded to 24 on first run; the owner can change any item's case_size from Manage.
-- Anything with case_size > 1 is "counted by cases" on the store screen and formatted that
-- way, so the owner never has to think in loose bottles for things that live in cases.
alter table items add column if not exists case_size int not null default 1 check (case_size >= 1);
update items set case_size = 24 where cat = 'BEER' and case_size = 1;

-- Existing databases created items with the old inline CHECK before
-- categories existed - drop it and swap in the real foreign key. Named and
-- dropped explicitly (like moves_type_check below) so this stays safe to
-- re-run.
alter table items drop constraint if exists items_cat_check;
alter table items drop constraint if exists items_cat_fkey;
-- on update cascade is what makes renaming a category from Manage possible: the
-- new name flows out to every item instead of the foreign key refusing the change.
alter table items add constraint items_cat_fkey foreign key (cat) references categories(name)
  on update cascade;

-- Extra categories beyond items.cat. A bottle has ONE main category - which
-- drives every total, colour and the beer cases-of-24 rule - plus any number
-- of tags here, so "WELL WHISKEY" counts once under Whiskey while still being
-- findable under Well. Keeping tags out of items.cat is what stops the report's
-- category totals from double-counting a bottle and exceeding real stock.
create table if not exists item_tags (
  item_id int  not null references items(id) on delete cascade,
  cat     text not null references categories(name),
  primary key (item_id, cat)
);
create index if not exists item_tags_cat_idx on item_tags (cat);
-- Same reason as items_cat_fkey: a rename has to reach the tags too.
alter table item_tags drop constraint if exists item_tags_cat_fkey;
alter table item_tags add constraint item_tags_cat_fkey foreign key (cat) references categories(name)
  on update cascade;

-- item_name/cat are denormalised on purpose: the activity log has to stay readable
-- after an item is archived or renamed.
create table if not exists moves (
  id        bigserial primary key,
  ts        timestamptz not null default now(),
  type      text not null check (type in ('give', 'receive', 'count', 'waste', 'transfer')),
  item_id   int not null references items(id),
  item_name text not null,
  cat       text not null,
  qty       numeric(10,2),                                  -- give + receive + waste + transfer
  loc       text check (loc in ('store', 'patio', 'back')), -- give/waste: loc; count: loc; transfer: from_loc
  from_val  numeric(10,2),                                  -- count only
  to_val    numeric(10,2),                                  -- count only
  user_id   int references users(id),
  user_name text not null
);

-- A delivery arrives as one drop with many lines, so its receive moves share a
-- batch id, plus the invoice and supplier the old Stock In sheet recorded.
alter table moves add column if not exists batch    text;
alter table moves add column if not exists invoice  text;
alter table moves add column if not exists supplier text;
alter table moves add column if not exists notes    text; -- waste reasons, comments
alter table moves add column if not exists to_loc   text; -- transfer destination

-- Delivery cost — per-line UNIT price (per bottle). Delivery total = sum(qty * cost)
-- grouped by batch. Nullable because the owner may book a delivery before the
-- invoice amount is to hand.
alter table moves add column if not exists cost     numeric(12,2);

-- Per-line case size for a delivery row — "this line was received as N cases of M
-- bottles". Beer cases vary (24-pack today, 30-pack tomorrow), so this is captured
-- per line rather than looked up from items.case_size. Null = plain bottles.
alter table moves add column if not exists line_case_size int;

-- Paperwork-only deliveries: the owner already received the drop manually (bottle-by-bottle
-- through Receive) and counted the bar, and only later books the delivery for the invoice
-- and supplier record. Without this flag, the booking would add the stock a SECOND time.
-- Default true so every existing move is a real stock move; a paperwork delivery sets
-- false on every one of its receive moves, and undo/edit/reports all treat them as logs.
alter table moves add column if not exists affects_stock boolean not null default true;

alter table moves drop constraint if exists moves_type_check;
alter table moves add constraint moves_type_check check (type in ('give', 'receive', 'count', 'waste', 'transfer'));

create index if not exists moves_ts_idx on moves (ts desc);
create index if not exists moves_item_ts_idx on moves (item_id, ts desc);
create index if not exists moves_batch_idx on moves (batch) where batch is not null;
-- the duplicate-invoice guard queries this on every delivery booking
create index if not exists moves_invoice_idx on moves (invoice) where invoice is not null;

-- App-wide settings as a key-value table. Seeded with defaults; the owner
-- edits them from Manage. Every value is text; the app casts as needed.
create table if not exists settings (
  key   text primary key,
  value text not null
);
insert into settings (key, value) values
  ('bar_name',                   '10X Bar'),
  ('app_subtitle',               'STOCK CONTROL'),
  ('business_day_cutoff_hour',   '3'),
  ('business_tz',                'America/Chicago')
on conflict (key) do nothing;

-- Wastage reasons the waste form offers. Seeded with the original five; the
-- owner can add, rename or reorder them from Manage (future). Sort preserves
-- display order; label is what the user sees and what gets stored in moves.notes.
create table if not exists wastage_reasons (
  id    serial primary key,
  label text not null unique,
  sort  int
);
insert into wastage_reasons (label, sort) values
  ('Spill / Breakage', 1),
  ('Expired / Spoiled', 2),
  ('Staff Comp / Promo', 3),
  ('Overpour', 4),
  ('Other', 5)
on conflict (label) do nothing;

-- Login brute-force throttle. Keyed by the ATTEMPTED username (not users.id) so a
-- guessed or non-existent name is throttled the same way, which is also what keeps
-- login from leaking whether a username exists. In-memory counting can't work on
-- serverless (each request may hit a fresh lambda with no shared memory), so the
-- one shared store — Postgres — holds it. See auth.ts for the 5-fails / 15-min rule.
create table if not exists login_attempts (
  username     text primary key,
  fails        int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
