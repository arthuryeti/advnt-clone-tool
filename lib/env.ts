import { z } from "zod/v4";

const urlSchema = z.string().url();

function readOptionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredUrl(name: string, fallback?: string): string {
  const value = readOptionalEnv(name) ?? fallback;
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }
  const parsed = urlSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${name} must be a valid URL.`);
  }
  return parsed.data;
}

function readRequiredEnv(name: string): string {
  const value = readOptionalEnv(name);
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }
  return value;
}

export function getNodeEnv(): "development" | "test" | "production" {
  const raw = readOptionalEnv("NODE_ENV");
  if (raw === "production" || raw === "test") return raw;
  return "development";
}

export function getDatabaseUrl(): string {
  return readRequiredUrl("DATABASE_URL");
}

/**
 * Public URL of this app (checked at runtime so Docker images never need SITE_URL baked in).
 * Reads SITE_URL first, then NEXT_PUBLIC_SITE_URL, defaulting to http://localhost:3000.
 */
export function getSiteUrl(): string {
  const raw =
    readOptionalEnv("SITE_URL") ??
    readOptionalEnv("NEXT_PUBLIC_SITE_URL") ??
    "http://localhost:3000";
  const parsed = urlSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("SITE_URL / NEXT_PUBLIC_SITE_URL must be a valid URL.");
  }
  return parsed.data.replace(/\/+$/u, "");
}

/** S3 bucket name read at runtime so changing S3_BUCKET never requires rebuilding the container. */
export function getImagesBucketName(): string {
  return (
    readOptionalEnv("S3_BUCKET") ??
    readOptionalEnv("NEXT_PUBLIC_IMAGES_BUCKET_NAME") ??
    "clone-media"
  );
}

export type S3RuntimeConfig = {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export function getS3Config(): S3RuntimeConfig {
  const endpoint = readRequiredUrl("S3_ENDPOINT").replace(/\/+$/u, "");
  const publicRaw = readOptionalEnv("S3_PUBLIC_ENDPOINT");
  const publicEndpoint = publicRaw
    ? readRequiredUrl("S3_PUBLIC_ENDPOINT").replace(/\/+$/u, "")
    : endpoint;
  return {
    endpoint,
    publicEndpoint,
    region: readOptionalEnv("S3_REGION") ?? "auto",
    accessKeyId: readRequiredEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: readRequiredEnv("S3_SECRET_ACCESS_KEY"),
    bucket: getImagesBucketName(),
  };
}

export function getVideoProviderId(): string {
  return (readOptionalEnv("VIDEO_PROVIDER") ?? "kie").toLowerCase();
}

export function getVideoAnalysisProviderId(): string | undefined {
  return readOptionalEnv("VIDEO_ANALYSIS_PROVIDER")?.toLowerCase();
}

export function getVideoAnalysisModelOverride(): string | undefined {
  return readOptionalEnv("VIDEO_ANALYSIS_MODEL");
}

export function getTextProviderId(): string | undefined {
  return readOptionalEnv("TEXT_PROVIDER")?.toLowerCase();
}

export function getTextModelOverride(): string | undefined {
  return readOptionalEnv("TEXT_MODEL");
}

export function getOptionalEnv(name: string): string | undefined {
  return readOptionalEnv(name);
}
