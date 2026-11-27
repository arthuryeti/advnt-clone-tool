import type { z } from "zod/v4";
import type { ProviderPreflightResult } from "@/lib/ai/providers/video/types";

export type TextReasoningEffort = "low" | "medium" | "high";

export type TextMessagePart =
  | { type: "text"; text: string }
  | { type: "image"; data: Uint8Array; mediaType: string };

export type TextProviderContext = {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchFn?: typeof fetch;
  retryBaseDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
};

export type StructuredTextRequest<T extends z.ZodType> = {
  system?: string;
  parts: TextMessagePart[];
  schema: T;
  schemaName: string;
  reasoningEffort?: TextReasoningEffort;
  maxTokens?: number;
};

export interface TextProvider {
  readonly id: string;
  readonly label: string;
  readonly apiKeyEnvVar: string;
  readonly baseUrlEnvVar: string;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;

  generateStructured<T extends z.ZodType>(
    ctx: TextProviderContext,
    request: StructuredTextRequest<T>,
  ): Promise<z.infer<T>>;

  preflight(ctx: TextProviderContext): Promise<ProviderPreflightResult>;
}
