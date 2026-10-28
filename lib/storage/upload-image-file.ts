import { storageConfig } from "@/config/storage.config";

/** Browser upload of a picture through /api/storage/upload (stored as WebP), ready for `assetLibrary.addLibraryAssets`. */
export async function uploadImageFile(file: File) {
  const form = new FormData();
  form.set("file", file);
  form.set("path", `creative-assets/uploads/${crypto.randomUUID()}`);
  form.set("bucket", storageConfig.bucketNames.images);
  form.set("contentType", file.type);
  const response = await fetch("/api/storage/upload", {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(`Could not upload ${file.name}.`);
  const result = (await response.json()) as { path: string };
  return {
    name: file.name,
    storageKey: result.path,
    mimeType: "image/webp",
    sizeBytes: file.size,
    mediaType: "image" as const,
    durationSeconds: null,
  };
}
