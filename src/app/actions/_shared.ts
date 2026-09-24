// Shared helpers for the server actions. Kept without a "use server" directive so it
// can export the non-async utilities (Result, isLoc, whole, partial) the actions reuse.

import { sql, LOCS, type Loc } from "@/lib/db";

export type Result = { ok: true; moveId?: number } | { ok: false; error: string };

export async function attempt(fn: () => Promise<number | void>): Promise<Result> {
  try {
    const moveId = await fn();
    return typeof moveId === "number" ? { ok: true, moveId } : { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Something went wrong";
    console.error("[action]", e);
    return { ok: false, error };
  }
}

export const isLoc = (v: unknown): v is Loc => LOCS.includes(v as Loc);
// Categories live in the database now, so validation asks it rather than a constant.
export async function knownCats(): Promise<Set<string>> {
  const rows = await sql`select name from categories`;
  return new Set(rows.map((r) => r.name as string));
}

/** Whole bottles only — used for store counts and for every give/receive. */
export function whole(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be a whole number`);
  return n;
}

/** Bars are counted to 2dp (0.25, 1.87). */
export function partial(v: unknown, what: string): number {
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be zero or more`);
  return n;
}
