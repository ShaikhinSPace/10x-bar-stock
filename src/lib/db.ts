import "server-only";
import { neon } from "@neondatabase/serverless";
import type { Delivery, Item, Move } from "./model";

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

export async function getItems(): Promise<Item[]> {
  const rows = await sql`
    select id, name, cat, store, patio, back, rl, ignore_reorder from items
    where not archived order by name`;
  return rows.map((r) => ({
    id: r.id, name: r.name, cat: r.cat,
    store: num(r.store)!, patio: num(r.patio)!, back: num(r.back)!, rl: num(r.rl)!,
    ignore_reorder: r.ignore_reorder,
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
           user_name, batch, invoice, supplier, notes
    from moves where ts >= ${new Date(sinceMs).toISOString()}
    order by ts desc, id desc`;
  return rows.map(toMove);
}

export async function getMoves(limit = 500): Promise<Move[]> {
  const rows = await sql`
    select id, ts, type, item_id, item_name, cat, qty, loc, to_loc, from_val, to_val,
           user_name, batch, invoice, supplier, notes
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
});


/**
 * Booked deliveries, rebuilt by grouping moves on their batch id — a delivery has
 * no table of its own, it *is* the set of receive moves that arrived together.
 */
export async function getDeliveries(limit = 100): Promise<Delivery[]> {
  const rows = await sql`
    select batch, invoice, supplier,
           min(ts) as ts, min(user_name) as user_name,
           sum(qty) as bottles,
           json_agg(json_build_object('item', item_name, 'cat', cat, 'qty', qty)
                    order by item_name) as lines
    from moves
    where batch is not null
    group by batch, invoice, supplier
    order by min(ts) desc
    limit ${limit}`;
  return rows.map((r) => ({
    batch: r.batch, invoice: r.invoice ?? "—", supplier: r.supplier,
    ts: new Date(r.ts).toISOString(), user_name: r.user_name,
    bottles: Number(r.bottles),
    lines: (r.lines as { item: string; cat: Item["cat"]; qty: string }[])
      .map((l) => ({ item: l.item, cat: l.cat, qty: Number(l.qty) })),
  }));
}
