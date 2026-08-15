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
  id: number; ts: string; type: "give" | "receive" | "count";
  item_id: number; item_name: string; cat: Cat;
  qty: number | null; loc: Loc | null;
  from_val: number | null; to_val: number | null;
  user_name: string;
};

export type SessionUser = {
  id: number; name: string; username: string; role: "owner" | "staff";
};

export type Staff = {
  id: number; username: string; name: string; role: "owner" | "staff"; active: boolean;
};

/** Store is whole bottles; bars are counted to 2dp. */
export const fmt = (n: number) =>
  Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);

/** "WHISKEY" -> "Whiskey", "manage" -> "Manage". */
export const cap = (c: string) => c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
