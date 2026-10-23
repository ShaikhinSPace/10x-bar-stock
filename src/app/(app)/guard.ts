import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import type { SessionUser } from "@/lib/model";

/** Where a signed-in user belongs when they have not asked for anywhere in particular. */
export const homeFor = (user: SessionUser) =>
  user.role === "owner" ? "/dashboard" : "/stock/run";

/**
 * Guard for owner-only pages (dashboard, delivery, activity, manage).
 *
 * Staff hit these only by typing a URL or following a stale bookmark; they
 * bounce back to /stock/run.
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

/** Guard for pages open to both roles (Stock sheet). Signed in = allowed. */
export async function signedInPage(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) redirect("/login");
  return user;
}
