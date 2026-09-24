import { ownerPage } from "../guard";
import { getCategories, getItems, getRecentMoves, requestNow } from "@/lib/db";
import { Stock } from "../../app";

export default async function StockPage() {
  const user = await ownerPage();

  const now = requestNow();
  const [items, recent, cats] = await Promise.all([
    getItems(), getRecentMoves(now - 8 * 864e5), getCategories(),
  ]);

  return <Stock items={items} moves={recent} now={now} user={user} cats={cats} />;
}
