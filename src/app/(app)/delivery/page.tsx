import { getSession } from "@/lib/auth";
import { getDeliveries, getItems } from "@/lib/db";
import { Delivery } from "../../app";

export default async function DeliveryPage() {
  const user = (await getSession())!; // the layout already redirected if absent
  const [items, deliveries] = await Promise.all([getItems(), getDeliveries()]);

  return <Delivery items={items} deliveries={deliveries} user={user} />;
}
