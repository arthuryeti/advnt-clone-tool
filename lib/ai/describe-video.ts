import "server-only";

import { readFile } from "node:fs/promises";
import type { z } from "zod/v4";
import { ProviderError } from "@/lib/ai/errors";
import { resolveActiveVideoUnderstandingProvider } from "@/lib/ai/providers/video-understanding/registry";

export const MAX_INLINE_VIDEO_BYTES = 7_500_000;

/**
 * Sends one mp4 (picture + sound), or several in order, to the configured video-understanding
 * provider (Google Gemini, OpenRouter, or Surplus) and parses the answer with `schema`.
 */
export async function describeVideo<T extends z.ZodType>(input: {
  file: string | string[];
  prompt: string;
  schema: T;
}): Promise<z.infer<T>> {
  const { provider, ctx } = resolveActiveVideoUnderstandingProvider();
  const videos = await Promise.all(
    [input.file].flat().map((file) => readFile(file)),
  );
  const bytes = videos.reduce((sum, video) => sum + video.length, 0);
  if (bytes > provider.maxInlineVideoBytes) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: provider.id,
      message: `Video is ${Math.round(bytes / 1e6)} MB; ${provider.label} takes at most ${Math.round(provider.maxInlineVideoBytes / 1e6)} MB inline.`,
    });
  }
  return provider.describeVideo(ctx, {
    videos,
    prompt: input.prompt,
    schema: input.schema,
  });
}
