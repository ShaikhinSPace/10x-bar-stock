import "server-only";
import { neon } from "@neondatabase/serverless";
import { DEFAULT_SETTINGS, type Category, type Delivery, type Item, type Location, type Move, type Role, type Settings } from "./model";

// Thrown at module load, so a missing value fails the build rather than every request.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Locally: copy .env.example to .env.local. " +
      "On Vercel: Settings > Environment Variables, then redeploy."
  );
}

export const sql = neon(process.env.DATABASE_URL);

export * from "./model";

/** Anchor for every "last 7 days" calculation, read once per request. */
export function requestNow(): number {
  return Date.now();
}

// numeric(10,2) arrives from pg as a string; the whole UI does arithmetic on these.
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** numeric[] arrives from pg as an array of strings. */
const nums = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);

export async function getSettings(): Promise<Settings> {
  const rows = await sql`select key, value from settings`;
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    bar_name: map.bar_name ?? DEFAULT_SETTINGS.bar_name,
    app_subtitle: map.app_subtitle ?? DEFAULT_SETTINGS.app_subtitle,
    business_day_cutoff_hour: Number(map.business_day_cutoff_hour ?? DEFAULT_SETTINGS.business_day_cutoff_hour),
    business_tz: map.business_tz ?? DEFAULT_SETTINGS.business_tz,
  };
}

export async function setSetting(key: string, value: string): Promise<void> {
  await sql`insert into settings (key, value) values (${key}, ${value})
            on conflict (key) do update set value = excluded.value`;
}

export async function getItems(): Promise<Item[]> {
  const rows = await sql`
    select i.id, i.name, i.cat, i.store, i.patio, i.back, i.rl, i.ignore_reorder,
           i.patio_levels, i.back_levels, i.case_size,
           coalesce(array_agg(t.cat order by t.cat) filter (where t.cat is not null), '{}') as tags
    from items i left join item_tags t on t.item_id = i.id
    where not i.archived
    group by i.id
    order by i.name`;
  return rows.map((r) => ({
    id: r.id, name: r.name, cat: r.cat,
    store: num(r.store)!, patio: num(r.patio)!, back: num(r.back)!, rl: num(r.rl)!,
    ignore_reorder: r.ignore_reorder,
    patio_levels: nums(r.patio_levels), back_levels: nums(r.back_levels),
    case_size: Number(r.case_size ?? 1),
    tags: Array.isArray(r.tags) ? r.tags : [],
  }));
}

/**
 * Every move inside a time window, unbounded by count.
 *
 * The dashboard's "last 7 days" figures used to be filtered out of getMoves()'s
 * newest-500, so once the bar logged more than 500 moves the totals silently got
 * smaller. Bounding by time instead of count keeps them correct at any volume.
 * Bucketing into days still happens client-side, so it stays in the viewer's
 * timezone rather than the database's.
 */
export async function getRecentMoves(sinceMs: number): Promise<Move[]> {
  const rows = await sql`
    select id, ts, type, item_id, item_name, cat, qty, loc, to_loc, from_val, to_val,
           user_name, batch, invoice, supplier, notes, affects_stock
    from moves where ts >= ${new Date(sinceMs).toISOString()}
    order by ts desc, id desc`;
  return rows.map(toMove);
}

export async function getWastageReasons(): Promise<string[]> {
  const rows = await sql`select label from wastage_reasons order by sort, id`;
  return rows.map((r) => r.label as string);
}

export async function getRoles(): Promise<Role[]> {
  const rows = await sql`select slug, label, description from roles order by sort, slug`;
  return rows.map((r) => ({ slug: r.slug as string, label: r.label as string, description: r.description as string }));
}

export async function getLocations(): Promise<Location[]> {
  const rows = await sql`select slug, label, short, color, mark_color from locations order by sort, slug`;
  return rows.map((r) => ({
    slug: r.slug as string,
    label: r.label as string,
    short: r.short as string,
    color: r.color as string,
    mark_color: (r.mark_color as string) ?? null,
  }));
}

/**
 * Every category, in display order, with what points at it.
 *
 * The counts are what Manage needs to decide whether a category can simply be
 * deleted or has to have its bottles moved somewhere first, so they are part of
 * the same read rather than a second round trip.
 */
export async function getCategories(): Promise<Category[]> {
  // Both counts exclude archived bottles: an archived item still carries its cat and
  // tags, but Manage's "is this category in use / can it be deleted" decision is about
  // live stock, so archived rows must not inflate either figure. (deleteCategory does
  // its own archived-inclusive check for the foreign key — a different question.)
  const rows = await sql`
    select c.name, c.color, c.bar_color, c.raises_reorder_alerts,
           (select count(*) from items where cat = c.name and not archived) as items,
           (select count(distinct t.item_id) from item_tags t
              join items i on i.id = t.item_id
              where t.cat = c.name and not i.archived) as tags,
           -- Every reference, archived included, for the delete-vs-merge decision:
           -- an archived bottle still holds the foreign key.
           (select count(*) from items     where cat = c.name)
             + (select count(*) from item_tags where cat = c.name) as refs
    from categories c
    order by c.sort, c.name`;
  return rows.map((r) => ({
    name: r.name as string,
    items: Number(r.items),
    tags: Number(r.tags),
    refs: Number(r.refs),
    color: (r.color as string) ?? null,
    bar_color: (r.bar_color as string) ?? null,
    raises_reorder_alerts: r.raises_reorder_alerts !== false,
  }));
}

export async function getMoves(limit = 500): Promise<Move[]> {
  const rows = await sql`
    select id, ts, type, item_id, item_name, cat, qty, loc, to_loc, from_val, to_val,
           user_name, batch, invoice, supplier, notes, affects_stock
    from moves order by ts desc, id desc limit ${limit}`;
  return rows.map(toMove);
}

type Row = Record<string, unknown>;
const toMove = (r: Row): Move => ({
  id: Number(r.id), ts: new Date(r.ts as string).toISOString(), type: r.type as Move["type"],
  item_id: r.item_id as number, item_name: r.item_name as string, cat: r.cat as Move["cat"],
  qty: num(r.qty), loc: r.loc as Move["loc"], to_loc: (r.to_loc ?? null) as Move["to_loc"],
  from_val: num(r.from_val), to_val: num(r.to_val),
  user_name: r.user_name as string,
  batch: (r.batch ?? null) as string | null,
  invoice: (r.invoice ?? null) as string | null,
  supplier: (r.supplier ?? null) as string | null,
  notes: (r.notes ?? null) as string | null,
  // Every pre-flag row is a real stock move, so a null default matches the schema.
  affects_stock: r.affects_stock !== false,
});


/**
 * Booked deliveries, rebuilt by grouping moves on their batch id — a delivery has
 * no table of its own, it *is* the set of receive moves that arrived together.
 */
export async function getDeliveries(limit = 100): Promise<Delivery[]> {
  const rows = await sql`
    select batch, invoice, supplier,
           min(ts) as ts, to_char(min(delivery_date), 'YYYY-MM-DD') as delivery_date, min(user_name) as user_name, min(user_id) as user_id,
           sum(qty) as bottles,
           -- cost is a UNIT price (per bottle) stored on each line. The delivery total
           -- is the per-bottle cost multiplied by that line's qty, summed. sum() returns
           -- null when every line's cost is null — exactly "no cost entered".
           sum(qty * cost) as cost,
           -- A delivery's lines all share one affects_stock, so bool_and == bool_or == the flag.
           bool_and(affects_stock) as affects_stock,
           json_agg(json_build_object(
                      'item_id', item_id, 'item', item_name, 'cat', cat,
                      'qty', qty, 'cost', cost, 'case_size', line_case_size)
                    order by item_name) as lines
    from moves
    where batch is not null and type = 'receive'
    group by batch, invoice, supplier
    order by min(ts) desc
    limit ${limit}`;
  return rows.map((r) => ({
    batch: r.batch, invoice: r.invoice ?? "—", supplier: r.supplier,
    ts: new Date(r.ts).toISOString(), delivery_date: (r.delivery_date as string | null) ?? null, user_name: r.user_name,
    user_id: r.user_id === null ? null : Number(r.user_id),
    bottles: Number(r.bottles),
    cost: r.cost === null || r.cost === undefined ? null : Number(r.cost),
    affects_stock: r.affects_stock !== false,
    lines: (r.lines as { item_id: number; item: string; cat: Item["cat"]; qty: string; cost: string | null; case_size: number | null }[])
      .map((l) => ({
        item_id: Number(l.item_id), item: l.item, cat: l.cat, qty: Number(l.qty),
        cost: l.cost === null || l.cost === undefined ? null : Number(l.cost),
        case_size: l.case_size === null || l.case_size === undefined ? null : Number(l.case_size),
      })),
  }));
}
