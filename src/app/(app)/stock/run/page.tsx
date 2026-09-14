import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getItems, getRecentMoves, requestNow } from "@/lib/db";
import { RunMode } from "../../../app";

// The one page a barback can reach, and a normal page for the owner. Deliberately
// NOT behind ownerPage() — this is where everyone else gets sent.
export default async function RunPage() {
  const user = await getSession();
  if (!user) redirect("/login");

  // A day is plenty for "what did I just run", and it keeps the undo rule sound:
  // anything logged after a move inside the window is inside the window too.
  const [items, recent] = await Promise.all([
    getItems(),
    getRecentMoves(requestNow() - 864e5),
  ]);

  return <RunMode items={items} moves={recent} user={user} />;
}
