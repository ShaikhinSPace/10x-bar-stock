import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getMoves, requestNow } from "@/lib/db";
import { Activity } from "../../app";

export default async function ActivityPage() {
  // Layout and page render in parallel, so the layout's redirect does not stop this
  // from running on a signed-out request — it has to guard itself.
  const user = await getSession();
  if (!user) redirect("/login");

  // The only route that pulls the full log — bounded by count, not by time.
  const [moves, now] = [await getMoves(), requestNow()];

  return <Activity moves={moves} user={user} now={now} />;
}
