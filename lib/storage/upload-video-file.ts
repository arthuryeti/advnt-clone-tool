/** Browser upload of a video to a presigned URL from `assetLibrary.prepareVideoUpload`. */
export async function uploadVideoFile(
  file: File,
  prepare: (input: {
    extension: "mov" | "mp4" | "webm";
    mimeType: "video/mp4" | "video/quicktime" | "video/webm";
    sizeBytes: number;
  }) => Promise<{ signedUrl: string; storageKey: string }>,
) {
  const rawExtension = file.name.split(".").pop()?.toLocaleLowerCase();
  const extension =
    rawExtension === "mov" || rawExtension === "webm" ? rawExtension : "mp4";
  let mimeType: "video/mp4" | "video/quicktime" | "video/webm" = "video/mp4";
  if (extension === "mov") mimeType = "video/quicktime";
  if (extension === "webm") mimeType = "video/webm";
  const durationSeconds = await readDuration(file);
  const upload = await prepare({ extension, mimeType, sizeBytes: file.size });
  const response = await fetch(upload.signedUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": mimeType },
  });
  if (!response.ok) throw new Error(`Storage rejected ${file.name}.`);
  return {
    name: file.name,
    storageKey: upload.storageKey,
    mimeType,
    sizeBytes: file.size,
    mediaType: "video" as const,
    durationSeconds,
  };
}

function readDuration(file: File): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.onloadedmetadata = () => {
    URL.revokeObjectURL(url);
    Number.isFinite(video.duration) && video.duration > 0
      ? resolve(video.duration)
      : reject(new Error(`Could not read ${file.name}.`));
  };
  video.onerror = () => {
    URL.revokeObjectURL(url);
    reject(new Error(`Could not read ${file.name}.`));
  };
  video.src = url;
  return promise;
}
