// Shared shapes and constants. No server imports — the client bundle pulls this in.

export const CATS = [
  "WHISKEY", "VODKA", "TEQUILA", "GIN", "RUM", "BEER", "WINE", "MIXER", "OTHER",
] as const;
export type Cat = (typeof CATS)[number];

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
};

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

/** A booked delivery, rebuilt from the moves that share one batch id. */
export type Delivery = {
  batch: string; invoice: string; supplier: string | null;
  ts: string; user_name: string; bottles: number;
  lines: { item: string; cat: Cat; qty: number }[];
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

/** Everything this bottle has, across all three locations. */
export const totalOf = (i: Item) => i.store + i.patio + i.back;

/**
 * Mixers (juices, syrups, salt, Tajin) are consumables nobody walks off with, and
 * they were 11 of the 55 day-one alerts. They stay out of every reorder surface —
 * a mixer at zero still shows OUT on the Stock tab, it just doesn't raise an alert.
 *
 * Reorder is measured against the STORE only: you reorder from the supplier into
 * the storeroom, not into a bar.
 */
export const NO_REORDER_ALERTS: readonly Cat[] = ["MIXER"];
export const needsReorder = (i: Item) =>
  !NO_REORDER_ALERTS.includes(i.cat) && i.store <= i.rl;

/** "WHISKEY" -> "Whiskey", "manage" -> "Manage". */
export const cap = (c: string) => c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
