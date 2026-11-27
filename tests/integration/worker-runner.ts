import { setInterval as setKeepaliveInterval } from "node:timers";
import { and, eq } from "drizzle-orm";
import { startVideoCloneRender } from "@/lib/content-workflows/video-clone-store";
import { closeDb, db } from "@/lib/db";
import { renderAttemptTable } from "@/lib/db/schema";
import { setWorkerIdForTests } from "@/lib/jobs";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const workerId = process.env.WORKER_ID;
  const organizationId = process.env.TEST_ORG_ID;
  const templateId = process.env.TEST_TEMPLATE_ID;
  const takeIndex = Number(process.env.TEST_TAKE_INDEX ?? "1");
  const skipPreflight = process.env.TEST_SKIP_PREFLIGHT === "true";

  if (!workerId || !organizationId || !templateId) {
    console.error(
      "Missing required WORKER_ID, TEST_ORG_ID, or TEST_TEMPLATE_ID env.",
    );
    process.exit(1);
  }

  setWorkerIdForTests(workerId);

  const started = await startVideoCloneRender(
    {
      organizationId,
      templateId,
      takeIndexes: [takeIndex],
      cast: {},
      changes: "",
      productFolder: null,
      frames: [],
    },
    { skipPreflight },
  );

  if ("error" in started) {
    console.error(`START_ERROR:${started.error}`);
    await closeDb().catch(() => undefined);
    process.exit(2);
  }

  console.log(`JOB:${started.runId}`);

  let emitted = false;
  for (let i = 0; i < 400; i++) {
    const attempt = await db.query.renderAttemptTable.findFirst({
      where: and(
        eq(renderAttemptTable.jobId, started.runId),
        eq(renderAttemptTable.takeIndex, takeIndex),
      ),
      columns: { id: true, status: true, externalJobId: true },
    });
    if (
      attempt &&
      (attempt.status === "submitted" ||
        attempt.status === "ambiguous" ||
        attempt.status === "done" ||
        attempt.status === "failed")
    ) {
      console.log(`SUBMITTED:${attempt.id}:${attempt.status}`);
      emitted = true;
      break;
    }
    await sleep(25);
  }

  if (!emitted) {
    console.error("Timed out waiting for attempt submission.");
    await closeDb().catch(() => undefined);
    process.exit(3);
  }

  // Stay alive intentionally until the parent test kills this worker with SIGKILL.
  const keepalive = setKeepaliveInterval(() => undefined, 5000);
  const shutdown = async () => {
    clearInterval(keepalive);
    await closeDb().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
