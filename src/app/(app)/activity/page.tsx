import { ownerPage } from "../guard";
import { getItems, getMoves, requestNow } from "@/lib/db";
import { Activity } from "../../app";

export default async function ActivityPage() {
  const user = await ownerPage();

  // The only route that pulls the full log — bounded by count, not by time.
  // Items come along so the owner can add a missed give/receive for a past day.
  const [moves, items] = await Promise.all([getMoves(), getItems()]);
  const now = requestNow();

  return <Activity moves={moves} items={items} user={user} now={now} />;
}
