import { z } from "zod/v4";

// Opus / OpenAI strict outputs reject numeric bounds, maxItems, minItems > 1, and any
// string constraint on optional fields. Move them into descriptions as hints;
// Zod still validates the full schema on the response.
const STRICT_UNSUPPORTED = [
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
  "$schema",
];

/**
 * Unwraps models that nest their JSON response under the schema's name
 * (e.g. `{"videoStory": {...}}`).
 */
export function unwrapNamedObjectText(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const values = Object.values(parsed);
      if (values.length === 1 && values[0] && typeof values[0] === "object") {
        return JSON.stringify(values[0]);
      }
    }
  } catch {
    // Ignore malformed JSON.
  }
  return null;
}

export function relaxSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(relaxSchemaNode);
  if (!node || typeof node !== "object") return node;
  const result: Record<string, unknown> = {};
  const hints: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" || key === "$defs" || key === "definitions") {
      // Keys here are field names, not JSON Schema keywords.
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([name, child]) => [name, relaxSchemaNode(child)],
        ),
      );
    } else if (
      STRICT_UNSUPPORTED.includes(key) &&
      !(key === "minItems" && (value === 0 || value === 1))
    ) {
      if (key !== "$schema") {
        hints.push(`${key}: ${JSON.stringify(value)}`);
      }
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

/** Strips top-level `$schema` and `$id` keywords for Gemini's `responseJsonSchema`. */
export function sanitizeGeminiJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeGeminiJsonSchema);
  if (!node || typeof node !== "object") return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema" || key === "$id") continue;
    if (key === "properties" || key === "$defs" || key === "definitions") {
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([name, child]) => [name, sanitizeGeminiJsonSchema(child)],
        ),
      );
    } else {
      result[key] = sanitizeGeminiJsonSchema(value);
    }
  }
  return result;
}

export function toRelaxedJsonSchema(
  schema: z.ZodType,
): Record<string, unknown> {
  return relaxSchemaNode(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export function toGeminiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitizeGeminiJsonSchema(z.toJSONSchema(schema)) as Record<
    string,
    unknown
  >;
}

export function parseStructuredJson<T extends z.ZodType>(
  schema: T,
  rawText: string,
): z.infer<T> {
  const tryParse = (text: string): unknown => JSON.parse(text);
  let parsedJson: unknown;
  try {
    parsedJson = tryParse(rawText);
  } catch {
    throw new Error("Structured output was not valid JSON.");
  }
  const direct = schema.safeParse(parsedJson);
  if (direct.success) return direct.data;

  const unwrapped = unwrapNamedObjectText(rawText);
  if (unwrapped) {
    const second = schema.safeParse(tryParse(unwrapped));
    if (second.success) return second.data;
  }
  return schema.parse(parsedJson);
}
