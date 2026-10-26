import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSettings, getWastageReasons } from "@/lib/db";
import { Shell } from "./shell";

// One session check for every tab. Pages below re-check only what they need
// on top of this (Manage wants owner), and every Server Action still checks
// itself, since an action is reachable by direct POST.
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const [user, settings, wastageReasons] = await Promise.all([getSession(), getSettings(), getWastageReasons()]);
  if (!user) redirect("/login");

  return <Shell user={user} settings={settings} wastageReasons={wastageReasons}>{children}</Shell>;
}
