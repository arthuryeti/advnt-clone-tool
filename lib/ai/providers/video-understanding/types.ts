import type { z } from "zod/v4";
import type { ProviderPreflightResult } from "@/lib/ai/providers/video/types";

export type VideoUnderstandingContext = {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchFn?: typeof fetch;
  retryBaseDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
};

export interface VideoUnderstandingProvider {
  readonly id: string;
  readonly label: string;
  readonly apiKeyEnvVar: string;
  readonly baseUrlEnvVar: string;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
  readonly maxInlineVideoBytes: number;

  describeVideo<T extends z.ZodType>(
    ctx: VideoUnderstandingContext,
    input: {
      videos: Buffer[];
      prompt: string;
      schema: T;
    },
  ): Promise<z.infer<T>>;

  preflight(ctx: VideoUnderstandingContext): Promise<ProviderPreflightResult>;
}
