import { getDeliveries, getItems } from "@/lib/db";
import { Delivery } from "../../app";

export default async function DeliveryPage() {
  const [items, deliveries] = await Promise.all([getItems(), getDeliveries()]);

  return <Delivery items={items} deliveries={deliveries} />;
}
