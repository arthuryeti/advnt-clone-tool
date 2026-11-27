import "server-only";

import { z } from "zod/v4";
import { ProviderError } from "@/lib/ai/errors";
import { fetchJsonWithTimeout, withBackoffRetry } from "@/lib/ai/http";
import {
  parseStructuredJson,
  toRelaxedJsonSchema,
} from "@/lib/ai/providers/text/schema-utils";
import type { ProviderPreflightResult } from "@/lib/ai/providers/video/types";
import type {
  VideoUnderstandingContext,
  VideoUnderstandingProvider,
} from "@/lib/ai/providers/video-understanding/types";
import { redactSecrets } from "@/lib/security/redact";

const chatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

function createChatCompletionsVideoProvider(config: {
  id: string;
  label: string;
  apiKeyEnvVar: string;
  baseUrlEnvVar: string;
  defaultBaseUrl: string;
  defaultModel: string;
  preflightPath: string;
  extraBody?: Record<string, unknown>;
}): VideoUnderstandingProvider {
  return {
    id: config.id,
    label: config.label,
    apiKeyEnvVar: config.apiKeyEnvVar,
    baseUrlEnvVar: config.baseUrlEnvVar,
    defaultBaseUrl: config.defaultBaseUrl,
    defaultModel: config.defaultModel,
    maxInlineVideoBytes: 7_500_000,

    async describeVideo<T extends z.ZodType>(
      ctx: VideoUnderstandingContext,
      input: { videos: Buffer[]; prompt: string; schema: T },
    ): Promise<z.infer<T>> {
      const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
      const body = JSON.stringify({
        model: ctx.model,
        ...config.extraBody,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "out",
            strict: true,
            schema: toRelaxedJsonSchema(input.schema),
          },
        },
        messages: [
          {
            role: "user",
            content: [
              ...input.videos.map((video) => ({
                type: "image_url",
                image_url: {
                  url: `data:video/mp4;base64,${video.toString("base64")}`,
                },
              })),
              { type: "text", text: input.prompt },
            ],
          },
        ],
      });

      return withBackoffRetry(
        async () => {
          const { data } = await fetchJsonWithTimeout<unknown>(
            `${baseUrl}/chat/completions`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${ctx.apiKey}`,
                "Content-Type": "application/json",
              },
              body,
            },
            {
              provider: config.id,
              timeoutMs: 180_000,
              fetchFn: ctx.fetchFn,
              secrets: [ctx.apiKey],
            },
          );

          const parsed = chatCompletionSchema.safeParse(data);
          const content = parsed.success
            ? parsed.data.choices?.[0]?.message?.content
            : undefined;
          if (!content) {
            throw new ProviderError({
              kind: "invalid_input",
              provider: config.id,
              message: `${config.label} video call returned empty content.`,
            });
          }

          try {
            return parseStructuredJson(input.schema, content);
          } catch (error) {
            throw new ProviderError({
              kind: "invalid_input",
              provider: config.id,
              message: `${config.label} returned malformed structured output: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
            });
          }
        },
        {
          maxAttempts: 3,
          baseDelayMs: ctx.retryBaseDelayMs,
          sleepFn: ctx.sleepFn,
        },
      );
    },

    async preflight(ctx): Promise<ProviderPreflightResult> {
      const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
      try {
        await fetchJsonWithTimeout<unknown>(
          `${baseUrl}${config.preflightPath}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${ctx.apiKey}`,
            },
          },
          {
            provider: config.id,
            timeoutMs: 10_000,
            fetchFn: ctx.fetchFn,
            secrets: [ctx.apiKey],
          },
        );
        return { ok: true, details: `${config.label} (${ctx.model}) verified` };
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
}

export const openrouterVideoUnderstandingProvider =
  createChatCompletionsVideoProvider({
    id: "openrouter",
    label: "OpenRouter",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    baseUrlEnvVar: "OPENROUTER_BASE_URL",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemini-2.5-flash",
    preflightPath: "/auth/key",
  });

export const surplusVideoUnderstandingProvider =
  createChatCompletionsVideoProvider({
    id: "surplus",
    label: "Surplus",
    apiKeyEnvVar: "SURPLUS_API_KEY",
    baseUrlEnvVar: "SURPLUS_BASE_URL",
    defaultBaseUrl: "https://api.surplusintelligence.ai/v1",
    defaultModel: "gemini-3.8-flash",
    preflightPath: "/models",
    extraBody: { provider: ["google", "openrouter"] },
  });
