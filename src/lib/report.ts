import "server-only";
import { sql } from "./db";
import { LOC_LABEL, cap, fmt, fmtQty, type Cat, type Loc } from "./model";
import type { PdfKpi, PdfReport, PdfSection } from "./pdf";

/**
 * The management report: what changed, versus the period before it.
 *
 * Everything here is quantity-based. There is no cost or price anywhere in
 * this database, so the usual beverage-program money metrics (pour cost,
 * inventory value, COGS) are not computable and are deliberately absent
 * rather than guessed at.
 *
 * The one number that matters most is the count adjustment. Receiving and
 * giving out are both recorded deliberately, so they are already known; it's
 * the gap a physical count finds - stock that left without being logged -
 * that this app exists to surface. A count that comes in under expectation
 * is either product poured/sold at the bar or product gone missing, and
 * without POS data those two cannot be separated. It is labelled as such.
 */

export const PERIODS = ["day", "week", "month"] as const;
export type Period = (typeof PERIODS)[number];
const DAYS: Record<Period, number> = { day: 1, week: 7, month: 30 };
const LABEL: Record<Period, string> = { day: "day", week: "7 days", month: "30 days" };

const DAY_MS = 86_400_000;
const num = (v: unknown) => Number(v ?? 0);
const md = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

type Window = { from: Date; to: Date };

/**
 * The change column: "+12 (+30%)" / "-3 (-8%)" / "+4" / "new" / "no change".
 *
 * A percentage off a tiny base is noise dressed up as insight - going from
 * 1 bottle to 107 is "+10600%", which tells nobody anything. Below this
 * base the absolute change is the honest figure, so the percentage is
 * dropped rather than printed and mentally discarded.
 */
const PCT_FLOOR = 8;

function delta(cur: number, prev: number, unit?: (n: number) => string): string {
  const d = Math.round((cur - prev) * 100) / 100;
  if (d === 0) return prev === 0 ? "—" : "no change";
  const show = unit ?? fmt;
  const body = `${d > 0 ? "+" : "-"}${show(Math.abs(d))}`;
  if (prev === 0) return `${body} (new)`;
  if (Math.abs(prev) < PCT_FLOOR) return body;
  const p = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  return `${body} (${p > 0 ? "+" : ""}${p}%)`;
}

async function movementTotals(w: Window) {
  const [r] = await sql`
    select
      coalesce(sum(case when m.type = 'receive' then m.qty else 0 end), 0)  as received,
      coalesce(sum(case when m.type = 'give'    then m.qty else 0 end), 0)  as issued,
      coalesce(sum(case when m.type = 'waste'   then m.qty else 0 end), 0)  as wasted,
      coalesce(sum(case when m.type = 'transfer' then m.qty else 0 end), 0) as transferred,
      coalesce(sum(case when m.type = 'count' and coalesce(m.to_val,0) < coalesce(m.from_val,0)
                        then coalesce(m.from_val,0) - coalesce(m.to_val,0) else 0 end), 0) as count_down,
      coalesce(sum(case when m.type = 'count' and coalesce(m.to_val,0) > coalesce(m.from_val,0)
                        then coalesce(m.to_val,0) - coalesce(m.from_val,0) else 0 end), 0) as count_up,
      count(*) filter (where m.type = 'count')                              as counts_done,
      count(distinct m.batch) filter (where m.batch is not null)            as deliveries
    from moves m
    join items i on i.id = m.item_id and not i.archived
    where m.ts >= ${w.from.toISOString()} and m.ts < ${w.to.toISOString()}`;
  return {
    received: num(r.received), issued: num(r.issued), wasted: num(r.wasted),
    transferred: num(r.transferred), countDown: num(r.count_down), countUp: num(r.count_up),
    countsDone: num(r.counts_done), deliveries: num(r.deliveries),
  };
}

/**
 * On-hand total at a moment, reconstructed by unwinding every later move.
 * Give and transfer only relocate stock, so they net to zero against the
 * three locations combined; only receive, waste and count change the total.
 */
async function onHandAt(t: Date): Promise<number> {
  const [now] = await sql`
    select coalesce(sum(store + patio + back), 0) as total from items where not archived`;
  const [since] = await sql`
    select coalesce(sum(case m.type
      when 'receive' then m.qty
      when 'waste'   then -m.qty
      when 'count'   then coalesce(m.to_val, 0) - coalesce(m.from_val, 0)
      else 0 end), 0) as d
    from moves m join items i on i.id = m.item_id and not i.archived
    where m.ts >= ${t.toISOString()}`;
  return num(now.total) - num(since.d);
}

async function stockPosition() {
  const [r] = await sql`
    select
      coalesce(sum(store + patio + back), 0)                        as onhand,
      coalesce(sum(store), 0)                                       as store,
      coalesce(sum(patio), 0)                                       as patio,
      coalesce(sum(back), 0)                                        as back,
      count(*)                                                      as items,
      count(*) filter (where store <= 0)                            as out_of_stock,
      count(*) filter (where not ignore_reorder and cat <> 'MIXER' and store <= rl) as need_reorder
    from items where not archived`;
  return {
    onhand: num(r.onhand), store: num(r.store), patio: num(r.patio), back: num(r.back),
    items: num(r.items), outOfStock: num(r.out_of_stock), needReorder: num(r.need_reorder),
  };
}

async function categorySection(cur: Window, prev: Window): Promise<PdfSection> {
  const rows = await sql`
    with agg as (
      select i.cat,
        sum(case when m.ts >= ${cur.from.toISOString()} and m.type = 'receive' then m.qty else 0 end) as recv_c,
        sum(case when m.ts <  ${cur.from.toISOString()} and m.type = 'receive' then m.qty else 0 end) as recv_p,
        sum(case when m.ts >= ${cur.from.toISOString()} and m.type = 'give'    then m.qty else 0 end) as iss_c,
        sum(case when m.ts <  ${cur.from.toISOString()} and m.type = 'give'    then m.qty else 0 end) as iss_p,
        sum(case when m.ts >= ${cur.from.toISOString()} and m.type = 'waste'   then m.qty else 0 end) as wst_c,
        sum(case when m.ts <  ${cur.from.toISOString()} and m.type = 'waste'   then m.qty else 0 end) as wst_p,
        sum(case when m.ts >= ${cur.from.toISOString()} and m.type = 'count'
                      and coalesce(m.to_val,0) < coalesce(m.from_val,0)
                 then coalesce(m.from_val,0) - coalesce(m.to_val,0) else 0 end) as down_c,
        sum(case when m.ts <  ${cur.from.toISOString()} and m.type = 'count'
                      and coalesce(m.to_val,0) < coalesce(m.from_val,0)
                 then coalesce(m.from_val,0) - coalesce(m.to_val,0) else 0 end) as down_p,
        sum(case when m.ts >= ${cur.from.toISOString()} and m.type = 'count'
                      and coalesce(m.to_val,0) > coalesce(m.from_val,0)
                 then coalesce(m.to_val,0) - coalesce(m.from_val,0) else 0 end) as up_c
      from moves m join items i on i.id = m.item_id and not i.archived
      where m.ts >= ${prev.from.toISOString()} and m.ts < ${cur.to.toISOString()}
      group by i.cat
    ), stock as (
      select cat, sum(store + patio + back) as onhand from items where not archived group by cat
    )
    select s.cat, s.onhand,
           coalesce(a.recv_c,0) recv_c, coalesce(a.recv_p,0) recv_p,
           coalesce(a.iss_c,0) iss_c, coalesce(a.iss_p,0) iss_p,
           coalesce(a.wst_c,0) wst_c, coalesce(a.wst_p,0) wst_p,
           coalesce(a.down_c,0) down_c, coalesce(a.down_p,0) down_p,
           coalesce(a.up_c,0) up_c
    from stock s left join agg a on a.cat = s.cat
    order by s.onhand desc`;

  return {
    title: "By category",
    note: "On hand now, and what moved in each category this period against the one before. "
      + "Down and up are kept apart so these columns add up to the totals on the front page.",
    columns: [
      { header: "Category", width: 1.4 },
      { header: "On hand", width: 1, align: "right" },
      { header: "Received", width: 1, align: "right" },
      { header: "Issued to bars", width: 1.1, align: "right" },
      { header: "Wasted", width: 0.9, align: "right" },
      { header: "Counted down", width: 1.1, align: "right" },
      { header: "Counted up", width: 1, align: "right" },
      { header: "Down vs previous", width: 1.3, align: "right" },
    ],
    rows: rows.map((r) => {
      const cat = r.cat as Cat;
      const downC = num(r.down_c), downP = num(r.down_p);
      // The change is shown in the same unit as the column it refers to -
      // "+2 cases" beside "2 cases", never "+48" beside it.
      const q = (n: number) => fmtQty(cat, n);
      return [
        cap(r.cat), q(num(r.onhand)), q(num(r.recv_c)), q(num(r.iss_c)), q(num(r.wst_c)),
        q(downC), q(num(r.up_c)), delta(downC, downP, q),
      ];
    }),
  };
}

async function moversSection(cur: Window, prev: Window): Promise<PdfSection> {
  // Gross down only (counts that fell), matching the front-page figure -
  // a later count going back up is a correction, not negative consumption.
  const rows = await sql`
    select i.name, i.cat,
      sum(case when m.ts >= ${cur.from.toISOString()} and coalesce(m.to_val,0) < coalesce(m.from_val,0)
               then coalesce(m.from_val,0) - coalesce(m.to_val,0) else 0 end) as down_c,
      sum(case when m.ts <  ${cur.from.toISOString()} and coalesce(m.to_val,0) < coalesce(m.from_val,0)
               then coalesce(m.from_val,0) - coalesce(m.to_val,0) else 0 end) as down_p,
      (select store + patio + back from items where id = i.id) as onhand
    from moves m join items i on i.id = m.item_id and not i.archived
    where m.type = 'count' and m.ts >= ${prev.from.toISOString()} and m.ts < ${cur.to.toISOString()}
    group by i.id, i.name, i.cat
    having sum(case when m.ts >= ${cur.from.toISOString()} and coalesce(m.to_val,0) < coalesce(m.from_val,0)
                    then coalesce(m.from_val,0) - coalesce(m.to_val,0) else 0 end) > 0
    order by down_c desc
    limit 25`;

  return {
    title: "Biggest movers",
    note: "Ranked by how far counts came down this period - product poured, sold, or otherwise gone. "
      + "Without till data this cannot separate normal service from loss; a big jump is what to ask about.",
    empty: "No counts recorded this period, so there is nothing to rank. Run a count to populate this.",
    columns: [
      { header: "Bottle", width: 2.6 },
      { header: "Category", width: 1.1 },
      { header: "Down this period", width: 1.3, align: "right" },
      { header: "Previous", width: 1.1, align: "right" },
      { header: "Change", width: 1.3, align: "right" },
      { header: "On hand now", width: 1.2, align: "right" },
    ],
    rows: rows.map((r) => {
      const cat = r.cat as Cat;
      const q = (n: number) => fmtQty(cat, n);
      const c = num(r.down_c), p = num(r.down_p);
      return [r.name, cap(r.cat), q(c), q(p), delta(c, p, q), q(num(r.onhand))];
    }),
  };
}

async function reorderSection(): Promise<PdfSection> {
  const rows = await sql`
    select name, cat, store, patio, back, rl from items
    where not archived and not ignore_reorder and cat <> 'MIXER' and store <= rl
    order by (store - rl), name`;
  return {
    title: "Order this",
    note: "At or below the reorder point, most urgent first. Muted items and mixers are excluded.",
    empty: "Everything is above its reorder point.",
    columns: [
      { header: "Bottle", width: 2.6 },
      { header: "Category", width: 1.1 },
      { header: "In store", width: 1, align: "right" },
      { header: "On bars", width: 1, align: "right" },
      { header: "Reorder at", width: 1.1, align: "right" },
      { header: "Short by", width: 1, align: "right" },
      { header: "Status", width: 0.9 },
    ],
    rows: rows.map((r) => {
      const cat = r.cat as Cat;
      const store = num(r.store), rl = num(r.rl);
      return [
        r.name, cap(r.cat), fmtQty(cat, store), fmtQty(cat, num(r.patio) + num(r.back)),
        fmtQty(cat, rl), fmtQty(cat, Math.max(0, rl - store)), store <= 0 ? "OUT" : "LOW",
      ];
    }),
  };
}

async function wastageSection(cur: Window, prev: Window): Promise<PdfSection> {
  const rows = await sql`
    select coalesce(nullif(m.notes, ''), 'Unspecified') as reason,
      sum(case when m.ts >= ${cur.from.toISOString()} then m.qty else 0 end) as c,
      sum(case when m.ts <  ${cur.from.toISOString()} then m.qty else 0 end) as p,
      count(*) filter (where m.ts >= ${cur.from.toISOString()})              as n
    from moves m join items i on i.id = m.item_id and not i.archived
    where m.type = 'waste' and m.ts >= ${prev.from.toISOString()} and m.ts < ${cur.to.toISOString()}
    group by 1 order by c desc`;
  return {
    title: "Wastage",
    note: "Recorded spills, breakage and comps, by reason.",
    empty: "No wastage recorded this period or the one before it.",
    columns: [
      { header: "Reason", width: 2.6 },
      { header: "Entries", width: 1, align: "right" },
      { header: "Bottles", width: 1.1, align: "right" },
      { header: "Previous", width: 1.1, align: "right" },
      { header: "Change", width: 1.3, align: "right" },
    ],
    rows: rows.filter((r) => num(r.c) > 0 || num(r.p) > 0).map((r) => {
      const c = num(r.c), p = num(r.p);
      return [r.reason, String(num(r.n)), fmt(c), fmt(p), delta(c, p)];
    }),
  };
}

async function varianceSection(cur: Window): Promise<PdfSection> {
  const rows = await sql`
    select m.ts, m.item_name, m.cat, m.loc, m.from_val, m.to_val, m.user_name
    from moves m join items i on i.id = m.item_id and not i.archived
    where m.type = 'count' and m.ts >= ${cur.from.toISOString()} and m.ts < ${cur.to.toISOString()}
      and coalesce(m.to_val,0) <> coalesce(m.from_val,0)
    order by abs(coalesce(m.to_val,0) - coalesce(m.from_val,0)) desc
    limit 25`;
  return {
    title: "Count corrections",
    note: "Where a physical count disagreed with the system, biggest gap first. A negative gap is stock "
      + "that left without a matching entry; a positive one usually means a delivery or return went unlogged.",
    empty: "No counts changed a figure this period.",
    columns: [
      { header: "Date", width: 1 },
      { header: "Bottle", width: 2.4 },
      { header: "Location", width: 1.1 },
      { header: "Expected", width: 1, align: "right" },
      { header: "Counted", width: 1, align: "right" },
      { header: "Gap", width: 1, align: "right" },
      { header: "Counted by", width: 1.2 },
    ],
    rows: rows.map((r) => {
      const cat = r.cat as Cat;
      const from = num(r.from_val), to = num(r.to_val);
      const gap = Math.round((to - from) * 100) / 100;
      return [
        new Date(r.ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        r.item_name, LOC_LABEL[r.loc as Loc] ?? r.loc,
        fmtQty(cat, from), fmtQty(cat, to),
        // Same unit as the two columns it sits beside, not raw bottles.
        `${gap > 0 ? "+" : "-"}${fmtQty(cat, Math.abs(gap))}`, r.user_name,
      ];
    }),
  };
}

async function deliveriesSection(cur: Window, prev: Window): Promise<PdfSection> {
  const rows = await sql`
    select coalesce(nullif(m.supplier, ''), 'Not recorded') as supplier,
      count(distinct m.batch) filter (where m.ts >= ${cur.from.toISOString()}) as drops,
      sum(case when m.ts >= ${cur.from.toISOString()} then m.qty else 0 end)   as c,
      sum(case when m.ts <  ${cur.from.toISOString()} then m.qty else 0 end)   as p,
      max(m.ts) filter (where m.ts >= ${cur.from.toISOString()})               as last_ts
    from moves m join items i on i.id = m.item_id and not i.archived
    where m.type = 'receive' and m.ts >= ${prev.from.toISOString()} and m.ts < ${cur.to.toISOString()}
    group by 1 order by c desc`;
  return {
    title: "Deliveries",
    note: "Everything booked in, grouped by supplier.",
    empty: "Nothing was received this period or the one before it.",
    columns: [
      { header: "Supplier", width: 2.4 },
      { header: "Drops", width: 1, align: "right" },
      { header: "Bottles in", width: 1.2, align: "right" },
      { header: "Previous", width: 1.1, align: "right" },
      { header: "Change", width: 1.3, align: "right" },
      { header: "Last delivery", width: 1.2 },
    ],
    rows: rows.filter((r) => num(r.c) > 0 || num(r.p) > 0).map((r) => {
      const c = num(r.c), p = num(r.p);
      return [
        r.supplier, String(num(r.drops)), fmt(c), fmt(p), delta(c, p),
        r.last_ts ? md(new Date(r.last_ts)) : "—",
      ];
    }),
  };
}

async function staleSection(cur: Window): Promise<PdfSection> {
  const rows = await sql`
    select i.name, i.cat, i.store + i.patio + i.back as onhand,
      (select max(ts) from moves where item_id = i.id) as last_ts
    from items i
    where not i.archived and i.store + i.patio + i.back > 0
      and not exists (select 1 from moves m where m.item_id = i.id and m.ts >= ${cur.from.toISOString()})
    order by (i.store + i.patio + i.back) desc
    limit 25`;
  return {
    title: "Sitting untouched",
    note: "Has stock, but nothing was logged against it this period - the top of this list is where "
      + "money is parked. Some of it is simply slow-moving; some of it is not selling.",
    empty: "Everything with stock saw activity this period.",
    columns: [
      { header: "Bottle", width: 2.8 },
      { header: "Category", width: 1.2 },
      { header: "On hand", width: 1.2, align: "right" },
      { header: "Last activity", width: 1.4 },
    ],
    rows: rows.map((r) => [
      r.name, cap(r.cat), fmtQty(r.cat as Cat, num(r.onhand)),
      r.last_ts ? new Date(r.last_ts).toLocaleDateString("en-US",
        { month: "short", day: "numeric", year: "numeric" }) : "never",
    ]),
  };
}

/**
 * The headline figures, without any PDF around them.
 *
 * Exported so scripts/check-report.mjs can assert the accounting identity
 * these have to satisfy: closing = opening + received - wasted + found - down.
 * If the reconstruction in onHandAt() ever drifts, that check fails loudly
 * instead of the report quietly printing a wrong opening balance.
 */
export async function periodStats(period: Period, now = new Date()) {
  const span = DAYS[period] * DAY_MS;
  const cur: Window = { from: new Date(+now - span), to: now };
  const prev: Window = { from: new Date(+now - span * 2), to: cur.from };
  const [pos, mCur, mPrev, openCur, openPrev] = await Promise.all([
    stockPosition(), movementTotals(cur), movementTotals(prev),
    onHandAt(cur.from), onHandAt(prev.from),
  ]);
  return { cur, prev, pos, mCur, mPrev, openCur, openPrev };
}

export async function buildReport(period: Period, userName: string, now = new Date()): Promise<PdfReport> {
  const { cur, prev, pos, mCur, mPrev, openCur, openPrev } = await periodStats(period, now);

  const [category, movers, reorder, wastage, variance, deliveries, stale] = await Promise.all([
    categorySection(cur, prev), moversSection(cur, prev), reorderSection(),
    wastageSection(cur, prev), varianceSection(cur), deliveriesSection(cur, prev), staleSection(cur),
  ]);

  const closePrev = openCur; // the previous period closed where this one opened
  const kpis: PdfKpi[] = [
    { label: "Bottles on hand (close)", value: fmt(pos.onhand), prev: fmt(closePrev), change: delta(pos.onhand, closePrev) },
    { label: "  opened the period at", value: fmt(openCur), prev: fmt(openPrev), change: delta(openCur, openPrev) },
    { label: "Received", value: fmt(mCur.received), prev: fmt(mPrev.received), change: delta(mCur.received, mPrev.received) },
    { label: "Issued to the bars", value: fmt(mCur.issued), prev: fmt(mPrev.issued), change: delta(mCur.issued, mPrev.issued) },
    { label: "Counted down (poured, sold or lost)", value: fmt(mCur.countDown), prev: fmt(mPrev.countDown), change: delta(mCur.countDown, mPrev.countDown) },
    { label: "Counted up (found / unlogged intake)", value: fmt(mCur.countUp), prev: fmt(mPrev.countUp), change: delta(mCur.countUp, mPrev.countUp) },
    { label: "Wasted", value: fmt(mCur.wasted), prev: fmt(mPrev.wasted), change: delta(mCur.wasted, mPrev.wasted) },
    { label: "Deliveries booked", value: fmt(mCur.deliveries), prev: fmt(mPrev.deliveries), change: delta(mCur.deliveries, mPrev.deliveries) },
    { label: "Counts carried out", value: fmt(mCur.countsDone), prev: fmt(mPrev.countsDone), change: delta(mCur.countsDone, mPrev.countsDone) },
    { label: "Out of stock right now", value: fmt(pos.outOfStock) },
    { label: "Below reorder point right now", value: fmt(pos.needReorder) },
  ];

  const range = `${md(cur.from)} - ${md(cur.to)}`;
  const prevRange = `${md(prev.from)} - ${md(cur.from)}`;

  return {
    title: "10X Bar - Stock Report",
    subtitle: `Last ${LABEL[period]} (${range})   vs   the ${LABEL[period]} before (${prevRange})`,
    meta: `Generated ${now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`
      + ` at ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} by ${userName}`
      + `   ·   ${pos.items} active bottles   ·   store ${fmt(pos.store)} / patio ${fmt(pos.patio)} / back ${fmt(pos.back)}`,
    kpiHeader: ["", `Last ${LABEL[period]}`, `Previous ${LABEL[period]}`],
    kpis,
    sections: [reorder, category, movers, variance, wastage, deliveries, stale],
  };
}
