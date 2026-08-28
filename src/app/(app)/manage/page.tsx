import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getItems, sql } from "@/lib/db";
import type { Staff } from "@/lib/model";
import { Manage } from "../../app";

export default async function ManagePage() {
  // Layout and page render in parallel, so the layout's redirect does not stop this
  // from running on a signed-out request — it has to guard itself.
  const user = await getSession();
  if (!user) redirect("/login");
  // Owner-only, and now enforced by the URL rather than by hiding a tab.
  if (user.role !== "owner") redirect("/dashboard");

  const [items, staff] = await Promise.all([
    getItems(),
    sql`select id, username, name, role, active from users order by name`,
  ]);

  return <Manage items={items} staff={staff as Staff[]} user={user} />;
}
