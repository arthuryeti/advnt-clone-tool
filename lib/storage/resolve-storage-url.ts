import { storageConfig } from "@/config/storage.config";
import { getSignedUrl } from "./s3";

const storagePathPrefix = "/storage/";

export async function resolveStorageDownloadUrl(
  url: string,
  expiresIn = 60 * 60,
): Promise<string> {
  // No reference (an account without a product image): nothing to sign. Signing "" failed the
  // storage path check and stranded slideshows in "generating" (2026-10-07).
  if (!url) {
    return url;
  }

  const storageObject = parseStorageObjectFromUrl(url);

  if (!storageObject) {
    return url;
  }

  return getSignedUrl(storageObject.path, storageObject.bucket, expiresIn);
}

export const parseStorageObjectFromUrl = (url: string) => {
  if (url.startsWith(storagePathPrefix)) {
    return parseStoragePath(url);
  }

  try {
    const parsedUrl = new URL(url);

    if (!parsedUrl.pathname.startsWith(storagePathPrefix)) {
      return null;
    }

    return parseStoragePath(parsedUrl.pathname);
  } catch {
    return url.startsWith("/")
      ? null
      : {
          bucket: storageConfig.bucketNames.images,
          path: url,
        };
  }
};

const parseStoragePath = (pathname: string) => {
  const [prefix, bucket, ...pathParts] = pathname.split("/").filter(Boolean);

  if (
    prefix !== "storage" ||
    bucket !== storageConfig.bucketNames.images ||
    pathParts.length === 0
  ) {
    return null;
  }

  return {
    bucket,
    path: pathParts.join("/"),
  };
};
