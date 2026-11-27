import "server-only";

import { z } from "zod/v4";
import { ProviderError } from "@/lib/ai/errors";
import { fetchJsonWithTimeout, withBackoffRetry } from "@/lib/ai/http";
import {
  parseStructuredJson,
  toRelaxedJsonSchema,
} from "@/lib/ai/providers/text/schema-utils";
import type {
  StructuredTextRequest,
  TextProvider,
  TextProviderContext,
} from "@/lib/ai/providers/text/types";
import type { ProviderPreflightResult } from "@/lib/ai/providers/video/types";
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

export function createOpenAICompatibleTextProvider(config: {
  id: string;
  label: string;
  apiKeyEnvVar: string;
  baseUrlEnvVar: string;
  defaultBaseUrl: string;
  defaultModel: string;
  preflightPath: string;
  includeReasoningEffort?: boolean;
}): TextProvider {
  return {
    id: config.id,
    label: config.label,
    apiKeyEnvVar: config.apiKeyEnvVar,
    baseUrlEnvVar: config.baseUrlEnvVar,
    defaultBaseUrl: config.defaultBaseUrl,
    defaultModel: config.defaultModel,

    async generateStructured<T extends z.ZodType>(
      ctx: TextProviderContext,
      request: StructuredTextRequest<T>,
    ): Promise<z.infer<T>> {
      const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
      const messages: Array<Record<string, unknown>> = [];
      if (request.system) {
        messages.push({ role: "system", content: request.system });
      }
      messages.push({
        role: "user",
        content: request.parts.map((part) => {
          if (part.type === "text") {
            return { type: "text", text: part.text };
          }
          return {
            type: "image_url",
            image_url: {
              url: `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`,
            },
          };
        }),
      });

      const body = JSON.stringify({
        model: ctx.model,
        ...(config.includeReasoningEffort && request.reasoningEffort
          ? { reasoning_effort: request.reasoningEffort }
          : {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.schemaName,
            strict: true,
            schema: toRelaxedJsonSchema(request.schema),
          },
        },
        messages,
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
              message: `${config.label} returned empty structured output.`,
            });
          }

          try {
            return parseStructuredJson(request.schema, content);
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

export const openaiTextProvider = createOpenAICompatibleTextProvider({
  id: "openai",
  label: "OpenAI",
  apiKeyEnvVar: "OPENAI_API_KEY",
  baseUrlEnvVar: "OPENAI_BASE_URL",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4.1",
  preflightPath: "/models",
});

export const openrouterTextProvider = createOpenAICompatibleTextProvider({
  id: "openrouter",
  label: "OpenRouter",
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  baseUrlEnvVar: "OPENROUTER_BASE_URL",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  defaultModel: "anthropic/claude-sonnet-4.5",
  preflightPath: "/auth/key",
});

export const surplusTextProvider = createOpenAICompatibleTextProvider({
  id: "surplus",
  label: "Surplus",
  apiKeyEnvVar: "SURPLUS_API_KEY",
  baseUrlEnvVar: "SURPLUS_BASE_URL",
  defaultBaseUrl: "https://api.surplusintelligence.ai/v1",
  defaultModel: "claude-opus-5.5",
  preflightPath: "/models",
  includeReasoningEffort: true,
});
