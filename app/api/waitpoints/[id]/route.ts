import "@/lib/render-reconciler";
import { z } from "zod/v4";
import { consumeWaitpointWebhook, type WaitpointStore } from "@/lib/jobs";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const uuidSchema = z.string().uuid();

function extractSecret(request: Request): string | null {
  try {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("token");
    if (queryToken) return queryToken;
  } catch {
    // Ignore malformed URL.
  }
  const headerToken = request.headers.get("x-waitpoint-token");
  if (headerToken) return headerToken;
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  return null;
}

export async function handleWaitpointPost(
  request: Request,
  id: string,
  store?: WaitpointStore,
): Promise<Response> {
  if (!uuidSchema.safeParse(id).success) {
    return Response.json({ message: "Invalid waitpoint id." }, { status: 400 });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
    return Response.json(
      { message: "Webhook body exceeds size limit." },
      { status: 413 },
    );
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return Response.json({ message: "Could not read body." }, { status: 400 });
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) {
    return Response.json(
      { message: "Webhook body exceeds size limit." },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json(
      { message: "Webhook body must be valid JSON." },
      { status: 400 },
    );
  }

  const result = await consumeWaitpointWebhook({
    id,
    secret: extractSecret(request),
    rawBody,
    body,
    request,
    store,
  });

  if (!result.ok) {
    return Response.json(
      { message: result.message },
      { status: result.status },
    );
  }

  return Response.json({ ok: true });
}

/** Providers POST finished render payloads here; verified by secret, single-use, and idempotent. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleWaitpointPost(request, id);
}
