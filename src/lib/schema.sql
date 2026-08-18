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

create table if not exists items (
  id       serial primary key,
  name     text not null unique,
  cat      text not null check (cat in
             ('WHISKEY','VODKA','TEQUILA','GIN','RUM','BEER','WINE','MIXER','OTHER')),
  store    numeric(10,2) not null default 0 check (store >= 0 and store = trunc(store)),
  patio    numeric(10,2) not null default 0 check (patio >= 0),
  back     numeric(10,2) not null default 0 check (back  >= 0),
  rl       numeric(10,2) not null default 2 check (rl >= 0),
  archived boolean not null default false
);

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
