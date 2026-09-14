import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import type { SessionUser } from "@/lib/model";

/** Where a signed-in user belongs when they have not asked for anywhere in particular. */
export const homeFor = (user: SessionUser) =>
  user.role === "owner" ? "/dashboard" : "/stock/run";

/**
 * Guard for every page except /stock/run.
 *
 * The barback's whole app is the run screen — no dashboard, no stock list, no
 * deliveries, no activity, no manage. Anything else bounces them straight back,
 * so a typed URL or a stale bookmark cannot land them somewhere they should not be.
 *
 * Layout and page render in parallel, so this has to live on the page itself; the
 * layout's own session check does not stop a page body from running.
 */
export async function ownerPage(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "owner") redirect("/stock/run");
  return user;
}
