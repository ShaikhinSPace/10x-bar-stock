// Shared shapes and constants. No server imports — the client bundle pulls this in.

/** A category name. Free text now, so it is validated against the database. */
export type Cat = string;

/** One row of the categories table, with what currently points at it. */
export type Category = {
  name: string;
  /** LIVE bottles whose MAIN category this is — what totals and colours key off. */
  items: number;
  /** LIVE bottles carrying it as an extra tag. */
  tags: number;
  /**
   * Total references INCLUDING archived bottles. An archived bottle still holds the
   * category foreign key, so a category with refs > 0 can't be hard-deleted — its
   * bottles must be merged elsewhere first. `items`/`tags` (live) drive the display;
   * `refs` drives the delete-vs-merge decision, so the two never disagree with the server.
   */
  refs: number;
  /** Muted dot colour for grouping cues. Null → derive from name via catHue(). */
  color: string | null;
  /** Vivid bar-chart colour for data encoding. Null → derive from name via catHue(). */
  bar_color: string | null;
  /** False for categories like MIXER whose items shouldn't raise reorder alerts. */
  raises_reorder_alerts: boolean;
};

/** Longest a category name may be; keeps chips and dropdowns from blowing out. */
export const CAT_MAX = 18;

/**
 * Normalised form of a typed category name. Upper-cased because every existing
 * category is, and the name is the primary key the foreign keys point at — so
 * "Mezcal" and "MEZCAL" must not become two categories.
 */
export const normCat = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");

/**
 * A stable colour for a category with no hand-picked one. Derived from the name so
 * it never repaints between renders, and spread around the wheel so two new
 * categories are unlikely to collide.
 */
export function catHue(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

/** A location slug. Free text now, validated against the database. */
export type Loc = string;

export type Location = {
  slug: string;
  label: string;
  short: string;
  color: string;
  mark_color: string | null;
};

export type Item = {
  id: number; name: string; cat: Cat;
  store: number; patio: number; back: number; rl: number;
  ignore_reorder: boolean;
  /**
   * The individual open bottles behind the patio/back totals, e.g. [1, 0.75,
   * 0.25] for "three open, two bottles' worth". Empty means nobody has
   * counted this item at that bar bottle-by-bottle yet - the scalar is still
   * the truth either way.
   */
  patio_levels: number[]; back_levels: number[];
  /** How many bottles make up a case. 1 = no case concept. Beer defaults to 24. */
  case_size: number;
  /**
   * Extra categories beyond `cat`. `cat` stays the single main one that drives
   * every total, colour and the beer cases rule; these only widen what the
   * bottle can be filtered by, so nothing gets counted twice.
   */
  tags: Cat[];
};

/** Main category plus tags - what this bottle can be filtered under. */
export const catsOf = (i: Item): Cat[] => [i.cat, ...i.tags.filter((t) => t !== i.cat)];
export const inCat = (i: Item, c: string) => i.cat === c || i.tags.includes(c as Cat);

/** The bottle-level breakdown for a bar. Store holds unopened bottles only. */
export const levelsAt = (i: Item, loc: Loc): number[] =>
  loc === "patio" ? i.patio_levels : loc === "back" ? i.back_levels : [];

/** "3 open · 2" — only when a bottle-by-bottle count actually happened. */
export function openLabel(i: Item, loc: Loc): string | null {
  const levels = levelsAt(i, loc).filter((n) => n > 0);
  return levels.length ? `${levels.length} open` : null;
}

export type Move = {
  id: number; ts: string; type: "give" | "receive" | "count" | "waste" | "transfer";
  item_id: number; item_name: string; cat: Cat;
  qty: number | null; loc: Loc | null;
  from_val: number | null; to_val: number | null;
  user_name: string;
  /** Set on every line of a delivery, so one drop groups in the activity log. */
  batch: string | null; invoice: string | null; supplier: string | null;
  notes: string | null; to_loc: Loc | null;
  /**
   * false only on a paperwork-only delivery (owner added the stock manually first,
   * then booked the invoice for the record). True for every other move, including
   * every pre-flag row — stock arithmetic has been default-on for the life of the
   * database. See schema.sql for the full reasoning.
   */
  affects_stock: boolean;
};


/**
 * Which moves undo will actually accept, mirroring applyUndo's rule so a link is
 * never offered on something that would then be refused.
 *
 * Both checks are by id — logging order — not by `ts`: the day editor can backdate a
 * count's `ts` to any business day, and judging "after" by ts there would hide a
 * backdated count sitting on top of a give. A count undoes only while it is the newest
 * move on its bottle (max id); a non-count undoes while no count on the same bottle
 * has a higher id. Paperwork receives (affects_stock = false) moved no stock, so no
 * count depends on them — they are always undoable.
 *
 * Order of `moves` doesn't matter, but it must not be filtered by type - a count
 * hidden by a filter still has to freeze the gives underneath it. Any window works as
 * long as it is complete: anything logged after a move in the window is in it too.
 */
export function undoableMoveIds(moves: Move[]): Set<number> {
  const maxId = new Map<number, number>();
  const lastCountId = new Map<number, number>();
  for (const m of moves) {
    if (m.id > (maxId.get(m.item_id) ?? 0)) maxId.set(m.item_id, m.id);
    if (m.type === "count" && m.id > (lastCountId.get(m.item_id) ?? 0)) {
      lastCountId.set(m.item_id, m.id);
    }
  }
  const ok = new Set<number>();
  for (const m of moves) {
    if (m.type === "count") {
      if (maxId.get(m.item_id) === m.id) ok.add(m.id);
    } else if (m.affects_stock === false) {
      ok.add(m.id); // paperwork receive — no stock to freeze, always undoable
    } else {
      const c = lastCountId.get(m.item_id);
      if (!c || c < m.id) ok.add(m.id);
    }
  }
  return ok;
}

/** A booked delivery, rebuilt from the moves that share one batch id. */
export type Delivery = {
  batch: string; invoice: string; supplier: string | null;
  ts: string; user_name: string; user_id: number | null; bottles: number;
  /** Sum of the per-line costs; null when no line carried one. */
  cost: number | null;
  /** false when this delivery is paperwork only — all of its receive moves share the flag. */
  affects_stock: boolean;
  // item_id is what lets a booked delivery be loaded back into the editor.
  lines: { item_id: number; item: string; cat: Cat; qty: number; cost: number | null; case_size: number | null }[];
};

/** One line of a delivery being drafted on the Delivery tab. */
export type DeliveryLine = {
  itemId: number; qty: number;
  cost?: number | null;
  /** Bottles per case AS RECEIVED for this line. Omit for loose bottles. */
  caseSize?: number | null;
};

export type SessionUser = {
  id: number; name: string; username: string; role: "owner" | "staff";
};

/** Display metadata for a role. The slug stays structural (permission checks). */
export type Role = { slug: string; label: string; description: string };

export type Staff = {
  id: number; username: string; name: string; role: "owner" | "staff"; active: boolean;
};

/** Stock level at a location. The item's store/patio/back fields are named after the slugs. */
export const stockAt = (i: Item, loc: Loc): number =>
  (i as unknown as Record<string, number>)[loc] ?? 0;

/** Store is whole bottles; bars are counted to 2dp. */
export const fmt = (n: number) =>
  Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);

const CASE_SIZE = 24;

/**
 * Beer is bought and stocked by the case (24 bottles), so a raw bottle count
 * like "192" is harder to read at a glance than "8 cases" — this is how the
 * owner actually thinks about and orders it. Every other category stays in
 * plain bottles, since a "case of whiskey" isn't a real unit here.
 *
 * Below one case, or for anything not a clean multiple, falls back to plain
 * bottles (or "N cases + M") rather than inventing a fractional-case unit.
 * Reserved for on-screen numbers only — CSV/Excel exports stay in raw bottle
 * counts, since that's what real spreadsheet math needs.
 */
export function fmtQty(cat: Cat, n: number, caseSize: number = CASE_SIZE): string {
  // "Counts in cases" is now driven by case_size, not a hardcoded BEER rule.
  // Beer defaults to 24; the owner can change any item from Manage. caseSize <= 1
  // means "no case concept" — show plain bottles.
  if (caseSize <= 1 || n < caseSize) return fmt(n);
  const cases = Math.floor(n / caseSize);
  const rem = Math.round((n - cases * caseSize) * 100) / 100;
  const label = `${cases} case${cases === 1 ? "" : "s"}`;
  return rem > 0 ? `${label} + ${fmt(rem)}` : label;
}

/** Everything this bottle has, across all three locations. */
export const totalOf = (i: Item) => i.store + i.patio + i.back;

/**
 * Mixers (juices, syrups, salt, Tajin) are consumables nobody walks off with, and
 * they were 11 of the 55 day-one alerts. They stay out of every reorder surface —
 * a mixer at zero still shows OUT on the Stock tab, it just doesn't raise an alert.
 * Same for any single item with ignore_reorder set (e.g. a flavor being sold down,
 * not restocked) - a category-wide switch and a per-item one, same effect.
 *
 * Reorder is measured against the STORE only: you reorder from the supplier into
 * the storeroom, not into a bar.
 */
export const needsReorder = (i: Item, noAlertCats: Set<string>) =>
  !i.ignore_reorder && !noAlertCats.has(i.cat) && i.store <= i.rl;

/** Build the set of category names that suppress reorder alerts. */
export const noAlertSet = (cats: Category[]) =>
  new Set(cats.filter((c) => !c.raises_reorder_alerts).map((c) => c.name));

/** "WHISKEY" -> "Whiskey", "manage" -> "Manage". */
export const cap = (c: string) => c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();

/** App-wide settings, read from the `settings` table. */
export type Settings = {
  bar_name: string;
  app_subtitle: string;
  business_day_cutoff_hour: number;
  business_tz: string;
};

/** Defaults used when settings haven't been loaded from DB yet (e.g. in tests). */
export const DEFAULT_SETTINGS: Settings = {
  bar_name: "10X Bar",
  app_subtitle: "STOCK CONTROL",
  business_day_cutoff_hour: 3,
  business_tz: "America/Chicago",
};

/**
 * The business-day key for a timestamp, as a TZ-local "YYYY-MM-DD".
 *
 * Vercel's functions run in UTC — hence Intl + the explicit timezone, instead
 * of Date.setHours (which would silently use the server's local time).
 */
export function bizDayKey(ts: number, cutoffHour = DEFAULT_SETTINGS.business_day_cutoff_hour, tz = DEFAULT_SETTINGS.business_tz): string {
  const shifted = new Date(ts - cutoffHour * 3_600_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(shifted);
}

/** Shift a business-day key by N days (negative to go back). "YYYY-MM-DD" in, "YYYY-MM-DD" out. */
export function addBusinessDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12));
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}-${String(base.getUTCDate()).padStart(2, "0")}`;
}
