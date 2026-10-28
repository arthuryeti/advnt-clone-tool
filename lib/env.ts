import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod/v4";

export const env = createEnv({
  server: {
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.string().url(),
    // S3-compatible storage (AWS S3, Cloudflare R2, MinIO).
    S3_ENDPOINT: z.string().url(),
    S3_REGION: z.string().default("auto"),
    S3_ACCESS_KEY_ID: z.string(),
    S3_SECRET_ACCESS_KEY: z.string(),
    // Text (Opus), vision, and video (Gemini) models: https://api.surplusintelligence.ai/v1
    SURPLUS_API_KEY: z.string(),
    // Who renders takes, and its key. KIE and Sume call back to NEXT_PUBLIC_SITE_URL.
    VIDEO_PROVIDER: z.enum(["kie", "revana", "sume"]).default("kie"),
    KIE_API_KEY: z.string().optional(),
    REVANA_API_KEY: z.string().optional(),
    SUME_API_KEY: z.string().optional(),
  },
  client: {
    NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
    NEXT_PUBLIC_IMAGES_BUCKET_NAME: z.string(),
  },
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_REGION: process.env.S3_REGION,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    SURPLUS_API_KEY: process.env.SURPLUS_API_KEY,
    VIDEO_PROVIDER: process.env.VIDEO_PROVIDER,
    KIE_API_KEY: process.env.KIE_API_KEY,
    REVANA_API_KEY: process.env.REVANA_API_KEY,
    SUME_API_KEY: process.env.SUME_API_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_IMAGES_BUCKET_NAME: process.env.NEXT_PUBLIC_IMAGES_BUCKET_NAME,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
