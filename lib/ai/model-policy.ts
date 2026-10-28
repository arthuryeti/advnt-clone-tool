import "server-only";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env } from "@/lib/env";

const surplusOptions = {
  name: "surplus",
  apiKey: env.SURPLUS_API_KEY,
  baseURL: "https://api.surplusintelligence.ai/v1",
  supportsStructuredOutputs: true,
};

/** Rewrites the clone's prompts and script (Opus). */
export const TEXT_MODEL = createOpenAICompatible({
  ...surplusOptions,
  transformRequestBody: relaxOutputSchema,
})("claude-opus-5.5");
/**
 * Watches videos (picture + sound), called through `describeVideo`: the AI SDK provider
 * rejects video parts.
 */
export const VIDEO_MODEL_ID = "gemini-3.8-flash";
// Opus on Surplus rejects disabled reasoning, so there is no "none".
export type ReasoningEffort = "low" | "medium" | "high";

export function getReasoningOptions(reasoningEffort: ReasoningEffort) {
  return {
    surplus: { reasoningEffort },
  } as const;
}

/**
 * generateObject's experimental_repairText: Opus sometimes nests its answer under the schema's
 * name ({"videoStory": {...}}); a lone object-valued key is unwrapped.
 */
export async function unwrapNamedObject({
  text,
}: {
  text: string;
}): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const values = Object.values(parsed);
      if (values.length === 1 && values[0] && typeof values[0] === "object") {
        return JSON.stringify(values[0]);
      }
    }
  } catch {}
  return null;
}

// Opus strict outputs reject numeric bounds, maxItems, minItems > 1, and any
// string constraint on optional fields. Move them into descriptions as hints;
// generateObject still validates the full Zod schema on the response.
const OPUS_UNSUPPORTED = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "maxItems",
  "minItems",
];

function relaxOutputSchema(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const format = body.response_format as
    | { json_schema?: { schema?: unknown } }
    | undefined;
  if (!format?.json_schema?.schema) return body;
  return {
    ...body,
    response_format: {
      ...format,
      json_schema: {
        ...format.json_schema,
        schema: relaxSchemaNode(format.json_schema.schema),
      },
    },
  };
}

export function relaxSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(relaxSchemaNode);
  if (!node || typeof node !== "object") return node;
  const result: Record<string, unknown> = {};
  const hints: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" || key === "$defs" || key === "definitions") {
      // Keys here are field names, not keywords.
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([name, child]) => [name, relaxSchemaNode(child)],
        ),
      );
    } else if (
      OPUS_UNSUPPORTED.includes(key) &&
      !(key === "minItems" && (value === 0 || value === 1))
    ) {
      hints.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      result[key] = relaxSchemaNode(value);
    }
  }
  if (hints.length > 0) {
    result.description = [result.description, `(${hints.join(", ")})`]
      .filter(Boolean)
      .join(" ");
  }
  return result;
}
