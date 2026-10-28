import "server-only";

const MAX_VIDEO_SIZE_BYTES = 50 * 1024 * 1024;

/** Downloads a remote file (a video, mostly) into memory, refusing failed responses and anything over 50 MB. */
export async function downloadVideo(
  url: string,
  label = "video",
  init?: RequestInit,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Could not download ${label}. Status ${response.status}.`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_VIDEO_SIZE_BYTES) {
    throw new Error("Files must be 50 MB or smaller.");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_VIDEO_SIZE_BYTES) {
    throw new Error("Files must be 50 MB or smaller.");
  }

  return { bytes, contentType: response.headers.get("content-type") };
}
