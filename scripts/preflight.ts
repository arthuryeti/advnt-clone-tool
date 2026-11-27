import { existsSync } from "node:fs";
import { closeDb } from "@/lib/db";
import { runPreflight } from "@/lib/preflight";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

async function main() {
  const report = await runPreflight({ scope: "all", force: true });
  console.log(JSON.stringify(report, null, 2));
  await closeDb();
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (error) => {
  console.error("Preflight crashed:", error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
