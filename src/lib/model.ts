// Shared shapes and constants. No server imports — the client bundle pulls this in.

/**
 * Categories a fresh database is seeded with, and the ones with hand-picked
 * colours. NOT the whole set — the owner creates and deletes categories from
 * Manage, so the live list comes from the categories table and is threaded
 * through as props. Treat this as defaults, never as validation.
 */
export const SEED_CATS = [
  "WHISKEY", "VODKA", "TEQUILA", "GIN", "RUM", "BEER", "WINE", "MIXER", "WELL", "OTHER",
] as const;

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

export const LOCS = ["store", "patio", "back"] as const;
export type Loc = (typeof LOCS)[number];

export const LOC_LABEL: Record<Loc, string> = {
  store: "Store", patio: "Patio Bar", back: "Back Bar",
};
/** Short form for chips and tags. */
export const LOC_SHORT: Record<Loc, string> = {
  store: "Store", patio: "Patio", back: "Back",
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
};

export const WASTAGE_REASONS = [
  "Spill / Breakage",
  "Expired / Spoiled",
  "Staff Comp / Promo",
  "Overpour",
  "Other",
] as const;
export type WastageReason = (typeof WASTAGE_REASONS)[number];

/**
 * Which moves undo will actually accept, mirroring undoMove's rule so a link is
 * never offered on something that would then be refused.
 *
 * give/receive/waste/transfer are deltas and deltas commute, so one stays undoable
 * until its bottle is counted. A count sets an absolute figure, so it only reverses
 * while nothing else has touched that bottle since.
 *
 * `moves` must be newest-first and must not be filtered by type — a count hidden by
 * a filter still has to freeze the gives underneath it. Any window works as long as
 * it is complete: anything logged after a move in the window is also in the window.
 */
export function undoableMoveIds(moves: Move[]): Set<number> {
  const ok = new Set<number>();
  const countedSince = new Set<number>();
  const touchedSince = new Set<number>();
  for (const m of moves) {
    const isCount = m.type === "count";
    if (isCount ? !touchedSince.has(m.item_id) : !countedSince.has(m.item_id)) ok.add(m.id);
    if (isCount) countedSince.add(m.item_id);
    touchedSince.add(m.item_id);
  }
  return ok;
}

/** A booked delivery, rebuilt from the moves that share one batch id. */
export type Delivery = {
  batch: string; invoice: string; supplier: string | null;
  ts: string; user_name: string; user_id: number | null; bottles: number;
  // item_id is what lets a booked delivery be loaded back into the editor.
  lines: { item_id: number; item: string; cat: Cat; qty: number }[];
};

/** One line of a delivery being drafted on the Delivery tab. */
export type DeliveryLine = { itemId: number; qty: number };

export type SessionUser = {
  id: number; name: string; username: string; role: "owner" | "staff";
};

export type Staff = {
  id: number; username: string; name: string; role: "owner" | "staff"; active: boolean;
};

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
export function fmtQty(cat: Cat, n: number): string {
  if (cat !== "BEER" || n < CASE_SIZE) return fmt(n);
  const cases = Math.floor(n / CASE_SIZE);
  const rem = Math.round((n - cases * CASE_SIZE) * 100) / 100;
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
export const NO_REORDER_ALERTS: readonly Cat[] = ["MIXER"];
export const needsReorder = (i: Item) =>
  !i.ignore_reorder && !NO_REORDER_ALERTS.includes(i.cat) && i.store <= i.rl;

/** "WHISKEY" -> "Whiskey", "manage" -> "Manage". */
export const cap = (c: string) => c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();

/**
 * A bar's night runs past midnight, so a "day" isn't midnight-to-midnight: the shift
 * runs from noon to roughly 6am the next morning. DAY_START_HOUR is that cutoff — any
 * move logged before it counts toward the previous date's business day, so one night's
 * numbers stay in a single bucket instead of splitting at midnight.
 *
 * ponytail: one constant for now; it becomes a per-location setting when bars keep
 * different hours at multi-bar scale — same bizDayKey, just reading the location's cutoff.
 */
export const DAY_START_HOUR = 12;

/** Local midnight (ms) of the business day that `ts` falls in — the day-bucket key. */
export function bizDayKey(ts: number): number {
  const d = new Date(ts);
  d.setHours(d.getHours() - DAY_START_HOUR, 0, 0, 0); // pull an after-midnight move back into its night
  d.setHours(0, 0, 0, 0);                             // floor to that business day's date
  return d.getTime();
}
