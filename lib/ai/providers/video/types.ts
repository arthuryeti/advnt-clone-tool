import type {
  TakePromptReferences,
  VideoModelPricingSpec,
} from "@/lib/content-workflows/video-clone";

export type VideoDeliveryMode = "webhook" | "polling" | "hybrid";

export type VideoModelSpec = VideoModelPricingSpec & {
  /** Display name shown in UI model picker. */
  label: string;
  /** Vendor-specific model slug sent over the wire. */
  providerModelId: string;
  maxImages: number;
  /** Token formatter for 1-based reference slot (e.g. `@image1`, `Image1`, `@img1`). */
  formatImageToken: (slot: number) => string;
};

export type VideoProviderCapabilities = {
  deliveryMode: VideoDeliveryMode;
  supportsWebhook: boolean;
  supportsPolling: boolean;
  requiresPublicCallbackUrl: boolean;
  supportsIdempotencyKey: boolean;
  defaultTimeoutMs: number;
  pollIntervalMs: number;
};

export type VideoProviderContext = {
  apiKey: string;
  baseUrl: string;
  fetchFn?: typeof fetch;
  retryBaseDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
};

export type VideoSubmitRequest = {
  model: string;
  prompt: string;
  seconds: number;
  hasDialogue: boolean;
  references: TakePromptReferences;
  idempotencyKey: string;
  callbackUrl?: string;
};

export type VideoSubmitResult = {
  externalJobId: string;
  renderedPrompt: string;
  providerModelId: string;
  canonicalModelId: string;
  providerMetadata?: Record<string, unknown>;
};

export type VideoJobRef = {
  externalJobId: string;
  providerModelId?: string;
  providerMetadata?: Record<string, unknown>;
};

export type VideoPollStatus =
  | { state: "pending" }
  | {
      state: "succeeded";
      artifactUrl: string;
      externalJobId?: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      state: "failed";
      error: string;
      externalJobId?: string;
    };

export type VideoWebhookOutcome =
  | {
      state: "succeeded";
      artifactUrl: string;
      externalJobId?: string;
    }
  | {
      state: "failed";
      error: string;
      externalJobId?: string;
    };

export type ProviderPreflightResult = {
  ok: boolean;
  kind?: string;
  details: string;
};

export interface VideoGenerationProvider {
  readonly id: string;
  readonly label: string;
  readonly apiKeyEnvVar: string;
  readonly baseUrlEnvVar: string;
  readonly defaultBaseUrl: string;
  readonly capabilities: VideoProviderCapabilities;
  readonly models: readonly VideoModelSpec[];
  readonly defaultModelId: string;

  /** Validates and formats a prompt + inputs for this provider without making a network call. */
  prepareSubmission(request: VideoSubmitRequest): {
    modelSpec: VideoModelSpec;
    renderedPrompt: string;
    imageUrls: string[];
    duration: number;
    input: Record<string, unknown>;
  };

  /** Submits one billable render job. Must NEVER auto-retry on error/timeout. */
  submit(
    ctx: VideoProviderContext,
    request: VideoSubmitRequest,
  ): Promise<VideoSubmitResult>;

  /** Polls job state (safe/idempotent; may retry transient/429 responses). */
  getStatus(
    ctx: VideoProviderContext,
    ref: VideoJobRef,
  ): Promise<VideoPollStatus>;

  /** Optional cryptographic or header verification for incoming webhook requests. */
  verifyWebhookRequest?(
    request: Request,
    rawBody: string,
    ctx: Partial<VideoProviderContext>,
  ): Promise<boolean> | boolean;

  /** Parses and Zod-validates an incoming webhook callback body. */
  parseWebhook(body: unknown): VideoWebhookOutcome;

  /** Downloads the completed video artifact safely (SSRF-checked, size/time capped). */
  downloadArtifact(
    ctx: VideoProviderContext,
    outcome: { artifactUrl?: string; externalJobId?: string },
  ): Promise<{ bytes: Uint8Array; contentType: string | null }>;

  /** Non-billable health/credential verification for preflight checks. */
  preflight(ctx: VideoProviderContext): Promise<ProviderPreflightResult>;
}

export type PublicVideoProviderInfo = {
  id: string;
  label: string;
  defaultModelId: string;
  requiresPublicCallbackUrl: boolean;
  models: Array<{
    id: string;
    label: string;
    aliases: string[];
    usdPerSecond: number;
    maxImages: number;
    minSeconds: number;
    maxSeconds: number;
  }>;
};
