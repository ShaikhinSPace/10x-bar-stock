import { ownerPage } from "../guard";
import { getDeliveries, getItems } from "@/lib/db";
import { Delivery } from "../../app";

export default async function DeliveryPage() {
  const user = await ownerPage();
  const [items, deliveries] = await Promise.all([getItems(), getDeliveries()]);

  return <Delivery items={items} deliveries={deliveries} user={user} />;
}
