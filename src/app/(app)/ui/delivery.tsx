"use client";

import { useMemo, useState } from "react";
import { cap, fmt, fmtQty, type DeliveryLine, type Item, type SessionUser, type Delivery as Booked } from "@/lib/model";
import { editDelivery, receiveDelivery } from "../../actions";
import { useAction } from "../shell";
import { catColor } from "./shared";

/**
 * Deliveries arrive as one drop with many lines. Booking them one bottle at a
 * time through the Stock sheet is slow enough that people skip it, so this is a
 * draft basket: search, add lines, then book the whole thing in one action.
 */
export function Delivery({
  items, deliveries, user,
}: {
  items: Item[]; deliveries: Booked[]; user: SessionUser;
}) {
  const { pending, run } = useAction();
  const [lines, setLines] = useState<Map<number, number>>(new Map());
  const [q, setQ] = useState("");
  const [invoice, setInvoice] = useState("");
  const [supplier, setSupplier] = useState("");
  // Non-null while correcting a booked delivery: same builder, different verb.
  const [editing, setEditing] = useState<Booked | null>(null);

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
  // What saving an edit would do to the storeroom overall: the new total minus what
  // this delivery already put there. Zero when only the paperwork changed.
  const netChange = editing ? totalBottles - editing.bottles : 0;

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

  function reset() {
    setLines(new Map());
    setInvoice("");
    setSupplier("");
    setEditing(null);
    setQ("");
  }

  /** Load a booked delivery back into the builder above. */
  function edit(d: Booked) {
    setEditing(d);
    setLines(new Map(d.lines.map((l) => [l.item_id, l.qty])));
    setInvoice(d.invoice === "—" ? "" : d.invoice);
    setSupplier(d.supplier ?? "");
    setQ("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function book() {
    const payload: DeliveryLine[] = drafted.map(([itemId, qty]) => ({ itemId, qty }));
    const noun = `${totalBottles} bottles across ${drafted.length} item${drafted.length === 1 ? "" : "s"}`;
    // Only clear the form once it actually worked - a rejected edit (duplicate
    // invoice, a bottle that would go negative) has to stay on screen to be fixed.
    if (editing) {
      run(() => editDelivery(editing.batch, payload, invoice, supplier),
        `Delivery updated — ${noun}`, reset);
    } else {
      run(() => receiveDelivery(payload, invoice, supplier), `Delivery booked — ${noun}`, reset);
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
              <span>
                booked {new Date(editing.ts).toLocaleDateString("en-US",
                  { day: "numeric", month: "short", year: "numeric" })} by {editing.user_name}
                {" · "}the storeroom moves by the difference, not the whole amount
              </span>
            </div>
            <button className="decancel" onClick={reset} disabled={pending}>Cancel</button>
          </div>
        )}
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
          {q && <button className="clr" aria-label="Clear search" onClick={() => setQ("")}>×</button>}
        </div>

        {needle && (
          <div className="dresults">
            {!matches.length && <div className="dnone">No bottle matches “{q}”.</div>}
            {matches.map((i) => (
              <button key={i.id} className="dhit" onClick={() => add(i)}>
                <span className="dhn">{i.name}</span>
                <span className="dhc">{cap(i.cat)} · {fmtQty(i.cat, i.store)} in store</span>
                <span className="dhadd">{i.cat === "BEER" ? "+24" : "+1"}</span>
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
            {drafted.map(([id, n]) => {
              const it = byId.get(id);
              if (!it) return null;
              const step = it.cat === "BEER" ? 24 : 1;
              // While editing, this line already contributed `was` to the storeroom,
              // so the projection has to back that out before adding the new number.
              const was = editing?.lines.find((l) => l.item_id === id)?.qty ?? 0;
              return (
                <div className="dline" key={id}>
                  <div className="dl-nm">
                    <div className="t">{it.name}</div>
                    <div className="s">
                      {fmtQty(it.cat, it.store)} in store → <b>{fmtQty(it.cat, it.store - was + n)}</b>
                      {was > 0 && n !== was && <span className="dlwas"> was {fmtQty(it.cat, was)}</span>}
                    </div>
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
                {editing && netChange !== 0 && (
                  <div className="dnet">
                    storeroom {netChange > 0 ? "+" : "−"}{fmt(Math.abs(netChange))} once saved
                  </div>
                )}
                {!invoice.trim() && (
                  <div className="dwarn">
                    Add the invoice number to {editing ? "save this" : "book this"}
                  </div>
                )}
              </div>
              <button className="commit green" disabled={pending || !invoice.trim()} onClick={book}>
                {pending
                  ? (editing ? "Saving…" : "Booking…")
                  : (editing ? "Save changes" : "Book delivery")}
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
            <details className={`inv${editing?.batch === d.batch ? " editing" : ""}`} key={d.batch}>
              <summary>
                <span className="ino">{d.invoice}</span>
                <span className="inmeta">
                  {new Date(d.ts).toLocaleDateString("en-US",
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
                      <span className="itdot" style={{ background: catColor(l.cat) }} />
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
          ))
        )}
      </div>
    </>
  );
}

/* ============================ activity ============================ */
