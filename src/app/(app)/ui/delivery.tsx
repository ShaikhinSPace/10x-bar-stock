"use client";

import { useMemo, useState } from "react";
import { cap, fmt, fmtQty, type Category, type DeliveryLine, type Item, type SessionUser, type Delivery as Booked } from "@/lib/model";
import { editDelivery, receiveDelivery } from "../../actions";
import { useAction } from "../shell";
import { catColor, dayKey } from "./shared";

/**
 * Deliveries arrive as one drop with many lines. Booking them one bottle at a
 * time through the Stock sheet is slow enough that people skip it, so this is a
 * draft basket: search, add lines, then book the whole thing in one action.
 */
export function Delivery({
  items, deliveries, user, cats,
}: {
  items: Item[]; deliveries: Booked[]; user: SessionUser; cats: Category[];
}) {
  const { pending, run } = useAction();
  // Per-item draft. `qty` is total bottles (what the server stores). `caseSize` is
  // bottles-per-case AS DELIVERED for this line, so beer orders that come in 24-packs
  // one week and 30-packs the next both record truthfully. For case-sized items the UI
  // edits cases; qty is cases × caseSize.
  type Draft = { qty: number; cost: string; caseSize: number };
  const [lines, setLines] = useState<Map<number, Draft>>(new Map());
  const [q, setQ] = useState("");
  const [invoice, setInvoice] = useState("");
  const [supplier, setSupplier] = useState("");
  // Paperwork-only: the owner has already added these bottles to stock manually (one by one
  // through Receive, then counted the bar) and only now records the invoice. Default off —
  // a normal delivery books stock. A paperwork booking logs the invoice without touching
  // the storeroom a second time.
  const [paperwork, setPaperwork] = useState(false);
  // Non-null while correcting a booked delivery: same builder, different verb.
  const [editing, setEditing] = useState<Booked | null>(null);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  // Pinned once per mount — the day-break labels ("Today", "Yesterday") rely on
  // this. Date.now() in render (even inside useMemo) trips the React Compiler
  // purity rule; useState's init runs exactly once and is allowed.
  const [renderedAtTs] = useState<number>(() => Date.now());
  // Supplier autocomplete pulls unique past supplier names so re-typing "Republic
  // National" doesn't fork into "Republic Nat'l" and friends.
  const pastSuppliers = useMemo(
    () => [...new Set(deliveries.map((d) => d.supplier).filter((s): s is string => !!s && s.trim() !== ""))].sort(),
    [deliveries]
  );
  const invoiceTrim = invoice.trim();
  // Inline duplicate check — server rejects dupes, surface it earlier so the user
  // doesn't book, see a cryptic toast, then have to re-type.
  const invoiceDup = invoiceTrim.length > 0 && deliveries.some((d) =>
    d.invoice === invoiceTrim && (!editing || d.batch !== editing.batch));
  const needle = q.trim().toLowerCase();
  const matches = useMemo(
    () => (needle
      ? items.filter((i) => i.name.toLowerCase().includes(needle)).slice(0, 8)
      : []),
    [items, needle]
  );

  const drafted = [...lines.entries()];
  const totalBottles = drafted.reduce((a, [, d]) => a + d.qty, 0);
  // Per-line cost is a UNIT price (per bottle). Delivery total multiplies by qty.
  // A half-typed line is excluded rather than coerced to NaN.
  const unitPrice = (d: { cost: string }) => {
    const n = Number(d.cost);
    return d.cost.trim() === "" || !Number.isFinite(n) ? null : n;
  };
  const lineTotal = (qty: number, d: { cost: string }) => {
    const u = unitPrice(d);
    return u === null ? null : Math.round(qty * u * 100) / 100;
  };
  const totalCost = drafted.reduce((a, [, d]) => {
    const lt = lineTotal(d.qty, d);
    return lt === null ? a : a + lt;
  }, 0);
  const hasAnyCost = drafted.some(([, d]) => d.cost.trim() !== "");
  // What saving an edit would do to the storeroom overall: the new total minus what
  // this delivery already put there. Zero when only the paperwork changed.
  const netChange = editing ? totalBottles - editing.bottles : 0;

  // setQty: user-initiated delete when quantity drops to 0 (the − button, the × button).
  // setQtyKeep: edits from the number input itself — never drop the row, because the user
  // is in the middle of clearing a value to retype it.
  const setQty = (id: number, n: number) =>
    setLines((prev) => {
      const next = new Map(prev);
      const curr = next.get(id) ?? { qty: 0, cost: "", caseSize: 1 };
      if (n <= 0) next.delete(id); else next.set(id, { ...curr, qty: n });
      return next;
    });
  const setQtyKeep = (id: number, n: number) =>
    setLines((prev) => {
      const next = new Map(prev);
      const curr = next.get(id) ?? { qty: 0, cost: "", caseSize: 1 };
      next.set(id, { ...curr, qty: Math.max(0, n) });
      return next;
    });
  const setLineCost = (id: number, c: string) =>
    setLines((prev) => {
      const next = new Map(prev);
      const curr = next.get(id) ?? { qty: 0, cost: "", caseSize: 1 };
      next.set(id, { ...curr, cost: c });
      return next;
    });
  // Changing bottles-per-case rescales qty so the "cases" number the user sees stays the same.
  const setLineCaseSize = (id: number, newCS: number) =>
    setLines((prev) => {
      const next = new Map(prev);
      const curr = next.get(id); if (!curr) return next;
      const cases = Math.round(curr.qty / Math.max(1, curr.caseSize));
      next.set(id, { ...curr, caseSize: Math.max(1, newCS), qty: cases * Math.max(1, newCS) });
      return next;
    });

  const add = (i: Item) => {
    // Case-sized bottles (beer, by default 24) step by the case; everything else a bottle at a time.
    const cs = Math.max(1, i.case_size);
    setLines((prev) => {
      const next = new Map(prev);
      const curr = next.get(i.id) ?? { qty: 0, cost: "", caseSize: cs };
      next.set(i.id, { ...curr, qty: curr.qty + curr.caseSize });
      return next;
    });
    setQ("");
  };

  function reset() {
    setLines(new Map());
    setInvoice("");
    setSupplier("");
    setPaperwork(false);
    setEditing(null);
    setQ("");
  }

  /** Load a booked delivery back into the builder above. */
  function edit(d: Booked) {
    setEditing(d);
    setLines(new Map(d.lines.map((l) => {
      const item = byId.get(l.item_id);
      const cs = l.case_size ?? item?.case_size ?? 1;
      return [l.item_id, { qty: l.qty, cost: l.cost === null ? "" : String(l.cost), caseSize: Math.max(1, cs) }];
    })));
    setInvoice(d.invoice === "—" ? "" : d.invoice);
    setSupplier(d.supplier ?? "");
    // The edit preserves the delivery's own paperwork flag — a real delivery stays real,
    // a paperwork one stays paperwork. The server enforces this; the UI just reflects it.
    setPaperwork(!d.affects_stock);
    setQ("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function book() {
    const payload: DeliveryLine[] = drafted.map(([itemId, d]) => ({
      itemId, qty: d.qty,
      cost: d.cost.trim() === "" ? null : Number(d.cost),
      caseSize: d.caseSize > 1 ? d.caseSize : null,
    }));
    const noun = `${totalBottles} bottles across ${drafted.length} item${drafted.length === 1 ? "" : "s"}`;
    // Only clear the form once it actually worked - a rejected edit (duplicate
    // invoice, a bottle that would go negative) has to stay on screen to be fixed.
    if (editing) {
      run(() => editDelivery(editing.batch, payload, invoice, supplier),
        `Delivery updated — ${noun}`, reset);
    } else {
      run(() => receiveDelivery(payload, invoice, supplier, !paperwork),
        `Delivery ${paperwork ? "recorded (paperwork only)" : "booked"} — ${noun}`, reset);
    }
  }

  return (
    <>
      <div className="ptitle">Delivery <span className="sub">
        {editing ? "correcting a booked delivery" : "book a whole drop at once"}</span></div>

      <div className="card">
        {editing && (
          <div className="dedit">
            <div className="det">
              <b>Editing invoice {editing.invoice}</b>
              {!editing.affects_stock && <span className="pbadge">paperwork only</span>}
              <span>
                booked {new Date(editing.ts).toLocaleDateString("en-US",
                  { day: "numeric", month: "short", year: "numeric" })} by {editing.user_name}
                {editing.affects_stock
                  ? " · the storeroom moves by the difference, not the whole amount"
                  : " · stock stays untouched — this delivery only tracks the paperwork"}
              </span>
            </div>
            <button className="decancel" onClick={reset} disabled={pending}>Cancel</button>
          </div>
        )}
        <div className="frow">
          <div className="fld">
            <label>Invoice # <span className="req">required</span></label>
            <input value={invoice} onChange={(e) => setInvoice(e.target.value)}
              inputMode="numeric" autoComplete="off" placeholder="e.g. 88214" />
          </div>
          <div className="fld">
            <label>Supplier <span className="opt">optional</span></label>
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)}
              list="past-suppliers" autoComplete="off" />
            <datalist id="past-suppliers">
              {pastSuppliers.map((s) => <option key={s} value={s} />)}
            </datalist>
          </div>
        </div>

        <label className={`paper${paperwork ? " on" : ""}`}>
          <input type="checkbox" checked={paperwork}
            disabled={!!editing}
            onChange={(e) => setPaperwork(e.target.checked)} />
          <span className="pt">
            <b>Stock already added — paperwork only</b>
            <span className="ps">
              Tick this if you&apos;ve already added these bottles manually (one by one in
              Receive, then counted the bar). Booking will log the invoice without touching
              the storeroom a second time.
            </span>
          </span>
        </label>

        <div className="search" style={{ margin: "14px 0 0" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" />
          </svg>
          <input placeholder="Search a bottle to add…" value={q} autoComplete="off"
            onChange={(e) => setQ(e.target.value)} />
          {q && <button className="clr" aria-label="Clear search" onClick={() => setQ("")}>×</button>}
        </div>

        {needle && (
          <div className="dresults">
            {!matches.length && <div className="dnone">No bottle matches “{q}”.</div>}
            {matches.map((i) => (
              <button key={i.id} className="dhit" onClick={() => add(i)}>
                <span className="dhn">{i.name}</span>
                <span className="dhc">{cap(i.cat)} · {fmtQty(i.cat, i.store, i.case_size)} in store</span>
                <span className="dhadd">+{i.case_size > 1 ? "1 case" : "1"}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="ch">
          <h3>{editing ? "Delivery lines" : "This delivery"}</h3>
          <span className={`badge${drafted.length ? " red" : ""}`}>{drafted.length}</span>
        </div>

        {!drafted.length ? (
          <div className="empty" style={{ padding: 22 }}>
            Nothing added yet.<br />Search above to start building the delivery.
          </div>
        ) : (
          <>
            {/* Newest-added appears at the top — scrolling through a long list to see
                the row you just added isn't it. */}
            {[...drafted].reverse().map(([id, d]) => {
              const it = byId.get(id);
              if (!it) return null;
              const n = d.qty;
              const isCase = d.caseSize > 1;
              const cases = isCase ? Math.round(n / d.caseSize) : n;
              const was = editing?.lines.find((l) => l.item_id === id)?.qty ?? 0;
              return (
                <div className="dline" key={id}>
                  <div className="dl-nm">
                    <div className="t">{it.name}</div>
                    <div className="s">
                      {paperwork
                        ? <>{fmtQty(it.cat, it.store, it.case_size)} in store · <span className="dlwas">no change</span></>
                        : <>{fmtQty(it.cat, it.store, it.case_size)} in store → <b>{fmtQty(it.cat, it.store - was + n, it.case_size)}</b></>}
                      {!paperwork && was > 0 && n !== was && <span className="dlwas"> was {fmtQty(it.cat, was, it.case_size)}</span>}
                      {isCase && <> · <b>{n}</b> bottles</>}
                      {lineTotal(n, d) !== null && <> · line <b>${lineTotal(n, d)!.toFixed(2)}</b></>}
                    </div>
                  </div>
                  <div className="dl-qty">
                    <button onClick={() => setQty(id, Math.max(0, n - d.caseSize))} aria-label={isCase ? `One fewer case of ${it.name}` : `Less ${it.name}`}>−</button>
                    <input type="number" inputMode="numeric" min="0"
                      value={isCase ? cases : n}
                      onChange={(e) => {
                        const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
                        setQtyKeep(id, isCase ? v * d.caseSize : v);
                      }} />
                    <button onClick={() => setQty(id, n + d.caseSize)} aria-label={isCase ? `One more case of ${it.name}` : `More ${it.name}`}>+</button>
                  </div>
                  {isCase && (
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--txt-3)" }}>
                      × <input type="number" inputMode="numeric" min="1" value={d.caseSize}
                        aria-label={`${it.name} bottles per case for this delivery`}
                        style={{ width: 44, textAlign: "right", padding: "4px 6px",
                                 background: "var(--surface-2)", border: "1px solid var(--line)",
                                 borderRadius: "var(--r-sm)", color: "var(--txt)", fontSize: 12 }}
                        onChange={(e) => setLineCaseSize(id, Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
                    </label>
                  )}
                  <input type="number" inputMode="decimal" min="0" step="0.01"
                    placeholder="$ / bottle"
                    aria-label={`${it.name} unit price per bottle`}
                    style={{ width: 86, textAlign: "right", padding: "6px 8px",
                             background: "var(--surface-2)", border: "1px solid var(--line)",
                             borderRadius: "var(--r-sm)", color: "var(--txt)", fontSize: 13 }}
                    value={d.cost} onChange={(e) => setLineCost(id, e.target.value)} />
                  <button className="dl-x" onClick={() => setQty(id, 0)} aria-label={`Remove ${it.name}`}>×</button>
                </div>
              );
            })}

            <div className="dfoot">
              <div className="dsum">
                <b>{fmt(totalBottles)}</b> bottles · {drafted.length} item{drafted.length === 1 ? "" : "s"}
                {hasAnyCost && <> · <b>${totalCost.toFixed(2)}</b> total</>}
                {paperwork && <div className="dnet">paperwork only · storeroom unchanged</div>}
                {!paperwork && editing && netChange !== 0 && (
                  <div className="dnet">
                    storeroom {netChange > 0 ? "+" : "−"}{fmt(Math.abs(netChange))} once saved
                  </div>
                )}
                {!invoiceTrim && (
                  <div className="dwarn">
                    Add the invoice number to {editing ? "save this" : "book this"}
                  </div>
                )}
                {invoiceDup && (
                  <div className="dwarn">
                    Invoice {invoiceTrim} is already on a past delivery — use a different number
                  </div>
                )}
              </div>
              <button className="commit green" disabled={pending || !invoiceTrim || invoiceDup} onClick={book}>
                {pending
                  ? (editing ? "Saving…" : "Booking…")
                  : (editing
                    ? "Save changes"
                    : paperwork ? "Record delivery" : "Book delivery")}
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
        ) : (() => {
          // Day-break headers — same Today / Yesterday / "Sat, Oct 18" rhythm as
          // Activity, so a scan here uses the same muscle memory. renderedAtTs is
          // pinned at component top (impure Date.now() in render would trip the
          // React Compiler purity rule).
          let currentDay: string | null = null;
          return deliveries.map((d) => {
            const label = dayKey(+new Date(d.ts), renderedAtTs);
            const head = label !== currentDay ? ((currentDay = label), label) : null;
            return (
              <div key={d.batch}>
                {head && <div className="day" style={{ margin: "14px 0 6px", color: "var(--txt-3)", fontSize: 11, fontWeight: 600, letterSpacing: 1 }}>{head.toUpperCase()}</div>}
                <details className={`inv${editing?.batch === d.batch ? " editing" : ""}${!d.affects_stock ? " paper" : ""}`}>
                  <summary>
                    <span className="ino">
                      {d.invoice}
                      {!d.affects_stock && <span className="pbadge">paperwork</span>}
                    </span>
                    <span className="inmeta">
                      {d.supplier || <span style={{ color: "var(--txt-3)" }}>no supplier</span>}
                      {d.cost !== null && <span style={{ marginLeft: 8 }}>· ${d.cost.toFixed(2)}</span>}
                    </span>
                    <span className="incount">
                      {fmt(d.bottles)}<small>bottles</small>
                    </span>
                  </summary>
              <div className="inbody">
                <div className="inlines">
                  {d.lines.map((l) => (
                    <div className="itile" key={l.item}>
                      <span className="itdot" style={{ background: catColor(l.cat, cats) }} />
                      <span className="itname">
                        <span className="n">{l.item}</span>
                        <span className="c">{cap(l.cat)}</span>
                      </span>
                      <span className="itq">+{fmtQty(l.cat, l.qty)}</span>
                    </div>
                  ))}
                </div>
                <div className="inby">
                  <span>
                    {d.lines.length} item{d.lines.length === 1 ? "" : "s"} · booked by {d.user_name}
                  </span>
                  {(user.role === "owner" || d.user_id === user.id) && (
                    <button className="inedit" onClick={() => edit(d)} disabled={pending}>
                      Edit delivery
                    </button>
                  )}
                </div>
              </div>
                </details>
              </div>
            );
          });
        })()}
      </div>
    </>
  );
}

/* ============================ activity ============================ */
