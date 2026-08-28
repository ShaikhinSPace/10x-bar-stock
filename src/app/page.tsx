import { redirect } from "next/navigation";

const TABS = ["dashboard", "stock", "delivery", "activity", "manage"] as const;

// Every tab is its own route now. This only forwards: bare "/" lands on the
// dashboard, and "/?tab=stock" keeps working for links saved before the split.
export default async function Page({ searchParams }: PageProps<"/">) {
  const { tab } = await searchParams;
  redirect(`/${TABS.find((t) => t === tab) ?? "dashboard"}`);
}
