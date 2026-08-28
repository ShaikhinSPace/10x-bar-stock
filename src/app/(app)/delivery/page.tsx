import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDeliveries, getItems } from "@/lib/db";
import { Delivery } from "../../app";

export default async function DeliveryPage() {
  // Layout and page render in parallel, so the layout's redirect does not stop this
  // from running on a signed-out request — it has to guard itself.
  const user = await getSession();
  if (!user) redirect("/login");
  const [items, deliveries] = await Promise.all([getItems(), getDeliveries()]);

  return <Delivery items={items} deliveries={deliveries} user={user} />;
}
