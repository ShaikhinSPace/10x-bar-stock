import { getItems, sql } from "@/lib/db";
import type { Staff } from "@/lib/model";
import { ownerPage } from "../guard";
import { Manage } from "../../app";

export default async function ManagePage() {
  const user = await ownerPage();

  const [items, staff] = await Promise.all([
    getItems(),
    sql`select id, username, name, role, active from users order by name`,
  ]);

  return <Manage items={items} staff={staff as Staff[]} user={user} />;
}
