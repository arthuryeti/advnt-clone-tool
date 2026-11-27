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
import { assertSafeRemoteUrl } from "@/lib/security/ssrf";
import { downloadVideo } from "@/lib/storage/download-video";

const SUME_MODELS: readonly VideoModelSpec[] = [
  {
    id: "seedance-2.5",
    label: "Seedance 2.5",
    providerModelId: "seedance-2.5",
    aliases: ["bytedance/seedance-2-5"],
    formatImageToken: (slot) => `@image${slot}`,
    maxImages: 30,
    minSeconds: 4,
    maxSeconds: 30,
    usdPerSecond: 0.1028,
  },
  {
    id: "wan-3.0",
    label: "Wan 3.0",
    providerModelId: "wan-3.0",
    aliases: ["wan/3-0-video"],
    formatImageToken: (slot) => `Image${slot}`,
    maxImages: 10,
    minSeconds: 2,
    maxSeconds: 30,
    usdPerSecond: 0.05,
  },
];

const sumeSubmitResponseSchema = z.object({
  data: z.object({
    request_id: z.string().min(1).optional(),
    job: z
      .object({
        id: z.string().min(1),
        status: z.string().optional(),
      })
      .optional(),
    status_url: z.string().url().optional(),
    result_url: z.string().url().optional(),
  }),
});

const sumeStatusResponseSchema = z.object({
  data: z
    .object({
      job: z
        .object({
          id: z.string().optional(),
          status: z.string(),
          error: z.object({ message: z.string().nullish() }).nullish(),
        })
        .optional(),
      status: z.string().optional(),
      error: z.object({ message: z.string().nullish() }).nullish(),
    })
    .optional(),
  status: z.string().optional(),
  error: z.object({ message: z.string().nullish() }).nullish(),
});

const sumeResultResponseSchema = z.object({
  data: z
    .object({
      artifacts: z
        .array(z.object({ type: z.string(), url: z.string().min(1) }))
        .optional(),
      result: z
        .object({
          output_url: z.string().min(1).optional(),
          artifacts: z
            .array(z.object({ type: z.string(), url: z.string().min(1) }))
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

const sumeWebhookSchema = z.object({
  event: z.string(),
  job_id: z.string().min(1).optional(),
  payload: z
    .object({
      artifacts: z.array(
        z.object({ type: z.string(), url: z.string().min(1) }),
      ),
    })
    .nullish(),
  error: z.object({ message: z.string().nullish() }).nullish(),
});

function resolveModel(modelId: string): VideoModelSpec {
  const canonical = normalizeVideoModelId(modelId);
  const found = SUME_MODELS.find(
    (spec) => spec.id === canonical || spec.aliases?.includes(modelId),
  );
  if (!found) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: "sume",
      message: `Unsupported Sume model "${modelId}".`,
    });
  }
  return found;
}

export const sumeVideoProvider: VideoGenerationProvider = {
  id: "sume",
  label: "Sume",
  apiKeyEnvVar: "SUME_API_KEY",
  baseUrlEnvVar: "SUME_BASE_URL",
  defaultBaseUrl: "https://api.sume.com",
  capabilities: {
    deliveryMode: "hybrid",
    supportsWebhook: true,
    supportsPolling: true,
    requiresPublicCallbackUrl: true,
    supportsIdempotencyKey: true,
    defaultTimeoutMs: 30 * 60 * 1000,
    pollIntervalMs: 15_000,
  },
  models: SUME_MODELS,
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
      duration,
      aspect_ratio: "9:16",
      ...(imageUrls.length > 0 ? { reference_image_urls: imageUrls } : {}),
      resolution: "480p",
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
        provider: "sume",
        message: "Sume requires a webhook URL for render jobs.",
      });
    }
    const { modelSpec, renderedPrompt, input } =
      this.prepareSubmission(request);
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    const { data } = await fetchJsonWithTimeout<unknown>(
      `${baseUrl}/v1/video-router/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify({
          model: modelSpec.providerModelId,
          ...input,
          mode: "webhook",
          webhook_url: request.callbackUrl,
        }),
      },
      {
        provider: "sume",
        timeoutMs: 30_000,
        isBillableSubmit: true,
        fetchFn: ctx.fetchFn,
        secrets: [ctx.apiKey],
      },
    );

    const parsed = sumeSubmitResponseSchema.safeParse(data);
    const jobId =
      parsed.success &&
      (parsed.data.data.job?.id ?? parsed.data.data.request_id);
    if (!parsed.success || !jobId) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "sume",
        message: "Sume returned malformed generate response without job id.",
      });
    }

    return {
      externalJobId: jobId,
      renderedPrompt,
      providerModelId: modelSpec.providerModelId,
      canonicalModelId: modelSpec.id,
      providerMetadata: {
        ...(parsed.data.data.status_url
          ? { statusUrl: parsed.data.data.status_url }
          : {}),
        ...(parsed.data.data.result_url
          ? { resultUrl: parsed.data.data.result_url }
          : {}),
      },
    };
  },

  async getStatus(
    ctx: VideoProviderContext,
    ref: VideoJobRef,
  ): Promise<VideoPollStatus> {
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    const metaStatusUrl =
      typeof ref.providerMetadata?.statusUrl === "string"
        ? ref.providerMetadata.statusUrl
        : `${baseUrl}/v1/jobs/${encodeURIComponent(ref.externalJobId)}/status`;
    const metaResultUrl =
      typeof ref.providerMetadata?.resultUrl === "string"
        ? ref.providerMetadata.resultUrl
        : `${baseUrl}/v1/jobs/${encodeURIComponent(ref.externalJobId)}/result`;

    await assertSafeRemoteUrl(metaStatusUrl);
    await assertSafeRemoteUrl(metaResultUrl);

    return withBackoffRetry(
      async () => {
        const { data } = await fetchJsonWithTimeout<unknown>(
          metaStatusUrl,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${ctx.apiKey}`,
            },
          },
          {
            provider: "sume",
            timeoutMs: 20_000,
            fetchFn: ctx.fetchFn,
            secrets: [ctx.apiKey],
          },
        );
        const parsed = sumeStatusResponseSchema.safeParse(data);
        if (!parsed.success) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "sume",
            message: "Sume returned malformed status payload.",
          });
        }
        const status = (
          parsed.data.data?.job?.status ??
          parsed.data.data?.status ??
          parsed.data.status ??
          ""
        ).toLowerCase();
        if (!status) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "sume",
            message: "Sume status payload omitted job status.",
          });
        }
        if (
          status === "queued" ||
          status === "pending" ||
          status === "running" ||
          status === "processing"
        ) {
          return { state: "pending" };
        }
        if (status === "failed" || status === "canceled") {
          const msg =
            parsed.data.data?.job?.error?.message ??
            parsed.data.data?.error?.message ??
            parsed.data.error?.message ??
            `Sume job ${status}`;
          return {
            state: "failed",
            error: redactSecrets(msg, [ctx.apiKey]),
            externalJobId: ref.externalJobId,
          };
        }
        if (status === "completed" || status === "succeeded") {
          const { data: resultData } = await fetchJsonWithTimeout<unknown>(
            metaResultUrl,
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${ctx.apiKey}`,
              },
            },
            {
              provider: "sume",
              timeoutMs: 20_000,
              fetchFn: ctx.fetchFn,
              secrets: [ctx.apiKey],
            },
          );
          const resultParsed = sumeResultResponseSchema.safeParse(resultData);
          if (!resultParsed.success) {
            throw new ProviderError({
              kind: "invalid_input",
              provider: "sume",
              message: "Sume returned malformed result payload.",
            });
          }
          const artifacts =
            resultParsed.data.data?.artifacts ??
            resultParsed.data.data?.result?.artifacts ??
            [];
          const videoUrl =
            artifacts.find((item) => item.type === "video")?.url ??
            resultParsed.data.data?.result?.output_url;
          if (!videoUrl) {
            throw new ProviderError({
              kind: "invalid_input",
              provider: "sume",
              message: "Sume completed without a video artifact URL.",
            });
          }
          return {
            state: "succeeded",
            artifactUrl: videoUrl,
            externalJobId: ref.externalJobId,
          };
        }
        return { state: "pending" };
      },
      {
        maxAttempts: 3,
        baseDelayMs: ctx.retryBaseDelayMs,
        sleepFn: ctx.sleepFn,
      },
    );
  },

  parseWebhook(body: unknown): VideoWebhookOutcome {
    const parsed = sumeWebhookSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "sume",
        message: "Malformed Sume webhook payload.",
      });
    }
    const { event, job_id, payload, error } = parsed.data;
    if (event !== "job.completed") {
      return {
        state: "failed",
        error: redactSecrets(error?.message || `Sume ${event}`),
        externalJobId: job_id,
      };
    }
    const url = payload?.artifacts.find(({ type }) => type === "video")?.url;
    if (!url) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "sume",
        message: "Sume finished without a video artifact URL.",
      });
    }
    return {
      state: "succeeded",
      artifactUrl: url,
      externalJobId: job_id,
    };
  },

  async downloadArtifact(ctx, outcome) {
    if (!outcome.artifactUrl) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "sume",
        message: "Missing Sume artifact URL.",
      });
    }
    return downloadVideo(outcome.artifactUrl, "Rendered take", undefined, {
      fetchFn: ctx.fetchFn,
    });
  },

  async preflight(ctx): Promise<ProviderPreflightResult> {
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    try {
      await fetchJsonWithTimeout<unknown>(
        `${baseUrl}/v1/video-router/models`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${ctx.apiKey}`,
          },
        },
        {
          provider: "sume",
          timeoutMs: 10_000,
          fetchFn: ctx.fetchFn,
          secrets: [ctx.apiKey],
        },
      );
      return { ok: true, details: "Sume credentials verified" };
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
