import { z } from "zod/v4";
import { storageConfig } from "@/config/storage.config";
import { putObject } from "@/lib/storage";
import { optimizeImage } from "@/lib/storage/optimize-image";

/** Image uploads from uploadImageFile, stored as WebP: product photos, faces, picked frames. */
const uploadRequestSchema = z.object({
  path: z.string().regex(/^creative-assets\/uploads\/[0-9a-f-]{36}$/u),
  bucket: z.literal(storageConfig.bucketNames.images),
  contentType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
});

const errorResponse = (message: string, status: number) =>
  Response.json({ message }, { status });

export async function POST(request: Request): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const parsed = uploadRequestSchema.safeParse({
      path: formData.get("path"),
      bucket: formData.get("bucket"),
      contentType: formData.get("contentType"),
    });
    if (!parsed.success) return errorResponse("Invalid upload payload.", 400);
    if (!(file instanceof File)) return errorResponse("File is required.", 400);

    const optimized = await optimizeImage(
      Buffer.from(await file.arrayBuffer()),
    );
    const finalPath = parsed.data.path;
    await putObject(
      finalPath,
      parsed.data.bucket,
      new Uint8Array(optimized.buffer),
      optimized.contentType,
    );
    return Response.json({ ok: true, path: finalPath });
  } catch {
    return errorResponse("Could not upload file.", 500);
  }
}
