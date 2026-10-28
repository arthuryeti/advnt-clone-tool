import "server-only";

import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import { VIDEO_MODEL_ID } from "@/lib/ai/model-policy";
import { env } from "@/lib/env";

// Surplus caps JSON bodies at 10 MB, and base64 adds a third.
export const MAX_INLINE_VIDEO_BYTES = 7_500_000;

/**
 * Sends one mp4 (picture + sound), or several in order, to Gemini on Surplus and parses the
 * answer with `schema`.
 *
 * Plain fetch on purpose: @ai-sdk/openai-compatible throws on video file parts, and smuggling
 * the part through providerOptions got it silently dropped — Gemini then described a video it
 * never saw. Surplus has no video contract; the data URL in `image_url` works only on sellers
 * that accept it, so the route is pinned to Google's own sellers and OpenRouter (which serves
 * Gemini from Google AI Studio and passes the video through). 2026-10-23: every "google" seller
 * was dead fleet-wide (503 no_healthy_sellers) while OpenRouter still served video.
 */
export async function describeVideo<T extends z.ZodType>(input: {
  file: string | string[];
  prompt: string;
  schema: T;
}): Promise<z.infer<T>> {
  const apiKey = env.SURPLUS_API_KEY;
  if (!apiKey) throw new Error("SURPLUS_API_KEY is not configured.");
  const videos = await Promise.all(
    [input.file].flat().map((file) => readFile(file)),
  );
  const bytes = videos.reduce((sum, video) => sum + video.length, 0);
  if (bytes > MAX_INLINE_VIDEO_BYTES) {
    throw new Error(
      `Video is ${Math.round(bytes / 1e6)} MB; Gemini takes at most 7.5 MB inline.`,
    );
  }
  const body = JSON.stringify({
    model: VIDEO_MODEL_ID,
    provider: ["google", "openrouter"],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "out",
        strict: true,
        schema: z.toJSONSchema(input.schema),
      },
    },
    messages: [
      {
        role: "user",
        content: [
          ...videos.map((video) => ({
            type: "image_url",
            image_url: {
              url: `data:video/mp4;base64,${video.toString("base64")}`,
            },
          })),
          { type: "text", text: input.prompt },
        ],
      },
    ],
  });

  // Seller hiccups are common on the marketplace; three attempts, then surface the error.
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(
        "https://api.surplusintelligence.ai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
        },
      );
      const json = (await response.json().catch(() => null)) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      } | null;
      const content = json?.choices?.[0]?.message?.content;
      if (!response.ok || !content) {
        throw new Error(
          `Gemini video call failed (${response.status}): ${json?.error?.message ?? "empty answer"}`,
        );
      }
      return input.schema.parse(JSON.parse(content));
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}
