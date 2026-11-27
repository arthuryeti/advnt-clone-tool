import "server-only";

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  listTextProviders,
  resolveActiveTextProvider,
} from "@/lib/ai/providers/text/registry";
import {
  listVideoProviders,
  resolveActiveVideoProvider,
} from "@/lib/ai/providers/video/registry";
import {
  listVideoUnderstandingProviders,
  resolveActiveVideoUnderstandingProvider,
} from "@/lib/ai/providers/video-understanding/registry";
import { db } from "@/lib/db";
import {
  getImagesBucketName,
  getS3Config,
  getSiteUrl,
  getTextProviderId,
  getVideoAnalysisProviderId,
  getVideoProviderId,
} from "@/lib/env";
import { redactSecrets } from "@/lib/security/redact";
import { isBlockedHostname, isBlockedIp } from "@/lib/security/ssrf";
import {
  deleteObject,
  getPublicSignedUrl,
  headBucket,
  putObject,
} from "@/lib/storage";
import { getErrorMessage } from "@/lib/utils";
import { FFMPEG, FFPROBE, run } from "@/trigger/run-command";

export type PreflightScope = "all" | "analyze" | "rewrite" | "render";

export type PreflightCheck = {
  name: string;
  ok: boolean;
  details: string;
  errorKind?: string;
};

export type PreflightReport = {
  ok: boolean;
  checkedAt: string;
  scope: PreflightScope;
  checks: PreflightCheck[];
};

const PREFLIGHT_CACHE_TTL_MS = 30_000;
let cachedReport: {
  fingerprint: string;
  expiresAt: number;
  report: PreflightReport;
} | null = null;

function isLoopbackOrPrivateUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (isBlockedHostname(host)) return true;
    if (/^\d+\.\d+\.\d+\.\d+$/u.test(host) || host.includes(":")) {
      return isBlockedIp(host);
    }
    return false;
  } catch {
    return true;
  }
}

function buildConfigFingerprint(scope: PreflightScope): string {
  const hash = createHash("sha256");
  const pieces = [
    scope,
    getSiteUrl(),
    process.env.DATABASE_URL ?? "",
    process.env.S3_ENDPOINT ?? "",
    process.env.S3_PUBLIC_ENDPOINT ?? "",
    process.env.S3_ACCESS_KEY_ID ?? "",
    process.env.S3_SECRET_ACCESS_KEY ?? "",
    getImagesBucketName(),
    getVideoProviderId(),
    getVideoAnalysisProviderId() ?? "",
    getTextProviderId() ?? "",
    process.env.PREFLIGHT_ALLOW_LOCAL_URLS ?? "",
  ];
  for (const provider of [
    ...listVideoProviders(),
    ...listVideoUnderstandingProviders(),
    ...listTextProviders(),
  ]) {
    pieces.push(process.env[provider.apiKeyEnvVar] ?? "");
    pieces.push(process.env[provider.baseUrlEnvVar] ?? "");
  }
  for (const piece of pieces) {
    hash.update(piece);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function resetPreflightCacheForTests(): void {
  cachedReport = null;
}

async function checkDatabase(): Promise<PreflightCheck> {
  try {
    await db.execute(sql`SELECT 1`);
    return { name: "database", ok: true, details: "Postgres reachable" };
  } catch (error) {
    return {
      name: "database",
      ok: false,
      errorKind: "transient",
      details: getErrorMessage(error),
    };
  }
}

async function checkBinaries(): Promise<PreflightCheck> {
  try {
    await Promise.all([
      run(FFMPEG, ["-version"], {
        timeoutMs: 5000,
        skipConcurrencyLimit: true,
      }),
      run(FFPROBE, ["-version"], {
        timeoutMs: 5000,
        skipConcurrencyLimit: true,
      }),
      run("yt-dlp", ["--version"], {
        timeoutMs: 5000,
        skipConcurrencyLimit: true,
      }),
    ]);
    return {
      name: "binaries",
      ok: true,
      details: "ffmpeg, ffprobe, and yt-dlp available",
    };
  } catch (error) {
    return {
      name: "binaries",
      ok: false,
      errorKind: "invalid_input",
      details: getErrorMessage(error),
    };
  }
}

async function checkS3Bucket(): Promise<PreflightCheck> {
  try {
    const s3 = getS3Config();
    await headBucket(s3.bucket);
    return {
      name: "storage_s3",
      ok: true,
      details: `S3 bucket "${s3.bucket}" accessible`,
    };
  } catch (error) {
    return {
      name: "storage_s3",
      ok: false,
      errorKind: "transient",
      details: getErrorMessage(error),
    };
  }
}

async function checkS3PublicReachability(
  providerBaseUrl: string | undefined,
  fetchFn: typeof fetch,
): Promise<PreflightCheck> {
  const probePath = `preflight-probes/probe-${crypto.randomUUID()}.txt`;
  try {
    const s3 = getS3Config();
    const allowLocal =
      process.env.PREFLIGHT_ALLOW_LOCAL_URLS === "true" ||
      (providerBaseUrl ? isLoopbackOrPrivateUrl(providerBaseUrl) : false);

    if (!allowLocal && isLoopbackOrPrivateUrl(s3.publicEndpoint)) {
      return {
        name: "s3_public_reachability",
        ok: false,
        errorKind: "invalid_input",
        details: `S3 public endpoint (${s3.publicEndpoint}) is private/loopback and unreachable by remote video providers. Set S3_PUBLIC_ENDPOINT to a publicly reachable S3 URL.`,
      };
    }

    await putObject(
      probePath,
      s3.bucket,
      new TextEncoder().encode("ok"),
      "text/plain",
    );
    const signedUrl = await getPublicSignedUrl(probePath, s3.bucket, 60);
    const response = await fetchFn(signedUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return {
        name: "s3_public_reachability",
        ok: false,
        errorKind: "transient",
        details: `Signed S3 probe returned HTTP ${response.status}`,
      };
    }
    return {
      name: "s3_public_reachability",
      ok: true,
      details: `Signed S3 URL reachable (${new URL(signedUrl).origin})`,
    };
  } catch (error) {
    return {
      name: "s3_public_reachability",
      ok: false,
      errorKind: "transient",
      details: redactSecrets(getErrorMessage(error)),
    };
  } finally {
    const bucket = getImagesBucketName();
    await deleteObject(probePath, bucket).catch(() => undefined);
  }
}

async function checkCallbackUrl(
  providerLabel: string,
  providerBaseUrl: string,
  fetchFn: typeof fetch,
): Promise<PreflightCheck> {
  try {
    const siteUrl = getSiteUrl();
    const allowLocal =
      process.env.PREFLIGHT_ALLOW_LOCAL_URLS === "true" ||
      isLoopbackOrPrivateUrl(providerBaseUrl);

    if (!allowLocal && isLoopbackOrPrivateUrl(siteUrl)) {
      return {
        name: "callback_url",
        ok: false,
        errorKind: "invalid_input",
        details: `SITE_URL (${siteUrl}) is private/loopback and unreachable by ${providerLabel} webhooks. Set SITE_URL to a public HTTPS URL.`,
      };
    }

    const healthUrl = `${siteUrl}/api/waitpoints/health`;
    const response = await fetchFn(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return {
        name: "callback_url",
        ok: false,
        errorKind: "transient",
        details: `Callback health endpoint ${healthUrl} returned HTTP ${response.status}`,
      };
    }
    return {
      name: "callback_url",
      ok: true,
      details: `Waitpoint callback reachable at ${siteUrl}`,
    };
  } catch (error) {
    return {
      name: "callback_url",
      ok: false,
      errorKind: "transient",
      details: redactSecrets(getErrorMessage(error)),
    };
  }
}

/**
 * Non-billable doctor/preflight check verifying configured keys across active AI planes,
 * local media binaries, database, S3 public reachability, and webhook callback reachability.
 */
export async function runPreflight(
  options: {
    scope?: PreflightScope;
    force?: boolean;
    fetchFn?: typeof fetch;
  } = {},
): Promise<PreflightReport> {
  const scope = options.scope ?? "all";
  const fingerprint = buildConfigFingerprint(scope);
  if (
    !options.force &&
    cachedReport &&
    cachedReport.fingerprint === fingerprint &&
    cachedReport.expiresAt > Date.now()
  ) {
    return cachedReport.report;
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const checks: PreflightCheck[] = [];

  checks.push(await checkDatabase());
  if (scope === "all" || scope === "analyze" || scope === "render") {
    checks.push(await checkBinaries());
  }
  const s3Check = await checkS3Bucket();
  checks.push(s3Check);

  let videoProviderBaseUrl: string | undefined;
  let requiresCallback = false;
  let videoProviderLabel = "";

  if (scope === "all" || scope === "render") {
    try {
      const { provider, ctx } = resolveActiveVideoProvider();
      videoProviderBaseUrl = ctx.baseUrl;
      requiresCallback = provider.capabilities.requiresPublicCallbackUrl;
      videoProviderLabel = provider.label;
      const result = await provider.preflight({ ...ctx, fetchFn });
      checks.push({
        name: "video_generation_provider",
        ok: result.ok,
        errorKind: result.kind,
        details: result.details,
      });
    } catch (error) {
      checks.push({
        name: "video_generation_provider",
        ok: false,
        errorKind: "auth",
        details: getErrorMessage(error),
      });
    }

    if (s3Check.ok) {
      checks.push(
        await checkS3PublicReachability(videoProviderBaseUrl, fetchFn),
      );
    }

    if (requiresCallback && videoProviderBaseUrl) {
      checks.push(
        await checkCallbackUrl(
          videoProviderLabel,
          videoProviderBaseUrl,
          fetchFn,
        ),
      );
    }
  }

  if (scope === "all" || scope === "analyze") {
    try {
      const { provider, ctx } = resolveActiveVideoUnderstandingProvider();
      const result = await provider.preflight({ ...ctx, fetchFn });
      checks.push({
        name: "video_analysis_provider",
        ok: result.ok,
        errorKind: result.kind,
        details: result.details,
      });
    } catch (error) {
      checks.push({
        name: "video_analysis_provider",
        ok: false,
        errorKind: "auth",
        details: getErrorMessage(error),
      });
    }
  }

  if (scope === "all" || scope === "rewrite") {
    try {
      const { provider, ctx } = resolveActiveTextProvider();
      const result = await provider.preflight({ ...ctx, fetchFn });
      checks.push({
        name: "text_provider",
        ok: result.ok,
        errorKind: result.kind,
        details: result.details,
      });
    } catch (error) {
      checks.push({
        name: "text_provider",
        ok: false,
        errorKind: "auth",
        details: getErrorMessage(error),
      });
    }
  }

  const report: PreflightReport = {
    ok: checks.every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    scope,
    checks,
  };

  if (report.ok && !options.force) {
    cachedReport = {
      fingerprint,
      expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS,
      report,
    };
  }

  return report;
}
