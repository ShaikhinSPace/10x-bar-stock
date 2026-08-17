import { getSession } from "@/lib/auth";
import { sql, LOC_LABEL, cap, needsReorder, totalOf, type Item, type Loc } from "@/lib/db";
import { buildXlsx, type Sheet } from "@/lib/xlsx";

// Reachable by URL, so it re-checks the session itself — the hidden button is not a control.
export const dynamic = "force-dynamic";

const KINDS = ["stock", "reorder", "deliveries", "activity", "all"] as const;
type Kind = (typeof KINDS)[number];

const num = (v: unknown) => Number(v ?? 0);
const dt = (ts: string | Date) => new Date(ts);

async function stockSheet(): Promise<Sheet> {
  const rows = await sql`
    select name, cat, store, patio, back, rl, archived from items order by cat, name`;
  return {
    name: "Stock",
    columns: [
      { header: "Bottle", width: 30 }, { header: "Category", width: 12 },
      { header: "In store", width: 10 }, { header: "Patio Bar", width: 10 },
      { header: "Back Bar", width: 10 }, { header: "Total", width: 10 },
      { header: "Reorder at", width: 11 }, { header: "Status", width: 12 },
      { header: "Archived", width: 10 },
    ],
    rows: rows.map((r) => {
      const i = {
        cat: r.cat, store: num(r.store), patio: num(r.patio), back: num(r.back), rl: num(r.rl),
      } as Item;
      const status = r.archived ? "archived"
        : num(r.store) <= 0 ? "OUT"
        : needsReorder(i) ? "LOW" : "ok";
      return [
        r.name, cap(r.cat), num(r.store), num(r.patio), num(r.back),
        totalOf(i), num(r.rl), status, r.archived ? "yes" : "",
      ];
    }),
  };
}

async function reorderSheet(): Promise<Sheet> {
  const rows = await sql`
    select name, cat, store, patio, back, rl from items
    where not archived and cat <> 'MIXER' and store <= rl
    order by (store - rl), name`;
  return {
    name: "Reorder",
    columns: [
      { header: "Bottle", width: 30 }, { header: "Category", width: 12 },
      { header: "In store", width: 10 }, { header: "On bars", width: 10 },
      { header: "Reorder at", width: 11 }, { header: "Status", width: 10 },
    ],
    rows: rows.map((r) => [
      r.name, cap(r.cat), num(r.store), num(r.patio) + num(r.back), num(r.rl),
      num(r.store) <= 0 ? "OUT" : "LOW",
    ]),
  };
}

/** One row per delivery line — flat, so Excel can filter and pivot it. */
async function deliveriesSheet(): Promise<Sheet> {
  const rows = await sql`
    select ts, invoice, supplier, item_name, cat, qty, user_name
    from moves where batch is not null
    order by ts desc, item_name`;
  return {
    name: "Deliveries",
    columns: [
      { header: "Date", width: 12 }, { header: "Invoice", width: 14 },
      { header: "Supplier", width: 22 }, { header: "Bottle", width: 30 },
      { header: "Category", width: 12 }, { header: "Qty received", width: 12 },
      { header: "Booked by", width: 16 },
    ],
    rows: rows.map((r) => [
      dt(r.ts).toLocaleDateString("en-GB"), r.invoice ?? "—", r.supplier ?? "",
      r.item_name, cap(r.cat), num(r.qty), r.user_name,
    ]),
  };
}

async function activitySheet(): Promise<Sheet> {
  const rows = await sql`
    select ts, type, item_name, cat, qty, loc, from_val, to_val, user_name, invoice, supplier, batch
    from moves order by ts desc`;
  return {
    name: "Activity",
    columns: [
      { header: "Date", width: 12 }, { header: "Time", width: 10 },
      { header: "Type", width: 12 }, { header: "Bottle", width: 30 },
      { header: "Category", width: 12 }, { header: "Qty / new count", width: 14 },
      { header: "Was", width: 8 }, { header: "Location", width: 12 },
      { header: "Entered by", width: 16 }, { header: "Invoice", width: 14 },
      { header: "Supplier", width: 20 },
    ],
    rows: rows.map((r) => {
      const d = dt(r.ts);
      const type = r.type === "give" ? "GIVE OUT"
        : r.type === "receive" ? (r.batch ? "DELIVERY" : "RECEIVE")
        : "COUNT SET";
      return [
        d.toLocaleDateString("en-GB"),
        d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        type, r.item_name, cap(r.cat),
        r.type === "count" ? num(r.to_val) : num(r.qty),
        r.type === "count" ? num(r.from_val) : null,
        r.loc ? LOC_LABEL[r.loc as Loc] : "",
        r.user_name, r.invoice ?? "", r.supplier ?? "",
      ];
    }),
  };
}

const BUILDERS: Record<Exclude<Kind, "all">, () => Promise<Sheet>> = {
  stock: stockSheet, reorder: reorderSheet,
  deliveries: deliveriesSheet, activity: activitySheet,
};

export async function GET(request: Request) {
  const user = await getSession();
  if (!user) return new Response("Not signed in", { status: 401 });
  if (user.role !== "owner") return new Response("Owners only", { status: 403 });

  const raw = new URL(request.url).searchParams.get("kind") ?? "all";
  const kind = (KINDS as readonly string[]).includes(raw) ? (raw as Kind) : "all";

  const sheets = kind === "all"
    ? await Promise.all(Object.values(BUILDERS).map((b) => b()))
    : [await BUILDERS[kind]()];

  const stamp = new Date().toISOString().slice(0, 10);
  const file = `10x-bar-${kind}-${stamp}.xlsx`;
  const body = buildXlsx(sheets);

  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${file}"`,
      "Content-Length": String(body.length),
      "Cache-Control": "no-store",
    },
  });
}
