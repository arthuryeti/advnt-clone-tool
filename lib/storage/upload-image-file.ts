/** Browser upload of a picture through /api/storage/upload (stored as WebP). */
export async function uploadImageFile(file: File) {
  const form = new FormData();
  form.set("file", file);
  form.set("path", `creative-assets/uploads/${crypto.randomUUID()}`);
  form.set("contentType", file.type);
  const response = await fetch("/api/storage/upload", {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(`Could not upload ${file.name}.`);
  const result = (await response.json()) as { path: string; url: string };
  return {
    name: file.name,
    storageKey: result.path,
    url: result.url,
    mimeType: "image/webp",
    sizeBytes: file.size,
    mediaType: "image" as const,
    durationSeconds: null,
  };
}
