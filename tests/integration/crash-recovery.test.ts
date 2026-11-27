import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { handleWaitpointPost } from "@/app/api/waitpoints/[id]/route";
import type { VideoClone } from "@/lib/content-workflows/video-clone";
import {
  commitVideoCloneEdit,
  requestVideoCloneStitch,
  startVideoCloneRender,
} from "@/lib/content-workflows/video-clone-store";
import { closeDb, db, WORKSPACE_ID } from "@/lib/db";
import {
  backgroundJobTable,
  contentTemplateTable,
  jobWaitpointTable,
  renderAttemptTable,
} from "@/lib/db/schema";
import { setWorkerIdForTests, stopJobReconciler } from "@/lib/jobs";
import { resetPreflightCacheForTests } from "@/lib/preflight";
import {
  reconcileInFlightWork,
  reconcileRenderAttempt,
} from "@/lib/render-reconciler";
import { getObject, putObject, resetS3ClientsForTests } from "@/lib/storage";
import { appRouter } from "@/trpc/routers/app";

const CANARY_KEY = "sk-canary-leak-test-0123456789";

type MockMode =
  | "normal_pending"
  | "destroy_socket_on_submit"
  | "http_400_echo_canary"
  | "preflight_401_echo_canary";

type MockState = {
  mode: MockMode;
  taskState: "generating" | "success" | "fail";
  submitCount: number;
  pollCount: number;
  lastTaskId: string | null;
  lastCallbackUrl: string | null;
  echoCanaryOnPreflight: boolean;
};

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toWebRequest(
  req: IncomingMessage,
  baseUrl: string,
  rawBody: string,
): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) {
      headers.set(k, v.join(", "));
    } else if (v !== undefined) {
      headers.set(k, v);
    }
  }
  return new Request(`${baseUrl}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : rawBody,
  });
}

async function writeWebResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(await response.text());
}

async function waitUntil<T>(
  check: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

function buildSeedPlan(sourceStorageUrl: string): VideoClone {
  return {
    sourceUrl: "https://example.test/source.mp4",
    sourceVideoUrl: sourceStorageUrl,
    durationSeconds: 1,
    vibe: {
      format: "talking head",
      summary: "Short studio demo",
      hook: "Quick wave",
      visualStyle: "handheld vertical video",
      setting: "indoor studio",
      pacing: "fast",
      audio: "ambient",
      onScreenText: "",
      characters: [
        {
          id: "creator",
          role: "presenter",
          description: "Presenter in casual jacket",
          reference: "creator",
        },
      ],
      product: { present: false, description: "" },
      transcript: [],
    },
    scenes: [{ id: "s1", location: "studio", cast: "creator" }],
    takes: [
      {
        index: 1,
        seconds: 1,
        videoUrl: sourceStorageUrl,
        parts: [
          {
            shot: 1,
            sceneId: "s1",
            srcStart: 0,
            srcEnd: 1,
            takeStart: 0,
            takeEnd: 1,
          },
        ],
        analysis: {
          description: "Presenter smiles in studio",
          shotType: "medium",
          camera: "static vertical lens",
          action: "Presenter waves briefly at camera",
          charactersInShot: ["creator"],
          needsCreatorReference: false,
          needsProductReference: false,
          dialogue: [],
          onScreenText: "",
          difficulty: "easy",
          difficultyReason: "",
          notes: "",
          prompt: "A presenter smiles and waves at the camera in a studio.",
        },
        model: "seedance-2.5",
      },
    ],
    verdict: "clone",
  };
}

describe("Postgres + SeaweedFS + Mock HTTP Server Crash Recovery & Fault Injection", () => {
  const dbUrl =
    process.env.DATABASE_URL ?? "postgresql://clone:clone@127.0.0.1:5439/clone";
  const s3Endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:8339";

  let server: Server;
  let baseUrl = "";
  let tempDir = "";
  let sampleMp4: Uint8Array;
  const createdTemplateIds: string[] = [];
  const createdOrgIds = new Set<string>([WORKSPACE_ID]);

  const mockState: MockState = {
    mode: "normal_pending",
    taskState: "generating",
    submitCount: 0,
    pollCount: 0,
    lastTaskId: null,
    lastCallbackUrl: null,
    echoCanaryOnPreflight: false,
  };

  const resetMockState = () => {
    mockState.mode = "normal_pending";
    mockState.taskState = "generating";
    mockState.submitCount = 0;
    mockState.pollCount = 0;
    mockState.lastTaskId = null;
    mockState.lastCallbackUrl = null;
    mockState.echoCanaryOnPreflight = false;
  };

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "advnt-int-"));
    const samplePath = join(tempDir, "sample.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=160x284:d=1",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        samplePath,
      ],
      { stdio: "inherit" },
    );
    sampleMp4 = new Uint8Array(await readFile(samplePath));

    server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? "/", baseUrl || "http://127.0.0.1");

      if (
        req.method === "GET" &&
        reqUrl.pathname === "/api/waitpoints/health"
      ) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (
        req.method === "POST" &&
        reqUrl.pathname.startsWith("/api/waitpoints/")
      ) {
        const id = reqUrl.pathname.slice("/api/waitpoints/".length);
        const body = await readRequestBody(req);
        const webReq = toWebRequest(req, baseUrl, body);
        const webRes = await handleWaitpointPost(webReq, id);
        await writeWebResponse(res, webRes);
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/api/v1/chat/credit") {
        if (
          mockState.echoCanaryOnPreflight ||
          mockState.mode === "preflight_401_echo_canary"
        ) {
          res.statusCode = 401;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              code: 401,
              msg: `Invalid API token: ${CANARY_KEY}`,
            }),
          );
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ code: 200, msg: "success", data: 100 }));
        return;
      }

      if (
        req.method === "POST" &&
        reqUrl.pathname === "/api/v1/jobs/createTask"
      ) {
        const raw = await readRequestBody(req);
        const body = JSON.parse(raw) as { callBackUrl?: string };
        mockState.submitCount += 1;
        mockState.lastCallbackUrl = body.callBackUrl ?? null;

        if (mockState.mode === "destroy_socket_on_submit") {
          req.socket.destroy();
          return;
        }
        if (mockState.mode === "http_400_echo_canary") {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              code: 400,
              msg: `Validation error forwarding Bearer ${CANARY_KEY} to backend`,
            }),
          );
          return;
        }

        const taskId = `kie-int-${crypto.randomUUID()}`;
        mockState.lastTaskId = taskId;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ code: 200, msg: "success", data: { taskId } }),
        );
        return;
      }

      if (
        req.method === "GET" &&
        reqUrl.pathname === "/api/v1/jobs/recordInfo"
      ) {
        mockState.pollCount += 1;
        const taskId =
          reqUrl.searchParams.get("taskId") ?? mockState.lastTaskId;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        if (mockState.taskState === "success") {
          res.end(
            JSON.stringify({
              code: 200,
              msg: "success",
              data: {
                taskId,
                state: "success",
                resultJson: JSON.stringify({
                  resultUrls: [`${baseUrl}/artifacts/${taskId}.mp4`],
                }),
              },
            }),
          );
          return;
        }
        if (mockState.taskState === "fail") {
          res.end(
            JSON.stringify({
              code: 200,
              msg: "success",
              data: {
                taskId,
                state: "fail",
                failCode: "500",
                failMsg: "Mock render failed",
              },
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            code: 200,
            msg: "success",
            data: { taskId, state: "generating" },
          }),
        );
        return;
      }

      if (req.method === "GET" && reqUrl.pathname.startsWith("/artifacts/")) {
        res.statusCode = 200;
        res.setHeader("content-type", "video/mp4");
        res.end(sampleMp4);
        return;
      }

      res.statusCode = 404;
      res.end("Not found");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    process.env.DATABASE_URL = dbUrl;
    process.env.S3_ENDPOINT = s3Endpoint;
    process.env.S3_PUBLIC_ENDPOINT = s3Endpoint;
    process.env.S3_ACCESS_KEY_ID = "clone";
    process.env.S3_SECRET_ACCESS_KEY = "clone-secret";
    process.env.S3_BUCKET = "clone-media";
    process.env.SITE_URL = baseUrl;
    process.env.VIDEO_PROVIDER = "kie";
    process.env.KIE_BASE_URL = baseUrl;
    process.env.KIE_API_KEY = CANARY_KEY;
    process.env.UNSAFE_ALLOW_PRIVATE_PROVIDER_HOSTS = `127.0.0.1:${addr.port}`;
    process.env.PREFLIGHT_ALLOW_LOCAL_URLS = "true";

    resetS3ClientsForTests();
    resetPreflightCacheForTests();
  });

  afterEach(async () => {
    stopJobReconciler();
    // Ensure background jobs spawned inside the test process settle before closing/moving on.
    if (createdTemplateIds.length > 0) {
      await waitUntil(async () => {
        const live = await db
          .select({ id: backgroundJobTable.id })
          .from(backgroundJobTable)
          .where(
            and(
              inArray(backgroundJobTable.templateId, createdTemplateIds),
              inArray(backgroundJobTable.status, ["running", "waiting"]),
            ),
          );
        return live.length === 0;
      }, "all background jobs settled in afterEach").catch(() => undefined);
    }
    resetMockState();
    resetPreflightCacheForTests();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    stopJobReconciler();
    if (createdTemplateIds.length > 0) {
      await db
        .delete(backgroundJobTable)
        .where(inArray(backgroundJobTable.templateId, createdTemplateIds))
        .catch(() => undefined);
      await db
        .delete(contentTemplateTable)
        .where(inArray(contentTemplateTable.id, createdTemplateIds))
        .catch(() => undefined);
    }
    await closeDb().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function seedTemplate(organizationId = WORKSPACE_ID): Promise<string> {
    createdOrgIds.add(organizationId);
    const key = `video-clones/${organizationId}/seed-source-${crypto.randomUUID()}.mp4`;
    await putObject(key, "clone-media", sampleMp4, "video/mp4");
    const sourceStorageUrl = `/storage/clone-media/${key}`;
    const [inserted] = await db
      .insert(contentTemplateTable)
      .values({
        organizationId,
        name: `Integration Plan ${crypto.randomUUID().slice(0, 8)}`,
        format: "video",
        status: "ready",
        structure: { video: buildSeedPlan(sourceStorageUrl) },
      })
      .returning({ id: contentTemplateTable.id });
    if (!inserted) throw new Error("Failed to seed template");
    createdTemplateIds.push(inserted.id);
    return inserted.id;
  }

  async function spawnWorkerAndWaitForSubmit(options: {
    workerId: string;
    organizationId: string;
    templateId: string;
  }): Promise<{ child: ChildProcess; attemptId: string }> {
    const child = spawn(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "./scripts/register-paths.mjs",
        "tests/integration/worker-runner.ts",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKER_ID: options.workerId,
          TEST_ORG_ID: options.organizationId,
          TEST_TEMPLATE_ID: options.templateId,
          TEST_TAKE_INDEX: "1",
          TEST_SKIP_PREFLIGHT: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const attemptId = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `Worker timed out before SUBMITTED. stdout=${stdout} stderr=${stderr}`,
          ),
        );
      }, 30_000);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        const match = /^SUBMITTED:([^:\s]+):/mu.exec(stdout);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (!/^SUBMITTED:/mu.test(stdout)) {
          reject(
            new Error(
              `Worker exited unexpectedly (${code}). stdout=${stdout} stderr=${stderr}`,
            ),
          );
        }
      });
    });

    return { child, attemptId };
  }

  async function killWorkerHard(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  }

  it("1. Recovers mid-render SIGKILL crash + dropped webhook via polling without double submit", async () => {
    const orgId = crypto.randomUUID();
    const templateId = await seedTemplate(orgId);
    const { child, attemptId } = await spawnWorkerAndWaitForSubmit({
      workerId: `worker-a-${crypto.randomUUID().slice(0, 8)}`,
      organizationId: orgId,
      templateId,
    });
    expect(mockState.submitCount).toBe(1);

    await killWorkerHard(child);
    // Simulate completed provider render with dropped webhook.
    mockState.taskState = "success";

    setWorkerIdForTests(`worker-b-${crypto.randomUUID().slice(0, 8)}`);
    await reconcileInFlightWork({ staleWorkerMs: 0, forcePoll: true });

    const settled = await waitUntil(async () => {
      const tpl = await db.query.contentTemplateTable.findFirst({
        where: eq(contentTemplateTable.id, templateId),
      });
      const attempt = await db.query.renderAttemptTable.findFirst({
        where: eq(renderAttemptTable.id, attemptId),
      });
      const stitchDone = tpl?.structure.video?.edit?.status === "done";
      const takeDone =
        tpl?.structure.video?.takes[0]?.generation?.status === "done";
      if (stitchDone && takeDone && attempt?.status === "done") {
        return { tpl, attempt };
      }
      return null;
    }, "recovered take & edit stitch");

    expect(mockState.submitCount).toBe(1);
    const renderUrl =
      settled.tpl.structure.video?.takes[0]?.generation?.videoUrl;
    expect(renderUrl).toMatch(/^\/storage\/clone-media\//u);
    const s3Key = renderUrl!.replace(/^\/storage\/clone-media\//u, "");
    const storedBytes = await getObject(s3Key, "clone-media");
    expect(storedBytes.byteLength).toBe(sampleMp4.byteLength);
    expect(settled.tpl.structure.video?.edit?.videoUrl).toMatch(
      /^\/storage\/clone-media\//u,
    );

    const activeAttempts = await db
      .select({ id: renderAttemptTable.id })
      .from(renderAttemptTable)
      .where(
        and(
          eq(renderAttemptTable.templateId, templateId),
          inArray(renderAttemptTable.status, [
            "claiming",
            "submitting",
            "submitted",
            "ambiguous",
            "downloading",
          ]),
        ),
      );
    expect(activeAttempts).toHaveLength(0);
  });

  it("2. Rejects forged & replayed webhooks after restart while accepting the authentic single-use webhook", async () => {
    const orgId = crypto.randomUUID();
    const templateId = await seedTemplate(orgId);
    const { child, attemptId } = await spawnWorkerAndWaitForSubmit({
      workerId: `worker-a-${crypto.randomUUID().slice(0, 8)}`,
      organizationId: orgId,
      templateId,
    });
    expect(mockState.submitCount).toBe(1);
    const callbackUrl = mockState.lastCallbackUrl!;
    const taskId = mockState.lastTaskId!;
    await killWorkerHard(child);

    // Worker B reconciles while job is still pending upstream.
    setWorkerIdForTests(`worker-b-${crypto.randomUUID().slice(0, 8)}`);
    await reconcileInFlightWork({ staleWorkerMs: 0, forcePoll: true });

    const badTokenUrl = new URL(callbackUrl);
    badTokenUrl.searchParams.set("token", "forged-token-value");
    const validPayload = {
      data: {
        taskId,
        state: "success",
        resultJson: JSON.stringify({
          resultUrls: [`${baseUrl}/artifacts/${taskId}.mp4`],
        }),
      },
    };

    const forgedRes = await fetch(badTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    expect(forgedRes.status).toBe(401);

    const mismatchedRes = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: { ...validPayload.data, taskId: "wrong-task-id" },
      }),
    });
    expect(mismatchedRes.status).toBe(400);

    const validRes = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    expect(validRes.status).toBe(200);

    const replayRes = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    expect(replayRes.status).toBe(409);

    const settled = await waitUntil(async () => {
      const tpl = await db.query.contentTemplateTable.findFirst({
        where: eq(contentTemplateTable.id, templateId),
      });
      const attempt = await db.query.renderAttemptTable.findFirst({
        where: eq(renderAttemptTable.id, attemptId),
      });
      if (
        attempt?.status === "done" &&
        tpl?.structure.video?.takes[0]?.generation?.status === "done" &&
        tpl.structure.video?.edit?.status === "done"
      ) {
        return tpl;
      }
      return null;
    }, "webhook-delivered render and stitch");

    expect(mockState.submitCount).toBe(1);
    expect(settled.structure.video?.takes[0]?.generation?.status).toBe("done");
  });

  it("3a. Holds ambiguous submit without retrying and rescues it when authentic webhook arrives", async () => {
    const orgId = crypto.randomUUID();
    const templateId = await seedTemplate(orgId);
    setWorkerIdForTests(`worker-b-${crypto.randomUUID().slice(0, 8)}`);
    mockState.mode = "destroy_socket_on_submit";

    const started = await startVideoCloneRender(
      {
        organizationId: orgId,
        templateId,
        takeIndexes: [1],
        cast: {},
        changes: "",
        productFolder: null,
        frames: [],
      },
      { skipPreflight: true },
    );
    expect("runId" in started && started.runId).toBeTruthy();
    if (!("runId" in started)) throw new Error("Expected runId");

    const ambiguousAttempt = await waitUntil(async () => {
      return db.query.renderAttemptTable.findFirst({
        where: and(
          eq(renderAttemptTable.jobId, started.runId),
          eq(renderAttemptTable.status, "ambiguous"),
        ),
      });
    }, "attempt entering ambiguous status");

    // Wait briefly to prove submit is NOT automatically retried.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mockState.submitCount).toBe(1);
    expect(ambiguousAttempt.externalJobId).toBeNull();

    const callbackUrl = mockState.lastCallbackUrl!;
    const rescueRes = await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: {
          taskId: "kie-rescued-after-socket-drop",
          state: "success",
          resultJson: JSON.stringify({
            resultUrls: [`${baseUrl}/artifacts/rescued.mp4`],
          }),
        },
      }),
    });
    expect(rescueRes.status).toBe(200);

    const settled = await waitUntil(async () => {
      const tpl = await db.query.contentTemplateTable.findFirst({
        where: eq(contentTemplateTable.id, templateId),
      });
      const attempt = await db.query.renderAttemptTable.findFirst({
        where: eq(renderAttemptTable.id, ambiguousAttempt.id),
      });
      if (
        attempt?.status === "done" &&
        tpl?.structure.video?.takes[0]?.generation?.status === "done" &&
        tpl.structure.video?.edit?.status === "done"
      ) {
        return tpl;
      }
      return null;
    }, "rescued ambiguous render");

    expect(mockState.submitCount).toBe(1);
    expect(settled.structure.video?.takes[0]?.generation?.status).toBe("done");
  });

  it("3b. Clears expired ambiguous submits cleanly with 0 stuck generating rows", async () => {
    const orgId = crypto.randomUUID();
    const templateId = await seedTemplate(orgId);
    setWorkerIdForTests(`worker-b-${crypto.randomUUID().slice(0, 8)}`);
    mockState.mode = "destroy_socket_on_submit";

    const started = await startVideoCloneRender(
      {
        organizationId: orgId,
        templateId,
        takeIndexes: [1],
        cast: {},
        changes: "",
        productFolder: null,
        frames: [],
      },
      { skipPreflight: true },
    );
    if (!("runId" in started)) throw new Error("Expected runId");

    const ambiguousAttempt = await waitUntil(async () => {
      return db.query.renderAttemptTable.findFirst({
        where: and(
          eq(renderAttemptTable.jobId, started.runId),
          eq(renderAttemptTable.status, "ambiguous"),
        ),
      });
    }, "ambiguous attempt before expiry");

    await db
      .update(renderAttemptTable)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(renderAttemptTable.id, ambiguousAttempt.id));

    await reconcileRenderAttempt(ambiguousAttempt.id);

    const failedState = await waitUntil(async () => {
      const attempt = await db.query.renderAttemptTable.findFirst({
        where: eq(renderAttemptTable.id, ambiguousAttempt.id),
      });
      const tpl = await db.query.contentTemplateTable.findFirst({
        where: eq(contentTemplateTable.id, templateId),
      });
      if (
        attempt?.status === "failed" &&
        tpl?.structure.video?.takes[0]?.generation?.status === "failed"
      ) {
        return { attempt, tpl };
      }
      return null;
    }, "expired ambiguous attempt failure");

    expect(mockState.submitCount).toBe(1);
    expect(failedState.attempt.errorKind).toBe("ambiguous_submit");
    expect(failedState.tpl.structure.video?.takes[0]?.generation?.status).toBe(
      "failed",
    );
  });

  it("4. Serializes concurrent renders and enforces monotonic stitch edit revisions", async () => {
    const orgId = crypto.randomUUID();
    const templateId = await seedTemplate(orgId);
    setWorkerIdForTests(`worker-b-${crypto.randomUUID().slice(0, 8)}`);
    mockState.taskState = "success";

    const [resA, resB] = await Promise.all([
      startVideoCloneRender(
        {
          organizationId: orgId,
          templateId,
          takeIndexes: [1],
          cast: {},
          changes: "",
          productFolder: null,
          frames: [],
        },
        { skipPreflight: true },
      ),
      startVideoCloneRender(
        {
          organizationId: orgId,
          templateId,
          takeIndexes: [1],
          cast: {},
          changes: "",
          productFolder: null,
          frames: [],
        },
        { skipPreflight: true },
      ),
    ]);

    const successes = [resA, resB].filter((r) => "runId" in r);
    const failures = [resA, resB].filter((r) => "error" in r);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    await waitUntil(async () => {
      const tpl = await db.query.contentTemplateTable.findFirst({
        where: eq(contentTemplateTable.id, templateId),
      });
      return tpl?.structure.video?.edit?.status === "done";
    }, "concurrent render completion");
    expect(mockState.submitCount).toBe(1);

    // Concurrent stitch requests bump revision monotonically and allow stale commit rejection.
    const [rev1, rev2] = await Promise.all([
      requestVideoCloneStitch(orgId, templateId),
      requestVideoCloneStitch(orgId, templateId),
    ]);
    expect(Math.max(rev1, rev2)).toBeGreaterThan(Math.min(rev1, rev2));

    const olderRev = Math.min(rev1, rev2);
    const staleCommit = await commitVideoCloneEdit(templateId, olderRev, {
      status: "done",
      rendered: [],
      startedAt: new Date().toISOString(),
    });
    expect(staleCommit.committed).toBe(false);
    expect(staleCommit.currentRevision).toBe(Math.max(rev1, rev2));

    await waitUntil(async () => {
      const liveStitches = await db
        .select({ id: backgroundJobTable.id })
        .from(backgroundJobTable)
        .where(
          and(
            eq(backgroundJobTable.templateId, templateId),
            eq(backgroundJobTable.taskId, "stitch-video-clone"),
            inArray(backgroundJobTable.status, ["running", "queued"]),
          ),
        );
      return liveStitches.length === 0;
    }, "coalesced stitch draining");
  });

  it("5. Redacts API keys from console logs, Postgres error columns, templates, and tRPC responses", async () => {
    const templateId = await seedTemplate(WORKSPACE_ID);
    setWorkerIdForTests(`worker-b-${crypto.randomUUID().slice(0, 8)}`);

    const loggedChunks: string[] = [];
    const origLog = console.log;
    const origInfo = console.info;
    const origWarn = console.warn;
    const origError = console.error;
    vi.spyOn(console, "log").mockImplementation((...args) => {
      loggedChunks.push(
        args.map((a) => JSON.stringify(a) ?? String(a)).join(" "),
      );
      origLog(...args);
    });
    vi.spyOn(console, "info").mockImplementation((...args) => {
      loggedChunks.push(
        args.map((a) => JSON.stringify(a) ?? String(a)).join(" "),
      );
      origInfo(...args);
    });
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      loggedChunks.push(
        args.map((a) => JSON.stringify(a) ?? String(a)).join(" "),
      );
      origWarn(...args);
    });
    vi.spyOn(console, "error").mockImplementation((...args) => {
      loggedChunks.push(
        args.map((a) => JSON.stringify(a) ?? String(a)).join(" "),
      );
      origError(...args);
    });

    mockState.mode = "http_400_echo_canary";
    mockState.echoCanaryOnPreflight = true;

    const caller = appRouter.createCaller({});
    const preflightReport = await caller.videoClone.preflight();
    expect(preflightReport.ok).toBe(false);
    expect(JSON.stringify(preflightReport)).not.toContain(CANARY_KEY);

    let thrownTrpcMessage = "";
    try {
      await caller.videoClone.generate({
        templateId,
        takeIndexes: [1],
        cast: {},
        changes: "",
        productFolder: null,
        frames: [],
      });
    } catch (error) {
      thrownTrpcMessage =
        error instanceof Error ? error.message : String(error);
    }
    expect(thrownTrpcMessage).toBeTruthy();
    expect(thrownTrpcMessage).not.toContain(CANARY_KEY);

    // Disable preflight echo so startVideoCloneRender reaches submit and hits echoed HTTP 400.
    mockState.echoCanaryOnPreflight = false;
    const generated = await caller.videoClone.generate({
      templateId,
      takeIndexes: [1],
      cast: {},
      changes: "",
      productFolder: null,
      frames: [],
    });
    expect(generated.runId).toBeTruthy();

    await waitUntil(async () => {
      const tpl = await db.query.contentTemplateTable.findFirst({
        where: eq(contentTemplateTable.id, templateId),
      });
      return tpl?.structure.video?.takes[0]?.generation?.status === "failed";
    }, "failed render error saved");

    const planRes = await caller.videoClone.get({ id: templateId });
    expect(planRes.takes[0]?.generation?.error).toContain("[REDACTED]");
    const runsRes = await caller.videoClone.runs();
    expect(JSON.stringify(planRes)).not.toContain(CANARY_KEY);
    expect(JSON.stringify(runsRes)).not.toContain(CANARY_KEY);
    expect(loggedChunks.join("\n")).not.toContain(CANARY_KEY);

    const dbTemplates = await db.select().from(contentTemplateTable);
    const dbJobs = await db.select().from(backgroundJobTable);
    const dbAttempts = await db.select().from(renderAttemptTable);
    const dbWaitpoints = await db.select().from(jobWaitpointTable);

    expect(JSON.stringify(dbTemplates)).not.toContain(CANARY_KEY);
    expect(JSON.stringify(dbJobs)).not.toContain(CANARY_KEY);
    expect(JSON.stringify(dbAttempts)).not.toContain(CANARY_KEY);
    expect(JSON.stringify(dbWaitpoints)).not.toContain(CANARY_KEY);

    // Double check DB-level text search across those tables too.
    const leakedRows = await db.execute(sql`
      SELECT count(*)::int AS cnt FROM render_attempts
      WHERE error LIKE ${`%${CANARY_KEY}%`}
    `);
    expect(leakedRows.rows[0]?.cnt).toBe(0);
  });
});
