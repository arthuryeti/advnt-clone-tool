import "server-only";

import { z } from "zod/v4";

/**
 * Starts a KIE job; KIE POSTs the outcome to `callBackUrl` (a waitpoint token URL).
 * KIE answers HTTP 200 even when it refuses the job, so `code` decides.
 */
export async function createKieTask(
  request: {
    model: string;
    input: Record<string, unknown>;
    callBackUrl: string;
  },
  apiKey: string,
): Promise<string> {
  const response = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const body = (await response.json().catch(() => null)) as {
    code?: number;
    msg?: string;
    data?: { taskId?: string };
  } | null;
  const taskId = body?.data?.taskId;
  if (body?.code !== 200 || !taskId) {
    throw new Error(
      `KIE refused the job (${body?.code ?? response.status}): ${body?.msg ?? "no message"}`,
    );
  }
  return taskId;
}

const kieCallbackSchema = z.object({
  data: z.object({
    taskId: z.string(),
    state: z.string(),
    resultJson: z.string().nullish(),
    failMsg: z.string().nullish(),
  }),
});

/** The first result URL from KIE's completion callback; throws KIE's reason on failure. */
export function kieCallbackResultUrl(callback: unknown): string {
  const { data } = kieCallbackSchema.parse(callback);
  if (data.state !== "success") {
    throw new Error(data.failMsg || `KIE job ${data.state}`);
  }
  const result = JSON.parse(data.resultJson ?? "{}") as {
    resultUrls?: string[];
  };
  const url = result.resultUrls?.[0];
  if (!url) throw new Error("KIE finished without a video.");
  return url;
}
