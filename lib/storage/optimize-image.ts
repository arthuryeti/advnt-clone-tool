import sharp from "sharp";

export interface OptimizeImageOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

export async function optimizeImage(
  input: Buffer,
  options: OptimizeImageOptions = {},
): Promise<{ buffer: Buffer; contentType: string }> {
  const { maxWidth = 1536, maxHeight = 1536, quality = 85 } = options;

  const pipeline = sharp(input)
    .resize(maxWidth, maxHeight, { fit: "inside", withoutEnlargement: true })
    .webp({ quality });

  const buffer = await pipeline.toBuffer();

  return { buffer, contentType: "image/webp" };
}
