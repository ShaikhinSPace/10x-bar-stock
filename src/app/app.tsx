"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  CATS, LOCS, LOC_LABEL, LOC_SHORT, cap, fmt, needsReorder, totalOf,
  type Cat, type Item, type Loc, type Move, type SessionUser, type Staff,
} from "@/lib/model";
import {
  addItem, addUser, archiveItem, giveOut, logout, receive, setCount,
  setReorderLevel, setUserActive, undoMove, type Result,
} from "./actions";

type Tab = "dashboard" | "stock" | "activity" | "manage";
type SheetAct = "give" | "receive" | "count";

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
  user, items, moves, staff, now, initialTab = "dashboard",
}: {
  user: SessionUser; items: Item[]; moves: Move[]; staff: Staff[];
  now: number; initialTab?: Tab;
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
    ? ["dashboard", "stock", "activity", "manage"]
    : ["dashboard", "stock", "activity"];

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

            {tab === "dashboard" && <Dashboard items={items} moves={moves} now={now} onPick={setSheetId} />}
            {tab === "stock" && <Stock items={items} moves={moves} now={now} onPick={setSheetId} />}
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
  const barsTot = sumAt(items, "patio") + sumAt(items, "back");
  const grandTot = sumAt(items, "store") + barsTot;
  const reorder = items
    .filter(needsReorder)
    .sort((a, b) => a.store - a.rl - (b.store - b.rl));
  const give7 = moves
    .filter((m) => m.type === "give" && +new Date(m.ts) >= since)
    .reduce((a, m) => a + (m.qty ?? 0), 0);

  return (
    <>
      <div className="ptitle">Dashboard <span className="sub">overview &amp; alerts</span></div>

      <div className="kpis">
        <div className="kpi accent"><div className="n">{fmt(grandTot)}</div><div className="l">Total bottles</div></div>
        <div className="kpi bars"><div className="n">{fmt(barsTot)}</div><div className="l">On the bars</div></div>
        <div className="kpi warn"><div className="n">{reorder.length}</div><div className="l">Need reorder</div></div>
        <div className="kpi mv"><div className="n">{fmt(give7)}</div><div className="l">Given out · 7 days</div></div>
      </div>

      <div className="card">
        <div className="ch">
          <h3>Reorder alerts</h3>
          <span className={`badge${reorder.length ? " red" : ""}`}>
            {reorder.length} item{reorder.length === 1 ? "" : "s"}
          </span>
        </div>
        {!reorder.length ? (
          <div className="empty" style={{ padding: 18 }}>Everything&apos;s above its reorder point. Nice.</div>
        ) : (
          <>
            {reorder.slice(0, 10).map((i) => (
              <button key={i.id} className={`alert ${i.store <= 0 ? "out" : "low"}`}
                onClick={() => onPick(i.id)} style={{ width: "100%", textAlign: "left" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="an">{i.name}</div>
                  <div className="ac">{cap(i.cat)} · reorder at {fmt(i.rl)}</div>
                </div>
                <div className="astat">{fmt(i.store)}<small>in store</small></div>
                <span className="go">Order ›</span>
              </button>
            ))}
            {reorder.length > 10 && (
              <div className="ac" style={{ paddingTop: 8, textAlign: "center" }}>
                +{reorder.length - 10} more
              </div>
            )}
          </>
        )}
      </div>

      <div className="dgrid">
        <CategoryCard items={items} />
        <TrendCard moves={moves} now={now} />
      </div>

      <div className="dgrid trio">
        <BarCard bar="patio" items={items} moves={moves} now={now} />
        <BarCard bar="back" items={items} moves={moves} now={now} />
        <TopMoversCard moves={moves} now={now} />
      </div>
    </>
  );
}

function CategoryCard({ items }: { items: Item[] }) {
  const data = CATS
    .map((c) => ({ c, v: items.filter((i) => i.cat === c).reduce((a, i) => a + Math.max(0, i.store), 0) }))
    .filter((d) => d.v > 0)
    .sort((a, b) => b.v - a.v);
  const max = Math.max(1, ...data.map((d) => d.v));

  return (
    <div className="card">
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
    <div className="card">
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

/* ============================ stock ============================ */

function Stock({
  items, moves, now, onPick,
}: { items: Item[]; moves: Move[]; now: number; onPick: (id: number) => void }) {
  const [loc, setLoc] = useState<Loc>("store");
  const [cat, setCat] = useState<string>("ALL");
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

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

  return (
    <>
      <div className="ptitle">Stock <span className="sub">tap a bottle to log a move</span></div>

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
  const [countLoc, setCountLoc] = useState<Loc>("store");
  const [countVal, setCountVal] = useState(String(item.store));

  const presets = item.cat === "BEER" ? [1, 6, 12, 24] : [1, 2, 3, 6];
  const qty = act === "give" ? giveQty : recvQty;
  const setQty = act === "give" ? setGiveQty : setRecvQty;
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

      <div className="actseg">
        {(["give", "receive", "count"] as SheetAct[]).map((a) => (
          <button key={a} className={act === a ? "on" : ""} onClick={() => setAct(a)}>
            {a === "give" ? "Give out" : a === "receive" ? "Receive" : "Count"}
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
          <QtyPicker qty={qty} setQty={setQty} presets={presets} />
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
          <QtyPicker qty={qty} setQty={setQty} presets={presets} />
          <button className="commit green" disabled={pending}
            onClick={() => run(() => receive(item.id, recvQty), `+${recvQty} × ${item.name} received`)}>
            Add to store
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

/* ============================ activity ============================ */

function Activity({
  moves, user, now, onUndo, onToast,
}: {
  moves: Move[]; user: SessionUser; now: number;
  onUndo: (id: number) => void;
  onToast: (t: { msg: string; error?: boolean }) => void;
}) {
  function copyCSV() {
    const rows: (string | number)[][] = [
      ["Date", "Time", "Type", "Item", "Category", "Qty/Value", "Location", "Entered By"],
    ];
    for (const m of [...moves].reverse()) {
      const d = new Date(m.ts);
      const base = [d.toLocaleDateString(), timeStr(+d)];
      if (m.type === "give") rows.push([...base, "GIVE OUT", m.item_name, m.cat, m.qty ?? 0, LOC_LABEL[m.loc!], m.user_name]);
      else if (m.type === "receive") rows.push([...base, "RECEIVE", m.item_name, m.cat, m.qty ?? 0, "Store", m.user_name]);
      else rows.push([...base, "COUNT SET", m.item_name, m.cat, m.to_val ?? 0, LOC_LABEL[m.loc!], m.user_name]);
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
      <div className="toolbar">
        <button className="tbtn" onClick={copyCSV}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />
          </svg>
          Copy log (CSV)
        </button>
      </div>

      {!moves.length ? (
        <div className="empty">No activity yet.<br />Log your first bottle from the Stock tab.</div>
      ) : (
        moves.map((m, idx) => {
          const ts = +new Date(m.ts);
          const dk = dayKey(ts, now);
          const head = dk !== currentDay ? ((currentDay = dk), dk) : null;
          const canUndo = idx === 0 && (user.role === "owner" || m.user_name === user.name);
          return (
            <div key={m.id}>
              {head && <div className="day">{head}</div>}
              <div className={`ev ${m.type}`}>
                <div className="ic">{m.type === "give" ? "↗" : m.type === "receive" ? "↓" : "✎"}</div>
                <div className="m">
                  <div className="t">
                    {m.type === "count"
                      ? `${m.item_name} → ${fmt(m.to_val ?? 0)}`
                      : `${fmt(m.qty ?? 0)} × ${m.item_name}`}
                  </div>
                  <div className="s">
                    {m.type === "count" ? `Was ${fmt(m.from_val ?? 0)} · ` : ""}
                    {cap(m.cat)} · {m.user_name}
                  </div>
                </div>
                <span className={`tag ${m.loc ?? "store"}`}>
                  {m.type === "receive" ? "Received" : `${LOC_SHORT[m.loc!]}${m.type === "count" ? " count" : ""}`}
                </span>
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
        <div className="ch"><h3>All bottles</h3><span className="badge">{items.length}</span></div>
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
