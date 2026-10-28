import "server-only";

import { downloadVideo } from "@/lib/storage/download-video";

const API = "https://api.revana.si/v1";

type RevanaGeneration = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error?: { message?: string } | null;
};

const authorization = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
});

/** Starts a Revana generation and returns its id to poll; a refusal throws Revana's reason. */
export async function createRevanaGeneration(
  request: { model: string; input: Record<string, unknown> },
  apiKey: string,
): Promise<string> {
  const response = await fetch(`${API}/generations`, {
    method: "POST",
    headers: { ...authorization(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = (await response
    .json()
    .catch(() => null)) as Partial<RevanaGeneration> | null;
  if (!response.ok || !body?.id) {
    throw new Error(
      `Revana refused the generation (${response.status}): ${body?.error?.message ?? "no message"}`,
    );
  }
  return body.id;
}

/**
 * A generation's status, or null while Revana is briefly unreachable (network, 429, 5xx): the
 * render may still land and be charged, so the caller keeps polling instead of dropping it.
 */
export async function getRevanaGeneration(
  id: string,
  apiKey: string,
): Promise<RevanaGeneration | null> {
  const response = await fetch(`${API}/generations/${id}`, {
    headers: authorization(apiKey),
  }).catch(() => null);
  if (!response || response.status === 429 || response.status >= 500) {
    return null;
  }
  const body = (await response
    .json()
    .catch(() => null)) as RevanaGeneration | null;
  if (!response.ok || !body) {
    throw new Error(
      `Revana couldn't read generation ${id} (${response.status}): ${body?.error?.message ?? "no message"}`,
    );
  }
  return body;
}

/** A succeeded generation's video. Revana's files expire, so callers keep their own copy. */
export const downloadRevanaVideo = (id: string, apiKey: string) =>
  // Redirects to a short-lived file URL; fetch drops the key on that cross-origin hop.
  downloadVideo(`${API}/generations/${id}/content`, "Rendered take", {
    headers: authorization(apiKey),
  });
