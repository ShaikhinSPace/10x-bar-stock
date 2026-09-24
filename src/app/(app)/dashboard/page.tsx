import { ownerPage } from "../guard";
import { getCategories, getItems, getRecentMoves, requestNow } from "@/lib/db";
import { Dashboard } from "../../app";

export default async function DashboardPage() {
  const user = await ownerPage();

  // "last 7 days" is anchored on the server so render stays pure and hydration matches.
  // 8 days covers the 7-day windows plus the day boundary.
  const now = requestNow();
  const [items, recent, cats] = await Promise.all([
    getItems(), getRecentMoves(now - 8 * 864e5), getCategories(),
  ]);

  return <Dashboard items={items} moves={recent} now={now} user={user} cats={cats} />;
}
