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

-- The fixed set of bottle categories - was a CHECK constraint inline on
-- items.cat, now a real table so it's a foreign key instead of a whitelist
-- baked into the column definition. Mirrors CATS in src/lib/model.ts, which
-- stays the source of truth for display order, colors, and Beer's
-- case-of-24 formatting - none of that is data-driven, just this list.
create table if not exists categories (
  id   serial primary key,
  name text not null unique
);
insert into categories (name) values
  ('WHISKEY'), ('VODKA'), ('TEQUILA'), ('GIN'), ('RUM'), ('BEER'), ('WINE'), ('MIXER'),
  ('WELL'), ('OTHER')
on conflict (name) do nothing;

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

-- Existing databases created items with the old inline CHECK before
-- categories existed - drop it and swap in the real foreign key. Named and
-- dropped explicitly (like moves_type_check below) so this stays safe to
-- re-run.
alter table items drop constraint if exists items_cat_check;
alter table items drop constraint if exists items_cat_fkey;
alter table items add constraint items_cat_fkey foreign key (cat) references categories(name);

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

alter table moves drop constraint if exists moves_type_check;
alter table moves add constraint moves_type_check check (type in ('give', 'receive', 'count', 'waste', 'transfer'));

create index if not exists moves_ts_idx on moves (ts desc);
create index if not exists moves_item_ts_idx on moves (item_id, ts desc);
create index if not exists moves_batch_idx on moves (batch) where batch is not null;
-- the duplicate-invoice guard queries this on every delivery booking
create index if not exists moves_invoice_idx on moves (invoice) where invoice is not null;
