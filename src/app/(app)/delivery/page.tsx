import { ownerPage } from "../guard";
import { getCategories, getDeliveries, getItems } from "@/lib/db";
import { Delivery } from "../../app";

export default async function DeliveryPage() {
  const user = await ownerPage();
  const [items, deliveries, cats] = await Promise.all([getItems(), getDeliveries(), getCategories()]);

  return <Delivery items={items} deliveries={deliveries} user={user} cats={cats} />;
}
