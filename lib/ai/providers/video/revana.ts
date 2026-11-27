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

const REVANA_MODELS: readonly VideoModelSpec[] = [
  {
    id: "seedance-2.5",
    label: "Seedance 2.5",
    providerModelId: "seedance-2.5",
    aliases: ["bytedance/seedance-2-5"],
    formatImageToken: (slot) => `@image${slot}`,
    maxImages: 30,
    minSeconds: 4,
    maxSeconds: 30,
    usdPerSecond: 0.11,
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

const revanaGenerationSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  error: z.object({ message: z.string().nullish() }).nullish(),
});

function resolveModel(modelId: string): VideoModelSpec {
  const canonical = normalizeVideoModelId(modelId);
  const found = REVANA_MODELS.find(
    (spec) => spec.id === canonical || spec.aliases?.includes(modelId),
  );
  if (!found) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: "revana",
      message: `Unsupported Revana model "${modelId}".`,
    });
  }
  return found;
}

export const revanaVideoProvider: VideoGenerationProvider = {
  id: "revana",
  label: "Revana",
  apiKeyEnvVar: "REVANA_API_KEY",
  baseUrlEnvVar: "REVANA_BASE_URL",
  defaultBaseUrl: "https://api.revana.si/v1",
  capabilities: {
    deliveryMode: "polling",
    supportsWebhook: false,
    supportsPolling: true,
    requiresPublicCallbackUrl: false,
    supportsIdempotencyKey: true,
    defaultTimeoutMs: 45 * 60 * 1000,
    pollIntervalMs: 20_000,
  },
  models: REVANA_MODELS,
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
      ...(imageUrls.length > 0 ? { image_urls: imageUrls } : {}),
      resolution: "480p",
      audio: request.hasDialogue,
    };
    return { modelSpec, renderedPrompt, imageUrls, duration, input };
  },

  async submit(
    ctx: VideoProviderContext,
    request: VideoSubmitRequest,
  ): Promise<VideoSubmitResult> {
    const { modelSpec, renderedPrompt, input } =
      this.prepareSubmission(request);
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    const { data } = await fetchJsonWithTimeout<unknown>(
      `${baseUrl}/generations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify({
          model: modelSpec.providerModelId,
          input,
        }),
      },
      {
        provider: "revana",
        timeoutMs: 30_000,
        isBillableSubmit: true,
        fetchFn: ctx.fetchFn,
        secrets: [ctx.apiKey],
      },
    );

    const parsed = revanaGenerationSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "revana",
        message: "Revana returned malformed generation payload.",
      });
    }

    return {
      externalJobId: parsed.data.id,
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
          `${baseUrl}/generations/${encodeURIComponent(ref.externalJobId)}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${ctx.apiKey}`,
            },
          },
          {
            provider: "revana",
            timeoutMs: 20_000,
            fetchFn: ctx.fetchFn,
            secrets: [ctx.apiKey],
          },
        );
        const parsed = revanaGenerationSchema.safeParse(data);
        if (!parsed.success) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "revana",
            message: "Revana returned malformed generation status.",
          });
        }
        if (parsed.data.status === "succeeded") {
          return {
            state: "succeeded",
            artifactUrl: `${baseUrl}/generations/${encodeURIComponent(ref.externalJobId)}/content`,
            externalJobId: parsed.data.id,
          };
        }
        if (parsed.data.status === "failed") {
          return {
            state: "failed",
            error: redactSecrets(
              parsed.data.error?.message || "Revana couldn't render this take.",
              [ctx.apiKey],
            ),
            externalJobId: parsed.data.id,
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

  parseWebhook(): VideoWebhookOutcome {
    throw new ProviderError({
      kind: "invalid_input",
      provider: "revana",
      message: "Revana does not use webhooks.",
    });
  },

  async downloadArtifact(ctx, outcome) {
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    const url =
      outcome.artifactUrl ??
      (outcome.externalJobId
        ? `${baseUrl}/generations/${encodeURIComponent(outcome.externalJobId)}/content`
        : undefined);
    if (!url) {
      throw new ProviderError({
        kind: "invalid_input",
        provider: "revana",
        message: "Missing Revana generation id/artifact URL.",
      });
    }
    return downloadVideo(
      url,
      "Rendered take",
      { headers: { Authorization: `Bearer ${ctx.apiKey}` } },
      { fetchFn: ctx.fetchFn },
    );
  },

  async preflight(ctx): Promise<ProviderPreflightResult> {
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    try {
      await fetchJsonWithTimeout<unknown>(
        `${baseUrl}/balance`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${ctx.apiKey}`,
          },
        },
        {
          provider: "revana",
          timeoutMs: 10_000,
          fetchFn: ctx.fetchFn,
          secrets: [ctx.apiKey],
        },
      );
      return { ok: true, details: "Revana credentials verified" };
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
