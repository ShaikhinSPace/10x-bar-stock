import { getSession } from "@/lib/auth";
import { getMoves, requestNow } from "@/lib/db";
import { Activity } from "../../app";

export default async function ActivityPage() {
  const user = (await getSession())!; // the layout already redirected if absent

  // The only route that pulls the full log — bounded by count, not by time.
  const [moves, now] = [await getMoves(), requestNow()];

  return <Activity moves={moves} user={user} now={now} />;
}
