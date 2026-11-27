const SENSITIVE_ENV_NAME = /(?:_KEY|_SECRET|_TOKEN|_PASSWORD|API_KEY)$/i;

const SENSITIVE_OBJECT_KEYS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "apikey",
  "api_key",
  "secret",
  "secrethash",
  "secret_hash",
  "token",
  "password",
  "cookie",
]);

function collectRuntimeSecrets(extraSecrets?: readonly string[]): string[] {
  const candidates = new Set<string>();
  const addCandidate = (value: string | undefined, minLength: number) => {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed.length < minLength) return;
    candidates.add(trimmed);
    const encoded = encodeURIComponent(trimmed);
    if (encoded !== trimmed && encoded.length >= minLength) {
      candidates.add(encoded);
    }
  };

  if (typeof process !== "undefined" && process.env) {
    for (const [key, value] of Object.entries(process.env)) {
      if (SENSITIVE_ENV_NAME.test(key)) {
        addCandidate(value, 6);
      }
    }
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      try {
        const parsed = new URL(dbUrl);
        if (parsed.password) {
          addCandidate(decodeURIComponent(parsed.password), 4);
        }
      } catch {
        // Ignore malformed DATABASE_URL during redaction.
      }
    }
  }

  if (extraSecrets) {
    for (const secret of extraSecrets) {
      addCandidate(secret, 4);
    }
  }

  return [...candidates].sort((a, b) => b.length - a.length);
}

/**
 * Redacts API keys, tokens, credentials, and URL query secrets from arbitrary text so raw
 * credentials never reach logs, Postgres error columns, or tRPC responses.
 */
export function redactSecrets(
  text: string,
  extraSecrets?: readonly string[],
): string {
  if (!text) return text;
  let output = text;

  for (const secret of collectRuntimeSecrets(extraSecrets)) {
    output = output.replaceAll(secret, "[REDACTED]");
  }

  // Pattern-based fallback redaction for echoed keys even if not in process.env.
  output = output
    .replace(
      /\b(Bearer|Key|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu,
      "$1 [REDACTED]",
    )
    .replace(
      /(x-(?:goog-)?api-key\s*[:=]\s*["']?)[^\s"',;}]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:key|token|api_key|apikey|secret|access_token)=)[^&#\s"']+/giu,
      "$1[REDACTED]",
    )
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+(@)/giu, "$1[REDACTED]$2")
    .replace(/\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{10,}\b/gu, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{16,}\b/gu, "[REDACTED]")
    .replace(/\bsr_live_[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/\bkie_[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]");

  return output;
}

/** Recursively redacts secrets from objects, arrays, and Error instances for safe logging. */
export function redactObject<T>(
  value: T,
  extraSecrets?: readonly string[],
  seen = new WeakSet<object>(),
): T {
  if (typeof value === "string") {
    return redactSecrets(value, extraSecrets) as T;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]" as T;
  }
  seen.add(value);

  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactSecrets(value.message, extraSecrets),
    };
    if (value.stack) {
      out.stack = redactSecrets(value.stack, extraSecrets);
    }
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactObject(v, extraSecrets, seen);
    }
    return out as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, extraSecrets, seen)) as T;
  }

  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      SENSITIVE_OBJECT_KEYS.has(key.toLowerCase()) &&
      typeof entry === "string"
    ) {
      record[key] = "[REDACTED]";
    } else {
      record[key] = redactObject(entry, extraSecrets, seen);
    }
  }
  return record as T;
}

/** Extracts a safe, redacted error message from an unknown thrown value. */
export function sanitizeErrorMessage(
  error: unknown,
  extraSecrets?: readonly string[],
): string {
  let raw = "Unknown error";
  if (error instanceof Error) {
    raw = error.message;
  } else if (typeof error === "string") {
    raw = error;
  }
  return redactSecrets(raw, extraSecrets);
}
