"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LOCS, LOC_LABEL, LOC_SHORT, cap, fmt, fmtQty, inCat, levelsAt, needsReorder, openLabel, undoableMoveIds, type Category, type Item, type Loc, type Move, type SessionUser } from "@/lib/model";
import { giveRun, submitStocktake, undoMove } from "../../actions";
import { useAction } from "../shell";
import { BottleSheet, DAY, LOC_COLOR, LOC_ICON, rankIn, sumAt, timeStr, useEscapeClose } from "./shared";

/* ============================ stock ============================ */

export function Stock({
  items, moves, now, user, cats,
}: {
  items: Item[]; moves: Move[]; now: number; user: SessionUser; cats: Category[];
}) {
  const catRank = useMemo(() => rankIn(cats), [cats]);
  const [sheetId, setSheetId] = useState<number | null>(null);
  const [loc, setLoc] = useState<Loc>("store");
  const [cat, setCat] = useState<string>("ALL");
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  const shown = useMemo(() => {
    let out = [...items].sort((a, b) => catRank(a.cat) - catRank(b.cat) || a.name.localeCompare(b.name));
    if (lowOnly) out = loc === "store" ? out.filter(needsReorder) : out.filter((i) => i[loc] > 0);
    // Matches the main category or any tag, so picking Well finds every well
    // bottle without changing what they count towards.
    else if (cat !== "ALL") out = out.filter((i) => inCat(i, cat));
    const needle = q.trim().toLowerCase();
    if (needle) out = out.filter((i) => i.name.toLowerCase().includes(needle));
    return out;
  }, [items, loc, cat, q, lowOnly, catRank]);

  const since = now - 7 * DAY;
  // One label everywhere — "Given out · 7d". For a bar view it's gives to that bar;
  // for the store view it's gives from the store to any bar. Same window, same term.
  const given7 = fmt(moves
    .filter((m) => m.type === "give" && (loc === "store" || m.loc === loc) && +new Date(m.ts) >= since)
    .reduce((a, m) => a + (m.qty ?? 0), 0));
  const stats = loc === "store"
    ? [
        { n: fmt(sumAt(items, "store")), l: "In store", cls: "accent" },
        { n: String(items.filter(needsReorder).length), l: "Reorder", cls: "warn" },
        { n: given7, l: "Given out · 7d", cls: "" },
      ]
    : [
        { n: fmt(sumAt(items, loc)), l: "At this bar", cls: "accent" },
        { n: String(items.filter((i) => i[loc] > 0).length), l: "Items stocked", cls: "" },
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
          const v = i[loc];
          const zero = v <= 0;
          const low = loc === "store" && !zero && needsReorder(i);
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
        onClose={() => setSheetId(null)} />
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
      .sort((a, b) => a[dest] - b[dest] || a.name.localeCompare(b.name));
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
              <span className="bd" style={{ background: LOC_COLOR[b] }} />
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

/* ============================ bulk count ============================ */

/**
 * Count a whole location in one pass. There is no separate "stocktake" — the
 * manager counts open and close, and the variance falls out of the move log.
 *
 * Expected is shown and actual is typed beside it, because the variance between
 * them IS the leakage signal - hiding the expected figure would make the count
 * "purer" but throws away the number the owner actually needs.
 *
 * A blank row means "not counted" and is left completely alone. Only a typed value
 * counts, and only a typed value that differs from expected is written.
 */
export function Stocktake({
  items, loc, user, cats, onClose, onFinish, step,
}: {
  items: Item[]; loc: Loc; user: SessionUser; cats: Category[];
  onClose: () => void;
  /** Called instead of onClose on a successful save, so a sweep can advance to the next loc. */
  onFinish?: () => void;
  /** When part of a sweep: "1 of 3". Shown after the location name. */
  step?: string;
}) {
  const catRank = useMemo(() => rankIn(cats), [cats]);
  const { pending, run } = useAction();
  useEscapeClose(onClose);
  const draftKey = `stocktake:${loc}:${user.id}`;

  // A full count takes many minutes; losing it to a tab switch is unacceptable, so the
  // draft is written locally on every keystroke and read back here. Reading it in the
  // initialiser rather than an effect is safe because this only mounts after a click,
  // never during SSR.
  const [initial] = useState<Record<number, string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? "{}");
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {}; // a corrupt draft is not worth blocking the count over
    }
  });
  const [counts, setCounts] = useState<Record<string, string>>(initial);
  const [q, setQ] = useState("");
  const restored = Object.keys(initial).length > 0;

  useEffect(() => {
    try {
      if (Object.keys(counts).length) localStorage.setItem(draftKey, JSON.stringify(counts));
      else localStorage.removeItem(draftKey);
    } catch { /* private mode / quota - the count still works, just isn't recoverable */ }
  }, [counts, draftKey]);

  // One row per PHYSICAL bottle on bars — a brand with two open bottles gets two
  // input rows. Store rows are always one-per-brand (sealed whole bottles). When a
  // bar's per-bottle breakdown isn't recorded yet, split integer totals into N
  // rows of 1 (likely sealed-just-delivered) and leave fractional totals as one.
  const rows = useMemo(() => {
    type Row = { item: Item; key: string; bottleIdx: number; bottleTotal: number; expected: number };
    const sorted = [...items].sort(
      (a, b) => catRank(a.cat) - catRank(b.cat) || a.name.localeCompare(b.name)
    );
    const out: Row[] = [];
    for (const item of sorted) {
      // Store, and anything case-sized (beer by default), is a single scalar row:
      // "how many bottles are there?" — no half or quarter.
      if (loc === "store" || item.case_size > 1) {
        if (loc !== "store" && item[loc] <= 0) continue;
        out.push({ item, key: `${item.id}:0`, bottleIdx: 0, bottleTotal: 1, expected: item[loc] });
        continue;
      }
      const total = item[loc];
      if (total <= 0) continue;
      const levels = levelsAt(item, loc).filter((n) => n > 0);
      const breakdown = levels.length ? levels
        : Number.isInteger(total) && total > 1 ? Array(total).fill(1)
        : [total];
      breakdown.forEach((lv, bi) => {
        out.push({ item, key: `${item.id}:${bi}`, bottleIdx: bi, bottleTotal: breakdown.length, expected: lv });
      });
    }
    const needle = q.trim().toLowerCase();
    return needle ? out.filter((r) => r.item.name.toLowerCase().includes(needle)) : out;
  }, [items, loc, q, catRank]);

  const filledRows = rows.reduce((n, r) => n + ((counts[r.key] ?? "").trim() ? 1 : 0), 0);

  // Group filled rows by item, sum, compare to current scalar — a brand's variance is
  // the sum of its bottles vs the stored total. A partially-filled brand (some bottle
  // rows blank) is skipped: better than silently zeroing the missing bottles.
  const perItem = useMemo(() => {
    type Agg = { id: number; was: number; sum: number; filled: number; need: number };
    const by = new Map<number, Agg>();
    const need = new Map<number, number>();
    for (const r of rows) need.set(r.item.id, (need.get(r.item.id) ?? 0) + 1);
    for (const r of rows) {
      const raw = counts[r.key] ?? "";
      if (!raw.trim()) continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) continue;
      const agg = by.get(r.item.id) ?? { id: r.item.id, was: r.item[loc], sum: 0, filled: 0, need: need.get(r.item.id) ?? 1 };
      agg.sum += v;
      agg.filled += 1;
      by.set(r.item.id, agg);
    }
    return [...by.values()];
  }, [rows, counts, loc]);

  const completeItems = perItem.filter((a) => a.filled === a.need);
  const variances = completeItems.filter((a) => Math.abs(a.sum - a.was) > 1e-9);

  function submit() {
    if (!variances.length) return;
    // Clear the draft and close ONLY on success — a failed submit must keep the
    // count and its localStorage draft, or a multi-minute count is lost to a
    // network blip. (Same success-gated pattern as RunMode.commit.)
    run(
      () => submitStocktake(loc, variances.map((a) => ({ itemId: a.id, value: a.sum }))),
      `${LOC_SHORT[loc]} count saved — ${variances.length} correction${variances.length === 1 ? "" : "s"}`,
      () => {
        setCounts({});
        try { localStorage.removeItem(draftKey); } catch { /* nothing to clean up */ }
        (onFinish ?? onClose)();
      },
    );
  }

  // In a sweep, a "no changes" count still counts as done — the user walked the list
  // and nothing was off. Advance to the next step without hitting the server.
  function skipToNext() {
    setCounts({});
    try { localStorage.removeItem(draftKey); } catch { /* nothing to clean up */ }
    (onFinish ?? onClose)();
  }

  /** Enter jumps to the next field so a count is one continuous run. */
  function onKey(e: React.KeyboardEvent<HTMLInputElement>, idx: number) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const inputs = document.querySelectorAll<HTMLInputElement>("[data-count-input]");
    inputs[idx + 1]?.focus();
    inputs[idx + 1]?.select();
  }

  return (
    <div className="stk">
      <div className="stk-head">
        <div>
          <div className="ptitle" style={{ margin: 0 }}>
            Count <span className="sub">{LOC_LABEL[loc]}{step ? ` · ${step}` : ""}</span>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            Type what you actually count. Leave a row blank if you didn&apos;t count it.
          </div>
        </div>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>

      {restored && (
        <div className="stk-restored">
          Picked up an unfinished count — {filledRows} row{filledRows === 1 ? "" : "s"} restored.
        </div>
      )}

      <div className="search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" />
        </svg>
        <input placeholder="Jump to a bottle…" value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <button className="clr" aria-label="Clear search" onClick={() => setQ("")}>×</button>}
      </div>

      <div className="stk-list">
        <div className="stk-row stk-hdr">
          <span className="s-n">Bottle</span>
          <span className="s-e">Expected</span>
          <span className="s-a">Counted</span>
          <span className="s-v">Variance</span>
        </div>
        {rows.map((r, idx) => {
          const raw = counts[r.key] ?? "";
          const has = raw.trim() !== "";
          const val = Number(raw);
          const ok = has && Number.isFinite(val) && val >= 0;
          const diff = ok ? Math.round((val - r.expected) * 100) / 100 : null;
          const label = r.bottleTotal > 1
            ? `${r.item.name} · bottle ${r.bottleIdx + 1} of ${r.bottleTotal}`
            : r.item.name;
          const expectedTxt = loc === "store"
            ? fmtQty(r.item.cat, r.expected, r.item.case_size)
            : r.item.case_size > 1 ? fmt(r.expected) : r.expected.toFixed(2);
          return (
            <div className={`stk-row${ok && diff !== 0 ? " has-var" : ""}`} key={r.key}>
              <span className="s-n">
                <span className="nm">{label}</span>
                <span className="ct">{cap(r.item.cat)}</span>
              </span>
              <span className="s-e">{expectedTxt}</span>
              <span className="s-a">
                <input
                  data-count-input type="number" inputMode="decimal" min="0"
                  step={loc === "store" || r.item.case_size > 1 ? "1" : "0.05"}
                  placeholder={loc === "store" || r.item.case_size > 1 ? "—" : "0.75"} value={raw}
                  onKeyDown={(e) => onKey(e, idx)}
                  onChange={(e) => setCounts((c) => ({ ...c, [r.key]: e.target.value }))}
                />
              </span>
              <span className={`s-v${diff === null ? "" : diff > 0 ? " up" : diff < 0 ? " down" : " same"}`}>
                {diff === null ? "" : diff === 0 ? "✓" : `${diff > 0 ? "+" : ""}${fmt(diff)}`}
              </span>
            </div>
          );
        })}
      </div>

      <div className="stk-foot">
        <div className="stk-sum">
          <b>{filledRows}</b> of {rows.length} counted
          {variances.length > 0 && <span className="vwarn"> · {variances.length} variance{variances.length === 1 ? "" : "s"}</span>}
        </div>
        {/* In a sweep, "no changes" is a valid outcome — advance without a server round-trip.
            Standalone, the button stays disabled until the user actually has corrections. */}
        {onFinish && !variances.length ? (
          <button className="commit ghost" disabled={pending} onClick={skipToNext}>
            No changes — continue
          </button>
        ) : (
          <button className="commit" disabled={pending || !variances.length} onClick={submit}>
            {pending ? "Saving…"
              : variances.length
                ? (onFinish ? `Save & continue (${variances.length})` : `Save ${variances.length} correction${variances.length === 1 ? "" : "s"}`)
                : "No changes to save"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ============================ item sheet ============================ */
