import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { homeFor } from "./(app)/guard";

const TABS = ["dashboard", "stock", "delivery", "activity", "manage"] as const;

// Pure forwarding. "/" lands wherever the signed-in user belongs — the dashboard for
// the owner, the run screen for a barback — and "/?tab=stock" still works for links
// saved before the tabs became routes. A barback asking for one of those old tabs is
// sent home instead; the page guards would only bounce them there anyway.
export default async function Page({ searchParams }: PageProps<"/">) {
  const user = await getSession();
  if (!user) redirect("/login");

  const { tab } = await searchParams;
  const asked = TABS.find((t) => t === tab);
  redirect(asked && user.role === "owner" ? `/${asked}` : homeFor(user));
}
