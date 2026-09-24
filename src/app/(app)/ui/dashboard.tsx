"use client";

import { useState } from "react";
import { LOC_LABEL, bizDayKey, cap, fmt, fmtQty, needsReorder, type Cat, type Category, type Item, type Loc, type Move, type SessionUser } from "@/lib/model";
import { setReorderIgnore, type Result } from "../../actions";
import { useAction } from "../shell";
import { BottleSheet, DAY, LOC_COLOR, SortTh, catBarColor, last7, sortRows, sumAt, useColumnSort } from "./shared";

export function Dashboard({
  items, moves, now, user, cats,
}: {
  items: Item[]; moves: Move[]; now: number; user: SessionUser; cats: Category[];
}) {
  const { pending, run } = useAction();
  const [sheetId, setSheetId] = useState<number | null>(null);

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
      <div className="ptitle">Dashboard <span className="sub">{new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span></div>

      <div className="dash">
        <div className="tiles">
          <div className="tile">
            <div className="v">{fmt(grandTot)}</div><div className="k">Total bottles</div>
            <div className="sp">
              <span>Store <b>{fmt(storeTot)}</b></span>
              <span>Patio <b>{fmt(patioTot)}</b></span>
              <span>Back <b>{fmt(backTot)}</b></span>
            </div>
          </div>
          <button className={`tile${outOfStock ? " badstate" : ""}`}
            onClick={() => document.getElementById("reorder-table")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            <div className="v">{outOfStock}</div><div className="k">Out of stock</div>
          </button>
          <button className={`tile${reorder.length ? " warnstate" : ""}`}
            onClick={() => document.getElementById("reorder-table")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            <div className="v">{reorder.length}</div><div className="k">Need reorder</div>
          </button>
          <div className="tile">
            <div className="v">{fmt(give7)}</div><div className="k">Given out · 7d</div>
          </div>
          <div className={`tile${waste7 > 0 ? " warnstate" : ""}`}>
            <div className="v">{fmt(waste7)}</div><div className="k">Wasted · 7d</div>
          </div>
        </div>

        <ReorderTable rows={reorder} onPick={setSheetId} canIgnore={user.role === "owner"} pending={pending} run={run} />

        <CategoryCard items={items} cats={cats} />
        <TrendCard moves={moves} now={now} />

        <div className="at-side">
          <BarCard bar="patio" items={items} moves={moves} now={now} />
          <BarCard bar="back" items={items} moves={moves} now={now} />
          <WastageCard moves={moves} now={now} />
          <TopMoversCard moves={moves} now={now} />
        </div>
      </div>

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

/**
 * Reorder is a table, not a list of cards: every row carries five facts and the
 * whole list has to be readable, so nothing is truncated - it scrolls instead.
 * "On bars" is here because a zero storeroom reads very differently when there
 * are still three bottles out on the Patio.
 */
type ReorderSortKey = "name" | "store" | "onBars" | "rl";

function ReorderTable({
  rows, onPick, canIgnore, pending, run,
}: {
  rows: Item[]; onPick: (id: number) => void; canIgnore: boolean; pending: boolean;
  run: (fn: () => Promise<Result>, ok: string, onOk?: () => void) => void;
}) {
  const { sort, toggle } = useColumnSort<ReorderSortKey>();
  const shown = sortRows(rows, sort, (i, key) =>
    key === "name" ? i.name : key === "store" ? i.store : key === "onBars" ? i.patio + i.back : i.rl);

  return (
    <div className="card at-reorder" id="reorder-table">
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
                <SortTh label="Bottle" thKey="name" sort={sort} toggle={toggle} />
                <SortTh label="In store" thKey="store" sort={sort} toggle={toggle} className="num" />
                <SortTh label="On bars" thKey="onBars" sort={sort} toggle={toggle} className="num hide-sm" />
                <SortTh label="Reorder at" thKey="rl" sort={sort} toggle={toggle} className="num" />
                {canIgnore && <th className="num"><span className="sr-only">Ignore</span></th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => {
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
                    <td className="num short">{fmtQty(i.cat, i.store)}</td>
                    <td className="num hide-sm">{fmtQty(i.cat, i.patio + i.back)}</td>
                    <td className="num">{fmtQty(i.cat, i.rl)}</td>
                    {canIgnore && (
                      <td className="num">
                        <button className="rignore" disabled={pending}
                          aria-label={`Ignore reorder alerts for ${i.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            run(() => setReorderIgnore(i.id, true), `${i.name} won't raise reorder alerts anymore`);
                          }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M2 2l20 20M6.7 6.7A6 6 0 0 0 6 10c0 4-2 5-2 5h11M14 17a2 2 0 0 1-3.46 1.37M11 5.06A6 6 0 0 1 18 11c0 1.7.34 2.9.75 3.75"
                              strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </td>
                    )}
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
              <div className="cb-fill" style={{ width: `${(d.v / max) * 100}%`, background: catBarColor(d.c) }} />
            </div>
            <span className="cb-val">{d.c === "BEER" ? fmtQty(d.c, d.v) : fmt(d.v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrendCard({ moves, now }: { moves: Move[]; now: number }) {
  const per = last7(now).map((d) => ({ d, p: 0, b: 0 }));
  for (const m of moves) {
    if (m.type !== "give") continue;
    const md = bizDayKey(new Date(m.ts).getTime());
    const slot = per.find((x) => x.d.getTime() === md);
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
                {x.d.toLocaleDateString("en-US", { weekday: "short" }).slice(0, 2)}
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
        <span className="bd" style={{ background: LOC_COLOR[bar] }} />
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
              style={{ width: `${Math.max(8, (qy / max) * 100)}%`, background: LOC_COLOR[bar] }} />
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
