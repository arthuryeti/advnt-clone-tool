import { setTimeout as sleep } from "node:timers/promises";
import { classifyHttpStatus, ProviderError } from "@/lib/ai/errors";
import { redactSecrets } from "@/lib/security/redact";

const MAX_RETRY_AFTER_MS = 60_000;

export function parseRetryAfterMs(
  headerValue: string | null,
): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const ms = Math.round(Number(trimmed) * 1000);
    return Number.isFinite(ms)
      ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms))
      : undefined;
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) {
    const ms = Math.max(0, timestamp - Date.now());
    return Math.min(MAX_RETRY_AFTER_MS, ms);
  }
  return undefined;
}

function extractBodyErrorMessage(
  body: unknown,
  rawText: string,
): {
  message?: string;
  code?: string | number;
} {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const nestedError =
      obj.error && typeof obj.error === "object"
        ? (obj.error as Record<string, unknown>)
        : undefined;
    const message =
      (typeof nestedError?.message === "string" && nestedError.message) ||
      (typeof obj.msg === "string" && obj.msg) ||
      (typeof obj.message === "string" && obj.message) ||
      (typeof obj.detail === "string" && obj.detail) ||
      undefined;
    const code =
      (typeof nestedError?.code === "string" ||
      typeof nestedError?.code === "number"
        ? nestedError.code
        : undefined) ??
      (typeof nestedError?.type === "string" ? nestedError.type : undefined) ??
      (typeof nestedError?.status === "string"
        ? nestedError.status
        : undefined) ??
      (typeof obj.code === "string" || typeof obj.code === "number"
        ? obj.code
        : undefined);
    return { message, code };
  }
  const cleanText = rawText.trim().slice(0, 300);
  return { message: cleanText || undefined };
}

export type FetchJsonOptions = {
  provider: string;
  timeoutMs: number;
  isBillableSubmit?: boolean;
  fetchFn?: typeof fetch;
  /** Optional secrets to redact from any constructed error message. */
  secrets?: readonly string[];
};

/**
 * Performs an HTTP JSON request with an explicit AbortSignal timeout and structured
 * ProviderError classification. Never retries on its own; callers wrap idempotent calls
 * in `withBackoffRetry`.
 */
export async function fetchJsonWithTimeout<T = unknown>(
  url: string,
  init: RequestInit,
  options: FetchJsonOptions,
): Promise<{ status: number; headers: Headers; data: T }> {
  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
      options.secrets,
    );
    throw new ProviderError({
      kind: options.isBillableSubmit ? "ambiguous_submit" : "transient",
      provider: options.provider,
      message: `${options.provider} request failed: ${message}`,
      cause: error,
    });
  }

  let rawText = "";
  try {
    rawText = await response.text();
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
      options.secrets,
    );
    throw new ProviderError({
      kind: options.isBillableSubmit ? "ambiguous_submit" : "transient",
      provider: options.provider,
      status: response.status,
      message: `${options.provider} response stream failed: ${message}`,
      cause: error,
    });
  }

  let parsed: unknown = null;
  if (rawText.length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const { message, code } = extractBodyErrorMessage(parsed, rawText);
    const kind = classifyHttpStatus(response.status, message ?? "", {
      code,
      isBillableSubmit: options.isBillableSubmit,
    });
    const retryAfterMs =
      kind === "rate_limited"
        ? parseRetryAfterMs(response.headers.get("retry-after"))
        : undefined;
    throw new ProviderError({
      kind,
      provider: options.provider,
      status: response.status,
      code,
      retryAfterMs,
      message: redactSecrets(
        `${options.provider} HTTP ${response.status}: ${message ?? "request failed"}`,
        options.secrets,
      ),
    });
  }

  if (parsed === null) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: options.provider,
      status: response.status,
      message: redactSecrets(
        `${options.provider} returned malformed JSON response.`,
        options.secrets,
      ),
    });
  }

  return {
    status: response.status,
    headers: response.headers,
    data: parsed as T,
  };
}

export type BackoffRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  jitterFactor?: number;
};

/**
 * Retries ONLY safe retryable errors (`rate_limited`, `transient`) with exponential backoff + jitter,
 * honoring `Retry-After` when provided. Auth, quota, moderation, invalid_input, and ambiguous_submit
 * fail fast on attempt 1.
 */
export async function withBackoffRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: BackoffRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const envBase = Number.parseInt(process.env.PROVIDER_RETRY_BASE_MS ?? "", 10);
  const baseDelayMs =
    options.baseDelayMs ??
    (Number.isFinite(envBase) && envBase >= 0 ? envBase : 500);
  const maxDelayMs = options.maxDelayMs ?? 15_000;
  const sleepFn = options.sleepFn ?? ((ms: number) => sleep(ms));
  const jitterFactor = options.jitterFactor ?? 0.25;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      const retryable = error instanceof ProviderError && error.retryable;
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = exp * jitterFactor * Math.random();
      const delay = error.retryAfterMs ?? Math.round(exp + jitter);
      if (delay > 0) {
        await sleepFn(Math.min(maxDelayMs, delay));
      }
    }
  }
}
