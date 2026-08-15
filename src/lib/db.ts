import "server-only";
import { neon } from "@neondatabase/serverless";
import type { Item, Move } from "./model";

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
    select id, name, cat, store, patio, back, rl from items
    where not archived order by name`;
  return rows.map((r) => ({
    id: r.id, name: r.name, cat: r.cat,
    store: num(r.store)!, patio: num(r.patio)!, back: num(r.back)!, rl: num(r.rl)!,
  }));
}

export async function getMoves(limit = 500): Promise<Move[]> {
  const rows = await sql`
    select id, ts, type, item_id, item_name, cat, qty, loc, from_val, to_val, user_name
    from moves order by ts desc, id desc limit ${limit}`;
  return rows.map((r) => ({
    id: Number(r.id), ts: new Date(r.ts).toISOString(), type: r.type,
    item_id: r.item_id, item_name: r.item_name, cat: r.cat,
    qty: num(r.qty), loc: r.loc, from_val: num(r.from_val), to_val: num(r.to_val),
    user_name: r.user_name,
  }));
}
