import "server-only";

import { z } from "zod/v4";

/**
 * Starts a Sume video job; Sume POSTs the outcome to `webhookUrl` (a waitpoint token URL).
 * A refusal throws Sume's reason.
 */
export async function createSumeVideoJob(
  request: {
    model: string;
    input: Record<string, unknown>;
    webhookUrl: string;
  },
  apiKey: string,
): Promise<void> {
  const response = await fetch(
    "https://api.sume.com/v1/video-router/generate",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Sume wants one per submit; we never resubmit, so a fresh one each time.
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        model: request.model,
        ...request.input,
        mode: "webhook",
        webhook_url: request.webhookUrl,
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new Error(
      `Sume refused the job (${body?.error?.code ?? response.status}): ${body?.error?.message ?? "no message"}`,
    );
  }
}

const sumeWebhookSchema = z.object({
  event: z.string(),
  payload: z
    .object({
      artifacts: z.array(z.object({ type: z.string(), url: z.string() })),
    })
    .nullish(),
  error: z.object({ message: z.string().nullish() }).nullish(),
});

/** The video from Sume's job webhook; throws Sume's reason on failure. */
export function sumeWebhookVideoUrl(webhook: unknown): string {
  const { event, payload, error } = sumeWebhookSchema.parse(webhook);
  if (event !== "job.completed") {
    throw new Error(error?.message || `Sume ${event}`);
  }
  const url = payload?.artifacts.find(({ type }) => type === "video")?.url;
  if (!url) throw new Error("Sume finished without a video.");
  return url;
}
