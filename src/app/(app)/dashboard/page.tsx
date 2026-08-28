import { getSession } from "@/lib/auth";
import { getItems, getRecentMoves, requestNow } from "@/lib/db";
import { Dashboard } from "../../app";

export default async function DashboardPage() {
  const user = (await getSession())!; // the layout already redirected if absent

  // "last 7 days" is anchored on the server so render stays pure and hydration matches.
  // 8 days covers the 7-day windows plus the day boundary.
  const now = requestNow();
  const [items, recent] = await Promise.all([getItems(), getRecentMoves(now - 8 * 864e5)]);

  return <Dashboard items={items} moves={recent} now={now} user={user} />;
}
