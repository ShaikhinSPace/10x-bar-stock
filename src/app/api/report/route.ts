import { getSession } from "@/lib/auth";
import { buildPdf } from "@/lib/pdf";
import { PERIODS, buildReport, type Period } from "@/lib/report";

// Reachable by URL, so it re-checks the session itself - the button on the
// page is not what gates this.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getSession();
  if (!user) return new Response("Not signed in", { status: 401 });
  if (user.role !== "owner") return new Response("Owners only", { status: 403 });

  const raw = new URL(request.url).searchParams.get("period") ?? "week";
  const period: Period = (PERIODS as readonly string[]).includes(raw) ? (raw as Period) : "week";

  const now = new Date();
  const body = buildPdf(await buildReport(period, user.name, now));

  const stamp = now.toISOString().slice(0, 10);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="10x-bar-report-${period}-${stamp}.pdf"`,
      "Content-Length": String(body.length),
      "Cache-Control": "no-store",
    },
  });
}
