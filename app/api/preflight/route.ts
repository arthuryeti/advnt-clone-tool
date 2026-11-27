import { runPreflight } from "@/lib/preflight";

export async function GET() {
  const report = await runPreflight({ scope: "all", force: true });
  return Response.json(report, { status: report.ok ? 200 : 503 });
}
