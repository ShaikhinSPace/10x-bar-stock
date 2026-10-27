"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { bizDayKey, cap, fmt, fmtQty, needsReorder, noAlertSet, stockAt, type Cat, type Category, type Item, type Loc, type Move, type SessionUser } from "@/lib/model";
import { setReorderIgnore } from "../../actions";
import { useAction, useSettings } from "../shell";
import { BottleSheet, DAY, catBarColor, dayKey, last7, locColor, sumAt, timeStr, useEscapeClose, useLocMaps } from "./shared";
import { Stocktake } from "./stock";

export function Dashboard({
  items, moves, now, user, cats,
}: {
  items: Item[]; moves: Move[]; now: number; user: SessionUser; cats: Category[];
}) {
  const locMaps = useLocMaps();
  const LOC_LABEL = locMaps.label;
  const { pending, run } = useAction();
  const settings = useSettings();
  const ch = settings.business_day_cutoff_hour, tz = settings.business_tz;
  const [sheetId, setSheetId] = useState<number | null>(null);
  const [panel, setPanel] = useState<PanelKey | null>(null);
  const router = useRouter();
  const [sweepStep, setSweepStep] = useState<number | null>(null); // null = closed, 0..2 = step index
  const SWEEP: Loc[] = ["patio", "back", "store"];

  // The sweep takes over the viewport — same pattern as Stock's own standalone Count,
  // which fully replaces its page body while active. Dashboard does the same so the
  // user focuses on walking the list without the strip and tables underneath competing.
  if (sweepStep !== null) {
    return (
      <Stocktake
        items={items} loc={SWEEP[sweepStep]} user={user} cats={cats}
        step={`${sweepStep + 1} of ${SWEEP.length}`}
        onClose={() => setSweepStep(null)}
        onFinish={() => setSweepStep(sweepStep + 1 < SWEEP.length ? sweepStep + 1 : null)}
      />
    );
  }

  const since = now - 7 * DAY;
  const storeTot = sumAt(items, "store");
  const patioTot = sumAt(items, "patio");
  const backTot = sumAt(items, "back");
  const grandTot = storeTot + patioTot + backTot;

  const nac = noAlertSet(cats);
  // most deficient first - how far under its own line each bottle is
  const reorder = items.filter((i) => needsReorder(i, nac)).sort((a, b) => a.store - a.rl - (b.store - b.rl));
  const outOfStock = reorder.filter((i) => i.store <= 0).length;
  const give7 = moves
    .filter((m) => m.type === "give" && +new Date(m.ts) >= since)
    .reduce((a, m) => a + (m.qty ?? 0), 0);
  const waste7 = moves
    .filter((m) => m.type === "waste" && +new Date(m.ts) >= since)
    .reduce((a, m) => a + (m.qty ?? 0), 0);
  // What the bars were counted DOWN over the week — product poured, sold, or gone.
  // This is how usage shows up on nights you just count instead of logging pours.
  const poured7 = moves
    .filter((m) => m.type === "count" && m.loc !== "store" && +new Date(m.ts) >= since)
    .reduce((a, m) => a + Math.max(0, (m.from_val ?? 0) - (m.to_val ?? 0)), 0);

  // "Today" strip — actionable facts for the current business day. Rolling 7d
  // tells you what's normal, "today" tells you what's happened this shift.
  const todayKey = bizDayKey(now, ch, tz);
  const todayMoves = moves.filter((m) => bizDayKey(+new Date(m.ts), ch, tz) === todayKey);
  const giveToday = todayMoves
    .filter((m) => m.type === "give")
    .reduce((a, m) => a + (m.qty ?? 0), 0);
  const deliveriesToday = new Set(
    todayMoves.filter((m) => m.type === "receive" && m.batch).map((m) => m.batch)
  ).size;
  const pouredToday = todayMoves
    .filter((m) => m.type === "count" && m.loc !== "store")
    .reduce((a, m) => a + Math.max(0, (m.from_val ?? 0) - (m.to_val ?? 0)), 0);
  const wasteToday = todayMoves
    .filter((m) => m.type === "waste")
    .reduce((a, m) => a + (m.qty ?? 0), 0);
  const lastCountTs = (loc: Loc) => {
    let ts = 0;
    for (const m of moves) if (m.type === "count" && m.loc === loc) {
      const t = +new Date(m.ts);
      if (t > ts) ts = t;
    }
    return ts;
  };
  const countLabel = (loc: Loc) => {
    const ts = lastCountTs(loc);
    if (!ts) return "never";
    if (bizDayKey(ts, ch, tz) !== todayKey) return "not today";
    const mins = Math.max(1, Math.round((now - ts) / 60_000));
    return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  };

  const { slugs: LOCS, short: LOC_SHORT } = locMaps;
  const when = (m: Move) => `${dayKey(+new Date(m.ts), now)} ${timeStr(+new Date(m.ts))} · ${m.user_name}`;
  // One entry per bottle, built from the moves behind a 7-day figure.
  const fromMoves = (pick: (m: Move) => { qty: number; line: [string, string] } | null, tone?: Entry["tone"]): Entry[] => {
    const per = new Map<number, Entry & { n: number }>();
    for (const m of moves) {
      if (+new Date(m.ts) < since) continue;
      const r = pick(m);
      if (!r || r.qty <= 0) continue;
      const e = per.get(m.item_id) ?? { key: String(m.item_id), id: m.item_id, name: m.item_name, cat: m.cat, value: "", tone, lines: [], n: 0 };
      e.n += r.qty;
      e.lines.push(r.line);
      per.set(m.item_id, e);
    }
    return [...per.values()].sort((a, b) => b.n - a.n).map((e) => ({ ...e, value: fmtQty(e.cat, e.n) }));
  };
  const stockEntry = (i: Item, tone?: Entry["tone"], withReorderAt = false): Entry => ({
    key: String(i.id), id: i.id, name: i.name, cat: i.cat, tone,
    value: fmtQty(i.cat, i.store, i.case_size),
    lines: [
      ...LOCS.map((l): [string, string] => [LOC_LABEL[l], fmtQty(i.cat, stockAt(i, l), i.case_size)]),
      ...(withReorderAt ? [["Reorder at", fmtQty(i.cat, i.rl, i.case_size)] as [string, string]] : []),
    ],
  });
  const panels: Record<PanelKey, { title: string; entries: Entry[] }> = {
    out: { title: "Out of stock", entries: reorder.filter((i) => i.store <= 0).map((i) => stockEntry(i, "red")) },
    reorder: { title: "Reorder", entries: reorder.map((i) => stockEntry(i, i.store <= 0 ? "red" : "amber", true)) },
    give: { title: "Given out · 7d", entries: fromMoves((m) => m.type === "give"
      ? { qty: m.qty ?? 0, line: [`${m.loc ? LOC_SHORT[m.loc] : "?"} · ${when(m)}`, fmtQty(m.cat, m.qty ?? 0)] } : null) },
    poured: { title: "Poured · 7d", entries: fromMoves((m) => {
      if (m.type !== "count" || m.loc === "store" || !m.loc) return null;
      const d = Math.max(0, (m.from_val ?? 0) - (m.to_val ?? 0));
      return { qty: d, line: [`${LOC_SHORT[m.loc]} · ${when(m)}`, `${fmt(m.from_val ?? 0)} → ${fmt(m.to_val ?? 0)}`] };
    }) },
    waste: { title: "Wasted · 7d", entries: fromMoves((m) => m.type === "waste"
      ? { qty: m.qty ?? 0, line: [`${m.notes || "Spill / Breakage"} · ${when(m)}`, fmtQty(m.cat, m.qty ?? 0)] } : null, "red") },
  };
  const open = panel ? panels[panel] : null;

  return (
    <>
      <div className="ptitle">Dashboard <span className="sub">{new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span></div>

      <div className="dash">
        <div className="today">
          <div className="today-head">Today</div>
          <div className="today-row">
            <div className="t-item"><div className="tv">{fmt(giveToday)}</div><div className="tk">Given out</div></div>
            <div className="t-item"><div className="tv">{deliveriesToday}</div><div className="tk">Deliveries</div></div>
            <div className="t-item"><div className="tv">{fmt(pouredToday)}</div><div className="tk">Poured</div></div>
            <div className={`t-item${wasteToday > 0 ? " warn" : ""}`}><div className="tv">{fmt(wasteToday)}</div><div className="tk">Wasted</div></div>
          </div>
          <div className="today-counts">
            <span className="today-last">
              Last count — <b>Patio</b> {countLabel("patio")}
              <span className="sep"> · </span>
              <b>Back</b> {countLabel("back")}
              <span className="sep"> · </span>
              <b>Store</b> {countLabel("store")}
            </span>
            {user.role === "owner" && (
              <button className="today-count-btn" onClick={() => setSweepStep(0)}>
                {[countLabel("patio"), countLabel("back"), countLabel("store")].every((s) => s !== "never" && s !== "not today")
                  ? "Re-count today"
                  : "Count today →"}
              </button>
            )}
          </div>
        </div>

        <div className="tiles">
          <button className="tile" onClick={() => router.push("/stock")}>
            <div className="v">{fmt(grandTot)}</div><div className="k">Total bottles</div>
            <div className="sp">
              <span>Store <b>{fmt(storeTot)}</b></span>
              <span>Patio <b>{fmt(patioTot)}</b></span>
              <span>Back <b>{fmt(backTot)}</b></span>
            </div>
          </button>
          <button className={`tile${outOfStock ? " badstate" : ""}`} onClick={() => setPanel("out")}>
            <div className="v">{outOfStock}</div><div className="k">Out of stock</div>
          </button>
          <button className={`tile${reorder.length ? " warnstate" : ""}`} onClick={() => setPanel("reorder")}>
            <div className="v">{reorder.length}</div><div className="k">Reorder</div>
          </button>
          <button className="tile" onClick={() => setPanel("give")}>
            <div className="v">{fmt(give7)}</div><div className="k">Given out · 7d</div>
          </button>
          <button className="tile" onClick={() => setPanel("poured")}>
            <div className="v">{fmt(poured7)}</div><div className="k">Poured · 7d</div>
          </button>
          <button className={`tile${waste7 > 0 ? " warnstate" : ""}`} onClick={() => setPanel("waste")}>
            <div className="v">{fmt(waste7)}</div><div className="k">Wasted · 7d</div>
          </button>
        </div>

        <CategoryCard items={items} cats={cats} />
        <TrendCard moves={moves} now={now} />

        <div className="at-side">
          <BarCard bar="patio" items={items} moves={moves} now={now} />
          <BarCard bar="back" items={items} moves={moves} now={now} />
          <WastageCard moves={moves} now={now} />
          <TopMoversCard moves={moves} now={now} />
        </div>
      </div>

      {open && (
        <TileList title={open.title} entries={open.entries} pending={pending}
          onClose={() => setPanel(null)}
          onPick={(id) => { setPanel(null); setSheetId(id); }}
          ignore={user.role === "owner" && panel === "reorder"
            ? (e) => run(() => setReorderIgnore(e.id, true), `${e.name} won't raise reorder alerts anymore`)
            : undefined} />
      )}

      <BottleSheet items={items} moves={moves} id={sheetId} user={user}
        onClose={() => setSheetId(null)} />
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

type Entry = {
  key: string; id: number; name: string; cat: Cat; value: string;
  tone?: "red" | "amber" | "green"; lines: [string, string][];
};
type PanelKey = "out" | "reorder" | "give" | "poured" | "waste";

/**
 * The pop-up behind every tile: one collapsible row per bottle, opened for the
 * numbers (or the individual moves) behind the tile's figure. "Open bottle" hands
 * off to the normal bottle sheet.
 */
function TileList({
  title, entries, onPick, onClose, ignore, pending,
}: {
  title: string; entries: Entry[]; onPick: (id: number) => void; onClose: () => void;
  ignore?: (e: Entry) => void; pending: boolean;
}) {
  useEscapeClose(onClose);
  return (
    <>
      <div className="scrim show" onClick={onClose} />
      <div className="sheet show">
        <div className="sheet-in">
          <div className="grab" />
          <button className="sheet-close" aria-label="Close" onClick={onClose}>×</button>
          <div className="sname">{title} <span className="badge">{entries.length}</span></div>
          <div style={{ marginTop: 12 }}>
            {!entries.length && <div className="empty" style={{ padding: 18 }}>Nothing here.</div>}
            {entries.map((e) => (
              <details className="inv" key={e.key}>
                <summary>
                  <span className="ino" style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</span>
                  <span className="incount" style={e.tone ? { color: `var(--${e.tone})` } : undefined}>{e.value}</span>
                </summary>
                <div className="inbody">
                  <div className="inlines">
                    {e.lines.map(([k, v], i) => (
                      <div className="itile" key={i}>
                        <span className="itname"><span className="c">{k}</span></span>
                        <span className="itq" style={{ color: "var(--txt)", background: "none" }}>{v}</span>
                      </div>
                    ))}
                  </div>
                  <div className="inby">
                    <span>{cap(e.cat)}</span>
                    <span style={{ display: "flex", gap: 8 }}>
                      {ignore && (
                        <button className="inedit" disabled={pending} onClick={() => ignore(e)}>Stop alerts</button>
                      )}
                      <button className="inedit" onClick={() => onPick(e.id)}>Open bottle</button>
                    </span>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Store by category, as a dense scannable bar list rather than a pie: every
 * category with stock gets its own row (no folding into "Rest" - a list
 * scales to nine rows fine, unlike a pie's wedge-legibility ceiling), sorted
 * by volume so the biggest category reads first.
 */
function CategoryCard({ items, cats }: { items: Item[]; cats: Category[] }) {
  const rows = cats
    .map((x) => x.name)
    .map((c) => ({ c, v: items.filter((i) => i.cat === c).reduce((a, i) => a + Math.max(0, i.store), 0) }))
    .filter((d) => d.v > 0)
    .sort((a, b) => b.v - a.v);
  const total = rows.reduce((a, d) => a + d.v, 0);
  const max = Math.max(...rows.map((d) => d.v), 1);

  return (
    <div className="card at-cat">
      <div className="ch">
        <h3>Store by category</h3>
        <span className="badge">{fmt(total)} bottles</span>
      </div>
      <div className="catbars">
        {rows.map((d) => (
          <div className="catbar" key={d.c}>
            <span className="cb-name">{cap(d.c)}</span>
            <div className="cb-track">
              <div className="cb-fill" style={{ width: `${(d.v / max) * 100}%`, background: catBarColor(d.c, cats) }} />
            </div>
            <span className="cb-val">{d.c === "BEER" ? fmtQty(d.c, d.v) : fmt(d.v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrendCard({ moves, now }: { moves: Move[]; now: number }) {
  const s = useSettings();
  const ch = s.business_day_cutoff_hour, tz = s.business_tz;
  const per = last7(now, s).map((d) => ({ d, key: bizDayKey(d.getTime(), ch, tz), p: 0, b: 0, u: 0 }));
  for (const m of moves) {
    if (m.type !== "give") continue;
    const md = bizDayKey(new Date(m.ts).getTime(), ch, tz);
    const slot = per.find((x) => x.key === md);
    if (!slot) continue;
    if (m.loc === "patio") slot.p += m.qty ?? 0;
    else if (m.loc === "back") slot.b += m.qty ?? 0;
    else slot.u += m.qty ?? 0; // give whose bar wasn't recorded
  }
  const max = Math.max(1, ...per.map((x) => x.p + x.b + x.u));

  return (
    <div className="card at-trend">
      <div className="ch"><h3>Given out · last 7 days</h3></div>
      <div className="cols">
        {per.map((x, idx) => {
          const tot = x.p + x.b + x.u;
          return (
            <div className="col" key={idx}>
              <span className="cv">{tot || ""}</span>
              <div className="stack">
                {tot > 0 ? (
                  <>
                    {x.b > 0 && <span className="seg b" style={{ height: (x.b / max) * 118 }} />}
                    {x.p > 0 && <span className="seg p" style={{ height: (x.p / max) * 118 }} />}
                    {x.u > 0 && <span className="seg" style={{ height: (x.u / max) * 118, background: "var(--txt-3)" }} />}
                  </>
                ) : (
                  <span className="dot" />
                )}
              </div>
              <span className="cl">
                {x.d.toLocaleDateString("en-US", { weekday: "short" }).slice(0, 2)} {x.d.getDate()}
              </span>
            </div>
          );
        })}
      </div>
      <div className="legend">
        <span><i style={{ background: "var(--patio)" }} />Patio</span>
        <span><i style={{ background: "var(--back)" }} />Back</span>
        {per.some((x) => x.u > 0) && <span><i style={{ background: "var(--txt-3)" }} />Unknown</span>}
      </div>
    </div>
  );
}

function BarCard({
  bar, items, moves, now,
}: { bar: Loc; items: Item[]; moves: Move[]; now: number }) {
  const { label: LOC_LABEL } = useLocMaps();
  const since = now - 7 * DAY;
  const evs = moves.filter((m) => m.type === "give" && m.loc === bar && +new Date(m.ts) >= since);
  const total = evs.reduce((a, m) => a + (m.qty ?? 0), 0);
  const per = new Map<string, { qty: number; cat: Cat }>();
  for (const m of evs) {
    const prev = per.get(m.item_name);
    per.set(m.item_name, { qty: (prev?.qty ?? 0) + (m.qty ?? 0), cat: m.cat });
  }
  const top = [...per.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 6);
  const max = top.length ? top[0][1].qty : 1;

  return (
    <div className="card barcard">
      <div className="h">
        <span className="bd" style={{ background: locColor(bar) }} />
        <span className="bn">{LOC_LABEL[bar]}</span>
        <span className="bt">{fmt(total)}<small>pulled 7d</small></span>
      </div>
      <div className="onhand"><b>{fmt(sumAt(items, bar))}</b> on hand now</div>
      {!top.length && <div className="onhand" style={{ margin: 0 }}>Nothing pulled this week.</div>}
      {top.map(([nm, { qty: qy, cat }]) => (
        <div className="brk" key={nm}>
          <span className="bnm">{nm}</span>
          <span className="bar-track">
            <span className="bar-fill"
              style={{ width: `${Math.max(8, (qy / max) * 100)}%`, background: locColor(bar) }} />
          </span>
          <span className="bq">{fmtQty(cat, qy)}</span>
        </div>
      ))}
    </div>
  );
}

function TopMoversCard({ moves, now }: { moves: Move[]; now: number }) {
  const since = now - 7 * DAY;
  const per = new Map<string, { qty: number; cat: Cat }>();
  for (const m of moves) {
    if (m.type !== "give" || +new Date(m.ts) < since) continue;
    const prev = per.get(m.item_name);
    per.set(m.item_name, { qty: (prev?.qty ?? 0) + (m.qty ?? 0), cat: m.cat });
  }
  const top = [...per.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 6);
  const max = top.length ? top[0][1].qty : 1;

  return (
    <div className="card">
      <div className="ch"><h3>Top movers · 7d</h3></div>
      {!top.length && <div className="empty" style={{ padding: 18 }}>No give-outs yet this week.</div>}
      {top.map(([nm, { qty: qy, cat }]) => (
        <div className="brk" key={nm} style={{ borderTopColor: "var(--line)" }}>
          <span className="bnm">{nm}</span>
          <span className="bar-track">
            <span className="bar-fill"
              style={{ width: `${Math.max(8, (qy / max) * 100)}%`, background: "var(--blue)" }} />
          </span>
          <span className="bq">{fmtQty(cat, qy)}</span>
        </div>
      ))}
    </div>
  );
}
