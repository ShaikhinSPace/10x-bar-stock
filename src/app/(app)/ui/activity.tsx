"use client";

import { useMemo, useState } from "react";
import { LOC_LABEL, LOC_SHORT, bizDayKey, cap, fmtQty, undoableMoveIds, type Item, type Loc, type Move, type SessionUser } from "@/lib/model";
import { addEntry, undoMove } from "../../actions";
import { useAction } from "../shell";
import { dayKey, timeStr } from "./shared";

export function Activity({
  moves, items, user, now,
}: {
  moves: Move[]; items: Item[]; user: SessionUser; now: number;
}) {
  const { run, say } = useAction();
  const onUndo = (id: number) => run(() => undoMove(id), "Entry undone");
  const onToast = (t: { msg: string; error?: boolean }) => say(t.msg, t.error);
  const [filter, setFilter] = useState<string>("ALL");
  const [adding, setAdding] = useState(false);

  const filtered = useMemo(() => {
    if (filter === "ALL") return moves;
    return moves.filter((m) => m.type.toUpperCase() === filter);
  }, [moves, filter]);

  // From the whole log, not `filtered` - a count hidden behind the "Give" filter
  // still has to freeze the gives underneath it.
  const undoable = useMemo(() => undoableMoveIds(moves), [moves]);

  function copyCSV() {
    const rows: (string | number)[][] = [
      ["Date", "Time", "Type", "Item", "Category", "Qty/Value", "Location", "Entered By",
       "Notes/Invoice", "Supplier"],
    ];
    for (const m of [...moves].reverse()) {
      const d = new Date(m.ts);
      const base = [d.toLocaleDateString("en-US"), timeStr(+d)];
      const extra = [m.notes ?? m.invoice ?? "", m.supplier ?? ""];
      if (m.type === "give") rows.push([...base, "GIVE OUT", m.item_name, m.cat, m.qty ?? 0, LOC_LABEL[m.loc!], m.user_name, ...extra]);
      else if (m.type === "receive") rows.push([...base, m.batch ? "DELIVERY" : "RECEIVE", m.item_name, m.cat, m.qty ?? 0, LOC_LABEL[m.loc ?? "store"], m.user_name, ...extra]);
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
        {user.role === "owner" && (
          <button className="tbtn" onClick={() => setAdding((v) => !v)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
            {adding ? "Close" : "Add entry"}
          </button>
        )}
      </div>

      {adding && user.role === "owner" && (
        <AddEntry items={items} now={now} onClose={() => setAdding(false)} />
      )}

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
        filtered.map((m) => {
          const ts = +new Date(m.ts);
          const dk = dayKey(ts, now);
          const head = dk !== currentDay ? ((currentDay = dk), dk) : null;
          const canUndo = undoable.has(m.id) && (user.role === "owner" || m.user_name === user.name);

          const icon = m.type === "give" ? "↗"
            : m.type === "receive" ? "↓"
            : m.type === "waste" ? "⚠"
            : m.type === "transfer" ? "⇄"
            : "✎";

          const tagClass = m.type === "receive" && m.batch ? "batch"
            : m.type === "waste" ? "waste"
            : m.type === "transfer" ? "transfer"
            : m.loc ?? "store";

          const tagLabel = m.type === "receive"
              ? (m.batch ? "Delivery" : m.loc && m.loc !== "store" ? `Received (${LOC_SHORT[m.loc]})` : "Received")
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
                      ? `${m.item_name} → ${fmtQty(m.cat, m.to_val ?? 0)}`
                      : `${fmtQty(m.cat, m.qty ?? 0)} × ${m.item_name}`}
                  </div>
                  <div className="s">
                    {m.type === "count" ? `Was ${fmtQty(m.cat, m.from_val ?? 0)} · ` : ""}
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

/**
 * Owner-only: add a give or receive that was missed on a past night. The day picker's
 * value is a calendar date; we stamp the entry at 8pm local that day, safely inside the
 * noon→6am business night so it buckets where the owner expects. The stock change is
 * applied now — a correction is a real move, undoable from the log like any other.
 */
function AddEntry({ items, now, onClose }: { items: Item[]; now: number; onClose: () => void }) {
  const { pending, run } = useAction();
  const [type, setType] = useState<"give" | "receive" | "count">("give");
  const [itemId, setItemId] = useState<number | "">("");
  const [q, setQ] = useState("");
  const [qty, setQty] = useState("1");
  const [loc, setLoc] = useState<Loc>("patio");
  const isCount = type === "count";
  const needsLoc = type === "give" || type === "receive"; // count is the storeroom only

  const dateOf = (ms: number) => {
    const d = new Date(bizDayKey(ms));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const [dateStr, setDateStr] = useState(() => dateOf(now));
  const todayStr = dateOf(now);

  const sorted = useMemo(() => [...items].sort((a, b) => a.name.localeCompare(b.name)), [items]);
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return sorted.filter((i) => i.name.toLowerCase().includes(needle)).slice(0, 10);
  }, [sorted, q]);
  const item = items.find((i) => i.id === itemId);
  const n = Number(qty);
  // All whole bottles (the store is sealed bottles) on a chosen day. give/receive need
  // >= 1; a store count may be 0 (an emptied storeroom).
  const valid = !!item && Number.isInteger(n) && !!dateStr
    && (isCount ? n >= 0 : n >= 1);

  function atMsFor(ds: string): number {
    const [y, m, d] = ds.split("-").map(Number);
    return new Date(y, m - 1, d, 20, 0, 0, 0).getTime();
  }

  function save() {
    if (!valid || !item) return;
    // 8pm of the chosen day, capped at now so a same-day entry isn't rejected as future.
    // Date.now() is correct here: save() is an onClick handler, not render, so reading the
    // clock at click time is exactly what we want (the purity rule can't see that).
    // eslint-disable-next-line react-hooks/purity
    const at = Math.min(atMsFor(dateStr), Date.now());
    const msg = type === "give" ? `Added ${n} × ${item.name} → ${LOC_SHORT[loc]}`
      : type === "receive" ? `Received ${n} × ${item.name} → ${LOC_SHORT[loc]}`
      : `Store count: ${item.name} = ${n}`;
    run(() => addEntry(at, type, item.id, n, needsLoc ? loc : null), msg, onClose);
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="ch"><h3>Add a past entry</h3></div>
      <div className="frm">
        <div className="frow">
          <div className="fld">
            <label>Day</label>
            <input type="date" value={dateStr} max={todayStr}
              onChange={(e) => setDateStr(e.target.value)} />
          </div>
          <div className="fld">
            <label>Type</label>
            <div className="actseg">
              {(["give", "receive", "count"] as const).map((t) => (
                <button key={t} type="button" className={type === t ? "on" : ""}
                  onClick={() => { setType(t); setLoc(t === "give" ? "patio" : "store"); }}>
                  {cap(t)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="fld">
          <label>Bottle</label>
          {item ? (
            <button type="button" className="ae-picked"
              onClick={() => { setItemId(""); setQ(""); }}>
              <span>{item.name} <small>{cap(item.cat)}</small></span>
              <span className="change">change</span>
            </button>
          ) : (
            <>
              <input placeholder="Search a bottle…" value={q} autoComplete="off"
                onChange={(e) => setQ(e.target.value)} />
              {q.trim() && (
                <div className="ae-results">
                  {matches.length ? matches.map((i) => (
                    <button key={i.id} type="button" className="ae-hit"
                      onClick={() => { setItemId(i.id); setQ(""); }}>
                      <span className="nm">{i.name}</span>
                      <span className="cat">{cap(i.cat)}</span>
                    </button>
                  )) : <div className="ae-empty">No bottle matches.</div>}
                </div>
              )}
            </>
          )}
        </div>

        <div className="frow">
          <div className="fld">
            <label>{isCount ? "Counted in store" : "Quantity"}</label>
            <input type="number" inputMode="numeric" min="0" step="1" value={qty}
              onChange={(e) => setQty(e.target.value)} />
          </div>
          {needsLoc && (
            <div className="fld">
              <label>{type === "give" ? "To bar" : "Into"}</label>
              <div className="actseg">
                {(type === "give" ? (["patio", "back"] as Loc[]) : (["store", "patio", "back"] as Loc[])).map((l) => (
                  <button key={l} type="button" className={loc === l ? "on" : ""} onClick={() => setLoc(l)}>
                    {LOC_SHORT[l]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="hint">
          {isCount
            ? "Enter the storeroom's current count; the day sets which shift it closes. The drop from its last figure shows as consumed. Undo it from the log."
            : "Applies the stock change now and dates it to that night. Undo it from the log like any entry."}
        </div>
        <div className="medit-foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={!valid || pending} onClick={save}>
            {pending ? "Adding…" : "Add entry"}
          </button>
        </div>
      </div>
    </div>
  );
}
