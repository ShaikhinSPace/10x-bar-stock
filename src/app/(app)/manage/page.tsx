import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getItems, sql } from "@/lib/db";
import type { Staff } from "@/lib/model";
import { Manage } from "../../app";

export default async function ManagePage() {
  const user = (await getSession())!; // the layout already redirected if absent
  // Owner-only, and now enforced by the URL rather than by hiding a tab.
  if (user.role !== "owner") redirect("/dashboard");

  const [items, staff] = await Promise.all([
    getItems(),
    sql`select id, username, name, role, active from users order by name`,
  ]);

  return <Manage items={items} staff={staff as Staff[]} user={user} />;
}
