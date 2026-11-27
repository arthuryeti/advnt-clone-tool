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

const anthropicResponseSchema = z.object({
  content: z
    .array(
      z.object({
        type: z.string(),
        name: z.string().optional(),
        input: z.unknown().optional(),
        text: z.string().optional(),
      }),
    )
    .optional(),
});

const TOOL_NAME = "submit_structured_output";

export const anthropicTextProvider: TextProvider = {
  id: "anthropic",
  label: "Anthropic",
  apiKeyEnvVar: "ANTHROPIC_API_KEY",
  baseUrlEnvVar: "ANTHROPIC_BASE_URL",
  defaultBaseUrl: "https://api.anthropic.com",
  defaultModel: "claude-sonnet-4-5",

  async generateStructured<T extends z.ZodType>(
    ctx: TextProviderContext,
    request: StructuredTextRequest<T>,
  ): Promise<z.infer<T>> {
    const baseUrl = ctx.baseUrl.replace(/\/+$/u, "");
    const content = request.parts.map((part) => {
      if (part.type === "text") {
        return { type: "text", text: part.text };
      }
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType,
          data: Buffer.from(part.data).toString("base64"),
        },
      };
    });

    const body = JSON.stringify({
      model: ctx.model,
      max_tokens: request.maxTokens ?? 8192,
      ...(request.system ? { system: request.system } : {}),
      tools: [
        {
          name: TOOL_NAME,
          description: `Return structured ${request.schemaName} JSON matching the schema.`,
          input_schema: toRelaxedJsonSchema(request.schema),
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [{ role: "user", content }],
    });

    return withBackoffRetry(
      async () => {
        const { data } = await fetchJsonWithTimeout<unknown>(
          `${baseUrl}/v1/messages`,
          {
            method: "POST",
            headers: {
              "x-api-key": ctx.apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body,
          },
          {
            provider: "anthropic",
            timeoutMs: 180_000,
            fetchFn: ctx.fetchFn,
            secrets: [ctx.apiKey],
          },
        );

        const parsed = anthropicResponseSchema.safeParse(data);
        if (!parsed.success) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "anthropic",
            message: "Anthropic returned malformed messages response.",
          });
        }

        const toolBlock = parsed.data.content?.find(
          (block) => block.type === "tool_use" && block.name === TOOL_NAME,
        );
        if (toolBlock?.input !== undefined) {
          try {
            return parseStructuredJson(
              request.schema,
              JSON.stringify(toolBlock.input),
            );
          } catch (error) {
            throw new ProviderError({
              kind: "invalid_input",
              provider: "anthropic",
              message: `Anthropic structured tool output failed validation: ${error instanceof Error ? error.message : String(error)}`,
              cause: error,
            });
          }
        }

        const textBlock = parsed.data.content?.find(
          (block) => block.type === "text" && typeof block.text === "string",
        );
        if (!textBlock?.text) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "anthropic",
            message: "Anthropic returned no structured output.",
          });
        }

        try {
          return parseStructuredJson(request.schema, textBlock.text);
        } catch (error) {
          throw new ProviderError({
            kind: "invalid_input",
            provider: "anthropic",
            message: `Anthropic returned malformed structured output: ${error instanceof Error ? error.message : String(error)}`,
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
        `${baseUrl}/v1/models?limit=1`,
        {
          method: "GET",
          headers: {
            "x-api-key": ctx.apiKey,
            "anthropic-version": "2023-06-01",
          },
        },
        {
          provider: "anthropic",
          timeoutMs: 10_000,
          fetchFn: ctx.fetchFn,
          secrets: [ctx.apiKey],
        },
      );
      return { ok: true, details: `Anthropic (${ctx.model}) verified` };
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
