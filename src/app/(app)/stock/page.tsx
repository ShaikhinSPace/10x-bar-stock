import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getItems, getRecentMoves, requestNow } from "@/lib/db";
import { Stock } from "../../app";

export default async function StockPage() {
  // Layout and page render in parallel, so the layout's redirect does not stop this
  // from running on a signed-out request — it has to guard itself.
  const user = await getSession();
  if (!user) redirect("/login");

  const now = requestNow();
  const [items, recent] = await Promise.all([getItems(), getRecentMoves(now - 8 * 864e5)]);

  return <Stock items={items} moves={recent} now={now} user={user} />;
}
