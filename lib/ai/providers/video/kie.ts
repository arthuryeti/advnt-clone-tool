import "server-only";

import { z } from "zod/v4";
import { classifyHttpStatus, ProviderError } from "@/lib/ai/errors";
import { fetchJsonWithTimeout, withBackoffRetry } from "@/lib/ai/http";
import type {
  ProviderPreflightResult,
  VideoGenerationProvider,
  VideoJobRef,
  VideoModelSpec,
  VideoPollStatus,
  VideoProviderContext,
  VideoSubmitRequest,
  VideoSubmitResult,
  VideoWebhookOutcome,
} from "@/lib/ai/providers/video/types";
import {
  normalizeVideoModelId,
  renderSecondsForModel,
  resolveTakePromptReferences,
} from "@/lib/content-workflows/video-clone";
import { redactSecrets } from "@/lib/security/redact";
import { downloadVideo } from "@/lib/storage/download-video";

const KIE_MODELS: readonly VideoModelSpec[] = [
  {
    id: "seedance-2.5",
    label: "Seedance 2.5",
    providerModelId: "bytedance/seedance-2-5",
    aliases: ["bytedance/seedance-2-5"],
    formatImageToken: (slot) => `@image${slot}`,
    maxImages: 30,
    minSeconds: 4,
    maxSeconds: 30,
    usdPerSecond: 0.14,
  },
  {
    id: "wan-3.0",
    label: "Wan 3.0",
    providerModelId: "wan/3-0-video",
    aliases: ["wan/3-0-video"],
    formatImageToken: (slot) => `Image${slot}`,
    maxImages: 10,
    minSeconds: 2,
    maxSeconds: 30,
    usdPerSecond: 0.04,
  },
];

const createTaskResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      taskId: z.string().min(1).optional(),
    })
    .nullish(),
});

const kieResultPayloadSchema = z.object({
  resultUrls: z.array(z.string().min(1)).optional(),
  result: z.array(z.string().min(1)).optional(),
});

const recordInfoResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      taskId: z.string().min(1),
      state: z.string(),
      resultJson: z.string().nullish(),
      failCode: z.string().nullish(),
      failMsg: z.string().nullish(),
    })
    .nullish(),
});

const kieCallbackSchema = z.object({
  data: z.object({
    taskId: z.string().min(1),
    state: z.string(),
    resultJson: z.string().nullish(),
    failCode: z.string().nullish(),
    failMsg: z.string().nullish(),
  }),
});

function resolveModel(modelId: string): VideoModelSpec {
  const canonical = normalizeVideoModelId(modelId);
  const found = KIE_MODELS.find(
    (spec) => spec.id === canonical || spec.aliases?.includes(modelId),
  );
  if (!found) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: "kie",
      message: `Unsupported KIE model "${modelId}".`,
    });
  }
  return found;
}

function parseResultUrl(resultJson: string | null | undefined): string {
  let rawObj: unknown;
  try {
    rawObj = JSON.parse(resultJson ?? "{}");
  } catch {
    throw new ProviderError({
      kind: "invalid_input",
      provider: "kie",
      message: "KIE returned malformed resultJson.",
    });
  }
  const parsed = kieResultPayloadSchema.safeParse(rawObj);
  if (!parsed.success) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: "kie",
      message: "KIE resultJson has unexpected structure.",
    });
  }
  const url = parsed.data.resultUrls?.[0] ?? parsed.data.result?.[0];
  if (!url) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: "kie",
      message: "KIE finished without a video URL.",
    });
  }
  return url;
}

export const kieVideoProvider: VideoGenerationProvider = {
  id: "kie",
  label: "KIE",
  apiKeyEnvVar: "KIE_API_KEY",
  baseUrlEnvVar: "KIE_BASE_URL",
  defaultBaseUrl: "https://api.kie.ai",
  capabilities: {
    deliveryMode: "hybrid",
    supportsWebhook: true,
    supportsPolling: true,
    requiresPublicCallbackUrl: true,
    supportsIdempotencyKey: false,
    defaultTimeoutMs: 30 * 60 * 1000,
    pollIntervalMs: 15_000,
  },
  models: KIE_MODELS,
  defaultModelId: "seedance-2.5",

  prepareSubmission(request: VideoSubmitRequest) {
    const modelSpec = resolveModel(request.model);
    const { prompt: renderedPrompt, imageUrls } = resolveTakePromptReferences(
      request.prompt,
      request.references,
      {
        formatImageToken: modelSpec.formatImageToken,
        maxImages: modelSpec.maxImages,
        modelLabel: modelSpec.label,
      },
    );
    const duration = renderSecondsForModel(
      request.seconds,
      modelSpec.minSeconds,
      modelSpec.maxSeconds,
    );
    const baseInput = {
      prompt: renderedPrompt,
      duration,
      aspect_ratio: "9:16",
      ...(imageUrls.length > 0 ? { reference_image_urls: imageUrls } : {}),
    };
    const input =
      modelSpec.id === "wan-3.0"
        ? { ...baseInput, resolution: "480P", audio: request.hasDialogue }
        : {
            ...baseInput,
            resolution: "480p",
            draft: true,
            generate_audio: request.hasDialogue,
          };
    return { modelSpec, renderedPrompt, imageUrls, duration, input };
  },

  async submit(
    ctx: VideoProviderContext,
    request: VideoSubmitRequest,
  ): Promise<VideoSubmitResult> {
    if (!request.callbackUrl) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "kie",
        message: "KIE requires a callback URL for render tasks.",
      });
    }
    const { modelSpec, renderedPrompt, input } =
      this.prepareSubmission(request);
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    const { data } = await fetchJsonWithTimeout<unknown>(
      `${baseUrl}/api/v1/jobs/createTask`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelSpec.providerModelId,
          input,
          callBackUrl: request.callbackUrl,
        }),
      },
      {
        provider: "kie",
        timeoutMs: 30_000,
        isBillableSubmit: true,
        fetchFn: ctx.fetchFn,
        secrets: [ctx.apiKey],
      },
    );

    const parsed = createTaskResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "kie",
        message: "KIE returned malformed createTask response.",
      });
    }

    if (parsed.data.code !== 200) {
      const msg = parsed.data.msg ?? "KIE refused the job";
      throw new ProviderError({
        kind: classifyHttpStatus(parsed.data.code, msg, {
          code: parsed.data.code,
          isBillableSubmit: false,
        }),
        provider: "kie",
        status: parsed.data.code,
        code: parsed.data.code,
        message: `KIE refused the job (${parsed.data.code}): ${msg}`,
      });
    }

    const taskId = parsed.data.data?.taskId;
    if (!taskId) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "kie",
        message: "KIE createTask succeeded without a taskId.",
      });
    }

    return {
      externalJobId: taskId,
      renderedPrompt,
      providerModelId: modelSpec.providerModelId,
      canonicalModelId: modelSpec.id,
    };
  },

  async getStatus(
    ctx: VideoProviderContext,
    ref: VideoJobRef,
  ): Promise<VideoPollStatus> {
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    return withBackoffRetry(
      async () => {
        const { data } = await fetchJsonWithTimeout<unknown>(
          `${baseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(ref.externalJobId)}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${ctx.apiKey}`,
            },
          },
          {
            provider: "kie",
            timeoutMs: 20_000,
            fetchFn: ctx.fetchFn,
            secrets: [ctx.apiKey],
          },
        );

        const parsed = recordInfoResponseSchema.safeParse(data);
        if (!parsed.success) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "kie",
            message: "KIE returned malformed recordInfo payload.",
          });
        }

        if (parsed.data.code !== 200) {
          const msg = parsed.data.msg ?? "KIE status check failed";
          throw new ProviderError({
            kind: classifyHttpStatus(parsed.data.code, msg, {
              code: parsed.data.code,
            }),
            provider: "kie",
            status: parsed.data.code,
            code: parsed.data.code,
            message: `KIE status error (${parsed.data.code}): ${msg}`,
          });
        }

        const record = parsed.data.data;
        if (!record) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "kie",
            message: "KIE recordInfo returned no task data.",
          });
        }

        const state = record.state.toLowerCase();
        if (
          state === "waiting" ||
          state === "queuing" ||
          state === "generating"
        ) {
          return { state: "pending" };
        }
        if (state === "success") {
          return {
            state: "succeeded",
            artifactUrl: parseResultUrl(record.resultJson),
            externalJobId: record.taskId,
          };
        }
        return {
          state: "failed",
          error: redactSecrets(record.failMsg || `KIE job ${record.state}`, [
            ctx.apiKey,
          ]),
          externalJobId: record.taskId,
        };
      },
      {
        maxAttempts: 3,
        baseDelayMs: ctx.retryBaseDelayMs,
        sleepFn: ctx.sleepFn,
      },
    );
  },

  parseWebhook(body: unknown): VideoWebhookOutcome {
    const parsed = kieCallbackSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "kie",
        message: "Malformed KIE webhook payload.",
      });
    }
    const { data } = parsed.data;
    if (data.state !== "success") {
      return {
        state: "failed",
        error: redactSecrets(data.failMsg || `KIE job ${data.state}`),
        externalJobId: data.taskId,
      };
    }
    return {
      state: "succeeded",
      artifactUrl: parseResultUrl(data.resultJson),
      externalJobId: data.taskId,
    };
  },

  async downloadArtifact(ctx, outcome) {
    if (!outcome.artifactUrl) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "kie",
        message: "Missing KIE artifact URL.",
      });
    }
    return downloadVideo(outcome.artifactUrl, "Rendered take", undefined, {
      fetchFn: ctx.fetchFn,
    });
  },

  async preflight(ctx): Promise<ProviderPreflightResult> {
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    try {
      const { data } = await fetchJsonWithTimeout<unknown>(
        `${baseUrl}/api/v1/chat/credit`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${ctx.apiKey}`,
          },
        },
        {
          provider: "kie",
          timeoutMs: 10_000,
          fetchFn: ctx.fetchFn,
          secrets: [ctx.apiKey],
        },
      );
      const parsed = z
        .object({ code: z.number(), msg: z.string().optional() })
        .safeParse(data);
      if (!parsed.success) {
        return {
          ok: false,
          kind: "invalid_input",
          details: "KIE preflight returned malformed JSON.",
        };
      }
      if (parsed.data.code !== 200) {
        const msg = parsed.data.msg ?? "KIE rejected credentials";
        return {
          ok: false,
          kind: classifyHttpStatus(parsed.data.code, msg),
          details: redactSecrets(
            `KIE credit check failed (${parsed.data.code}): ${msg}`,
            [ctx.apiKey],
          ),
        };
      }
      return { ok: true, details: "KIE credentials verified" };
    } catch (error) {
      if (error instanceof ProviderError) {
        return { ok: false, kind: error.kind, details: error.message };
      }
      return {
        ok: false,
        kind: "transient",
        details: redactSecrets(
          error instanceof Error ? error.message : String(error),
          [ctx.apiKey],
        ),
      };
    }
  },
};
