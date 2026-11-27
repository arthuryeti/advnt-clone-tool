import "server-only";

import { z } from "zod/v4";
import { ProviderError } from "@/lib/ai/errors";
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

const FAL_MODELS: readonly VideoModelSpec[] = [
  {
    id: "seedance-2.5",
    label: "Seedance 2.5",
    providerModelId: "fal-ai/seedance-2.5",
    aliases: ["fal-ai/seedance-2.5", "bytedance/seedance-2-5"],
    formatImageToken: (slot) => `@img${slot}`,
    maxImages: 10,
    minSeconds: 4,
    maxSeconds: 12,
    usdPerSecond: 0.14,
  },
  {
    id: "wan-3.0",
    label: "Wan 3.0",
    providerModelId: "fal-ai/wan-3.0",
    aliases: ["fal-ai/wan-3.0", "wan/3-0-video"],
    formatImageToken: (slot) => `Image${slot}`,
    maxImages: 10,
    minSeconds: 2,
    maxSeconds: 12,
    usdPerSecond: 0.05,
  },
];

const falQueueSubmitSchema = z.object({
  status: z.string(),
  request_id: z.string().min(1),
  response_url: z.string().url().optional(),
  status_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
});

const falStatusSchema = z.object({
  status: z.string(),
  request_id: z.string().min(1).optional(),
  response_url: z.string().url().optional(),
  status_url: z.string().url().optional(),
  error: z.string().optional(),
});

const falResultSchema = z.object({
  video: z.object({
    url: z.string().url(),
    content_type: z.string().optional(),
  }),
});

const falWebhookSchema = z.object({
  request_id: z.string().min(1),
  status: z.enum(["OK", "ERROR"]),
  payload: z
    .object({
      video: z
        .object({
          url: z.string().url(),
          content_type: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  error: z.string().optional(),
});

function resolveModel(modelId: string): VideoModelSpec {
  const canonical = normalizeVideoModelId(modelId);
  const found = FAL_MODELS.find(
    (spec) => spec.id === canonical || spec.aliases?.includes(modelId),
  );
  if (!found) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: "fal",
      message: `Unsupported fal.ai model "${modelId}".`,
    });
  }
  return found;
}

export const falVideoProvider: VideoGenerationProvider = {
  id: "fal",
  label: "fal.ai",
  apiKeyEnvVar: "FAL_API_KEY",
  baseUrlEnvVar: "FAL_BASE_URL",
  defaultBaseUrl: "https://queue.fal.run",
  capabilities: {
    deliveryMode: "hybrid",
    supportsWebhook: true,
    supportsPolling: true,
    requiresPublicCallbackUrl: true,
    supportsIdempotencyKey: false,
    defaultTimeoutMs: 30 * 60 * 1000,
    pollIntervalMs: 10_000,
  },
  models: FAL_MODELS,
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
    const input: Record<string, unknown> = {
      prompt: renderedPrompt,
      duration: `${duration}s`,
      aspect_ratio: "9:16",
      resolution: "480p",
      generate_audio: request.hasDialogue,
      ...(imageUrls.length > 0 ? { image_urls: imageUrls } : {}),
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
        provider: "fal",
        message: "fal.ai requires a callback URL for render tasks.",
      });
    }
    const { modelSpec, renderedPrompt, input } =
      this.prepareSubmission(request);
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    const endpoint = `${baseUrl}/${modelSpec.providerModelId}?fal_webhook=${encodeURIComponent(request.callbackUrl)}`;

    const { data } = await fetchJsonWithTimeout<unknown>(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${ctx.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
      {
        provider: "fal",
        timeoutMs: 30_000,
        isBillableSubmit: true,
        fetchFn: ctx.fetchFn,
        secrets: [ctx.apiKey],
      },
    );

    const parsed = falQueueSubmitSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "fal",
        message: "fal.ai returned malformed queue submit payload.",
      });
    }

    return {
      externalJobId: parsed.data.request_id,
      renderedPrompt,
      providerModelId: modelSpec.providerModelId,
      canonicalModelId: modelSpec.id,
      providerMetadata: {
        statusUrl:
          parsed.data.status_url ??
          `${baseUrl}/${modelSpec.providerModelId}/requests/${encodeURIComponent(parsed.data.request_id)}/status`,
        responseUrl:
          parsed.data.response_url ??
          `${baseUrl}/${modelSpec.providerModelId}/requests/${encodeURIComponent(parsed.data.request_id)}`,
      },
    };
  },

  async getStatus(
    ctx: VideoProviderContext,
    ref: VideoJobRef,
  ): Promise<VideoPollStatus> {
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    const modelPath = ref.providerModelId ?? "fal-ai/seedance-2.5";
    const statusUrl =
      typeof ref.providerMetadata?.statusUrl === "string"
        ? ref.providerMetadata.statusUrl
        : `${baseUrl}/${modelPath}/requests/${encodeURIComponent(ref.externalJobId)}/status`;

    return withBackoffRetry(
      async () => {
        const { data: rawStatus } = await fetchJsonWithTimeout<unknown>(
          statusUrl,
          {
            method: "GET",
            headers: {
              Authorization: `Key ${ctx.apiKey}`,
            },
          },
          {
            provider: "fal",
            timeoutMs: 20_000,
            fetchFn: ctx.fetchFn,
            secrets: [ctx.apiKey],
          },
        );

        const parsedStatus = falStatusSchema.safeParse(rawStatus);
        if (!parsedStatus.success) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "fal",
            message: "fal.ai returned malformed status payload.",
          });
        }

        const state = parsedStatus.data.status.toUpperCase();
        if (state === "IN_QUEUE" || state === "IN_PROGRESS") {
          return { state: "pending" };
        }
        if (state === "FAILED" || state === "ERROR") {
          return {
            state: "failed",
            error: redactSecrets(
              parsedStatus.data.error || "fal.ai couldn't render this take.",
              [ctx.apiKey],
            ),
            externalJobId: parsedStatus.data.request_id ?? ref.externalJobId,
          };
        }
        if (state !== "COMPLETED") {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "fal",
            message: `fal.ai returned unexpected queue status "${parsedStatus.data.status}".`,
          });
        }

        const responseUrl =
          parsedStatus.data.response_url ??
          (typeof ref.providerMetadata?.responseUrl === "string"
            ? ref.providerMetadata.responseUrl
            : `${baseUrl}/${modelPath}/requests/${encodeURIComponent(ref.externalJobId)}`);

        const { data: rawResult } = await fetchJsonWithTimeout<unknown>(
          responseUrl,
          {
            method: "GET",
            headers: {
              Authorization: `Key ${ctx.apiKey}`,
            },
          },
          {
            provider: "fal",
            timeoutMs: 20_000,
            fetchFn: ctx.fetchFn,
            secrets: [ctx.apiKey],
          },
        );

        const parsedResult = falResultSchema.safeParse(rawResult);
        if (!parsedResult.success) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "fal",
            message: "fal.ai returned malformed completed video result.",
          });
        }

        return {
          state: "succeeded",
          artifactUrl: parsedResult.data.video.url,
          externalJobId: parsedStatus.data.request_id ?? ref.externalJobId,
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
    const parsed = falWebhookSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "fal",
        message: "Malformed fal.ai webhook payload.",
      });
    }
    const { data } = parsed;
    if (data.status === "ERROR") {
      return {
        state: "failed",
        error: redactSecrets(data.error || "fal.ai render failed"),
        externalJobId: data.request_id,
      };
    }
    const videoUrl = data.payload?.video?.url;
    if (!videoUrl) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "fal",
        message: "fal.ai webhook succeeded without payload.video.url.",
      });
    }
    return {
      state: "succeeded",
      artifactUrl: videoUrl,
      externalJobId: data.request_id,
    };
  },

  async downloadArtifact(ctx, outcome) {
    if (!outcome.artifactUrl) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "fal",
        message: "Missing fal.ai artifact URL.",
      });
    }
    return downloadVideo(outcome.artifactUrl, "Rendered take", undefined, {
      fetchFn: ctx.fetchFn,
    });
  },

  async preflight(ctx): Promise<ProviderPreflightResult> {
    const cleaned = ctx.baseUrl.replace(/\/+$/u, "");
    const preflightBase =
      cleaned === "https://queue.fal.run" ? "https://api.fal.ai" : cleaned;
    try {
      await fetchJsonWithTimeout<unknown>(
        `${preflightBase}/v1/models?limit=1`,
        {
          method: "GET",
          headers: {
            Authorization: `Key ${ctx.apiKey}`,
          },
        },
        {
          provider: "fal",
          timeoutMs: 10_000,
          fetchFn: ctx.fetchFn,
          secrets: [ctx.apiKey],
        },
      );
      return { ok: true, details: "fal.ai credentials verified" };
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
