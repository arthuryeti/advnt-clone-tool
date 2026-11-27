import { storageConfig } from "@/config/storage.config";
import { getSignedUrl } from "@/lib/storage";

async function handleStorageRequest(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
  includeBody: boolean,
) {
  const { path } = await params;

  const [bucket, ...filePathParts] = path;
  const filePath = filePathParts.join("/");

  if (!(bucket && filePath)) {
    return new Response("Invalid path", { status: 400 });
  }

  if (bucket === storageConfig.bucketNames.images) {
    const signedUrl = await getSignedUrl(filePath, bucket, 60 * 60);
    const range = request.headers.get("range");
    const storageResponse = await fetch(signedUrl, {
      headers: range ? { Range: range } : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    if (!storageResponse.ok || !storageResponse.body) {
      return new Response("Storage object not found", {
        status: storageResponse.status,
      });
    }

    const headers = new Headers({
      "Access-Control-Allow-Origin": "*",
      // Media is already compressed. A proxy gzipping it drops Content-Length, so Cloudflare can't
      // answer byte ranges, and Safari won't play a video without them.
      "Cache-Control": "public, max-age=3600, no-transform",
      "Content-Encoding": "identity",
      "Content-Type":
        storageResponse.headers.get("content-type") ??
        "application/octet-stream",
    });
    const contentLength = storageResponse.headers.get("content-length");
    const contentRange = storageResponse.headers.get("content-range");
    const acceptRanges = storageResponse.headers.get("accept-ranges");

    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }
    if (contentRange) {
      headers.set("Content-Range", contentRange);
    }
    if (acceptRanges) {
      headers.set("Accept-Ranges", acceptRanges);
    }

    return new Response(includeBody ? storageResponse.body : null, {
      headers,
      status: storageResponse.status,
    });
  }

  return new Response("Not found", {
    status: 404,
  });
}

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) => {
  return handleStorageRequest(request, { params }, true);
};

export const HEAD = async (
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) => {
  return handleStorageRequest(request, { params }, false);
};
