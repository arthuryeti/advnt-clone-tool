import "server-only";

import { redactSecrets } from "@/lib/security/redact";
import {
  type AssertSafeRemoteUrlOptions,
  assertSafeRemoteUrl,
} from "@/lib/security/ssrf";

export const MAX_VIDEO_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "x-goog-api-key",
]);

export type DownloadRemoteBytesOptions = {
  label?: string;
  maxBytes?: number;
  timeoutMs?: number;
  init?: RequestInit;
  ssrf?: AssertSafeRemoteUrlOptions;
  fetchFn?: typeof fetch;
};

function sanitizeHeadersForHop(
  headersInit: HeadersInit | undefined,
  sameOrigin: boolean,
): Headers {
  const headers = new Headers(headersInit);
  if (!sameOrigin) {
    for (const key of [...headers.keys()]) {
      if (SENSITIVE_REQUEST_HEADERS.has(key.toLowerCase())) {
        headers.delete(key);
      }
    }
  }
  return headers;
}

/**
 * Downloads a remote artifact into memory with per-hop SSRF validation, cross-origin
 * credential stripping on redirects, explicit timeout, and a streaming byte cap.
 */
export async function downloadRemoteBytes(
  rawUrl: string,
  options: DownloadRemoteBytesOptions = {},
): Promise<{
  bytes: Uint8Array;
  contentType: string | null;
  finalUrl: string;
}> {
  const label = options.label ?? "file";
  const maxBytes = options.maxBytes ?? MAX_VIDEO_SIZE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const fetchImpl = options.fetchFn ?? globalThis.fetch;

  const initialUrl = await assertSafeRemoteUrl(rawUrl, options.ssrf);
  let currentUrl = initialUrl;
  let method = (options.init?.method ?? "GET").toUpperCase();

  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.init?.signal
    ? AbortSignal.any([options.init.signal, deadlineSignal])
    : deadlineSignal;

  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const sameOrigin = currentUrl.origin === initialUrl.origin;
    const headers = sanitizeHeadersForHop(options.init?.headers, sameOrigin);

    try {
      response = await fetchImpl(currentUrl.toString(), {
        ...options.init,
        method,
        headers,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw new Error(
        `Could not download ${label}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `Could not download ${label}. Redirect missing Location header.`,
        );
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Could not download ${label}. Too many redirects.`);
      }
      const nextUrl = new URL(location, currentUrl);
      currentUrl = await assertSafeRemoteUrl(nextUrl.toString(), options.ssrf);
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method === "POST")
      ) {
        method = "GET";
      }
      continue;
    }

    break;
  }

  if (!response) {
    throw new Error(`Could not download ${label}.`);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Could not download ${label}. Status ${response.status}.`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Files must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller.`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(
        `Files must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller.`,
      );
    }
    return {
      bytes,
      contentType: response.headers.get("content-type"),
      finalUrl: currentUrl.toString(),
    };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `Files must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    bytes,
    contentType: response.headers.get("content-type"),
    finalUrl: currentUrl.toString(),
  };
}

/** Downloads a remote video into memory, enforcing SSRF checks, timeouts, and the 50 MB size cap. */
export async function downloadVideo(
  url: string,
  label = "video",
  init?: RequestInit,
  options?: Omit<DownloadRemoteBytesOptions, "label" | "init">,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const { bytes, contentType } = await downloadRemoteBytes(url, {
    ...options,
    label,
    init,
    maxBytes: options?.maxBytes ?? MAX_VIDEO_SIZE_BYTES,
  });
  return { bytes, contentType };
}
