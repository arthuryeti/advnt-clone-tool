import "server-only";

import { z } from "zod/v4";
import { ProviderError } from "@/lib/ai/errors";
import { fetchJsonWithTimeout, withBackoffRetry } from "@/lib/ai/http";
import {
  parseStructuredJson,
  toGeminiJsonSchema,
} from "@/lib/ai/providers/text/schema-utils";
import type {
  StructuredTextRequest,
  TextProvider,
  TextProviderContext,
} from "@/lib/ai/providers/text/types";
import type { ProviderPreflightResult } from "@/lib/ai/providers/video/types";
import { redactSecrets } from "@/lib/security/redact";

const geminiResponseSchema = z.object({
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z
          .object({
            parts: z
              .array(z.object({ text: z.string().optional() }))
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

export const geminiTextProvider: TextProvider = {
  id: "gemini",
  label: "Google Gemini",
  apiKeyEnvVar: "GEMINI_API_KEY",
  baseUrlEnvVar: "GEMINI_BASE_URL",
  defaultBaseUrl: "https://generativelanguage.googleapis.com",
  defaultModel: "gemini-2.5-flash",

  async generateStructured<T extends z.ZodType>(
    ctx: TextProviderContext,
    request: StructuredTextRequest<T>,
  ): Promise<z.infer<T>> {
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    const parts = request.parts.map((part) => {
      if (part.type === "text") {
        return { text: part.text };
      }
      return {
        inline_data: {
          mime_type: part.mediaType,
          data: Buffer.from(part.data).toString("base64"),
        },
      };
    });

    const body = JSON.stringify({
      ...(request.system
        ? { system_instruction: { parts: [{ text: request.system }] } }
        : {}),
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiJsonSchema(request.schema),
      },
    });

    return withBackoffRetry(
      async () => {
        const { data } = await fetchJsonWithTimeout<unknown>(
          `${baseUrl}/v1beta/models/${encodeURIComponent(ctx.model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "x-goog-api-key": ctx.apiKey,
              "Content-Type": "application/json",
            },
            body,
          },
          {
            provider: "gemini",
            timeoutMs: 180_000,
            fetchFn: ctx.fetchFn,
            secrets: [ctx.apiKey],
          },
        );

        const parsed = geminiResponseSchema.safeParse(data);
        if (!parsed.success) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "gemini",
            message: "Gemini returned malformed generateContent response.",
          });
        }
        const blockReason = parsed.data.promptFeedback?.blockReason;
        const finishReason = parsed.data.candidates?.[0]?.finishReason;
        if (
          blockReason === "SAFETY" ||
          blockReason === "PROHIBITED_CONTENT" ||
          finishReason === "SAFETY"
        ) {
          throw new ProviderError({
            kind: "moderation",
            provider: "gemini",
            message: `Gemini blocked response (${blockReason ?? finishReason}).`,
          });
        }

        const text = parsed.data.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? "")
          .join("")
          .trim();
        if (!text) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "gemini",
            message: "Gemini returned empty text output.",
          });
        }

        try {
          return parseStructuredJson(request.schema, text);
        } catch (error) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "gemini",
            message: `Gemini returned malformed structured output: ${error instanceof Error ? error.message : String(error)}`,
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
        `${baseUrl}/v1beta/models/${encodeURIComponent(ctx.model)}`,
        {
          method: "GET",
          headers: {
            "x-goog-api-key": ctx.apiKey,
          },
        },
        {
          provider: "gemini",
          timeoutMs: 10_000,
          fetchFn: ctx.fetchFn,
          secrets: [ctx.apiKey],
        },
      );
      return { ok: true, details: `Gemini (${ctx.model}) verified` };
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
