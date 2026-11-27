import { z } from "zod/v4";
import { getImagesBucketName } from "@/lib/env";
import { putObject } from "@/lib/storage";
import { optimizeImage } from "@/lib/storage/optimize-image";

/** Image uploads from uploadImageFile, stored as WebP: product photos, faces, picked frames. */
const uploadRequestSchema = z.object({
  path: z.string().regex(/^creative-assets\/uploads\/[0-9a-f-]{36}$/u),
  contentType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
});

const errorResponse = (message: string, status: number) =>
  Response.json({ message }, { status });

export async function POST(request: Request): Promise<Response> {
  try {
    const bucket = getImagesBucketName();
    const formData = await request.formData();
    const file = formData.get("file");
    const providedBucket = formData.get("bucket");
    if (typeof providedBucket === "string" && providedBucket !== bucket) {
      return errorResponse("Invalid upload bucket.", 400);
    }
    const parsed = uploadRequestSchema.safeParse({
      path: formData.get("path"),
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
      bucket,
      new Uint8Array(optimized.buffer),
      optimized.contentType,
    );
    return Response.json({
      ok: true,
      path: finalPath,
      url: `/storage/${bucket}/${finalPath}`,
    });
  } catch {
    return errorResponse("Could not upload file.", 500);
  }
}
