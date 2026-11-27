import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Dispatcher,
  getGlobalDispatcher,
  MockAgent,
  setGlobalDispatcher,
  fetch as undiciFetch,
} from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { handleWaitpointPost } from "@/app/api/waitpoints/[id]/route";
import { ProviderError } from "@/lib/ai/errors";
import { listTextProviders } from "@/lib/ai/providers/text/registry";
import { listVideoProviders } from "@/lib/ai/providers/video/registry";
import { listVideoUnderstandingProviders } from "@/lib/ai/providers/video-understanding/registry";
import {
  hashWaitpointSecret,
  logger,
  type WaitpointRecord,
  type WaitpointStore,
} from "@/lib/jobs";
import { redactSecrets, sanitizeErrorMessage } from "@/lib/security/redact";
import {
  assertSafeRemoteUrl,
  setSsrfDnsLookupForTests,
} from "@/lib/security/ssrf";
import { downloadVideo } from "@/lib/storage/download-video";
import { createTRPCRouter, publicProcedure } from "@/trpc/init";

const PUBLIC_TEST_IP = "93.184.216.34";

function loadFixture<T = Record<string, any>>(providerId: string): T {
  const path = join(process.cwd(), "lib/ai/fixtures", `${providerId}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function createInMemoryWaitpointStore(options: {
  id: string;
  attemptId: string;
  providerId: string;
  secret: string;
  externalJobId: string | null;
  expiresAt?: Date;
}): {
  store: WaitpointStore;
  getState: () => WaitpointRecord;
} {
  const record: WaitpointRecord = {
    id: options.id,
    attemptId: options.attemptId,
    providerId: options.providerId,
    secretHash: hashWaitpointSecret(options.secret),
    status: "pending",
    payload: null,
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000),
    externalJobId: options.externalJobId,
  };
  const store: WaitpointStore = {
    async getById(id) {
      return id === record.id ? { ...record } : null;
    },
    async markExpired(id) {
      if (id === record.id && record.status === "pending") {
        record.status = "expired";
      }
    },
    async consumePending(id, payload) {
      if (
        id !== record.id ||
        record.status !== "pending" ||
        record.expiresAt.getTime() <= Date.now()
      ) {
        return false;
      }
      record.status = "completed";
      record.payload = payload;
      return true;
    },
  };
  return { store, getState: () => record };
}

let mockAgent: MockAgent;
let originalFetch: typeof fetch;
let originalDispatcher: Dispatcher;
const testFetch = undiciFetch as unknown as (
  input: RequestInfo | URL,
  init?: RequestInit & { dispatcher?: MockAgent },
) => Promise<Response>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    testFetch(input, {
      ...init,
      dispatcher: mockAgent,
    })) as typeof fetch;

  setSsrfDnsLookupForTests(async (hostname) => {
    const h = hostname.toLowerCase();
    if (h === "rebind.example.test") {
      return [{ address: "127.0.0.1", family: 4 }];
    }
    if (h === "imds-rebind.example.test") {
      return [{ address: "169.254.169.254", family: 4 }];
    }
    return [{ address: PUBLIC_TEST_IP, family: 4 }];
  });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setGlobalDispatcher(originalDispatcher);
  setSsrfDnsLookupForTests(null);
  vi.restoreAllMocks();
  await mockAgent.close();
});

describe("Shared Video Generation Provider Contract Suite", () => {
  const providers = listVideoProviders();

  it("exposes at least 3 registered video providers with unique ids and valid capabilities", () => {
    expect(providers.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(providers.map((p) => p.id));
    expect(ids.size).toBe(providers.length);
  });

  describe.each(providers.map((p) => [p.id, p] as const))(
    "video provider: %s",
    (providerId, provider) => {
      const fixture = loadFixture<Record<string, any>>(providerId);
      const baseOrigin = new URL(fixture.baseUrl).origin;
      const preflightOrigin = new URL(
        fixture.preflightBaseUrl ?? fixture.baseUrl,
      ).origin;
      const canaryKey = `sk-canary-video-${providerId}-9876543210`;

      const ctx = {
        apiKey: canaryKey,
        baseUrl: fixture.baseUrl,
        fetchFn: ((...args: Parameters<typeof fetch>) =>
          globalThis.fetch(...args)) as typeof fetch,
        retryBaseDelayMs: 1,
        sleepFn: async () => undefined,
      };

      const makeSubmitReq = (callbackUrl?: string) => ({
        model: provider.defaultModelId,
        prompt: "{{creator}} holds {{product}}.",
        seconds: 5.2,
        hasDialogue: true,
        references: {
          creator: "https://cdn.example.test/creator.jpg",
          products: ["https://cdn.example.test/product.jpg"],
        },
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        callbackUrl:
          callbackUrl ??
          "https://app.example.test/api/waitpoints/00000000-0000-4000-8000-000000000010?token=test-secret",
      });

      it("passes happy-path submit, delivery (webhook/poll), and artifact download with dialect & header verification", async () => {
        const expectedAuth = `${fixture.authHeader.prefix}${canaryKey}`;
        const submitMock = mockAgent.get(baseOrigin);
        const submitPathPrefix = fixture.submit.path;

        let capturedHeaders: Record<string, string> = {};
        let capturedBody: unknown;

        submitMock
          .intercept({
            method: fixture.submit.method,
            path: (p) => p.startsWith(submitPathPrefix),
          })
          .reply((opts) => {
            capturedHeaders = Object.fromEntries(
              Object.entries(opts.headers ?? {}).map(([k, v]) => [
                k.toLowerCase(),
                Array.isArray(v) ? v.join(",") : String(v),
              ]),
            );
            capturedBody =
              typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
            return {
              statusCode: fixture.submit.successResponse.status,
              data: fixture.submit.successResponse.body,
              responseOptions: {
                headers: { "content-type": "application/json" },
              },
            };
          });

        const submitResult = await provider.submit(ctx, makeSubmitReq());
        expect(submitResult.externalJobId).toBeTruthy();
        expect(capturedHeaders[fixture.authHeader.name.toLowerCase()]).toBe(
          expectedAuth,
        );
        if (provider.capabilities.supportsIdempotencyKey) {
          expect(capturedHeaders["idempotency-key"]).toBe(
            "11111111-1111-4111-8111-111111111111",
          );
        }
        // Dialect verification against model capability.
        const defaultSpec = provider.models.find(
          (m) => m.id === provider.defaultModelId,
        )!;
        expect(submitResult.renderedPrompt).toContain(
          defaultSpec.formatImageToken(1),
        );
        expect(submitResult.renderedPrompt).toContain(
          defaultSpec.formatImageToken(2),
        );
        expect(capturedBody).toBeTruthy();

        const videoPayload = Buffer.from("ftypmp42mockvideobytes");

        if (provider.capabilities.supportsWebhook) {
          const outcome = provider.parseWebhook(fixture.webhook.success);
          expect(outcome.state).toBe("succeeded");
          if (outcome.state !== "succeeded") throw new Error("unreachable");
          const artifactOrigin = new URL(outcome.artifactUrl).origin;
          const artifactPath = new URL(outcome.artifactUrl).pathname;
          mockAgent
            .get(artifactOrigin)
            .intercept({ method: "GET", path: artifactPath })
            .reply(200, videoPayload, {
              headers: { "content-type": "video/mp4" },
            });
          const downloaded = await provider.downloadArtifact(ctx, {
            artifactUrl: outcome.artifactUrl,
            externalJobId: submitResult.externalJobId,
          });
          expect(Buffer.from(downloaded.bytes)).toEqual(videoPayload);
        }

        if (provider.capabilities.supportsPolling) {
          if (fixture.poll.statusPath) {
            mockAgent
              .get(baseOrigin)
              .intercept({
                method: "GET",
                path: (p) => p === fixture.poll.statusPath,
              })
              .reply(
                fixture.poll.pendingStatusResponse.status,
                fixture.poll.pendingStatusResponse.body,
                { headers: { "content-type": "application/json" } },
              );
            const pending = await provider.getStatus(ctx, {
              externalJobId: submitResult.externalJobId,
              providerModelId: submitResult.providerModelId,
              providerMetadata: submitResult.providerMetadata,
            });
            expect(pending.state).toBe("pending");

            mockAgent
              .get(baseOrigin)
              .intercept({
                method: "GET",
                path: (p) => p === fixture.poll.statusPath,
              })
              .reply(
                fixture.poll.completedStatusResponse.status,
                fixture.poll.completedStatusResponse.body,
                { headers: { "content-type": "application/json" } },
              );
            const resultPath =
              fixture.poll.resultPath ?? fixture.poll.responsePath;
            const resultOrigin = new URL(resultPath, baseOrigin).origin;
            mockAgent
              .get(resultOrigin)
              .intercept({
                method: "GET",
                path: (p) => p === new URL(resultPath, baseOrigin).pathname,
              })
              .reply(
                fixture.poll.resultResponse.status,
                fixture.poll.resultResponse.body,
                { headers: { "content-type": "application/json" } },
              );
            const done = await provider.getStatus(ctx, {
              externalJobId: submitResult.externalJobId,
              providerModelId: submitResult.providerModelId,
              providerMetadata: submitResult.providerMetadata,
            });
            expect(done.state).toBe("succeeded");
          } else {
            mockAgent
              .get(baseOrigin)
              .intercept({ method: "GET", path: fixture.poll.path })
              .reply(
                fixture.poll.pendingResponse.status,
                fixture.poll.pendingResponse.body,
                { headers: { "content-type": "application/json" } },
              );
            const pending = await provider.getStatus(ctx, {
              externalJobId: submitResult.externalJobId,
              providerModelId: submitResult.providerModelId,
              providerMetadata: submitResult.providerMetadata,
            });
            expect(pending.state).toBe("pending");

            mockAgent
              .get(baseOrigin)
              .intercept({ method: "GET", path: fixture.poll.path })
              .reply(
                fixture.poll.successResponse.status,
                fixture.poll.successResponse.body,
                { headers: { "content-type": "application/json" } },
              );
            const done = await provider.getStatus(ctx, {
              externalJobId: submitResult.externalJobId,
              providerModelId: submitResult.providerModelId,
              providerMetadata: submitResult.providerMetadata,
            });
            expect(done.state).toBe("succeeded");

            if (fixture.download?.redirectResponse) {
              const redirectUrl =
                fixture.download.redirectResponse.headers.location;
              const cdnOrigin = new URL(redirectUrl).origin;
              const cdnPath = new URL(redirectUrl).pathname;
              mockAgent
                .get(baseOrigin)
                .intercept({ method: "GET", path: fixture.download.path })
                .reply(fixture.download.redirectResponse.status, "", {
                  headers: fixture.download.redirectResponse.headers,
                });
              let cdnSawAuth = false;
              mockAgent
                .get(cdnOrigin)
                .intercept({ method: "GET", path: cdnPath })
                .reply((opts) => {
                  const hdrs = opts.headers as Record<string, unknown>;
                  cdnSawAuth = Boolean(
                    hdrs?.authorization || hdrs?.Authorization,
                  );
                  return {
                    statusCode: 200,
                    data: videoPayload,
                    responseOptions: {
                      headers: { "content-type": "video/mp4" },
                    },
                  };
                });
              if (done.state === "succeeded") {
                const downloaded = await provider.downloadArtifact(ctx, {
                  artifactUrl: done.artifactUrl,
                  externalJobId: submitResult.externalJobId,
                });
                expect(cdnSawAuth).toBe(false);
                expect(Buffer.from(downloaded.bytes)).toEqual(videoPayload);
              }
            }
          }
        }
      });

      it("rejects malformed submit responses and verifies preflight success + 401 failure", async () => {
        mockAgent
          .get(baseOrigin)
          .intercept({
            method: fixture.submit.method,
            path: (p) => p.startsWith(fixture.submit.path),
          })
          .reply(
            fixture.submit.malformedResponse.status,
            fixture.submit.malformedResponse.body,
            { headers: { "content-type": "application/json" } },
          );
        await expect(
          provider.submit(ctx, makeSubmitReq()),
        ).rejects.toMatchObject({
          kind: "invalid_input",
        });

        mockAgent
          .get(preflightOrigin)
          .intercept({
            method: fixture.preflight.method,
            path: (p) => p === fixture.preflight.path,
          })
          .reply(
            fixture.preflight.successResponse.status,
            fixture.preflight.successResponse.body,
            { headers: { "content-type": "application/json" } },
          );
        const okRes = await provider.preflight(ctx);
        expect(okRes.ok).toBe(true);

        mockAgent
          .get(preflightOrigin)
          .intercept({
            method: fixture.preflight.method,
            path: (p) => p === fixture.preflight.path,
          })
          .reply(
            fixture.preflight.authErrorResponse.status,
            fixture.preflight.authErrorResponse.body,
            { headers: { "content-type": "application/json" } },
          );
        const failRes = await provider.preflight(ctx);
        expect(failRes.ok).toBe(false);
        expect(failRes.kind).toBe("auth");
      });

      if (fixture.submit.http200Errors) {
        it("classifies HTTP-200 error codes accurately without retrying", async () => {
          const cases: Array<[string, string]> = [
            ["auth", "auth"],
            ["quota", "quota"],
            ["moderation", "moderation"],
            ["invalidInput", "invalid_input"],
            ["rateLimited", "rate_limited"],
            ["transient", "transient"],
          ];
          for (const [key, expectedKind] of cases) {
            let calls = 0;
            mockAgent
              .get(baseOrigin)
              .intercept({
                method: fixture.submit.method,
                path: (p) => p.startsWith(fixture.submit.path),
              })
              .reply(() => {
                calls += 1;
                return {
                  statusCode: fixture.submit.http200Errors[key].status,
                  data: fixture.submit.http200Errors[key].body,
                  responseOptions: {
                    headers: { "content-type": "application/json" },
                  },
                };
              });
            await expect(
              provider.submit(ctx, makeSubmitReq()),
            ).rejects.toMatchObject({ kind: expectedKind });
            expect(calls).toBe(1);
          }
        });
      }

      if (fixture.submit.errors) {
        it("fails fast on 401/402/moderation and classifies ambiguous 5xx without retrying submit", async () => {
          for (const [key, expectedKind] of [
            ["auth", "auth"],
            ["quota", "quota"],
            ["moderation", "moderation"],
            ["invalidInput", "invalid_input"],
            ["rateLimited", "rate_limited"],
            ["transient", "ambiguous_submit"],
          ] as const) {
            const spec = fixture.submit.errors[key];
            if (!spec) continue;
            let calls = 0;
            mockAgent
              .get(baseOrigin)
              .intercept({
                method: fixture.submit.method,
                path: (p) => p.startsWith(fixture.submit.path),
              })
              .reply(() => {
                calls += 1;
                return {
                  statusCode: spec.status,
                  data: spec.body,
                  responseOptions: {
                    headers: {
                      "content-type": "application/json",
                      ...(spec.headers ?? {}),
                    },
                  },
                };
              });
            await expect(
              provider.submit(ctx, makeSubmitReq()),
            ).rejects.toMatchObject({ kind: expectedKind });
            expect(calls).toBe(1);
          }
        });
      }

      it("treats submit socket timeouts as ambiguous_submit with exactly 1 attempt (never duplicates billable submits)", async () => {
        let submitCalls = 0;
        const slowFetch: typeof fetch = async (_url, init) => {
          submitCalls += 1;
          expect(init?.signal).toBeDefined();
          throw new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          );
        };
        await expect(
          provider.submit({ ...ctx, fetchFn: slowFetch }, makeSubmitReq()),
        ).rejects.toMatchObject({
          kind: "ambiguous_submit",
          retryable: false,
        });
        expect(submitCalls).toBe(1);
      });

      if (provider.capabilities.supportsPolling) {
        it("honors Retry-After on 429 and uses exponential backoff on 5xx during status polling", async () => {
          const slept: number[] = [];
          const pollPath = fixture.poll.statusPath ?? fixture.poll.path;
          const pollUrl = new URL(pollPath, baseOrigin);

          mockAgent
            .get(baseOrigin)
            .intercept({
              method: "GET",
              path: `${pollUrl.pathname}${pollUrl.search}`,
            })
            .reply(
              429,
              { error: { message: "Slow down" } },
              {
                headers: {
                  "content-type": "application/json",
                  "retry-after": "2",
                },
              },
            );
          mockAgent
            .get(baseOrigin)
            .intercept({
              method: "GET",
              path: `${pollUrl.pathname}${pollUrl.search}`,
            })
            .reply(
              503,
              { error: { message: "Temporary hiccup" } },
              { headers: { "content-type": "application/json" } },
            );

          const okResp =
            fixture.poll.pendingStatusResponse ?? fixture.poll.pendingResponse;
          mockAgent
            .get(baseOrigin)
            .intercept({
              method: "GET",
              path: `${pollUrl.pathname}${pollUrl.search}`,
            })
            .reply(okResp.status, okResp.body, {
              headers: { "content-type": "application/json" },
            });

          const submitBody = fixture.submit.successResponse.body;
          const pollExternalId =
            submitBody?.data?.taskId ??
            submitBody?.id ??
            submitBody?.data?.job?.id ??
            submitBody?.request_id ??
            "job-1";
          const providerMetadata = fixture.poll.statusPath
            ? {
                statusUrl: `${baseOrigin}${fixture.poll.statusPath}`,
                ...(fixture.poll.responsePath
                  ? {
                      responseUrl: `${baseOrigin}${fixture.poll.responsePath}`,
                    }
                  : {}),
              }
            : undefined;

          const status = await provider.getStatus(
            {
              ...ctx,
              retryBaseDelayMs: 50,
              sleepFn: async (ms) => {
                slept.push(ms);
              },
            },
            {
              externalJobId: pollExternalId,
              providerMetadata,
            },
          );
          expect(status.state).toBe("pending");
          expect(slept.length).toBe(2);
          expect(slept[0]).toBe(2000);
          expect(slept[1]).toBeGreaterThanOrEqual(50);
        });
      }

      if (provider.capabilities.supportsWebhook) {
        it("enforces authenticated, single-use, job-matched waitpoints and rejects forged/replayed/expired webhooks", async () => {
          const id = "00000000-0000-4000-8000-000000000099";
          const attemptId = "00000000-0000-4000-8000-000000000100";
          const secret = "valid-secret-token-value-123456";
          const parsedValid = provider.parseWebhook(fixture.webhook.success);
          const { store } = createInMemoryWaitpointStore({
            id,
            attemptId,
            providerId,
            secret,
            externalJobId: parsedValid.externalJobId ?? null,
          });

          const post = (
            url: string,
            body: unknown,
            headers?: Record<string, string>,
          ) =>
            handleWaitpointPost(
              new Request(url, {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify(body),
              }),
              id,
              store,
            );

          // Missing secret -> 401
          expect(
            (
              await post(
                `https://app.test/api/waitpoints/${id}`,
                fixture.webhook.success,
              )
            ).status,
          ).toBe(401);

          // Wrong secret -> 401
          expect(
            (
              await post(
                `https://app.test/api/waitpoints/${id}?token=wrong-secret`,
                fixture.webhook.success,
              )
            ).status,
          ).toBe(401);

          // Unknown waitpoint -> 404
          expect(
            (
              await handleWaitpointPost(
                new Request(
                  "https://app.test/api/waitpoints/00000000-0000-4000-8000-000000000999?token=x",
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(fixture.webhook.success),
                  },
                ),
                "00000000-0000-4000-8000-000000000999",
                store,
              )
            ).status,
          ).toBe(404);

          // Malformed body -> 400
          expect(
            (
              await post(
                `https://app.test/api/waitpoints/${id}?token=${secret}`,
                fixture.webhook.malformed,
              )
            ).status,
          ).toBe(400);

          // Job ID mismatch -> 400
          if (parsedValid.externalJobId) {
            const mismatched = JSON.parse(
              JSON.stringify(fixture.webhook.success).replaceAll(
                parsedValid.externalJobId,
                "other-job-id",
              ),
            );
            expect(
              (
                await post(
                  `https://app.test/api/waitpoints/${id}?token=${secret}`,
                  mismatched,
                )
              ).status,
            ).toBe(400);
          }

          // Valid first delivery -> 200
          expect(
            (
              await post(
                `https://app.test/api/waitpoints/${id}?token=${secret}`,
                fixture.webhook.success,
              )
            ).status,
          ).toBe(200);

          // Replay -> 409
          expect(
            (
              await post(
                `https://app.test/api/waitpoints/${id}?token=${secret}`,
                fixture.webhook.success,
              )
            ).status,
          ).toBe(409);

          // Expired -> 410
          const expiredStore = createInMemoryWaitpointStore({
            id,
            attemptId,
            providerId,
            secret,
            externalJobId: null,
            expiresAt: new Date(Date.now() - 1000),
          });
          expect(
            (
              await handleWaitpointPost(
                new Request(
                  `https://app.test/api/waitpoints/${id}?token=${secret}`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(fixture.webhook.success),
                  },
                ),
                id,
                expiredStore.store,
              )
            ).status,
          ).toBe(410);
        });
      }

      it("redacts echoed API keys across errors, logs, and tRPC error responses", async () => {
        mockAgent
          .get(preflightOrigin)
          .intercept({
            method: fixture.preflight.method,
            path: (p) => p === fixture.preflight.path,
          })
          .reply(401, {
            error: {
              message: `Auth rejected for Bearer ${canaryKey} with key=${canaryKey}`,
            },
          });

        const preflight = await provider.preflight(ctx);
        expect(preflight.ok).toBe(false);
        expect(preflight.details).not.toContain(canaryKey);

        const err = new ProviderError({
          kind: "auth",
          provider: providerId,
          message: `Failure with token ${canaryKey}`,
        });
        expect(err.message).not.toContain(canaryKey);
        expect(
          sanitizeErrorMessage(new Error(`Echoed ${canaryKey}`), [canaryKey]),
        ).not.toContain(canaryKey);
      });
    },
  );
});

describe("Shared Video Understanding Provider Contract Suite", () => {
  const providers = listVideoUnderstandingProviders();

  describe.each(providers.map((p) => [p.id, p] as const))(
    "video-understanding provider: %s",
    (providerId, provider) => {
      const fixture = loadFixture<Record<string, any>>(providerId);
      const spec = fixture.generateContent ?? fixture.chatCompletions;
      const baseOrigin = new URL(fixture.baseUrl).origin;
      const canaryKey = `AIzaCanaryVideoUnderstanding_${providerId}_99999`;
      const ctx = {
        apiKey: canaryKey,
        baseUrl: fixture.baseUrl,
        model: provider.defaultModel,
        fetchFn: ((...args: Parameters<typeof fetch>) =>
          globalThis.fetch(...args)) as typeof fetch,
        retryBaseDelayMs: 1,
        sleepFn: async () => undefined,
      };
      const outSchema = z.object({ summary: z.string() });
      const videos = [Buffer.from("mockmp4")];

      it("passes happy path, malformed payload rejection, and preflight", async () => {
        let capturedHeader = "";
        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply((opts) => {
            const hdrs = Object.fromEntries(
              Object.entries(opts.headers ?? {}).map(([k, v]) => [
                k.toLowerCase(),
                Array.isArray(v) ? v.join(",") : String(v),
              ]),
            );
            capturedHeader = hdrs[fixture.authHeader.name.toLowerCase()] ?? "";
            return {
              statusCode: spec.successResponse.status,
              data: spec.successResponse.body,
              responseOptions: {
                headers: { "content-type": "application/json" },
              },
            };
          });

        const result = await provider.describeVideo(ctx, {
          videos,
          prompt: "Summarize",
          schema: outSchema,
        });
        expect(result).toEqual({ summary: "A quick product demo" });
        expect(capturedHeader).toBe(`${fixture.authHeader.prefix}${canaryKey}`);

        // Malformed structured JSON fails fast without retrying.
        let malformedCalls = 0;
        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply(() => {
            malformedCalls += 1;
            return {
              statusCode: spec.malformedResponse.status,
              data: spec.malformedResponse.body,
              responseOptions: {
                headers: { "content-type": "application/json" },
              },
            };
          });
        await expect(
          provider.describeVideo(ctx, {
            videos,
            prompt: "Summarize",
            schema: outSchema,
          }),
        ).rejects.toMatchObject({ kind: "invalid_input" });
        expect(malformedCalls).toBe(1);

        // Preflight ok + 401 fail
        mockAgent
          .get(baseOrigin)
          .intercept({
            method: fixture.preflight.method,
            path: fixture.preflight.path,
          })
          .reply(
            fixture.preflight.successResponse.status,
            fixture.preflight.successResponse.body,
            { headers: { "content-type": "application/json" } },
          );
        expect((await provider.preflight(ctx)).ok).toBe(true);

        mockAgent
          .get(baseOrigin)
          .intercept({
            method: fixture.preflight.method,
            path: fixture.preflight.path,
          })
          .reply(
            fixture.preflight.authErrorResponse.status,
            fixture.preflight.authErrorResponse.body,
            { headers: { "content-type": "application/json" } },
          );
        const bad = await provider.preflight(ctx);
        expect(bad.ok).toBe(false);
        expect(bad.kind).toBe("auth");
      });

      it("fails fast on 401/quota/moderation and retries only 429/5xx with backoff + Retry-After", async () => {
        for (const [errKey, expectedKind] of [
          ["auth", "auth"],
          ["quota", "quota"],
          ["moderation", "moderation"],
        ] as const) {
          const errSpec = spec.errors[errKey];
          if (!errSpec) continue;
          let calls = 0;
          mockAgent
            .get(baseOrigin)
            .intercept({ method: spec.method, path: spec.path })
            .reply(() => {
              calls += 1;
              return {
                statusCode: errSpec.status,
                data: errSpec.body,
                responseOptions: {
                  headers: { "content-type": "application/json" },
                },
              };
            });
          await expect(
            provider.describeVideo(ctx, {
              videos,
              prompt: "Summarize",
              schema: outSchema,
            }),
          ).rejects.toMatchObject({ kind: expectedKind, retryable: false });
          expect(calls).toBe(1);
        }

        // 429 with Retry-After + 503 backoff
        const slept: number[] = [];
        const rateSpec = spec.errors.rateLimited;
        const transientSpec =
          spec.errors.transient ?? spec.errors.noHealthySellers;
        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply(rateSpec.status, rateSpec.body, {
            headers: {
              "content-type": "application/json",
              ...(rateSpec.headers ?? {}),
            },
          });
        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply(transientSpec.status, transientSpec.body, {
            headers: { "content-type": "application/json" },
          });
        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply(spec.successResponse.status, spec.successResponse.body, {
            headers: { "content-type": "application/json" },
          });

        const retried = await provider.describeVideo(
          {
            ...ctx,
            retryBaseDelayMs: 40,
            sleepFn: async (ms) => {
              slept.push(ms);
            },
          },
          { videos, prompt: "Summarize", schema: outSchema },
        );
        expect(retried).toEqual({ summary: "A quick product demo" });
        expect(slept.length).toBe(2);
        expect(slept[0]).toBe(1000);
        expect(slept[1]).toBeGreaterThanOrEqual(40);
      });

      it("aborts cleanly on socket timeout and redacts echoed keys", async () => {
        let attempts = 0;
        const timeoutFetch: typeof fetch = async () => {
          attempts += 1;
          throw new DOMException("Timed out", "TimeoutError");
        };
        await expect(
          provider.describeVideo(
            { ...ctx, fetchFn: timeoutFetch, retryBaseDelayMs: 1 },
            { videos, prompt: "Summarize", schema: outSchema },
          ),
        ).rejects.toMatchObject({ kind: "transient" });
        expect(attempts).toBe(3);

        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply(401, {
            error: { message: `Invalid key ${canaryKey}` },
          });
        await expect(
          provider.describeVideo(ctx, {
            videos,
            prompt: "Summarize",
            schema: outSchema,
          }),
        ).rejects.toSatisfy((err: Error) => !err.message.includes(canaryKey));
      });
    },
  );
});

describe("Shared Text & Vision Structured Output Provider Contract Suite", () => {
  const providers = listTextProviders();

  describe.each(providers.map((p) => [p.id, p] as const))(
    "text provider: %s",
    (providerId, provider) => {
      const fixture = loadFixture<Record<string, any>>(providerId);
      const spec =
        fixture.messages ?? fixture.generateContent ?? fixture.chatCompletions;
      const baseOrigin = new URL(fixture.baseUrl).origin;
      const canaryKey = `sk-ant-canary-text-${providerId}-1122334455`;
      const ctx = {
        apiKey: canaryKey,
        baseUrl: fixture.baseUrl,
        model: provider.defaultModel,
        fetchFn: ((...args: Parameters<typeof fetch>) =>
          globalThis.fetch(...args)) as typeof fetch,
        retryBaseDelayMs: 1,
        sleepFn: async () => undefined,
      };
      const outSchema = z.object({ summary: z.string() });
      const parts = [
        { type: "text" as const, text: "Summarize" },
        {
          type: "image" as const,
          data: new Uint8Array([1, 2, 3]),
          mediaType: "image/jpeg",
        },
      ];

      it("handles multimodal structured output, malformed response, 401/429/5xx, timeout, and key redaction", async () => {
        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply(spec.successResponse.status, spec.successResponse.body, {
            headers: { "content-type": "application/json" },
          });

        const ok = await provider.generateStructured(ctx, {
          system: "Be concise.",
          parts,
          schema: outSchema,
          schemaName: "summaryOut",
          reasoningEffort: "low",
        });
        expect(ok).toEqual({ summary: "A quick product demo" });

        // Malformed payload
        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply(spec.malformedResponse.status, spec.malformedResponse.body, {
            headers: { "content-type": "application/json" },
          });
        await expect(
          provider.generateStructured(ctx, {
            parts,
            schema: outSchema,
            schemaName: "summaryOut",
          }),
        ).rejects.toMatchObject({ kind: "invalid_input" });

        // 401 fail-fast
        const authErr = spec.errors.auth;
        let authCalls = 0;
        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply(() => {
            authCalls += 1;
            return {
              statusCode: authErr.status,
              data: {
                error: {
                  ...authErr.body.error,
                  message: `Bad key: ${canaryKey}`,
                },
              },
              responseOptions: {
                headers: { "content-type": "application/json" },
              },
            };
          });
        await expect(
          provider.generateStructured(ctx, {
            parts,
            schema: outSchema,
            schemaName: "summaryOut",
          }),
        ).rejects.toSatisfy(
          (err: unknown) =>
            err instanceof ProviderError &&
            err.kind === "auth" &&
            !err.message.includes(canaryKey),
        );
        expect(authCalls).toBe(1);

        // 429 Retry-After + 5xx backoff
        const slept: number[] = [];
        const rateSpec = spec.errors.rateLimited;
        const transientSpec =
          spec.errors.transient ?? spec.errors.noHealthySellers;
        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply(rateSpec.status, rateSpec.body, {
            headers: {
              "content-type": "application/json",
              ...(rateSpec.headers ?? {}),
            },
          });
        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply(transientSpec.status, transientSpec.body, {
            headers: { "content-type": "application/json" },
          });
        mockAgent
          .get(baseOrigin)
          .intercept({ method: spec.method, path: spec.path })
          .reply(spec.successResponse.status, spec.successResponse.body, {
            headers: { "content-type": "application/json" },
          });

        const retried = await provider.generateStructured(
          {
            ...ctx,
            retryBaseDelayMs: 30,
            sleepFn: async (ms) => {
              slept.push(ms);
            },
          },
          { parts, schema: outSchema, schemaName: "summaryOut" },
        );
        expect(retried).toEqual({ summary: "A quick product demo" });
        expect(slept.length).toBe(2);
      });
    },
  );
});

describe("SSRF, Download Size Caps, and Secret Redaction Contract", () => {
  it("blocks loopback, private CIDRs, IMDS, IPv4-mapped IPv6, DNS rebinding, and malicious 302 redirects", async () => {
    const blockedUrls = [
      "http://127.0.0.1/video.mp4",
      "https://127.0.0.1:8080/video.mp4",
      "https://[::1]/video.mp4",
      "https://[::ffff:127.0.0.1]/video.mp4",
      "https://[::ffff:7f00:1]/video.mp4",
      "https://10.1.2.3/video.mp4",
      "https://172.16.5.4/video.mp4",
      "https://192.168.1.50/video.mp4",
      "http://169.254.169.254/latest/meta-data/",
      "https://localhost/video.mp4",
      "https://metadata.google.internal/computeMetadata/v1/",
      "file:///etc/passwd",
      "https://rebind.example.test/video.mp4",
      "https://imds-rebind.example.test/video.mp4",
    ];
    for (const url of blockedUrls) {
      await expect(assertSafeRemoteUrl(url)).rejects.toThrow(
        /Blocked remote URL/i,
      );
    }

    // Public URL redirecting to IMDS must be rejected before fetching IMDS.
    mockAgent
      .get("https://cdn.example.test")
      .intercept({ method: "GET", path: "/evil-redirect" })
      .reply(302, "", {
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    await expect(
      downloadVideo(
        "https://cdn.example.test/evil-redirect",
        "test",
        undefined,
        {
          fetchFn: globalThis.fetch,
        },
      ),
    ).rejects.toThrow(/Blocked remote URL/i);
  });

  it("enforces streaming byte cap even when Content-Length is omitted", async () => {
    const chunks = [new Uint8Array(600), new Uint8Array(600)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const streamingFetch: typeof fetch = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });

    await expect(
      downloadVideo("https://cdn.example.test/too-big.mp4", "test", undefined, {
        maxBytes: 1000,
        fetchFn: streamingFetch,
      }),
    ).rejects.toThrow(/smaller/i);
  });

  it("redacts keys across logger, error helpers, and tRPC error formatter", async () => {
    const canary = "sk-canary-trpc-secret-0123456789";
    process.env.TEST_DUMMY_API_KEY = canary;
    try {
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      logger.warn(`Failed calling https://api.test?key=${canary}`, {
        authorization: `Bearer ${canary}`,
        nested: `x-api-key: ${canary}`,
      });
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain(canary);
      expect(
        redactSecrets(`Bearer ${canary} & ?token=${canary}`),
      ).not.toContain(canary);

      const router = createTRPCRouter({
        boom: publicProcedure.query(() => {
          throw new Error(`Upstream failed with ${canary}`);
        }),
      });
      const caller = router.createCaller({});
      let caughtMessage = "";
      try {
        await caller.boom();
      } catch (err) {
        caughtMessage = sanitizeErrorMessage(err);
      }
      expect(caughtMessage).not.toContain(canary);
    } finally {
      delete process.env.TEST_DUMMY_API_KEY;
    }
  });
});
