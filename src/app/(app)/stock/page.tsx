import { getSession } from "@/lib/auth";
import { getItems, getRecentMoves, requestNow } from "@/lib/db";
import { Stock } from "../../app";

export default async function StockPage() {
  const user = (await getSession())!; // the layout already redirected if absent

  const now = requestNow();
  const [items, recent] = await Promise.all([getItems(), getRecentMoves(now - 8 * 864e5)]);

  return <Stock items={items} moves={recent} now={now} user={user} />;
}
