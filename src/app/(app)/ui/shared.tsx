"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SETTINGS, addBusinessDays, bizDayKey, catHue, stockAt, type Category, type Loc, type Item, type Settings } from "@/lib/model";
import { useLocations } from "../shell";

export const DAY = 864e5;

export const LOC_ICON: Record<Loc, React.ReactNode> = {
  store: (
    <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 9l9-5 9 5v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M3 9h18" strokeLinecap="round" />
    </svg>
  ),
  patio: (
    <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"
        strokeLinecap="round"
      />
    </svg>
  ),
  back: (
    <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 21V7l8-4 8 4v14" strokeLinejoin="round" />
      <path d="M9 21v-6h6v6" strokeLinejoin="round" />
    </svg>
  ),
};

/** Look up a category's dot colour from the DB-stored value, falling back to a hue derived from the name. */
export const catColor = (c: string, cats: Category[]) =>
  cats.find((x) => x.name === c)?.color ?? `oklch(0.72 0.075 ${catHue(c)})`;

export const catBarColor = (c: string, cats: Category[]) =>
  cats.find((x) => x.name === c)?.bar_color ?? `oklch(0.63 0.155 ${catHue(c)})`;

export const locColor = (slug: Loc): string => `var(--${slug})`;

export function useLocMaps() {
  const locs = useLocations();
  return useMemo(() => {
    const slugs = locs.map((l) => l.slug);
    const label = Object.fromEntries(locs.map((l) => [l.slug, l.label])) as Record<string, string>;
    const short = Object.fromEntries(locs.map((l) => [l.slug, l.short])) as Record<string, string>;
    return { slugs, label, short };
  }, [locs]);
}


/* ============================ helpers ============================ */

/** Sort key for a category name, following the order the owner set in Manage. */
export const rankIn = (cats: Category[]) => (c: string) => {
  const i = cats.findIndex((x) => x.name === c);
  return i < 0 ? 99 : i;
};

export const sumAt = (items: Item[], k: Loc) => items.reduce((a, i) => a + Math.max(0, stockAt(i, k)), 0);

/** The last 7 business days as Date objects (noon UTC of each, so TZ shifts can't drop a day). */
export function last7(now: number, s: Settings = DEFAULT_SETTINGS): Date[] {
  const todayKey = bizDayKey(now, s.business_day_cutoff_hour, s.business_tz);
  const out: Date[] = [];
  for (let i = 6; i >= 0; i--) {
    const [y, m, d] = addBusinessDays(todayKey, -i).split("-").map(Number);
    out.push(new Date(Date.UTC(y, m - 1, d, 12)));
  }
  return out;
}

export function dayKey(ts: number, now: number, s: Settings = DEFAULT_SETTINGS) {
  const ch = s.business_day_cutoff_hour, tz = s.business_tz;
  const k = bizDayKey(ts, ch, tz), today = bizDayKey(now, ch, tz);
  if (k === today) return "Today";
  if (k === addBusinessDays(today, -1)) return "Yesterday";
  const [y, m, d] = k.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
  });
}

export const timeStr = (ts: number) =>
  new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/* ============================ delivery ============================ */

/**
 * Click-to-sort for the two big lists (the Dashboard reorder table, Manage's
 * bottle list). `null` means "respect whatever order the caller already
 * computed" — the reorder table's default is "most deficient first," which a
 * click on a header should be able to override, not fight with on every render.
 * A second click on the same key reverses it; a third clears back to default.
 */
export type SortDir = 1 | -1;

export function useColumnSort<K extends string>() {
  const [sort, setSort] = useState<{ key: K; dir: SortDir } | null>(null);
  const toggle = (key: K) =>
    setSort((s) => (s?.key === key ? (s.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));
  return { sort, toggle };
}

export function sortRows<T, K extends string>(
  rows: T[], sort: { key: K; dir: SortDir } | null, get: (row: T, key: K) => string | number
): T[] {
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    const av = get(a, sort.key), bv = get(b, sort.key);
    const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return cmp * sort.dir;
  });
}

/** A sortable <th>: a real button inside it (not the cell itself) so it's a
 * proper keyboard/screen-reader target, with aria-sort on the cell. */
export function SortTh<K extends string>({
  label, thKey, sort, toggle, className,
}: { label: string; thKey: K; sort: { key: K; dir: SortDir } | null; toggle: (k: K) => void; className?: string }) {
  const active = sort?.key === thKey;
  return (
    <th className={className} aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="sort-th" onClick={() => toggle(thKey)}>
        {label}
        {active && <span className="sort-ind">{sort!.dir === 1 ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}

/* ============================ manage (owner) ============================ */

/** Escape closes whatever full-screen overlay is currently mounted — the item
 * Sheet and Stocktake, both of which only exist in the tree while open, so
 * there's no "active" flag to track (unlike the popovers below). */
export function useEscapeClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** A small dismissable panel anchored to its trigger button — closes on an
 * outside click, Escape, or its own × — shared by the Add staff and Export
 * popovers below since both need identical dismiss behavior. */
export function usePopoverClose(active: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, onClose]);
  return ref;
}
