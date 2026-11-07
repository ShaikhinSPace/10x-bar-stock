"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cap, fmt, fmtQty, inCat, levelsAt, needsReorder, noAlertSet, openLabel, stockAt, undoableMoveIds, type Category, type Item, type Loc, type Move, type SessionUser } from "@/lib/model";
import { giveRun, submitStocktake, undoMove, type Variance } from "../../actions";
import { useAction } from "../shell";
import { BottleSheet } from "./bottle-sheet";
import { DAY, LOC_ICON, locColor, rankIn, sumAt, timeStr, useEscapeClose, useLocMaps } from "./shared";

/* ============================ stock ============================ */

export function Stock({
  items, moves, now, user, cats,
}: {
  items: Item[]; moves: Move[]; now: number; user: SessionUser; cats: Category[];
}) {
  const { slugs: LOCS, short: LOC_SHORT } = useLocMaps();
  const catRank = useMemo(() => rankIn(cats), [cats]);
  const nac = useMemo(() => noAlertSet(cats), [cats]);
  const [sheetId, setSheetId] = useState<number | null>(null);
  const [loc, setLoc] = useState<Loc>("store");
  const [cat, setCat] = useState<string>("ALL");
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  const shown = useMemo(() => {
    let out = [...items].sort((a, b) => catRank(a.cat) - catRank(b.cat) || a.name.localeCompare(b.name));
    if (lowOnly) out = loc === "store" ? out.filter((i) => needsReorder(i, nac)) : out.filter((i) => stockAt(i, loc) > 0);
    // Matches the main category or any tag, so picking Well finds every well
    // bottle without changing what they count towards.
    else if (cat !== "ALL") out = out.filter((i) => inCat(i, cat));
    const needle = q.trim().toLowerCase();
    if (needle) out = out.filter((i) => i.name.toLowerCase().includes(needle));
    return out;
  }, [items, loc, cat, q, lowOnly, catRank, nac]);

  const since = now - 7 * DAY;
  // One label everywhere — "Given out · 7d". For a bar view it's gives to that bar;
  // for the store view it's gives from the store to any bar. Same window, same term.
  const given7 = fmt(moves
    .filter((m) => m.type === "give" && (loc === "store" || m.loc === loc) && +new Date(m.ts) >= since)
    .reduce((a, m) => a + (m.qty ?? 0), 0));
  const stats = loc === "store"
    ? [
        { n: fmt(sumAt(items, "store")), l: "In store", cls: "accent" },
        { n: String(items.filter((i) => needsReorder(i, nac)).length), l: "Reorder", cls: "warn" },
        { n: given7, l: "Given out · 7d", cls: "" },
      ]
    : [
        { n: fmt(sumAt(items, loc)), l: "At this bar", cls: "accent" },
        { n: String(items.filter((i) => stockAt(i, loc) > 0).length), l: "Items stocked", cls: "" },
        { n: given7, l: "Given out · 7d", cls: "" },
      ];

  // Only categories that actually have a bottle get a chip, in the owner's order.
  const chips = ["ALL", ...cats.map((c) => c.name).filter((c) => items.some((i) => inCat(i, c)))];

  return (
    <>
      <div className="ptitle">Stock <span className="sub">tap a bottle to log a move</span></div>

      <div className="locs">
        {LOCS.map((k) => (
          <button key={k} data-loc={k} aria-pressed={loc === k}
            className={`loc${loc === k ? " on" : ""}`}
            onClick={() => { setLoc(k); setLowOnly(k !== "store"); }}>
            {LOC_ICON[k]}
            <span className="nm">{LOC_SHORT[k]}</span>
            <span className="ct">{fmt(sumAt(items, k))}</span>
          </button>
        ))}
      </div>

      {/* Bulk give-run from the store to a bar — anyone restocking a bar at open
          benefits, so it's visible to owners and staff alike. Hidden on the bar
          views because the flow is store → bar and the destination is the bar. */}
      {loc === "store" && (
        <Link className="stk-start run" href="/stock/run">
          <span className="si">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M13 3 4 14h7l-1 7 9-11h-7z" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="st">
            <span className="n">Run stock to a bar</span>
            <span className="b">Load Patio or Back in one pass, straight from the store</span>
          </span>
          <span className="sgo">›</span>
        </Link>
      )}

      {/* No per-location Count CTA here — the daily count is "Count today →" on the
          Dashboard (Patio → Back → Store as one sweep). Mid-day per-bottle corrections
          are still available via each bottle's own sheet. */}

      <div className="stats">
        {stats.map((s) => (
          <div className={`stat ${s.cls}`} key={s.l}><div className="n">{s.n}</div><div className="l">{s.l}</div></div>
        ))}
      </div>

      <div className="search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" />
        </svg>
        <input placeholder="Search a bottle…" value={q} autoComplete="off"
          onChange={(e) => setQ(e.target.value)} />
        {q && <button className="clr" aria-label="Clear search" onClick={() => setQ("")}>×</button>}
      </div>

      <div className="chips">
        <button className={`chip warn${lowOnly ? " on" : ""}`} onClick={() => setLowOnly(!lowOnly)}>
          {loc === "store" ? "Reorder" : "Stocked here"}
        </button>
        {chips.map((c) => (
          <button key={c} className={`chip${!lowOnly && cat === c ? " on" : ""}`}
            onClick={() => { setCat(c); setLowOnly(false); }}>
            {c === "ALL" ? "All" : cap(c)}
          </button>
        ))}
      </div>

      <div className="list">
        {!shown.length && <div className="empty">No bottles match.</div>}
        {shown.map((i) => {
          const v = stockAt(i, loc);
          const zero = v <= 0;
          const low = loc === "store" && !zero && needsReorder(i, nac);
          return (
            <button key={i.id} onClick={() => setSheetId(i.id)}
              className={`row${zero && loc === "store" ? " zero" : ""}${low ? " lowstk" : ""}`}>
              <div className="info">
                <div className="nm">{i.name}</div>
                {/* Just what the bottle IS. The quantities used to be repeated
                    here for all three locations at once, which buried the one
                    figure you're actually looking at. */}
                <div className="dist"><span className="d-cat">{cap(i.cat)}</span></div>
              </div>
              {loc === "store" && zero && <span className="pill out">OUT</span>}
              {loc === "store" && low && <span className="pill low">LOW</span>}
              {/* The figure for the location you picked, not a grand total. */}
              <div className="qty">
                {fmtQty(i.cat, v, i.case_size)}
                <small>{loc === "store" ? "in store" : `on ${LOC_SHORT[loc].toLowerCase()}`}</small>
                {openLabel(i, loc) && <small className="opn">{openLabel(i, loc)}</small>}
              </div>
            </button>
          );
        })}
      </div>

      <BottleSheet items={items} moves={moves} id={sheetId} user={user}
        onClose={() => setSheetId(null)} activeLoc={loc} />
    </>
  );
}

/**
 * What you just ran, with undo.
 *
 * The barback's whole app is this one screen, so without this a mis-run is only
 * fixable inside the six seconds the toast lasts — the Activity tab and the bottle
 * sheet, where undo otherwise lives, are both off-limits to them.
 *
 * Only your own gives, because that is what "just ran" means and it is exactly the
 * set undoMove will let a barback reverse. Bottles counted since are dropped rather
 * than shown dead: the count is the truth now, and a run screen is the wrong place
 * to explain that.
 */
function JustRan({
  moves, user, pending,
}: {
  moves: Move[]; user: SessionUser; pending: boolean;
}) {
  const { run } = useAction();
  const { short: LOC_SHORT } = useLocMaps();
  const undoable = useMemo(() => undoableMoveIds(moves), [moves]);
  const mine = useMemo(
    () => moves
      .filter((m) => m.type === "give" && m.user_name === user.name && undoable.has(m.id))
      .slice(0, 3),
    [moves, user.name, undoable]
  );
  if (!mine.length) return null;

  return (
    <div className="justran">
      <div className="jr-h">Just ran</div>
      {mine.map((m) => (
        <div className="jr-r" key={m.id}>
          <span className="jr-t">
            {fmtQty(m.cat, m.qty ?? 0)} × {m.item_name} → {LOC_SHORT[m.loc!]}
          </span>
          <span className="jr-w">{timeStr(+new Date(m.ts))}</span>
          <button className="jr-u" disabled={pending}
            onClick={() => run(() => undoMove(m.id), `Put ${m.item_name} back`)}>
            Undo
          </button>
        </div>
      ))}
    </div>
  );
}

/* ============================ run mode ============================ */

/**
 * The barback's give-run as its own full-screen surface.
 *
 * Pick the bar you're running to, and the list sorts itself emptiest-at-that-bar
 * first so the run assembles without hunting. Loading a bottle onto the run is one
 * tap; the whole run commits in a single all-or-nothing giveRun. Store stock is
 * shown because it's the ceiling — you can't run what the storeroom doesn't have.
 *
 * A run is destination-specific, so switching bars clears the cart rather than
 * silently running a Patio load out to Back.
 */
export function RunMode({
  items, moves, user,
}: {
  items: Item[]; moves: Move[]; user: SessionUser;
}) {
  const { label: LOC_LABEL, short: LOC_SHORT } = useLocMaps();
  const { pending, run } = useAction();
  const router = useRouter();
  // For the owner this is one screen among many, so Escape and Done both go back to
  // Stock. For a barback it is the entire app — there is nowhere to leave to, so
  // neither exit exists and Sign out is the only way out.
  const canLeave = user.role === "owner";
  useEscapeClose(() => { if (canLeave) router.push("/stock"); });
  const [dest, setDest] = useState<Loc>("patio");
  const [q, setQ] = useState("");
  const [queue, setQueue] = useState<Record<number, number>>({});

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...items]
      .filter((i) => !needle || i.name.toLowerCase().includes(needle))
      // Lowest at the chosen bar floats up; no par level exists, so current
      // quantity is the proxy for "needs running". Name breaks ties.
      .sort((a, b) => stockAt(a, dest) - stockAt(b, dest) || a.name.localeCompare(b.name));
  }, [items, dest, q]);

  const total = Object.values(queue).reduce((a, n) => a + n, 0);

  // Clamp to what's in the store — the + can never load more than giveRun would accept.
  // ponytail: +1 per tap; add a case step (24) for beer if running cases gets tappy.
  const bump = (id: number, d: number, max: number) =>
    setQueue((s) => {
      const next = Math.max(0, Math.min(max, (s[id] ?? 0) + d));
      const cp = { ...s };
      if (next <= 0) delete cp[id]; else cp[id] = next;
      return cp;
    });

  function commit() {
    const lines = Object.entries(queue).map(([id, qty]) => ({ itemId: Number(id), qty }));
    if (!lines.length) return;
    run(
      () => giveRun(lines, dest),
      `Ran ${total} bottle${total === 1 ? "" : "s"} → ${LOC_LABEL[dest]}`,
      () => setQueue({}), // clears only on success — a refused run keeps the cart to fix
    );
  }

  return (
    <div className="runview">
      <div className="run-head">
        <div className="ptitle" style={{ margin: 0 }}>
          Run stock <span className="sub">store → bar</span>
        </div>
        {canLeave && <Link className="btn ghost" href="/stock">Done</Link>}
      </div>

      <div className="run-fixed">
        <div className="lbl">Running to</div>
        <div className="run-dest">
          {(["patio", "back"] as Loc[]).map((b) => (
            <button key={b} data-loc={b} aria-pressed={dest === b}
              className={`run-pick${dest === b ? " on" : ""}`}
              onClick={() => { setDest(b); setQueue({}); }}>
              <span className="bd" style={{ background: locColor(b) }} />
              <span className="meta">
                <span className="nm">{LOC_LABEL[b]}</span>
                <span className="ct">running lowest at top</span>
              </span>
            </button>
          ))}
        </div>
        <div className="hint" style={{ margin: "0 0 12px" }}>
          Whatever&apos;s running lowest at the bar rises to the top.
        </div>
        <div className="search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" />
          </svg>
          <input placeholder="Search a bottle…" value={q} autoComplete="off"
            onChange={(e) => setQ(e.target.value)} />
          {q && <button className="clr" aria-label="Clear search" onClick={() => setQ("")}>×</button>}
        </div>
      </div>

      <JustRan moves={moves} user={user} pending={pending} />

      <div className="run-list">
        {!shown.length && <div className="empty">No bottles match.</div>}
        {shown.map((i) => {
          const qty = queue[i.id] ?? 0;
          const dead = i.store <= 0;
          const atMax = qty >= i.store;
          return (
            <div key={i.id}
              className={`run-row${qty > 0 ? " queued" : ""}${dest === "back" ? " back" : ""}${dead ? " dead" : ""}`}>
              <div className="info">
                <div className="nm">{i.name}</div>
                <div className="dist">
                  <span className="d-cat">{cap(i.cat)}</span>
                  {qty > 0 && <span className="qmark">→ {LOC_SHORT[dest]}</span>}
                </div>
              </div>
              <div className={`instore${dead ? " none" : ""}`}>
                <span className="v">{dead ? "0" : fmtQty(i.cat, i.store, i.case_size)}</span>
                <span className="k">{dead ? "empty" : "store"}</span>
              </div>
              <div className="run-step">
                <button className="step" aria-label={`Remove one ${i.name}`} disabled={qty <= 0}
                  onClick={() => bump(i.id, -1, i.store)}>−</button>
                <span className={`val${qty <= 0 ? " zero" : ""}`}>{qty}</span>
                <button className={`step plus${qty > 0 ? " on" : ""}`} aria-label={`Add one ${i.name}`}
                  disabled={dead || atMax} onClick={() => bump(i.id, 1, i.store)}>+</button>
              </div>
            </div>
          );
        })}
      </div>

      <button className={`run-commit${dest === "back" ? " back" : ""}${total > 0 ? " show" : ""}`}
        disabled={pending || total <= 0} onClick={commit}>
        <span>{pending ? "Running…" : `Run ${total} bottle${total === 1 ? "" : "s"} → ${LOC_SHORT[dest]}`}</span>
        <span className="arrow" aria-hidden>→</span>
      </button>
    </div>
  );
}

/* ============================ blind count ============================ */

type Entry = { key: number; itemId: number; value: string };
type DraftLine = { itemId: number; value: string };
let _ek = 0;

/**
 * Blind count: start empty, add bottles as you find them.
 *
 * Store: one row per brand, type whole bottles.
 * Bars:  one row per open bottle, type fill level. Add the same brand
 *        again for each physical bottle on the bar.
 *
 * Items NOT added are treated as absent (counted to zero). The server
 * handles the zeroing — the client sends only what was counted; the
 * server fills in zeroes for everything else at that location.
 */
export function Stocktake({
  items, loc, user, cats, onClose, onFinish, step,
}: {
  items: Item[]; loc: Loc; user: SessionUser; cats: Category[];
  onClose: () => void;
  onFinish?: () => void;
  step?: string;
}) {
  const { label: LOC_LABEL } = useLocMaps();
  const catRank = useMemo(() => rankIn(cats), [cats]);
  useEscapeClose(onClose);
  const { say } = useAction();
  const draftKey = `stocktake-v2:${loc}:${user.id}`;
  const searchRef = useRef<HTMLInputElement>(null);

  // Restore draft from localStorage
  const [entries, setEntries] = useState<Entry[]>(() => {
    try {
      const saved: DraftLine[] = JSON.parse(localStorage.getItem(draftKey) ?? "[]");
      if (!Array.isArray(saved) || !saved.length) return [];
      return saved
        .filter(d => items.some(i => i.id === d.itemId))
        .map(d => ({ key: ++_ek, itemId: d.itemId, value: d.value }));
    } catch { return []; }
  });
  const [search, setSearch] = useState("");
  const [report, setReport] = useState<Variance[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmZero, setConfirmZero] = useState(false);
  // Prevent the Continue button's click from carrying over to Save count
  const [ready, setReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setReady(true), 200); return () => clearTimeout(t); }, []);
  const restored = entries.length > 0 && !report;

  // Persist draft
  useEffect(() => {
    try {
      const draft: DraftLine[] = entries.map(e => ({ itemId: e.itemId, value: e.value }));
      if (draft.length) localStorage.setItem(draftKey, JSON.stringify(draft));
      else localStorage.removeItem(draftKey);
    } catch {}
  }, [entries, draftKey]);

  // Non-archived items, sorted
  const sortedItems = useMemo(
    () => [...items].sort(
      (a, b) => catRank(a.cat) - catRank(b.cat) || a.name.localeCompare(b.name)
    ),
    [items, catRank],
  );

  // Items in the entries (for store: exclude already-added)
  const addedIds = useMemo(() => new Set(entries.map(e => e.itemId)), [entries]);

  // Search results
  const results = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return [];
    return sortedItems
      .filter(i => i.name.toLowerCase().includes(needle))
      .filter(i => loc === "store" ? !addedIds.has(i.id) : true)
      .slice(0, 8);
  }, [search, sortedItems, addedIds, loc]);

  // Items with stock at this location that aren't in the count
  const uncounted = useMemo(
    () => sortedItems.filter(i => stockAt(i, loc) > 0 && !addedIds.has(i.id)),
    [sortedItems, loc, addedIds],
  );

  // How many entries have a value typed
  const filledCount = entries.filter(e => e.value.trim() !== "").length;
  const blankCount = entries.length - filledCount;

  function addItem(item: Item) {
    // Store: if already added, focus that row
    if (loc === "store" && addedIds.has(item.id)) {
      const el = document.querySelector<HTMLInputElement>(`[data-entry-item="${item.id}"]`);
      el?.focus(); el?.select();
      setSearch("");
      return;
    }
    setEntries(prev => [...prev, { key: ++_ek, itemId: item.id, value: "" }]);
    setSearch("");
    setConfirmZero(false);
    // Focus the new input after render
    requestAnimationFrame(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>("[data-count-input]");
      const last = inputs[inputs.length - 1];
      last?.focus(); last?.select();
    });
  }

  function removeEntry(key: number) {
    setEntries(prev => prev.filter(e => e.key !== key));
  }

  function updateValue(key: number, value: string) {
    setEntries(prev => prev.map(e => e.key === key ? { ...e, value } : e));
  }

  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && results.length) { e.preventDefault(); addItem(results[0]); }
    if (e.key === "Escape") { setSearch(""); }
  }

  function onEntryKey(e: React.KeyboardEvent<HTMLInputElement>, idx: number) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const inputs = document.querySelectorAll<HTMLInputElement>("[data-count-input]");
    if (idx + 1 < inputs.length) { inputs[idx + 1]?.focus(); inputs[idx + 1]?.select(); }
    else searchRef.current?.focus();
  }

  async function submit() {
    if (blankCount > 0) { say("Fill in all rows or remove the blank ones", true); return; }
    if (!entries.length && !uncounted.length) { (onFinish ?? onClose)(); return; }
    // Empty count with uncounted items = everything zeros. Require a confirm.
    if (!entries.length && uncounted.length > 0 && !confirmZero) { setConfirmZero(true); return; }

    setPending(true);
    setError(null);
    try {
      const lines = entries
        .filter(e => e.value.trim() !== "")
        .map(e => ({ itemId: e.itemId, value: Number(e.value) }));
      const result = await submitStocktake(loc, lines);
      if (result.ok) {
        setEntries([]);
        try { localStorage.removeItem(draftKey); } catch {}
        setReport(result.variances);
      } else {
        setError(result.error);
        say(result.error, true);
      }
    } catch {
      say("Something went wrong", true);
    } finally {
      setPending(false);
    }
  }

  // --- Variance report ---
  if (report !== null) {
    const sorted = [...report].sort((a, b) => (a.counted - a.was) - (b.counted - b.was));
    return (
      <div className="stk">
        <div className="stk-head">
          <div>
            <div className="ptitle" style={{ margin: 0 }}>
              Count report <span className="sub">{LOC_LABEL[loc]}{step ? ` · ${step}` : ""}</span>
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              {sorted.length
                ? `${sorted.length} correction${sorted.length === 1 ? "" : "s"} recorded.`
                : "Everything matched — no corrections needed."}
            </div>
          </div>
        </div>
        {sorted.length > 0 && (
          <div className="stk-list">
            <div className="stk-row stk-hdr">
              <span className="s-n">Bottle</span>
              <span className="s-e">Expected</span>
              <span className="s-a">Counted</span>
              <span className="s-v">Diff</span>
            </div>
            {sorted.map((v, i) => {
              const diff = Math.round((v.counted - v.was) * 100) / 100;
              return (
                <div className={`stk-row has-var`} key={i}>
                  <span className="s-n">
                    <span className="nm">{v.name}</span>
                    <span className="ct">{cap(v.cat)}</span>
                  </span>
                  <span className="s-e">{fmt(v.was)}</span>
                  <span className="s-a">{fmt(v.counted)}</span>
                  <span className={`s-v${diff > 0 ? " up" : " down"}`}>
                    {diff > 0 ? "+" : ""}{fmt(diff)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="stk-foot">
          <button className="commit" onClick={() => (onFinish ?? onClose)()}>
            {onFinish ? "Continue" : "Done"}
          </button>
        </div>
      </div>
    );
  }

  // --- Blind count entry ---
  return (
    <div className="stk">
      <div className="stk-head">
        <div>
          <div className="ptitle" style={{ margin: 0 }}>
            Count <span className="sub">{LOC_LABEL[loc]}{step ? ` · ${step}` : ""}</span>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            Add bottles as you find them.{loc !== "store" ? " Add the same brand again for each open bottle." : ""}
          </div>
        </div>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>

      {restored && (
        <div className="stk-restored">
          Picked up an unfinished count — {entries.length} row{entries.length === 1 ? "" : "s"} restored.
        </div>
      )}

      <div className="search" style={{ position: "relative" }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" />
        </svg>
        <input
          ref={searchRef}
          placeholder="Search to add a bottle…"
          value={search} onChange={e => setSearch(e.target.value)}
          onKeyDown={onSearchKey}
        />
        {search && <button className="clr" aria-label="Clear search" onClick={() => setSearch("")}>×</button>}
        {results.length > 0 && (
          <div className="stk-results">
            {results.map(item => (
              <button key={item.id} className="stk-result" onClick={() => addItem(item)}>
                <span className="nm">{item.name}</span>
                <span className="ct">{cap(item.cat)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {entries.length > 0 && (
        <div className="stk-list">
          <div className="stk-row stk-hdr">
            <span className="s-n">Bottle</span>
            <span className="s-a">{loc === "store" ? "Count" : "Level"}</span>
            <span className="s-x">&nbsp;</span>
          </div>
          {entries.map((entry, idx) => {
            const item = sortedItems.find(i => i.id === entry.itemId);
            if (!item) return null;
            const sameCount = entries.filter(e => e.itemId === entry.itemId).length;
            const sameIdx = entries.filter((e, j) => e.itemId === entry.itemId && j <= idx).length;
            const label = sameCount > 1
              ? `${item.name} · bottle ${sameIdx} of ${sameCount}`
              : item.name;
            return (
              <div className="stk-row" key={entry.key}>
                <span className="s-n">
                  <span className="nm">{label}</span>
                  <span className="ct">{cap(item.cat)}</span>
                </span>
                <span className="s-a">
                  <input
                    data-count-input
                    data-entry-item={item.id}
                    type="number" inputMode="decimal" min="0"
                    step={loc === "store" || item.case_size > 1 ? "1" : "0.05"}
                    placeholder={loc === "store" || item.case_size > 1 ? "0" : "0.75"}
                    value={entry.value}
                    onKeyDown={e => onEntryKey(e, idx)}
                    onChange={e => updateValue(entry.key, e.target.value)}
                  />
                </span>
                <span className="s-x">
                  <button className="stk-rm" aria-label="Remove" onClick={() => removeEntry(entry.key)}>×</button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {!entries.length && (
        <div className="stk-empty">
          Search above to start adding bottles.
        </div>
      )}

      <div className="stk-foot">
        <div className="stk-sum">
          <b>{filledCount}</b> bottle{filledCount === 1 ? "" : "s"} counted
          {blankCount > 0 && <span className="vwarn"> · {blankCount} blank</span>}
        </div>
        {uncounted.length > 0 && (
          <div className="stk-warn">
            {uncounted.length} bottle{uncounted.length === 1 ? "" : "s"} at {LOC_LABEL[loc]} not in your count — will be set to 0
          </div>
        )}
        {error && <div className="stk-warn" style={{ color: "var(--red)" }}>{error}</div>}
        {!entries.length && !uncounted.length && onFinish ? (
          <button className="commit ghost" onClick={() => (onFinish ?? onClose)()}>
            Nothing here — continue
          </button>
        ) : (
          <button className="commit" disabled={!ready || pending || (blankCount > 0) || (!entries.length && !uncounted.length)} onClick={submit}>
            {pending ? "Saving…" : confirmZero ? `Yes, zero ${uncounted.length} bottle${uncounted.length === 1 ? "" : "s"}` : "Save count"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ============================ item sheet ============================ */
