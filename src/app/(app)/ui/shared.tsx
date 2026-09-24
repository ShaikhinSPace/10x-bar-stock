"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LOCS, LOC_SHORT, WASTAGE_REASONS, bizDayKey, cap, catHue, fmt, fmtQty, levelsAt, openLabel, undoableMoveIds, type Category, type Item, type Loc, type Move, type SessionUser, type WastageReason } from "@/lib/model";
import { countBarBottles, giveOut, logWaste, receive, transferBar, undoMove, type Result } from "../../actions";
import { useAction } from "../shell";

type SheetAct = "give" | "receive" | "transfer" | "waste" | "count";

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

/** Muted category dots — grouping cues inside a delivery, not a data encoding. */
/** Hand-picked dots for the seeded categories; anything created later derives one. */
const CAT_COLOR: Record<string, string> = {
  WHISKEY: "#C08A4A", VODKA: "#6FA8DC", TEQUILA: "#8FBF6A", GIN: "#5FB8A8",
  RUM: "#C2705A", BEER: "#D6A63C", WINE: "#B0607F", MIXER: "#7E8CA8",
  WELL: "#9AA3B2", OTHER: "#8E86F2",
};

/**
 * Categories are created by the owner now, so neither palette can be exhaustive.
 * An unknown one gets a colour derived from its name: stable across renders and
 * sessions, and in the same lightness band as the hand-picked values so a new
 * category does not glare next to them.
 */
export const catColor = (c: string) => CAT_COLOR[c] ?? `oklch(0.72 0.075 ${catHue(c)})`;

export const catBarColor = (c: string) => CAT_BAR_COLOR[c] ?? `oklch(0.63 0.155 ${catHue(c)})`;

export const LOC_COLOR: Record<Loc, string> = {
  store: "var(--store)", patio: "var(--patio)", back: "var(--back)",
};

/**
 * Store-by-category bars: a real data encoding, not a grouping dot, so it
 * gets its own palette rather than reusing CAT_COLOR's muted values (those
 * read fine as small dots but wash out as large fills on the dark surface).
 * Every category keeps the same bar color regardless of rank, so a
 * category's identity never repaints just because stock levels shifted.
 * Alternating lightness (0.59/0.67 OKLCH) between adjacent categories in
 * fixed hue order clears an 8+ OKLab pairwise-distance target across all 9 —
 * worst case (Whiskey/Other) checked at 10.3.
 *
 * WELL is deliberately a neutral grey rather than another hue: it is a
 * cross-cutting tag (a well bottle is also a whiskey, a gin...), so it should
 * not compete with the real spirit categories for a slot in that palette.
 * It only ever appears as a main category if someone explicitly picks it.
 */
const CAT_BAR_COLOR: Record<string, string> = {
  WHISKEY: "#C75157", VODKA: "#D67B19", TEQUILA: "#8F7E03", GIN: "#5FAB4D",
  RUM: "#069180", BEER: "#00A6C9", WINE: "#457BD5", MIXER: "#A47DE3",
  WELL: "#8A93A3", OTHER: "#B55499",
};

/* ============================ helpers ============================ */

/** Sort key for a category name, following the order the owner set in Manage. */
export const rankIn = (cats: Category[]) => (c: string) => {
  const i = cats.findIndex((x) => x.name === c);
  return i < 0 ? 99 : i;
};

export const sumAt = (items: Item[], k: Loc) => items.reduce((a, i) => a + Math.max(0, i[k]), 0);

/** The last 7 business days, each as its bucket-key midnight. setDate so DST can't drop a day. */
export function last7(now: number): Date[] {
  const start = new Date(bizDayKey(now));
  const out: Date[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(d.getDate() - i);
    out.push(d);
  }
  return out;
}

export function dayKey(ts: number, now: number) {
  const k = bizDayKey(ts), today = bizDayKey(now);
  if (k === today) return "Today";
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  if (k === yest.getTime()) return "Yesterday";
  return new Date(k).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export const timeStr = (ts: number) =>
  new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/* ============================ dashboard ============================ */

/**
 * The bottle sheet and its scrim. Lives with whichever tab can open one, so the
 * item it shows always comes from that route's own freshly rendered `items` -
 * a give logged from here re-renders the page and the numbers follow.
 */
export function BottleSheet({
  items, moves, id, user, onClose,
}: {
  items: Item[]; moves: Move[]; id: number | null; user: SessionUser;
  onClose: () => void;
}) {
  const item = id === null ? null : items.find((i) => i.id === id) ?? null;
  // Undoability is judged across every bottle, then narrowed to this one: the rule
  // only ever depends on what happened to the same bottle, but it has to be computed
  // before filtering so nothing that blocks an undo gets dropped first.
  const undoable = useMemo(() => undoableMoveIds(moves), [moves]);
  const mine = useMemo(
    () => (item ? moves.filter((m) => m.item_id === item.id) : []),
    [moves, item]
  );
  return (
    <>
      <div className={`scrim${item ? " show" : ""}`} onClick={onClose} />
      <div className={`sheet${item ? " show" : ""}`}>
        {item && (
          <Sheet key={item.id} item={item} recent={mine} undoable={undoable} user={user}
            onClose={onClose} />
        )}
      </div>
    </>
  );
}

function Sheet({
  item, recent, undoable, user, onClose,
}: {
  item: Item; recent: Move[]; undoable: Set<number>; user: SessionUser;
  onClose: () => void;
}) {
  const { pending, run: runAction } = useAction();
  // Every commit in here closes the sheet once it succeeds. That used to ride on
  // run()'s old default; it is stated once here instead of at all seven buttons.
  const run = (fn: () => Promise<Result>, ok: string, onOk: () => void = onClose) =>
    runAction(fn, ok, onOk);

  useEscapeClose(onClose);
  const [act, setAct] = useState<SheetAct>("give");

  const [bar, setBar] = useState<Loc | null>(null);
  const [giveQty, setGiveQty] = useState(1);
  const [recvQty, setRecvQty] = useState(1);

  // Transfer state. Quantity is text, not a number, for the same reason Count's is:
  // bar-to-bar transfers are partial (0.25 steps, same as a bar count), so the field
  // has to accept "0.75" while it's still being typed. Store is always whole bottles.
  const [transFrom, setTransFrom] = useState<Loc>("patio");
  const [transTo, setTransTo] = useState<Loc>("back");
  const [transQtyStr, setTransQtyStr] = useState("1");
  const transQty = Number(transQtyStr) || 0;
  const transBothBars = transFrom !== "store" && transTo !== "store";
  const transStep = transBothBars ? 0.25 : 1;

  // Waste state - same string/partial split as transfer: a bar can spill
  // part of a bottle, the storeroom can't.
  const [wasteLoc, setWasteLoc] = useState<Loc>("patio");
  const [wasteReason, setWasteReason] = useState<WastageReason>("Spill / Breakage");
  const [wasteQtyStr, setWasteQtyStr] = useState("1");
  const wasteQty = Number(wasteQtyStr) || 0;
  const wasteIsBar = wasteLoc !== "store";

  // Count state. Only the bars are counted — a row per open bottle, seeded from the
  // last bottle-by-bottle count so a recount starts from what's already known. The
  // storeroom isn't counted: it's whole sealed bottles whose total is fixed by the
  // deliveries in and gives out, so there's nothing to recount there.
  const [countLoc, setCountLoc] = useState<Loc>("patio");
  const [bottles, setBottles] = useState<string[]>(() => seedBottles(item, "patio"));

  const presets = item.cat === "BEER" ? [1, 6, 12, 24] : [1, 2, 3, 6];
  const barLevels = bottles.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const barTotal = Math.round(barLevels.reduce((a, n) => a + n, 0) * 100) / 100;
  const countedBottles = barLevels.length;
  const barDelta = Math.round((barTotal - item[countLoc]) * 100) / 100;

  return (
    <div className="sheet-in">
      <div className="grab" />
      <button className="sheet-close" aria-label="Close" onClick={onClose}>×</button>
      <div className="sname">{item.name}</div>
      <div className="scat">{cap(item.cat)}</div>

      <div className="mini">
        {LOCS.map((k) => {
          const open = openLabel(item, k);
          return (
            <div className={`c ${k}`} key={k}>
              <div className="v">{fmtQty(item.cat, item[k])}</div>
              <div className="k">{LOC_SHORT[k]}</div>
              {open && <div className="o" title={levelsAt(item, k).join(" + ")}>{open}</div>}
            </div>
          );
        })}
      </div>

      {/* Give/Receive/Count are what staff do dozens of times a shift, so they get the
          primary tab strip. Transfer and Wastage are rarer and, for wastage, destructive —
          demoted to smaller secondary buttons below rather than competing for equal space
          in what used to be a 5-wide, horizontally-scrolling strip. */}
      <div className="actseg">
        {(["give", "receive", "count"] as SheetAct[]).map((a) => (
          <button key={a} className={act === a ? "on" : ""} onClick={() => setAct(a)}>
            {a === "give" ? "Give" : a === "receive" ? "Receive" : "Count"}
          </button>
        ))}
      </div>
      <div className="actmore">
        <button className={`actmore-btn${act === "transfer" ? " on" : ""}`} onClick={() => setAct("transfer")}>
          Transfer stock
        </button>
        <button className={`actmore-btn${act === "waste" ? " on danger" : ""}`} onClick={() => setAct("waste")}>
          Record wastage
        </button>
      </div>

      {act === "give" && (
        <div>
          <div className="lbl">To which bar?</div>
          <div className="pickrow">
            {(["patio", "back"] as Loc[]).map((b) => (
              <button key={b} data-t={b} className={`pick${bar === b ? " sel" : ""}`}
                onClick={() => setBar(b)}>
                <span className="bd" style={{ background: LOC_COLOR[b] }} />{LOC_SHORT[b]}
              </button>
            ))}
          </div>
          <div className="lbl">How many bottles?</div>
          <QtyPicker qty={giveQty} setQty={setGiveQty} presets={presets} />
          <button className="commit" disabled={!bar || pending}
            onClick={() => run(() => giveOut(item.id, giveQty, bar!),
              `${fmtQty(item.cat, giveQty)} × ${item.name} → ${LOC_SHORT[bar!]}`)}>
            {pending ? "Giving…" : "Give out"}
          </button>
        </div>
      )}

      {act === "receive" && (
        <div>
          <div className="lbl">Add to store</div>
          <QtyPicker qty={recvQty} setQty={setRecvQty} presets={presets} />
          <button className="commit green" disabled={pending}
            onClick={() => run(() => receive(item.id, recvQty), `+${fmtQty(item.cat, recvQty)} × ${item.name} received`)}>
            {pending ? "Adding…" : "Add to store"}
          </button>
        </div>
      )}

      {act === "transfer" && (
        <div>
          <div className="lbl">From</div>
          <div className="pickrow">
            {LOCS.map((k) => (
              <button key={k} data-t={k} className={`pick${transFrom === k ? " sel" : ""}`}
                onClick={() => {
                  setTransFrom(k);
                  if (transTo === k) setTransTo(k === "patio" ? "back" : "patio");
                  setTransQtyStr("1");
                }}>
                <span className="bd" style={{ background: LOC_COLOR[k] }} />{LOC_SHORT[k]}
              </button>
            ))}
          </div>
          <div className="lbl">To</div>
          <div className="pickrow">
            {LOCS.map((k) => (
              <button key={k} data-t={k} className={`pick${transTo === k ? " sel" : ""}`}
                disabled={k === transFrom}
                onClick={() => { setTransTo(k); setTransQtyStr("1"); }}>
                <span className="bd" style={{ background: LOC_COLOR[k] }} />{LOC_SHORT[k]}
              </button>
            ))}
          </div>
          <div className="lbl">Transfer quantity</div>
          {transBothBars ? (
            <>
              <div className="qsel">
                <button className="step" aria-label="Decrease quantity"
                  onClick={() => setTransQtyStr(String(Math.max(0, Math.round((transQty - transStep) * 100) / 100)))}>−</button>
                <input className="qnum" type="number" inputMode="decimal" min="0" step="0.05"
                  value={transQtyStr} onChange={(e) => setTransQtyStr(e.target.value)} />
                <button className="step" aria-label="Increase quantity"
                  onClick={() => setTransQtyStr(String(Math.round((transQty + transStep) * 100) / 100))}>+</button>
              </div>
              <div className="hint" style={{ textAlign: "center", margin: "-8px 0 16px" }}>
                Bars count part bottles — 0.5 is a half, 0.25 a quarter.
              </div>
            </>
          ) : (
            <QtyPicker qty={transQty} setQty={(n) => setTransQtyStr(String(n))} presets={presets} />
          )}
          <button className="commit" disabled={pending || transQty <= 0}
            onClick={() => run(() => transferBar(item.id, transQty, transFrom, transTo),
              `Transferred ${fmtQty(item.cat, transQty)} × ${item.name} (${LOC_SHORT[transFrom]} → ${LOC_SHORT[transTo]})`)}>
            {pending ? "Transferring…" : "Transfer stock"}
          </button>
        </div>
      )}

      {act === "waste" && (
        <div>
          <div className="lbl">Wasted from</div>
          <div className="pickrow">
            {LOCS.map((k) => (
              <button key={k} data-t={k} className={`pick${wasteLoc === k ? " sel" : ""}`}
                onClick={() => { setWasteLoc(k); setWasteQtyStr("1"); }}>
                <span className="bd" style={{ background: LOC_COLOR[k] }} />{LOC_SHORT[k]}
              </button>
            ))}
          </div>
          <div className="lbl">Reason</div>
          <div className="fld" style={{ marginBottom: 16 }}>
            <select value={wasteReason} onChange={(e) => setWasteReason(e.target.value as WastageReason)}>
              {WASTAGE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="lbl">Quantity wasted</div>
          {wasteIsBar ? (
            <>
              <div className="qsel">
                <button className="step" aria-label="Decrease quantity"
                  onClick={() => setWasteQtyStr(String(Math.max(0, Math.round((wasteQty - 0.25) * 100) / 100)))}>−</button>
                <input className="qnum" type="number" inputMode="decimal" min="0" step="0.05"
                  value={wasteQtyStr} onChange={(e) => setWasteQtyStr(e.target.value)} />
                <button className="step" aria-label="Increase quantity"
                  onClick={() => setWasteQtyStr(String(Math.round((wasteQty + 0.25) * 100) / 100))}>+</button>
              </div>
              <div className="hint" style={{ textAlign: "center", margin: "-8px 0 16px" }}>
                Bars count part bottles — 0.5 is a half, 0.25 a quarter.
              </div>
            </>
          ) : (
            <QtyPicker qty={wasteQty} setQty={(n) => setWasteQtyStr(String(n))} presets={presets} />
          )}
          <button className="commit red" disabled={pending || wasteQty <= 0}
            onClick={() => {
              if (confirm(`Record ${fmtQty(item.cat, wasteQty)} × ${item.name} as wasted from `
                + `${LOC_SHORT[wasteLoc]} (${wasteReason})?`)) {
                run(() => logWaste(item.id, wasteQty, wasteLoc, wasteReason),
                  `Recorded ${fmtQty(item.cat, wasteQty)} × ${item.name} waste (${wasteReason})`);
              }
            }}>
            {pending ? "Recording…" : "Record wastage"}
          </button>
        </div>
      )}

      {act === "count" && (
        <div>
          <div className="lbl">Count which bar?</div>
          <div className="pickrow">
            {(["patio", "back"] as Loc[]).map((k) => (
              <button key={k} data-t={k} className={`pick${countLoc === k ? " sel" : ""}`}
                onClick={() => { setCountLoc(k); setBottles(seedBottles(item, k)); }}>
                <span className="bd" style={{ background: LOC_COLOR[k] }} />{LOC_SHORT[k]}
              </button>
            ))}
          </div>
          <div className="lbl">Each open bottle, how full?</div>
          <BottleLevels levels={bottles} setLevels={setBottles} />
          <div className="cnote">
            {barDelta === 0
              ? `No change — ${LOC_SHORT[countLoc]} stays at ${fmt(barTotal)}`
              : `${LOC_SHORT[countLoc]}: ${fmt(item[countLoc])} → ${fmt(barTotal)} (${barDelta > 0 ? "+" : ""}${fmt(barDelta)})`}
          </div>
          <div className="hint" style={{ textAlign: "center", margin: "-8px 0 16px" }}>
            One row per bottle on the bar — 1 is full, 0.5 a half, 0.25 a quarter.
            No adding up needed.
          </div>
          <button className="commit amber" disabled={pending}
            onClick={() => run(
              () => countBarBottles(item.id, countLoc, bottles.map(Number).filter((n) => n > 0)),
              `${LOC_SHORT[countLoc]} count: ${item.name} = ${fmt(barTotal)}`
                + (countedBottles ? ` across ${countedBottles} bottle${countedBottles === 1 ? "" : "s"}` : ""))}>
            {pending ? "Saving…" : "Set count"}
          </button>
        </div>
      )}

      <RecentOnBottle recent={recent} undoable={undoable} user={user}
        pending={pending} onUndo={(id) => runAction(() => undoMove(id), "Entry undone")} />
    </div>
  );
}

/**
 * The last few moves on this bottle, with undo where it will work.
 *
 * This is the tap-again path: mis-hit Give instead of Count in a rush and the fix is
 * on the bottle you just mis-hit, rather than a six-second toast or a hunt through
 * the whole activity log.
 */
function RecentOnBottle({
  recent, undoable, user, pending, onUndo,
}: {
  recent: Move[]; undoable: Set<number>; user: SessionUser;
  pending: boolean; onUndo: (id: number) => void;
}) {
  const shown = recent.slice(0, 4);
  if (!shown.length) return null;

  return (
    <div className="rcb">
      <div className="rcb-h">Recent on this bottle</div>
      {shown.map((m) => {
        const allowed = undoable.has(m.id);
        const canUndo = allowed && (user.role === "owner" || m.user_name === user.name);
        // Only explain a rule that blocked it. "Not your entry" needs no label -
        // the barback cannot act on it either way and the reason is obvious.
        const locked = allowed ? null
          : m.type === "count" ? "newer entries" : "counted since";
        const what = m.type === "give" ? `Gave ${fmtQty(m.cat, m.qty ?? 0)} to ${LOC_SHORT[m.loc!]}`
          : m.type === "receive" ? `Received ${fmtQty(m.cat, m.qty ?? 0)}${m.batch ? " (delivery)" : ""}`
          : m.type === "waste" ? `Wasted ${fmtQty(m.cat, m.qty ?? 0)} off ${LOC_SHORT[m.loc!]}`
          : m.type === "transfer"
            ? `Moved ${fmtQty(m.cat, m.qty ?? 0)} ${LOC_SHORT[m.loc!]} → ${LOC_SHORT[m.to_loc!]}`
            : `Counted ${LOC_SHORT[m.loc!]} to ${fmtQty(m.cat, m.to_val ?? 0)}`;
        return (
          <div className="rcb-r" key={m.id}>
            <div className="rcb-t">
              <span className="w">{what}</span>
              <span className="b">{timeStr(+new Date(m.ts))} · {m.user_name}</span>
            </div>
            {canUndo && (
              <button className="rcb-u" disabled={pending} onClick={() => onUndo(m.id)}>
                Undo
              </button>
            )}
            {locked && (
              <span className="rcb-l"
                title="A later count is now the truth for this bottle — correct it with another Count">
                {locked}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Rows to start a bar count from: the last bottle-by-bottle count if there
 * is one, otherwise the plain total split into as many full bottles as it
 * holds plus the remainder - which is the most likely shape, and still
 * every row is editable.
 */
function seedBottles(item: Item, loc: Loc): string[] {
  const known = levelsAt(item, loc).filter((n) => n > 0);
  if (known.length) return known.map((n) => String(n));

  const total = item[loc];
  if (total <= 0) return ["1"];
  const full = Math.floor(total);
  const rest = Math.round((total - full) * 100) / 100;
  return [...Array(full).fill("1"), ...(rest > 0 ? [String(rest)] : [])];
}

/** One row per open bottle, with the running total done for you. */
function BottleLevels({
  levels, setLevels,
}: { levels: string[]; setLevels: (v: string[]) => void }) {
  const total = Math.round(
    levels.map(Number).filter((n) => Number.isFinite(n) && n > 0).reduce((a, n) => a + n, 0) * 100
  ) / 100;
  const set = (idx: number, v: string) => setLevels(levels.map((x, i) => (i === idx ? v : x)));

  return (
    <div className="blv">
      {levels.map((v, i) => (
        <div className="blv-row" key={i}>
          <span className="blv-n">Bottle {i + 1}</span>
          <div className="blv-quick">
            {[1, 0.75, 0.5, 0.25].map((q) => (
              <button key={q} className={`blv-q${Number(v) === q ? " on" : ""}`}
                aria-pressed={Number(v) === q}
                onClick={() => set(i, String(q))}>
                {q === 1 ? "Full" : q === 0.5 ? "½" : q === 0.75 ? "¾" : "¼"}
              </button>
            ))}
          </div>
          <input className="blv-in" type="number" inputMode="decimal" min="0" max="1" step="0.05"
            aria-label={`Bottle ${i + 1} level`} value={v} onChange={(e) => set(i, e.target.value)} />
          <button className="blv-x" aria-label={`Remove bottle ${i + 1}`}
            onClick={() => setLevels(levels.filter((_, x) => x !== i))}>×</button>
        </div>
      ))}
      <div className="blv-foot">
        <button className="blv-add" onClick={() => setLevels([...levels, "1"])}>+ Add a bottle</button>
        <span className="blv-tot">
          {levels.length} bottle{levels.length === 1 ? "" : "s"} · <b>{fmt(total)}</b> total
        </span>
      </div>
    </div>
  );
}

function QtyPicker({
  qty, setQty, presets,
}: { qty: number; setQty: (n: number) => void; presets: number[] }) {
  return (
    <>
      <div className="qsel">
        <button className="step" aria-label="Decrease quantity" onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
        <div className="qnum">{qty}</div>
        <button className="step" aria-label="Increase quantity" onClick={() => setQty(qty + 1)}>+</button>
      </div>
      <div className="presets">
        {presets.map((p) => (
          <button key={p} className={`preset${p === qty ? " on" : ""}`} onClick={() => setQty(p)}>{p}</button>
        ))}
      </div>
    </>
  );
}

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
