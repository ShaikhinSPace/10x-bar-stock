import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDeliveries, getItems, getMoves, getRecentMoves, requestNow, sql } from "@/lib/db";
import { App } from "./app";

const TABS = ["dashboard", "stock", "delivery", "activity", "manage"] as const;

export default async function Page({ searchParams }: PageProps<"/">) {
  const user = await getSession();
  if (!user) redirect("/login");

  // ?tab=stock deep-links a tab and survives a refresh.
  const { tab } = await searchParams;
  const initialTab = TABS.find((t) => t === tab) ?? "dashboard";

  // "last 7 days" is anchored on the server so render stays pure and hydration matches.
  const now = requestNow();

  // Stats are bounded by time (8 days covers the 7-day windows plus the day boundary),
  // the activity log by count. Mixing the two is what made the totals drift.
  const [items, moves, recent, deliveries, staff] = await Promise.all([
    getItems(),
    getMoves(),
    getRecentMoves(now - 8 * 864e5),
    getDeliveries(),
    user.role === "owner"
      ? sql`select id, username, name, role, active from users order by name`
      : Promise.resolve([]),
  ]);

  return (
    <App user={user} items={items} moves={moves} staff={staff as never} recent={recent} deliveries={deliveries} now={now} initialTab={initialTab} />
  );
}
