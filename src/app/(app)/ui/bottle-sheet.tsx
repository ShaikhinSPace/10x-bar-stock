"use client";

import { useMemo, useState } from "react";
import { cap, fmt, fmtQty, levelsAt, openLabel, stockAt, undoableMoveIds, type Item, type Loc, type Move, type SessionUser } from "@/lib/model";
import { countBarBottles, countStore, giveOut, logWaste, receive, transferBar, undoMove, type Result } from "../../actions";
import { useAction, useWastageReasons } from "../shell";
import { locColor, timeStr, useEscapeClose, useLocMaps } from "./shared";

type SheetAct = "give" | "receive" | "transfer" | "waste" | "count";

export function BottleSheet({
  items, moves, id, user, onClose, activeLoc,
}: {
  items: Item[]; moves: Move[]; id: number | null; user: SessionUser;
  onClose: () => void; activeLoc?: Loc;
}) {
  const item = id === null ? null : items.find((i) => i.id === id) ?? null;
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
            onClose={onClose} activeLoc={activeLoc} />
        )}
      </div>
    </>
  );
}

function Sheet({
  item, recent, undoable, user, onClose, activeLoc,
}: {
  item: Item; recent: Move[]; undoable: Set<number>; user: SessionUser;
  onClose: () => void; activeLoc?: Loc;
}) {
  const { slugs: LOCS, short: LOC_SHORT } = useLocMaps();
  const { pending, run: runAction } = useAction();
  const run = (fn: () => Promise<Result>, ok: string, onOk: () => void = onClose) =>
    runAction(fn, ok, onOk);

  useEscapeClose(onClose);
  const [act, setAct] = useState<SheetAct>("give");

  const [bar, setBar] = useState<Loc | "unknown" | null>(null);
  const [giveQty, setGiveQty] = useState(1);
  const [recvQty, setRecvQty] = useState(1);
  const [recvLoc, setRecvLoc] = useState<Loc>("store");

  const [transFrom, setTransFrom] = useState<Loc>("patio");
  const [transTo, setTransTo] = useState<Loc>("back");
  const [transQtyStr, setTransQtyStr] = useState("1");
  const transQty = Number(transQtyStr) || 0;
  const transBothBars = transFrom !== "store" && transTo !== "store";
  const transStep = transBothBars ? 0.25 : 1;

  const [wasteLoc, setWasteLoc] = useState<Loc>("patio");
  const wastageReasons = useWastageReasons();
  const [wasteReason, setWasteReason] = useState(wastageReasons[0] ?? "Spill / Breakage");
  const [wasteQtyStr, setWasteQtyStr] = useState("1");
  const wasteQty = Number(wasteQtyStr) || 0;
  const wasteIsBar = wasteLoc !== "store";

  const initLoc: Loc = activeLoc === "store" && user.role !== "owner" ? "patio" : (activeLoc ?? "patio");
  const [countLoc, setCountLoc] = useState<Loc>(initLoc);
  const [bottles, setBottles] = useState<string[]>(() => seedBottles(item, initLoc));
  const [barCountStr, setBarCountStr] = useState<string>(() => fmt(stockAt(item, initLoc)));
  const storeIsCases = item.case_size > 1;
  const [storeCountStr, setStoreCountStr] = useState<string>(() =>
    storeIsCases ? fmt(Math.floor(item.store / item.case_size)) : fmt(item.store));
  const [storeLooseStr, setStoreLooseStr] = useState<string>(() =>
    storeIsCases ? fmt(item.store % item.case_size) : "0");
  const storeCountRaw = Number(storeCountStr);
  const storeLooseRaw = Number(storeLooseStr);
  const storeCountValid = Number.isInteger(storeCountRaw) && storeCountRaw >= 0
    && (!storeIsCases || (Number.isInteger(storeLooseRaw) && storeLooseRaw >= 0));
  const storeCountBottles = storeCountValid
    ? storeCountRaw * (storeIsCases ? item.case_size : 1) + (storeIsCases ? storeLooseRaw : 0)
    : 0;
  const storeDelta = storeCountValid ? Math.round((storeCountBottles - item.store) * 100) / 100 : 0;

  const presets = item.cat === "BEER" ? [1, 6, 12, 24] : [1, 2, 3, 6];
  const barLevels = bottles.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const barTotal = Math.round(barLevels.reduce((a, n) => a + n, 0) * 100) / 100;
  const countedBottles = barLevels.length;
  const barDelta = Math.round((barTotal - stockAt(item, countLoc === "store" ? "patio" : countLoc)) * 100) / 100;
  const countLocs: Loc[] = user.role === "owner" ? ["store", "patio", "back"] : ["patio", "back"];

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
              <div className="v">{fmtQty(item.cat, stockAt(item, k), item.case_size)}</div>
              <div className="k">{LOC_SHORT[k]}</div>
              {open && <div className="o" title={levelsAt(item, k).join(" + ")}>{open}</div>}
            </div>
          );
        })}
      </div>

      <div className="actseg">
        {((user.role === "owner" ? ["give", "receive", "count"] : ["give", "receive"]) as SheetAct[]).map((a) => (
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
            {(["patio", "back", "unknown"] as const).map((b) => (
              <button key={b} data-t={b} className={`pick${bar === b ? " sel" : ""}`}
                onClick={() => setBar(b)}>
                {b === "unknown"
                  ? <><span className="bd" style={{ background: "var(--line)" }} />Not sure</>
                  : <><span className="bd" style={{ background: locColor(b) }} />{LOC_SHORT[b]}</>}
              </button>
            ))}
          </div>
          <div className="lbl">How many bottles?</div>
          <QtyPicker qty={giveQty} setQty={setGiveQty} presets={presets} />
          <button className="commit" disabled={!bar || pending}
            onClick={() => run(
              () => giveOut(item.id, giveQty, bar === "unknown" ? null : bar!),
              `${fmtQty(item.cat, giveQty, item.case_size)} × ${item.name} → ${bar === "unknown" ? "unknown bar" : LOC_SHORT[bar as Loc]}`)}>
            {pending ? "Giving…" : "Give out"}
          </button>
        </div>
      )}

      {act === "receive" && (
        <div>
          <div className="lbl">Receive into</div>
          <div className="pickrow">
            {LOCS.map((k) => (
              <button key={k} data-t={k} className={`pick${recvLoc === k ? " sel" : ""}`}
                onClick={() => setRecvLoc(k)}>
                <span className="bd" style={{ background: locColor(k) }} />{LOC_SHORT[k]}
              </button>
            ))}
          </div>
          <div className="lbl">How many bottles?</div>
          <QtyPicker qty={recvQty} setQty={setRecvQty} presets={presets} />
          {recvLoc !== "store" && (
            <div className="hint" style={{ textAlign: "center", margin: "-8px 0 16px" }}>
              Delivered straight to {LOC_SHORT[recvLoc]} — the bar&apos;s open-bottle breakdown
              resets since the new bottles&apos; composition isn&apos;t known.
            </div>
          )}
          <button className="commit green" disabled={pending}
            onClick={() => run(() => receive(item.id, recvQty, recvLoc),
              `+${fmtQty(item.cat, recvQty, item.case_size)} × ${item.name} → ${LOC_SHORT[recvLoc]}`)}>
            {pending ? "Adding…" : recvLoc === "store" ? "Add to store" : `Add to ${LOC_SHORT[recvLoc]}`}
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
                <span className="bd" style={{ background: locColor(k) }} />{LOC_SHORT[k]}
              </button>
            ))}
          </div>
          <div className="lbl">To</div>
          <div className="pickrow">
            {LOCS.map((k) => (
              <button key={k} data-t={k} className={`pick${transTo === k ? " sel" : ""}`}
                disabled={k === transFrom}
                onClick={() => { setTransTo(k); setTransQtyStr("1"); }}>
                <span className="bd" style={{ background: locColor(k) }} />{LOC_SHORT[k]}
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
              `Transferred ${fmtQty(item.cat, transQty, item.case_size)} × ${item.name} (${LOC_SHORT[transFrom]} → ${LOC_SHORT[transTo]})`)}>
            {pending ? "Transferring…" : "Transfer stock"}
          </button>
        </div>
      )}

      {act === "waste" && (
        <div>
          <div className="lbl">Wasted from</div>
          <div className="pickrow">
            {(user.role === "owner" ? LOCS : LOCS.filter((k) => k !== "store")).map((k) => (
              <button key={k} data-t={k} className={`pick${wasteLoc === k ? " sel" : ""}`}
                onClick={() => { setWasteLoc(k); setWasteQtyStr("1"); }}>
                <span className="bd" style={{ background: locColor(k) }} />{LOC_SHORT[k]}
              </button>
            ))}
          </div>
          <div className="lbl">Reason</div>
          <div className="fld" style={{ marginBottom: 16 }}>
            <select value={wasteReason} onChange={(e) => setWasteReason(e.target.value)}>
              {wastageReasons.map((r) => <option key={r} value={r}>{r}</option>)}
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
              if (confirm(`Record ${fmtQty(item.cat, wasteQty, item.case_size)} × ${item.name} as wasted from `
                + `${LOC_SHORT[wasteLoc]} (${wasteReason})?`)) {
                run(() => logWaste(item.id, wasteQty, wasteLoc, wasteReason),
                  `Recorded ${fmtQty(item.cat, wasteQty, item.case_size)} × ${item.name} waste (${wasteReason})`);
              }
            }}>
            {pending ? "Recording…" : "Record wastage"}
          </button>
        </div>
      )}

      {act === "count" && (
        <div>
          <div className="lbl">Count which location?</div>
          <div className="pickrow">
            {countLocs.map((k) => (
              <button key={k} data-t={k} className={`pick${countLoc === k ? " sel" : ""}`}
                onClick={() => {
                  setCountLoc(k);
                  if (k === "store") {
                    setStoreCountStr(storeIsCases ? fmt(Math.floor(item.store / item.case_size)) : fmt(item.store));
                    setStoreLooseStr(storeIsCases ? fmt(item.store % item.case_size) : "0");
                  }
                  else { setBottles(seedBottles(item, k)); setBarCountStr(fmt(stockAt(item, k))); }
                }}>
                <span className="bd" style={{ background: locColor(k) }} />{LOC_SHORT[k]}
              </button>
            ))}
          </div>

          {countLoc === "store" ? (
            <>
              <div className="lbl">{storeIsCases ? "How many cases + loose?" : "Counted amount"}</div>
              {storeIsCases ? (
                <div className="qsel" style={{ gap: 10 }}>
                  <button className="step" aria-label="One fewer case"
                    onClick={() => setStoreCountStr(String(Math.max(0, (Number.isInteger(storeCountRaw) ? storeCountRaw : 0) - 1)))}>−</button>
                  <input className="qnum" type="number" inputMode="numeric" min="0" step="1"
                    aria-label="Cases"
                    value={storeCountStr} onChange={(e) => setStoreCountStr(e.target.value)} />
                  <button className="step" aria-label="One more case"
                    onClick={() => setStoreCountStr(String(Math.max(0, (Number.isInteger(storeCountRaw) ? storeCountRaw : 0) + 1)))}>+</button>
                  <span style={{ color: "var(--txt-3)", fontSize: 14, padding: "0 4px" }}>+</span>
                  <input className="qnum" type="number" inputMode="numeric" min="0" step="1"
                    aria-label="Loose bottles"
                    style={{ maxWidth: 90 }}
                    value={storeLooseStr} onChange={(e) => setStoreLooseStr(e.target.value)} />
                  <span style={{ color: "var(--txt-3)", fontSize: 13 }}>loose</span>
                </div>
              ) : (
                <div className="qsel">
                  <button className="step" aria-label="One fewer"
                    onClick={() => setStoreCountStr(String(Math.max(0, (storeCountValid ? storeCountRaw : 0) - 1)))}>−</button>
                  <input className="qnum" type="number" inputMode="numeric" min="0" step="1"
                    value={storeCountStr} onChange={(e) => setStoreCountStr(e.target.value)} />
                  <button className="step" aria-label="One more"
                    onClick={() => setStoreCountStr(String(Math.max(0, (storeCountValid ? storeCountRaw : 0) + 1)))}>+</button>
                </div>
              )}
              {(() => {
                if (!storeCountValid) return <div className="cnote">Enter a whole number</div>;
                if (storeIsCases) {
                  const totalBottles = storeCountBottles;
                  const casesTxt = `${fmt(storeCountRaw)} case${storeCountRaw === 1 ? "" : "s"}`;
                  const looseTxt = storeLooseRaw > 0 ? ` + ${fmt(storeLooseRaw)} loose` : "";
                  const deltaTxt = storeDelta === 0 ? `no change` : `${storeDelta > 0 ? "+" : ""}${fmt(storeDelta)} bottles`;
                  return <div className="cnote">{casesTxt}{looseTxt} = {fmt(totalBottles)} bottles · {deltaTxt}</div>;
                }
                return (
                  <div className="cnote">
                    {storeDelta === 0
                      ? `No change — store stays at ${fmt(item.store)}`
                      : `Store: ${fmt(item.store)} → ${fmt(storeCountRaw)} (${storeDelta > 0 ? "+" : ""}${fmt(storeDelta)})`}
                  </div>
                );
              })()}
              <div className="hint" style={{ textAlign: "center", margin: "-8px 0 16px" }}>
                {storeIsCases
                  ? `A case is ${item.case_size} bottles. Count whole cases, then any loose bottles from an opened case separately. If the number is lower, prefer logging a Waste for the missing bottles — a count overwrites the running total and hides where the loss came from.`
                  : "The storeroom counts whole sealed bottles. If the counted number is lower, prefer logging a Waste for the missing bottles — a count overwrites the running total and hides where the loss came from."}
              </div>
              <button className="commit amber" disabled={pending || !storeCountValid || storeDelta === 0}
                onClick={() => run(() => countStore(item.id, storeCountBottles),
                  `Store count: ${item.name} = ${fmtQty(item.cat, storeCountBottles, item.case_size)}`)}>
                {pending ? "Saving…" : "Set count"}
              </button>
            </>
          ) : item.case_size > 1 ? (
            <>
              <div className="lbl">How many bottles?</div>
              <div className="qsel">
                <button className="step" aria-label="One fewer"
                  onClick={() => setBarCountStr(String(Math.max(0, (Math.floor(Number(barCountStr) || 0)) - 1)))}>−</button>
                <input className="qnum" type="number" inputMode="numeric" min="0" step="1"
                  value={barCountStr} onChange={(e) => setBarCountStr(e.target.value)} />
                <button className="step" aria-label="One more"
                  onClick={() => setBarCountStr(String(Math.max(0, Math.floor(Number(barCountStr) || 0) + 1)))}>+</button>
              </div>
              {(() => {
                const n = Math.max(0, Math.floor(Number(barCountStr) || 0));
                const valid = Number.isInteger(Number(barCountStr)) && Number(barCountStr) >= 0;
                const was = stockAt(item, countLoc);
                const delta = Math.round((n - was) * 100) / 100;
                return (
                  <>
                    <div className="cnote">
                      {!valid ? "Enter a whole number"
                        : delta === 0 ? `No change — ${LOC_SHORT[countLoc]} stays at ${fmt(was)}`
                        : `${LOC_SHORT[countLoc]}: ${fmt(was)} → ${fmt(n)} (${delta > 0 ? "+" : ""}${fmt(delta)})`}
                    </div>
                    <button className="commit amber" disabled={pending || !valid || delta === 0}
                      onClick={() => run(
                        () => countBarBottles(item.id, countLoc, Array(n).fill(1)),
                        `${LOC_SHORT[countLoc]} count: ${item.name} = ${fmt(n)}`)}>
                      {pending ? "Saving…" : "Set count"}
                    </button>
                  </>
                );
              })()}
            </>
          ) : (
            <>
              <div className="lbl">Each open bottle, how full?</div>
              <BottleLevels levels={bottles} setLevels={setBottles} />
              <div className="cnote">
                {barDelta === 0
                  ? `No change — ${LOC_SHORT[countLoc]} stays at ${fmt(barTotal)}`
                  : `${LOC_SHORT[countLoc]}: ${fmt(stockAt(item, countLoc))} → ${fmt(barTotal)} (${barDelta > 0 ? "+" : ""}${fmt(barDelta)})`}
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
            </>
          )}
        </div>
      )}

      <RecentOnBottle recent={recent} undoable={undoable} user={user}
        pending={pending} onUndo={(id) => runAction(() => undoMove(id), "Entry undone")} />
    </div>
  );
}

function RecentOnBottle({
  recent, undoable, user, pending, onUndo,
}: {
  recent: Move[]; undoable: Set<number>; user: SessionUser;
  pending: boolean; onUndo: (id: number) => void;
}) {
  const { short: LOC_SHORT } = useLocMaps();
  const shown = recent.slice(0, 4);
  if (!shown.length) return null;

  return (
    <div className="rcb">
      <div className="rcb-h">Recent on this bottle</div>
      {shown.map((m) => {
        const allowed = undoable.has(m.id);
        const canUndo = allowed && (user.role === "owner" || m.user_name === user.name);
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

function seedBottles(item: Item, loc: Loc): string[] {
  const known = levelsAt(item, loc).filter((n) => n > 0);
  if (known.length) return known.map((n) => String(n));

  const total = stockAt(item, loc);
  if (total <= 0) return ["1"];
  const full = Math.floor(total);
  const rest = Math.round((total - full) * 100) / 100;
  return [...Array(full).fill("1"), ...(rest > 0 ? [String(rest)] : [])];
}

function BottleLevels({
  levels, setLevels,
}: { levels: string[]; setLevels: (v: string[]) => void }) {
  const total = Math.round(
    levels.map(Number).filter((n) => Number.isFinite(n) && n > 0).reduce((a, n) => a + n, 0) * 100
  ) / 100;
  const set = (idx: number, v: string) => setLevels(levels.map((x, i) => (i === idx ? v : x)));

  return (
    <div className="blv">
      {levels.map((v, i) => {
        const n = Math.round((Number(v) || 0) * 100) / 100;
        return (
          <div className="blv-row" key={i}>
            <span className="blv-n">Bottle {i + 1}</span>
            <input className="blv-slider" type="range" min="0" max="1" step="0.01"
              aria-label={`Bottle ${i + 1} level`} value={n}
              onChange={(e) => set(i, String(Math.round(Number(e.target.value) * 100) / 100))}
              style={{ "--fill": `${n * 100}%` } as React.CSSProperties} />
            <span className="blv-lbl">{n.toFixed(2)}</span>
            <button className="blv-x" aria-label={`Remove bottle ${i + 1}`}
              onClick={() => setLevels(levels.filter((_, x) => x !== i))}>×</button>
          </div>
        );
      })}
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
