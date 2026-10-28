import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

/**
 * Validates and sanitizes a storage path to prevent path traversal attacks.
 * @throws Error if the path is invalid or contains dangerous patterns
 */
function validatePath(path: string): string {
  // Check for path traversal attempts
  if (path.includes("..")) {
    throw new Error("Invalid path: path traversal not allowed");
  }

  // Check for absolute paths
  if (path.startsWith("/")) {
    throw new Error("Invalid path: absolute paths not allowed");
  }

  // Check for null bytes (can be used to bypass validation)
  if (path.includes("\0")) {
    throw new Error("Invalid path: null bytes not allowed");
  }

  // Only allow alphanumeric, hyphens, underscores, forward slashes, and dots
  // This prevents special characters that could be used for injection
  const safePathRegex = /^[a-zA-Z0-9\-_/.]+$/;
  if (!safePathRegex.test(path)) {
    throw new Error(
      "Invalid path: only alphanumeric characters, hyphens, underscores, forward slashes, and dots are allowed",
    );
  }

  // Prevent hidden files (starting with dot)
  if (path.startsWith(".") || path.includes("/.")) {
    throw new Error("Invalid path: hidden files not allowed");
  }

  // Normalize multiple slashes
  const normalizedPath = path.replace(/\/+/g, "/");

  return normalizedPath;
}

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    const endpoint = env.S3_ENDPOINT;
    const region = env.S3_REGION || "auto";
    const accessKeyId = env.S3_ACCESS_KEY_ID;
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY;

    if (!(endpoint && accessKeyId && secretAccessKey)) {
      throw new Error("Missing one or more required S3 environment variables");
    }

    s3Client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      // Presigned browser PUTs can't carry the SDK's default body checksum (it's signed as empty).
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  return s3Client;
}

export async function getSignedUploadUrl(
  path: string,
  bucket: string,
  contentType = "image/jpeg",
  contentLength?: number,
): Promise<string> {
  const safePath = validatePath(path);
  const s3 = getS3Client();
  try {
    return await getS3SignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: safePath,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
      { expiresIn: 60 },
    );
  } catch {
    throw new Error("Could not generate signed upload URL");
  }
}

export async function getSignedUrl(
  path: string,
  bucket: string,
  expiresIn: number,
): Promise<string> {
  const safePath = validatePath(path);
  const s3 = getS3Client();
  try {
    return await getS3SignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: safePath,
      }),
      { expiresIn },
    );
  } catch {
    throw new Error("Could not generate signed download URL");
  }
}

export async function deleteObject(
  path: string,
  bucket: string,
): Promise<void> {
  const safePath = validatePath(path);
  const s3 = getS3Client();

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: safePath,
      }),
    );
  } catch {
    throw new Error("Could not delete storage object");
  }
}

export async function putObject(
  path: string,
  bucket: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const safePath = validatePath(path);
  const s3 = getS3Client();

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: safePath,
        Body: body,
        ContentType: contentType,
      }),
    );
  } catch (error) {
    throw new Error("Could not upload storage object", { cause: error });
  }
}

export async function getObject(
  path: string,
  bucket: string,
): Promise<Uint8Array> {
  const safePath = validatePath(path);
  const s3 = getS3Client();

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: safePath,
      }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error("empty body");
    }
    return bytes;
  } catch (error) {
    throw new Error("Could not download storage object", { cause: error });
  }
}
