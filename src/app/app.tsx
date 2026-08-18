"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  CATS, LOCS, LOC_LABEL, LOC_SHORT, WASTAGE_REASONS, cap, fmt, needsReorder, totalOf,
  type Cat, type Delivery as Booked, type DeliveryLine, type Item, type Loc, type Move,
  type SessionUser, type Staff, type WastageReason,
} from "@/lib/model";
import {
  addItem, addUser, archiveItem, giveOut, logWaste, logout, receive, submitStocktake,
  receiveDelivery, setCount, setReorderLevel, setUserActive, transferBar, undoMove, type Result,
} from "./actions";

type Tab = "dashboard" | "stock" | "delivery" | "activity" | "manage";
type SheetAct = "give" | "receive" | "transfer" | "waste" | "count";

const DAY = 864e5;


/* ============================ icons ============================ */

const NAV_ICON: Record<Tab, React.ReactNode> = {
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="8" height="9" rx="1.5" />
      <rect x="13" y="3" width="8" height="5" rx="1.5" />
      <rect x="13" y="11" width="8" height="10" rx="1.5" />
      <rect x="3" y="15" width="8" height="6" rx="1.5" />
    </svg>
  ),
  stock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
    </svg>
  ),
  delivery: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5z" strokeLinejoin="round" />
      <path d="M3 8.5 12 13l9-4.5M12 13v7" strokeLinejoin="round" />
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v4l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  manage: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path
        d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 2h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 22h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6A7 7 0 0 0 19 12z"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

const LOC_ICON: Record<Loc, React.ReactNode> = {
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
const CAT_COLOR: Record<Cat, string> = {
  WHISKEY: "#C08A4A", VODKA: "#6FA8DC", TEQUILA: "#8FBF6A", GIN: "#5FB8A8",
  RUM: "#C2705A", BEER: "#D6A63C", WINE: "#B0607F", MIXER: "#7E8CA8",
  OTHER: "#8E86F2",
};

const LOC_COLOR: Record<Loc, string> = {
  store: "var(--store)", patio: "var(--patio)", back: "var(--back)",
};

/* ============================ helpers ============================ */

const catRank = (c: string) => (CATS.indexOf(c as Cat) < 0 ? 99 : CATS.indexOf(c as Cat));
const sumAt = (items: Item[], k: Loc) => items.reduce((a, i) => a + Math.max(0, i[k]), 0);

/** Midnight for each of the last 7 days. Built with setDate so DST can't drop a day. */
function last7(now: number): Date[] {
  const out: Date[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    out.push(d);
  }
  return out;
}

function dayKey(ts: number, now: number) {
  const d = new Date(ts), today = new Date(now);
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
const timeStr = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/* ============================ shell ============================ */

export function App({
  user, items, moves, recent, staff, deliveries, now, initialTab = "dashboard",
}: {
  user: SessionUser; items: Item[]; moves: Move[]; recent: Move[]; staff: Staff[];
  deliveries: Booked[]; now: number; initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [sheetId, setSheetId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; error?: boolean; moveId?: number } | null>(null);
  const [pending, startTransition] = useTransition();

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!toast) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), toast.moveId ? 6000 : 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [toast]);

  /** Runs a server action, then either closes the sheet or shows why it failed. */
  function run(fn: () => Promise<Result>, okMsg: string, closeSheet = true) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        if (closeSheet) setSheetId(null);
        setToast({ msg: okMsg, moveId: r.moveId });
      } else {
        setToast({ msg: r.error, error: true });
      }
    });
  }

  const tabs: Tab[] = user.role === "owner"
    ? ["dashboard", "stock", "delivery", "activity", "manage"]
    : ["dashboard", "stock", "delivery", "activity"];

  const nav = (
    <>
      {tabs.map((t) => (
        <button key={t} className={t === tab ? "on" : ""} onClick={() => { setTab(t); window.scrollTo(0, 0); }}>
          {NAV_ICON[t]}
          {cap(t)}
        </button>
      ))}
    </>
  );

  const sheetItem = sheetId === null ? null : items.find((i) => i.id === sheetId) ?? null;

  const brand = (
    <div className="brand">
      <span className="mark">10<b>X</b> Bar</span>
      <span className="sub">Stock control</span>
    </div>
  );

  return (
    <>
      <h2 className="sr-only">10X Bar stock control</h2>

      <div className="app">
        <aside className="sidebar">
          {brand}
          <div className="snav">{nav}</div>
          <div className="foot">Store counts whole bottles · bars count partials</div>
        </aside>

        <div className="content">
          <div className="topbar">{brand}</div>
          <main className="wrap">
            <div className="whoami">
              <span className="nm">Signed in as {user.name}</span>
              <span className="role">{user.role}</span>
              <button onClick={() => logout()}>Sign out</button>
            </div>

            {tab === "dashboard" && <Dashboard items={items} moves={recent} now={now} onPick={setSheetId} />}
            {tab === "stock" && <Stock items={items} moves={recent} now={now} user={user} pending={pending} run={run}
                onPick={setSheetId} />}
            {tab === "delivery" && <Delivery items={items} deliveries={deliveries} run={run} pending={pending} />}
            {tab === "activity" && (
              <Activity moves={moves} user={user} now={now} onToast={setToast}
                onUndo={(id) => run(() => undoMove(id), "Entry undone", false)} />
            )}
            {tab === "manage" && user.role === "owner" && (
              <Manage items={items} staff={staff} user={user} run={run} pending={pending} />
            )}
          </main>
        </div>
      </div>

      <nav className="mnav"><div className="mnav-in">{nav}</div></nav>

      <div className={`scrim${sheetItem ? " show" : ""}`} onClick={() => setSheetId(null)} />
      <div className={`sheet${sheetItem ? " show" : ""}`}>
        {sheetItem && <Sheet key={sheetItem.id} item={sheetItem} pending={pending} run={run} />}
      </div>

      {toast && (
        <div className="toast show" style={toast.error ? { borderColor: "var(--red)" } : undefined}>
          <span className="tx">{toast.msg}</span>
          {toast.moveId !== undefined && (
            <button className="undo" onClick={() => {
              const id = toast.moveId!;
              setToast(null);
              run(() => undoMove(id), "Entry undone", false);
            }}>
              Undo
            </button>
          )}
        </div>
      )}
    </>
  );
}

/* ============================ dashboard ============================ */

function Dashboard({
  items, moves, now, onPick,
}: { items: Item[]; moves: Move[]; now: number; onPick: (id: number) => void }) {
  const since = now - 7 * DAY;
  const storeTot = sumAt(items, "store");
  const patioTot = sumAt(items, "patio");
  const backTot = sumAt(items, "back");
  const grandTot = storeTot + patioTot + backTot;

  // most deficient first - how far under its own line each bottle is
  const reorder = items.filter(needsReorder).sort((a, b) => a.store - a.rl - (b.store - b.rl));
  const outOfStock = reorder.filter((i) => i.store <= 0).length;
  const give7 = moves
    .filter((m) => m.type === "give" && +new Date(m.ts) >= since)
    .reduce((a, m) => a + (m.qty ?? 0), 0);
  const waste7 = moves
    .filter((m) => m.type === "waste" && +new Date(m.ts) >= since)
    .reduce((a, m) => a + (m.qty ?? 0), 0);

  return (
    <>
      <div className="ptitle">Dashboard <span className="sub">{new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span></div>

      <div className="dash">
        <section className="hero">
          <div className="lbl">Total bottles</div>
          <div className="fig">{fmt(grandTot)}</div>
          <div className="split">
            <span><i style={{ background: "var(--store)" }} />Store <b>{fmt(storeTot)}</b></span>
            <span><i style={{ background: "var(--patio-mark)" }} />Patio <b>{fmt(patioTot)}</b></span>
            <span><i style={{ background: "var(--back-mark)" }} />Back <b>{fmt(backTot)}</b></span>
          </div>
        </section>

        <div className="tiles">
          <div className={`tile${outOfStock ? " badstate" : ""}`}>
            <div className="v">{outOfStock}</div><div className="k">Out of stock</div>
          </div>
          <div className={`tile${reorder.length ? " warnstate" : ""}`}>
            <div className="v">{reorder.length}</div><div className="k">Need reorder</div>
          </div>
          <div className="tile">
            <div className="v">{fmt(give7)}</div><div className="k">Given out · 7d</div>
          </div>
          <div className={`tile${waste7 > 0 ? " warnstate" : ""}`}>
            <div className="v">{fmt(waste7)}</div><div className="k">Wasted · 7d</div>
          </div>
        </div>

        <ReorderTable rows={reorder} onPick={onPick} />
        <CategoryCard items={items} />
        <TrendCard moves={moves} now={now} />

        <div className="at-side">
          <BarCard bar="patio" items={items} moves={moves} now={now} />
          <BarCard bar="back" items={items} moves={moves} now={now} />
          <WastageCard moves={moves} now={now} />
          <TopMoversCard moves={moves} now={now} />
        </div>
      </div>
    </>
  );
}

function WastageCard({ moves, now }: { moves: Move[]; now: number }) {
  const since = now - 7 * DAY;
  const wasteMoves = moves.filter((m) => m.type === "waste" && +new Date(m.ts) >= since);
  const totalWaste = wasteMoves.reduce((a, m) => a + (m.qty ?? 0), 0);

  const byReason = new Map<string, number>();
  for (const m of wasteMoves) {
    const r = m.notes || "Spill / Breakage";
    byReason.set(r, (byReason.get(r) ?? 0) + (m.qty ?? 0));
  }
  const topReasons = [...byReason.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div className="card">
      <div className="ch">
        <h3>Wastage &amp; Spills · 7d</h3>
        <span className={`badge${totalWaste > 0 ? " red" : ""}`}>{fmt(totalWaste)} bottles</span>
      </div>
      {!wasteMoves.length ? (
        <div className="empty" style={{ padding: 16 }}>No wastage recorded this week.</div>
      ) : (
        topReasons.map(([r, q]) => (
          <div className="brk" key={r} style={{ borderTopColor: "var(--line)" }}>
            <span className="bnm">{r}</span>
            <span className="bq" style={{ color: "var(--red)" }}>{fmt(q)}</span>
          </div>
        ))
      )}
    </div>
  );
}


/**
 * Reorder is a table, not a list of cards: every row carries five facts and the
 * whole list has to be readable, so nothing is truncated - it scrolls instead.
 * "On bars" is here because a zero storeroom reads very differently when there
 * are still three bottles out on the Patio.
 */
function ReorderTable({ rows, onPick }: { rows: Item[]; onPick: (id: number) => void }) {
  return (
    <div className="card at-reorder">
      <div className="ch">
        <h3>Reorder</h3>
        <span className={`badge${rows.length ? " red" : ""}`}>{rows.length}</span>
      </div>
      {!rows.length ? (
        <div className="empty" style={{ padding: 18 }}>
          Everything&apos;s above its reorder point.
        </div>
      ) : (
        <div className="rscroll">
          <table className="rtable">
            <thead>
              <tr>
                <th>Status</th>
                <th>Bottle</th>
                <th className="num">In store</th>
                <th className="num hide-sm">On bars</th>
                <th className="num">Reorder at</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const isOut = i.store <= 0;
                return (
                  <tr key={i.id} onClick={() => onPick(i.id)}>
                    <td>
                      <span className={`rstat ${isOut ? "out" : "low"}`}>
                        <i />{isOut ? "Out" : "Low"}
                      </span>
                    </td>
                    <td>
                      <div className="nm">{i.name}</div>
                      <div className="cat">{cap(i.cat)}</div>
                    </td>
                    <td className="num short">{fmt(i.store)}</td>
                    <td className="num hide-sm">{fmt(i.patio + i.back)}</td>
                    <td className="num">{fmt(i.rl)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CategoryCard({ items }: { items: Item[] }) {
  const data = CATS
    .map((c) => ({ c, v: items.filter((i) => i.cat === c).reduce((a, i) => a + Math.max(0, i.store), 0) }))
    .filter((d) => d.v > 0)
    .sort((a, b) => b.v - a.v);
  const max = Math.max(1, ...data.map((d) => d.v));

  return (
    <div className="card at-cat">
      <div className="ch"><h3>Store by category</h3></div>
      {data.map((d) => (
        <div className="hbar" key={d.c}>
          <span className="k">{cap(d.c)}</span>
          <span className="track">
            <span className="fill" style={{ width: `${Math.max(3, (d.v / max) * 100)}%` }} />
          </span>
          <span className="v">{fmt(d.v)}</span>
        </div>
      ))}
    </div>
  );
}

function TrendCard({ moves, now }: { moves: Move[]; now: number }) {
  const per = last7(now).map((d) => ({ d, p: 0, b: 0 }));
  for (const m of moves) {
    if (m.type !== "give") continue;
    const md = new Date(m.ts);
    md.setHours(0, 0, 0, 0);
    const slot = per.find((x) => x.d.getTime() === md.getTime());
    if (!slot) continue;
    if (m.loc === "patio") slot.p += m.qty ?? 0;
    else slot.b += m.qty ?? 0;
  }
  const max = Math.max(1, ...per.map((x) => x.p + x.b));

  return (
    <div className="card at-trend">
      <div className="ch"><h3>Given out · last 7 days</h3></div>
      <div className="cols">
        {per.map((x, idx) => {
          const tot = x.p + x.b;
          return (
            <div className="col" key={idx}>
              <span className="cv">{tot || ""}</span>
              <div className="stack">
                {tot > 0 ? (
                  <>
                    {x.b > 0 && <span className="seg b" style={{ height: (x.b / max) * 118 }} />}
                    {x.p > 0 && <span className="seg p" style={{ height: (x.p / max) * 118 }} />}
                  </>
                ) : (
                  <span className="dot" />
                )}
              </div>
              <span className="cl">
                {x.d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="legend">
        <span><i style={{ background: "var(--patio)" }} />Patio</span>
        <span><i style={{ background: "var(--back)" }} />Back</span>
      </div>
    </div>
  );
}

function BarCard({
  bar, items, moves, now,
}: { bar: Loc; items: Item[]; moves: Move[]; now: number }) {
  const since = now - 7 * DAY;
  const evs = moves.filter((m) => m.type === "give" && m.loc === bar && +new Date(m.ts) >= since);
  const total = evs.reduce((a, m) => a + (m.qty ?? 0), 0);
  const per = new Map<string, number>();
  for (const m of evs) per.set(m.item_name, (per.get(m.item_name) ?? 0) + (m.qty ?? 0));
  const top = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = top.length ? top[0][1] : 1;

  return (
    <div className="card barcard">
      <div className="h">
        <span className="bd" style={{ background: LOC_COLOR[bar] }} />
        <span className="bn">{LOC_LABEL[bar]}</span>
        <span className="bt">{fmt(total)}<small>pulled 7d</small></span>
      </div>
      <div className="onhand"><b>{fmt(sumAt(items, bar))}</b> on hand now</div>
      {!top.length && <div className="onhand" style={{ margin: 0 }}>Nothing pulled this week.</div>}
      {top.map(([nm, qy]) => (
        <div className="brk" key={nm}>
          <span className="bnm">{nm}</span>
          <span className="bar-track">
            <span className="bar-fill"
              style={{ width: `${Math.max(8, (qy / max) * 100)}%`, background: LOC_COLOR[bar] }} />
          </span>
          <span className="bq">{fmt(qy)}</span>
        </div>
      ))}
    </div>
  );
}

function TopMoversCard({ moves, now }: { moves: Move[]; now: number }) {
  const since = now - 7 * DAY;
  const per = new Map<string, number>();
  for (const m of moves) {
    if (m.type !== "give" || +new Date(m.ts) < since) continue;
    per.set(m.item_name, (per.get(m.item_name) ?? 0) + (m.qty ?? 0));
  }
  const top = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = top.length ? top[0][1] : 1;

  return (
    <div className="card">
      <div className="ch"><h3>Top movers · 7d</h3></div>
      {!top.length && <div className="empty" style={{ padding: 18 }}>No give-outs yet this week.</div>}
      {top.map(([nm, qy]) => (
        <div className="brk" key={nm} style={{ borderTopColor: "var(--line)" }}>
          <span className="bnm">{nm}</span>
          <span className="bar-track">
            <span className="bar-fill"
              style={{ width: `${Math.max(8, (qy / max) * 100)}%`, background: "var(--blue)" }} />
          </span>
          <span className="bq">{fmt(qy)}</span>
        </div>
      ))}
    </div>
  );
}

function ScannerModal({

  items, onClose, onPick,
}: {
  items: Item[]; onClose: () => void; onPick: (id: number) => void;
}) {
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items.slice(0, 8);
    return items.filter((i) => i.name.toLowerCase().includes(needle) || cap(i.cat).toLowerCase().includes(needle)).slice(0, 10);
  }, [items, q]);

  return (
    <div className="scan-modal" onClick={onClose}>
      <div className="scan-box" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>Barcode &amp; Bottle Scanner</h3>
        <div className="hint" style={{ margin: "0 0 12px" }}>Align barcode in camera viewport or type to filter</div>
        <div className="scan-viewport">
          <div className="scan-line" />
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--txt-3)", fontSize: 13 }}>
            Ready to scan...
          </div>
        </div>
        <div className="search">
          <input placeholder="Scan or type bottle name..." value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ maxHeight: 200, overflowY: "auto", margin: "10px 0" }}>
          {matches.map((i) => (
            <button key={i.id} onClick={() => { onPick(i.id); onClose(); }} className="dhit">
              <span className="dhn">{i.name}</span>
              <span className="dhc">{cap(i.cat)}</span>
              <span className="dhadd">Select</span>
            </button>
          ))}
        </div>
        <button className="btn ghost" style={{ width: "100%", marginTop: 8 }} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/* ============================ stock ============================ */


function Stock({
  items, moves, now, user, pending, run, onPick,
}: {
  items: Item[]; moves: Move[]; now: number; user: SessionUser; pending: boolean;
  run: (fn: () => Promise<Result>, ok: string, closeSheet?: boolean) => void;
  onPick: (id: number) => void;
}) {
  const [loc, setLoc] = useState<Loc>("store");
  const [counting, setCounting] = useState(false);
  const [cat, setCat] = useState<string>("ALL");
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [showScan, setShowScan] = useState(false);

  const shown = useMemo(() => {
    let out = [...items].sort((a, b) => catRank(a.cat) - catRank(b.cat) || a.name.localeCompare(b.name));
    if (lowOnly) out = loc === "store" ? out.filter(needsReorder) : out.filter((i) => i[loc] > 0);
    else if (cat !== "ALL") out = out.filter((i) => i.cat === cat);
    const needle = q.trim().toLowerCase();
    if (needle) out = out.filter((i) => i.name.toLowerCase().includes(needle));
    return out;
  }, [items, loc, cat, q, lowOnly]);

  const since = now - 7 * DAY;
  const stats = loc === "store"
    ? [
        { n: fmt(sumAt(items, "store")), l: "In store", cls: "accent" },
        { n: String(items.filter(needsReorder).length), l: "Low / out", cls: "warn" },
        {
          n: fmt(moves.filter((m) => m.type === "give" &&
            new Date(m.ts).toDateString() === new Date(now).toDateString())
            .reduce((a, m) => a + (m.qty ?? 0), 0)),
          l: "Given today", cls: "",
        },
      ]
    : [
        { n: fmt(sumAt(items, loc)), l: "At this bar", cls: "accent" },
        { n: String(items.filter((i) => i[loc] > 0).length), l: "Items stocked", cls: "" },
        {
          n: fmt(moves.filter((m) => m.type === "give" && m.loc === loc && +new Date(m.ts) >= since)
            .reduce((a, m) => a + (m.qty ?? 0), 0)),
          l: "Pulled 7d", cls: "",
        },
      ];

  const cats = ["ALL", ...CATS.filter((c) => items.some((i) => i.cat === c))];

  if (counting) {
    return (
      <Stocktake items={items} loc={loc} user={user} pending={pending} run={run}
        onClose={() => setCounting(false)} />
    );
  }

  return (
    <>
      <div className="ptitle" style={{ justifyContent: "space-between" }}>
        <span>Stock <span className="sub">tap a bottle to log a move</span></span>
        <button className="scan-btn" onClick={() => setShowScan(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" strokeLinecap="round" />
            <rect x="7" y="7" width="10" height="10" rx="1" />
          </svg>
          Scan Barcode
        </button>
      </div>

      {showScan && <ScannerModal items={items} onClose={() => setShowScan(false)} onPick={onPick} />}

      <div className="locs">
        {LOCS.map((k) => (
          <button key={k} className={`loc${loc === k ? " on" : ""}`}
            onClick={() => { setLoc(k); setLowOnly(false); }}>
            {LOC_ICON[k]}
            <span className="nm">{LOC_SHORT[k]}</span>
            <span className="ct">{fmt(sumAt(items, k))}</span>
          </button>
        ))}
      </div>

      <button className="stk-start" onClick={() => setCounting(true)}>
        <span className="si">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"
              strokeLinejoin="round" />
            <rect x="9" y="3" width="6" height="4" rx="1" />
            <path d="M9 12h6M9 16h4" strokeLinecap="round" />
          </svg>
        </span>
        <span className="st">
          <span className="n">Count {LOC_LABEL[loc]}</span>
          <span className="b">Walk the list once and enter what&apos;s actually there</span>
        </span>
        <span className="sgo">›</span>
      </button>

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
        {q && <button className="clr" onClick={() => setQ("")}>×</button>}
      </div>

      <div className="chips">
        <button className={`chip warn${lowOnly ? " on" : ""}`} onClick={() => setLowOnly(!lowOnly)}>
          {loc === "store" ? "Low / out" : "Stocked here"}
        </button>
        {cats.map((c) => (
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
            <button key={i.id} onClick={() => onPick(i.id)}
              className={`row${zero && loc === "store" ? " zero" : ""}${low ? " lowstk" : ""}`}>
              <div className="info">
                <div className="nm">{i.name}</div>
                <div className="dist">
                  <span className="d-store">Store <b>{fmt(i.store)}</b></span>
                  <span className="d-patio">Patio <b>{fmt(i.patio)}</b></span>
                  <span className="d-back">Back <b>{fmt(i.back)}</b></span>
                </div>
              </div>
              {loc === "store" && zero && <span className="pill out">OUT</span>}
              {loc === "store" && low && <span className="pill low">LOW</span>}
              <div className="qty">{fmt(totalOf(i))}<small>total</small></div>
            </button>
          );
        })}
      </div>
    </>
  );
}

/* ============================ stocktake ============================ */

/**
 * Count a whole location in one pass.
 *
 * Expected is shown and actual is typed beside it, because the variance between
 * them IS the leakage signal - hiding the expected figure would make the count
 * "purer" but throws away the number the owner actually needs.
 *
 * A blank row means "not counted" and is left completely alone. Only a typed value
 * counts, and only a typed value that differs from expected is written.
 */
function Stocktake({
  items, loc, user, onClose, run, pending,
}: {
  items: Item[]; loc: Loc; user: SessionUser; onClose: () => void; pending: boolean;
  run: (fn: () => Promise<Result>, ok: string, closeSheet?: boolean) => void;
}) {
  const draftKey = `stocktake:${loc}:${user.id}`;

  // A stocktake takes many minutes; losing it to a tab switch is unacceptable, so the
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
  const [counts, setCounts] = useState<Record<number, string>>(initial);
  const [q, setQ] = useState("");
  const restored = Object.keys(initial).length > 0;

  useEffect(() => {
    try {
      if (Object.keys(counts).length) localStorage.setItem(draftKey, JSON.stringify(counts));
      else localStorage.removeItem(draftKey);
    } catch { /* private mode / quota - the count still works, just isn't recoverable */ }
  }, [counts, draftKey]);

  const rows = useMemo(() => {
    const out = [...items].sort(
      (a, b) => catRank(a.cat) - catRank(b.cat) || a.name.localeCompare(b.name)
    );
    const needle = q.trim().toLowerCase();
    return needle ? out.filter((i) => i.name.toLowerCase().includes(needle)) : out;
  }, [items, q]);

  const entered = Object.entries(counts).filter(([, v]) => v.trim() !== "");
  const parsed = entered.map(([id, v]) => {
    const item = items.find((i) => i.id === Number(id));
    return { id: Number(id), item, value: Number(v), was: item ? item[loc] : 0 };
  }).filter((r) => r.item && Number.isFinite(r.value) && r.value >= 0);
  const variances = parsed.filter((r) => r.value !== r.was);

  function submit() {
    if (!variances.length) return;
    run(
      () => submitStocktake(loc, variances.map((r) => ({ itemId: r.id, value: r.value }))),
      `${LOC_SHORT[loc]} stocktake saved — ${variances.length} correction${variances.length === 1 ? "" : "s"}`,
      false
    );
    setCounts({});
    try { localStorage.removeItem(draftKey); } catch { /* nothing to clean up */ }
    onClose();
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
            Stocktake <span className="sub">{LOC_LABEL[loc]}</span>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            Type what you actually count. Leave a row blank if you didn&apos;t count it.
          </div>
        </div>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>

      {restored && (
        <div className="stk-restored">
          Picked up an unfinished count — {entered.length} row{entered.length === 1 ? "" : "s"} restored.
        </div>
      )}

      <div className="search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" />
        </svg>
        <input placeholder="Jump to a bottle…" value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <button className="clr" onClick={() => setQ("")}>×</button>}
      </div>

      <div className="stk-list">
        <div className="stk-row stk-hdr">
          <span className="s-n">Bottle</span>
          <span className="s-e">Expected</span>
          <span className="s-a">Counted</span>
          <span className="s-v">Variance</span>
        </div>
        {rows.map((i, idx) => {
          const raw = counts[i.id] ?? "";
          const has = raw.trim() !== "";
          const val = Number(raw);
          const ok = has && Number.isFinite(val) && val >= 0;
          const diff = ok ? Math.round((val - i[loc]) * 100) / 100 : null;
          return (
            <div className={`stk-row${ok && diff !== 0 ? " has-var" : ""}`} key={i.id}>
              <span className="s-n">
                <span className="nm">{i.name}</span>
                <span className="ct">{cap(i.cat)}</span>
              </span>
              <span className="s-e">{fmt(i[loc])}</span>
              <span className="s-a">
                <input
                  data-count-input type="number" inputMode="decimal" min="0"
                  step={loc === "store" ? "1" : "0.05"} placeholder="—" value={raw}
                  onKeyDown={(e) => onKey(e, idx)}
                  onChange={(e) => setCounts((c) => ({ ...c, [i.id]: e.target.value }))}
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
          <b>{entered.length}</b> of {items.length} counted
          {variances.length > 0 && <span className="vwarn"> · {variances.length} variance{variances.length === 1 ? "" : "s"}</span>}
        </div>
        <button className="commit" disabled={pending || !variances.length} onClick={submit}>
          {variances.length ? `Save ${variances.length} correction${variances.length === 1 ? "" : "s"}` : "No changes to save"}
        </button>
      </div>
    </div>
  );
}

/* ============================ item sheet ============================ */

function Sheet({
  item, pending, run,
}: {
  item: Item; pending: boolean;
  run: (fn: () => Promise<Result>, ok: string, closeSheet?: boolean) => void;
}) {
  const [act, setAct] = useState<SheetAct>("give");
  const [bar, setBar] = useState<Loc | null>(null);
  const [giveQty, setGiveQty] = useState(1);
  const [recvQty, setRecvQty] = useState(1);

  // Transfer state
  const [transFrom, setTransFrom] = useState<Loc>("patio");
  const [transTo, setTransTo] = useState<Loc>("back");
  const [transQty, setTransQty] = useState(1);

  // Waste state
  const [wasteLoc, setWasteLoc] = useState<Loc>("patio");
  const [wasteReason, setWasteReason] = useState<WastageReason>("Spill / Breakage");
  const [wasteQty, setWasteQty] = useState(1);

  // Count state
  const [countLoc, setCountLoc] = useState<Loc>("store");
  const [countVal, setCountVal] = useState(String(item.store));

  const presets = item.cat === "BEER" ? [1, 6, 12, 24] : [1, 2, 3, 6];
  const isBar = countLoc !== "store";
  const step = isBar ? 0.25 : 1;
  const target = Number(countVal) || 0;
  const delta = Math.round((target - item[countLoc]) * 100) / 100;

  return (
    <div className="sheet-in">
      <div className="grab" />
      <div className="sname">{item.name}</div>
      <div className="scat">{cap(item.cat)}</div>

      <div className="mini">
        {LOCS.map((k) => (
          <div className={`c ${k}`} key={k}>
            <div className="v">{fmt(item[k])}</div>
            <div className="k">{LOC_SHORT[k]}</div>
          </div>
        ))}
      </div>

      <div className="actseg" style={{ overflowX: "auto" }}>
        {(["give", "receive", "transfer", "waste", "count"] as SheetAct[]).map((a) => (
          <button key={a} className={act === a ? "on" : ""} onClick={() => setAct(a)}>
            {a === "give" ? "Give" : a === "receive" ? "Receive" : a === "transfer" ? "Transfer" : a === "waste" ? "Wastage" : "Count"}
          </button>
        ))}
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
              `${giveQty} × ${item.name} → ${LOC_SHORT[bar!]}`)}>
            Give out
          </button>
        </div>
      )}

      {act === "receive" && (
        <div>
          <div className="lbl">Add to store</div>
          <QtyPicker qty={recvQty} setQty={setRecvQty} presets={presets} />
          <button className="commit green" disabled={pending}
            onClick={() => run(() => receive(item.id, recvQty), `+${recvQty} × ${item.name} received`)}>
            Add to store
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
                }}>
                <span className="bd" style={{ background: LOC_COLOR[k] }} />{LOC_SHORT[k]}
              </button>
            ))}
          </div>
          <div className="lbl">To</div>
          <div className="pickrow">
            {LOCS.filter((k) => k !== transFrom).map((k) => (
              <button key={k} data-t={k} className={`pick${transTo === k ? " sel" : ""}`}
                onClick={() => setTransTo(k)}>
                <span className="bd" style={{ background: LOC_COLOR[k] }} />{LOC_SHORT[k]}
              </button>
            ))}
          </div>
          <div className="lbl">Transfer quantity</div>
          <QtyPicker qty={transQty} setQty={setTransQty} presets={presets} />
          <button className="commit" disabled={pending}
            onClick={() => run(() => transferBar(item.id, transQty, transFrom, transTo),
              `Transferred ${transQty} × ${item.name} (${LOC_SHORT[transFrom]} → ${LOC_SHORT[transTo]})`)}>
            Transfer stock
          </button>
        </div>
      )}

      {act === "waste" && (
        <div>
          <div className="lbl">Wasted from</div>
          <div className="pickrow">
            {LOCS.map((k) => (
              <button key={k} data-t={k} className={`pick${wasteLoc === k ? " sel" : ""}`}
                onClick={() => setWasteLoc(k)}>
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
          <QtyPicker qty={wasteQty} setQty={setWasteQty} presets={presets} />
          <button className="commit red" disabled={pending}
            onClick={() => run(() => logWaste(item.id, wasteQty, wasteLoc, wasteReason),
              `Recorded ${wasteQty} × ${item.name} waste (${wasteReason})`)}>
            Record wastage
          </button>
        </div>
      )}

      {act === "count" && (
        <div>
          <div className="lbl">Count where?</div>
          <div className="pickrow">
            {LOCS.map((k) => (
              <button key={k} data-t={k} className={`pick${countLoc === k ? " sel" : ""}`}
                onClick={() => { setCountLoc(k); setCountVal(String(item[k])); }}>
                <span className="bd" style={{ background: LOC_COLOR[k] }} />{LOC_SHORT[k]}
              </button>
            ))}
          </div>
          <div className="lbl">Bottles counted</div>
          <div className="qsel">
            <button className="step"
              onClick={() => setCountVal(String(Math.max(0, Math.round((target - step) * 100) / 100)))}>−</button>
            <input className="qnum" type="number" inputMode="decimal" min="0"
              step={isBar ? "0.05" : "1"} value={countVal}
              onChange={(e) => setCountVal(e.target.value)} />
            <button className="step"
              onClick={() => setCountVal(String(Math.round((target + step) * 100) / 100))}>+</button>
          </div>
          <div className="cnote">
            {delta === 0
              ? `No change — ${LOC_SHORT[countLoc]} stays at ${fmt(item[countLoc])}`
              : `${LOC_SHORT[countLoc]}: ${fmt(item[countLoc])} → ${fmt(target)} (${delta > 0 ? "+" : ""}${fmt(delta)})`}
          </div>
          <div className="hint" style={{ textAlign: "center", margin: "-8px 0 16px" }}>
            {isBar
              ? "Bars count part bottles — 0.5 is a half, 0.25 a quarter."
              : "The storeroom is whole, unopened bottles only."}
          </div>
          <button className="commit amber" disabled={pending}
            onClick={() => run(() => setCount(item.id, countLoc, target),
              `${LOC_SHORT[countLoc]} count: ${item.name} = ${fmt(target)}`)}>
            Set count
          </button>
        </div>
      )}
    </div>
  );
}


function QtyPicker({
  qty, setQty, presets,
}: { qty: number; setQty: (n: number) => void; presets: number[] }) {
  return (
    <>
      <div className="qsel">
        <button className="step" onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
        <div className="qnum">{qty}</div>
        <button className="step" onClick={() => setQty(qty + 1)}>+</button>
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
 * Deliveries arrive as one drop with many lines. Booking them one bottle at a
 * time through the Stock sheet is slow enough that people skip it, so this is a
 * draft basket: search, add lines, then book the whole thing in one action.
 */
function Delivery({
  items, deliveries, run, pending,
}: {
  items: Item[]; deliveries: Booked[]; pending: boolean;
  run: (fn: () => Promise<Result>, ok: string, closeSheet?: boolean) => void;
}) {
  const [lines, setLines] = useState<Map<number, number>>(new Map());
  const [q, setQ] = useState("");
  const [invoice, setInvoice] = useState("");
  const [supplier, setSupplier] = useState("");

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const needle = q.trim().toLowerCase();
  const matches = useMemo(
    () => (needle
      ? items.filter((i) => i.name.toLowerCase().includes(needle)).slice(0, 8)
      : []),
    [items, needle]
  );

  const drafted = [...lines.entries()];
  const totalBottles = drafted.reduce((a, [, n]) => a + n, 0);

  const setQty = (id: number, n: number) =>
    setLines((prev) => {
      const next = new Map(prev);
      if (n <= 0) next.delete(id); else next.set(id, n);
      return next;
    });

  const add = (i: Item) => {
    // Beer moves by the case; everything else a bottle at a time.
    const step = i.cat === "BEER" ? 24 : 1;
    setQty(i.id, (lines.get(i.id) ?? 0) + step);
    setQ("");
  };

  function book() {
    const payload: DeliveryLine[] = drafted.map(([itemId, qty]) => ({ itemId, qty }));
    run(
      () => receiveDelivery(payload, invoice, supplier),
      `Delivery booked — ${totalBottles} bottles across ${drafted.length} item${drafted.length === 1 ? "" : "s"}`,
      false
    );
    setLines(new Map());
    setInvoice("");
    setSupplier("");
  }

  return (
    <>
      <div className="ptitle">Delivery <span className="sub">book a whole drop at once</span></div>

      <div className="card">
        <div className="frow">
          <div className="fld">
            <label>Invoice # <span className="req">required</span></label>
            <input value={invoice} onChange={(e) => setInvoice(e.target.value)}
              autoComplete="off" placeholder="e.g. 88214" />
          </div>
          <div className="fld">
            <label>Supplier <span className="opt">optional</span></label>
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} autoComplete="off" />
          </div>
        </div>

        <div className="search" style={{ margin: "14px 0 0" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" />
          </svg>
          <input placeholder="Search a bottle to add…" value={q} autoComplete="off"
            onChange={(e) => setQ(e.target.value)} />
          {q && <button className="clr" onClick={() => setQ("")}>×</button>}
        </div>

        {needle && (
          <div className="dresults">
            {!matches.length && <div className="dnone">No bottle matches “{q}”.</div>}
            {matches.map((i) => (
              <button key={i.id} className="dhit" onClick={() => add(i)}>
                <span className="dhn">{i.name}</span>
                <span className="dhc">{cap(i.cat)} · {fmt(i.store)} in store</span>
                <span className="dhadd">{i.cat === "BEER" ? "+24" : "+1"}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="ch">
          <h3>This delivery</h3>
          <span className={`badge${drafted.length ? " red" : ""}`}>{drafted.length}</span>
        </div>

        {!drafted.length ? (
          <div className="empty" style={{ padding: 22 }}>
            Nothing added yet.<br />Search above to start building the delivery.
          </div>
        ) : (
          <>
            {drafted.map(([id, n]) => {
              const it = byId.get(id);
              if (!it) return null;
              const step = it.cat === "BEER" ? 24 : 1;
              return (
                <div className="dline" key={id}>
                  <div className="dl-nm">
                    <div className="t">{it.name}</div>
                    <div className="s">{fmt(it.store)} in store → <b>{fmt(it.store + n)}</b></div>
                  </div>
                  <div className="dl-qty">
                    <button onClick={() => setQty(id, n - step)} aria-label={`Less ${it.name}`}>−</button>
                    <input type="number" inputMode="numeric" min="0" value={n}
                      onChange={(e) => setQty(id, Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
                    <button onClick={() => setQty(id, n + step)} aria-label={`More ${it.name}`}>+</button>
                  </div>
                  <button className="dl-x" onClick={() => setQty(id, 0)} aria-label={`Remove ${it.name}`}>×</button>
                </div>
              );
            })}

            <div className="dfoot">
              <div className="dsum">
                <b>{fmt(totalBottles)}</b> bottles · {drafted.length} item{drafted.length === 1 ? "" : "s"}
                {!invoice.trim() && <div className="dwarn">Add the invoice number to book this</div>}
              </div>
              <button className="commit green" disabled={pending || !invoice.trim()} onClick={book}>
                Book delivery
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="ch">
          <h3>Past deliveries</h3>
          <span className="badge">{deliveries.length}</span>
        </div>
        {!deliveries.length ? (
          <div className="empty" style={{ padding: 22 }}>
            No deliveries booked yet.
          </div>
        ) : (
          deliveries.map((d) => (
            <details className="inv" key={d.batch}>
              <summary>
                <span className="ino">{d.invoice}</span>
                <span className="inmeta">
                  {new Date(d.ts).toLocaleDateString(undefined,
                    { day: "numeric", month: "short", year: "numeric" })}
                  {d.supplier ? ` · ${d.supplier}` : ""}
                </span>
                <span className="incount">
                  {fmt(d.bottles)}<small>bottles</small>
                </span>
              </summary>
              <div className="inbody">
                <div className="inlines">
                  {d.lines.map((l) => (
                    <div className="itile" key={l.item}>
                      <span className="itdot" style={{ background: CAT_COLOR[l.cat] }} />
                      <span className="itname">
                        <span className="n">{l.item}</span>
                        <span className="c">{cap(l.cat)}</span>
                      </span>
                      <span className="itq">+{fmt(l.qty)}</span>
                    </div>
                  ))}
                </div>
                <div className="inby">
                  {d.lines.length} item{d.lines.length === 1 ? "" : "s"} · booked by {d.user_name}
                </div>
              </div>
            </details>
          ))
        )}
      </div>
    </>
  );
}

/* ============================ activity ============================ */

function Activity({
  moves, user, now, onUndo, onToast,
}: {
  moves: Move[]; user: SessionUser; now: number;
  onUndo: (id: number) => void;
  onToast: (t: { msg: string; error?: boolean }) => void;
}) {
  const [filter, setFilter] = useState<string>("ALL");

  const filtered = useMemo(() => {
    if (filter === "ALL") return moves;
    return moves.filter((m) => m.type.toUpperCase() === filter);
  }, [moves, filter]);

  function copyCSV() {
    const rows: (string | number)[][] = [
      ["Date", "Time", "Type", "Item", "Category", "Qty/Value", "Location", "Entered By",
       "Notes/Invoice", "Supplier"],
    ];
    for (const m of [...moves].reverse()) {
      const d = new Date(m.ts);
      const base = [d.toLocaleDateString(), timeStr(+d)];
      const extra = [m.notes ?? m.invoice ?? "", m.supplier ?? ""];
      if (m.type === "give") rows.push([...base, "GIVE OUT", m.item_name, m.cat, m.qty ?? 0, LOC_LABEL[m.loc!], m.user_name, ...extra]);
      else if (m.type === "receive") rows.push([...base, m.batch ? "DELIVERY" : "RECEIVE", m.item_name, m.cat, m.qty ?? 0, "Store", m.user_name, ...extra]);
      else if (m.type === "waste") rows.push([...base, "WASTAGE", m.item_name, m.cat, m.qty ?? 0, LOC_LABEL[m.loc!], m.user_name, ...extra]);
      else if (m.type === "transfer") rows.push([...base, "TRANSFER", m.item_name, m.cat, m.qty ?? 0, `${LOC_LABEL[m.loc!]} -> ${LOC_LABEL[m.to_loc!]}`, m.user_name, ...extra]);
      else rows.push([...base, "COUNT SET", m.item_name, m.cat, m.to_val ?? 0, LOC_LABEL[m.loc!], m.user_name, ...extra]);
    }
    const csv = rows
      .map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(","))
      .join("\n");
    navigator.clipboard.writeText(csv)
      .then(() => onToast({ msg: "Log copied — paste into your sheet" }))
      .catch(() => onToast({ msg: "Couldn't copy — check clipboard permissions", error: true }));
  }

  let currentDay: string | null = null;

  return (
    <>
      <div className="ptitle">Activity <span className="sub">every move, newest first</span></div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className="tbtn" onClick={copyCSV}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />
          </svg>
          Copy log (CSV)
        </button>
      </div>

      <div className="chips" style={{ marginBottom: 14 }}>
        {["ALL", "GIVE", "RECEIVE", "TRANSFER", "WASTE", "COUNT"].map((f) => (
          <button key={f} className={`chip${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
            {f === "ALL" ? "All moves" : cap(f)}
          </button>
        ))}
      </div>

      {!filtered.length ? (
        <div className="empty">No activity matches filter.<br />Log a move from the Stock tab.</div>
      ) : (
        filtered.map((m, idx) => {
          const ts = +new Date(m.ts);
          const dk = dayKey(ts, now);
          const head = dk !== currentDay ? ((currentDay = dk), dk) : null;
          const canUndo = idx === 0 && (user.role === "owner" || m.user_name === user.name);

          const icon = m.type === "give" ? "↗"
            : m.type === "receive" ? "↓"
            : m.type === "waste" ? "⚠"
            : m.type === "transfer" ? "⇄"
            : "✎";

          const tagClass = m.type === "receive" && m.batch ? "batch"
            : m.type === "waste" ? "waste"
            : m.type === "transfer" ? "transfer"
            : m.loc ?? "store";

          const tagLabel = m.type === "receive" ? (m.batch ? "Delivery" : "Received")
            : m.type === "waste" ? `Wasted (${LOC_SHORT[m.loc!]})`
            : m.type === "transfer" ? `${LOC_SHORT[m.loc!]} → ${LOC_SHORT[m.to_loc!]}`
            : `${LOC_SHORT[m.loc!]}${m.type === "count" ? " count" : ""}`;

          return (
            <div key={m.id}>
              {head && <div className="day">{head}</div>}
              <div className={`ev ${m.type}`}>
                <div className="ic">{icon}</div>
                <div className="m">
                  <div className="t">
                    {m.type === "count"
                      ? `${m.item_name} → ${fmt(m.to_val ?? 0)}`
                      : `${fmt(m.qty ?? 0)} × ${m.item_name}`}
                  </div>
                  <div className="s">
                    {m.type === "count" ? `Was ${fmt(m.from_val ?? 0)} · ` : ""}
                    {cap(m.cat)} · {m.user_name}
                    {m.notes ? ` · ${m.notes}` : ""}
                    {m.invoice ? ` · inv ${m.invoice}` : ""}
                    {m.supplier ? ` · ${m.supplier}` : ""}
                  </div>
                </div>
                <span className={`tag ${tagClass}`}>{tagLabel}</span>
                <div className="time">
                  {timeStr(ts)}
                  {canUndo && (
                    <button onClick={() => onUndo(m.id)}
                      style={{ display: "block", color: "var(--txt-3)", fontSize: 11, fontWeight: 600 }}>
                      undo
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}
    </>
  );
}


/* ============================ manage (owner) ============================ */

function Manage({
  items, staff, user, run, pending,
}: {
  items: Item[]; staff: Staff[]; user: SessionUser; pending: boolean;
  run: (fn: () => Promise<Result>, ok: string, closeSheet?: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [cat, setCat] = useState<Cat>("WHISKEY");
  const [store, setStore] = useState("0");
  const [rl, setRl] = useState("2");
  const [mq, setMq] = useState("");

  const [uName, setUName] = useState("");
  const [uUser, setUUser] = useState("");
  const [uPass, setUPass] = useState("");
  const [uRole, setURole] = useState<"owner" | "staff">("staff");

  const shown = useMemo(() => {
    const out = [...items].sort((a, b) => catRank(a.cat) - catRank(b.cat) || a.name.localeCompare(b.name));
    const needle = mq.trim().toLowerCase();
    return needle ? out.filter((i) => i.name.toLowerCase().includes(needle)) : out;
  }, [items, mq]);

  return (
    <>
      <div className="ptitle">Manage <span className="sub">bottles, reorder points &amp; staff</span></div>

      <div className="card addcard">
        <div className="ch"><h3>Add a bottle</h3></div>
        <div className="frm">
          <div className="fld">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Casamigos Mezcal" autoComplete="off" />
          </div>
          <div className="frow">
            <div className="fld">
              <label>Category</label>
              <select value={cat} onChange={(e) => setCat(e.target.value as Cat)}>
                {CATS.map((c) => <option key={c} value={c}>{cap(c)}</option>)}
              </select>
            </div>
            <div className="fld">
              <label>In store</label>
              <input type="number" inputMode="numeric" min="0" value={store}
                onChange={(e) => setStore(e.target.value)} />
            </div>
            <div className="fld">
              <label>Reorder at</label>
              <input type="number" inputMode="numeric" min="0" value={rl}
                onChange={(e) => setRl(e.target.value)} />
            </div>
          </div>
          <button className="btn" disabled={pending} onClick={() =>
            run(() => addItem(name, cat, Number(store), Number(rl)), `Added ${name.trim()}`, false)
          }>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
            Add bottle
          </button>
          <div className="hint">Opening stock is the storeroom count — bars get theirs from a Count.</div>
        </div>
      </div>

      <div className="card">
        <div className="ch">
          <h3>All bottles</h3>
          <span className="badge">{items.length}</span>
        </div>
        <div className="search" style={{ marginBottom: 12 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" />
          </svg>
          <input placeholder="Search bottles…" value={mq} autoComplete="off"
            onChange={(e) => setMq(e.target.value)} />
        </div>
        {!shown.length && <div className="empty" style={{ padding: 20 }}>No bottles match.</div>}
        {shown.map((i) => (
          <div className="mrow" key={i.id}>
            <div className="mn">
              <div className="t">{i.name}</div>
              <div className="s">
                {cap(i.cat)} · store {fmt(i.store)} · patio {fmt(i.patio)} · back {fmt(i.back)}
              </div>
            </div>
            <div className="rl">
              <label>reorder</label>
              <input type="number" inputMode="numeric" min="0" defaultValue={fmt(i.rl)}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (v !== i.rl) run(() => setReorderLevel(i.id, v), `${i.name} reorders at ${fmt(v)}`, false);
                }} />
            </div>
            <button className="del" aria-label={`Remove ${i.name}`} onClick={() => {
              if (confirm(`Remove "${i.name}" from the list? Its past activity stays in the log.`)) {
                run(() => archiveItem(i.id), "Bottle removed", false);
              }
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>


      <div className="card">
        <div className="ch"><h3>Export to Excel</h3></div>
        <div className="xgrid">
          {([
            ["stock", "Stock list", "Every bottle, per location, with totals and status"],
            ["reorder", "Reorder list", "Only what is at or below its reorder point"],
            ["deliveries", "Deliveries", "One row per delivery line, with invoice and supplier"],
            ["activity", "Full activity", "Every give-out, delivery and count ever logged"],
            ["all", "Everything", "All four as separate sheets in one workbook"],
          ] as const).map(([kind, title, blurb]) => (
            <a className={`xcard${kind === "all" ? " xall" : ""}`} key={kind}
               href={`/api/export?kind=${kind}`} download>
              <span className="xi">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2">
                  <path d="M12 3v12m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" strokeLinecap="round" />
                </svg>
              </span>
              <span className="xt">
                <span className="n">{title}</span>
                <span className="b">{blurb}</span>
              </span>
            </a>
          ))}
        </div>
        <div className="hint">
          Downloads a real .xlsx — open it straight in Excel or Numbers.
        </div>
      </div>

      <div className="card addcard">
        <div className="ch"><h3>Staff</h3><span className="badge">{staff.length}</span></div>
        <div className="frm">
          <div className="frow">
            <div className="fld">
              <label>Name</label>
              <input value={uName} onChange={(e) => setUName(e.target.value)} autoComplete="off" />
            </div>
            <div className="fld">
              <label>Username</label>
              <input value={uUser} onChange={(e) => setUUser(e.target.value)}
                autoCapitalize="none" autoComplete="off" />
            </div>
          </div>
          <div className="frow">
            <div className="fld">
              <label>Password</label>
              <input type="password" value={uPass} onChange={(e) => setUPass(e.target.value)}
                autoComplete="new-password" />
            </div>
            <div className="fld">
              <label>Role</label>
              <select value={uRole} onChange={(e) => setURole(e.target.value as "owner" | "staff")}>
                <option value="staff">Staff</option>
                <option value="owner">Owner</option>
              </select>
            </div>
          </div>
          <button className="btn" disabled={pending} onClick={() => {
            run(() => addUser(uUser, uName, uPass, uRole), `Added ${uName.trim()}`, false);
            setUPass("");
          }}>
            Add person
          </button>
          <div className="hint">
            Staff can give out, receive and count. Owners can also edit bottles and staff.
          </div>
        </div>

        {staff.map((s) => (
          <div className={`urow${s.active ? "" : " off"}`} key={s.id}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t">{s.name}</div>
              <div className="s">@{s.username} · {s.role}{s.active ? "" : " · disabled"}</div>
            </div>
            {s.id !== user.id && (
              <button className="toggle"
                onClick={() => run(() => setUserActive(s.id, !s.active),
                  s.active ? `${s.name} disabled` : `${s.name} re-enabled`, false)}>
                {s.active ? "Disable" : "Enable"}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
