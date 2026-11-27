import { redactSecrets } from "@/lib/security/redact";

export type ProviderErrorKind =
  | "auth"
  | "quota"
  | "moderation"
  | "invalid_input"
  | "rate_limited"
  | "transient"
  | "ambiguous_submit";

const RETRYABLE_KINDS = new Set<ProviderErrorKind>([
  "rate_limited",
  "transient",
]);

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(options: {
    kind: ProviderErrorKind;
    provider: string;
    message: string;
    status?: number;
    code?: string | number;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(redactSecrets(options.message), { cause: options.cause });
    this.name = "ProviderError";
    this.kind = options.kind;
    this.provider = options.provider;
    this.status = options.status;
    this.code = options.code === undefined ? undefined : String(options.code);
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = RETRYABLE_KINDS.has(options.kind);
  }
}

const MODERATION_RE =
  /moderation|safety|nsfw|content[_\s-]?policy|policy[_\s-]?violation|prohibited|blocked by content|harmful|safety system|safety_block/iu;
const QUOTA_RE =
  /insufficient[_\s-]?(?:quota|credits|balance)|credit balance|balance too low|payment[_\s-]?required|exceeded your current quota|exhausted balance|quota exceeded for billing|billing account/iu;
const AUTH_RE =
  /invalid api key|api key not valid|invalid x-api-key|invalid key|unauthorized|invalid bearer|authentication[_\s-]?error|no auth credentials|incorrect api key/iu;

export function classifyHttpStatus(
  status: number,
  message: string,
  options: { code?: string | number; isBillableSubmit?: boolean } = {},
): ProviderErrorKind {
  const combined = `${options.code ?? ""} ${message}`.trim();
  const isModeration = MODERATION_RE.test(combined);
  const isQuota = QUOTA_RE.test(combined);
  const isAuth = AUTH_RE.test(combined);

  if (status === 401) return "auth";
  if (status === 402) return "quota";
  if (status === 403) {
    if (isModeration) return "moderation";
    if (isQuota) return "quota";
    return "auth";
  }
  if (status === 429) {
    return isQuota ? "quota" : "rate_limited";
  }
  if (status === 400 || status === 404 || status === 422) {
    if (isAuth) return "auth";
    if (isModeration) return "moderation";
    if (isQuota) return "quota";
    return "invalid_input";
  }
  if (status >= 500) {
    return options.isBillableSubmit ? "ambiguous_submit" : "transient";
  }
  if (isAuth) return "auth";
  if (isModeration) return "moderation";
  if (isQuota) return "quota";
  return "invalid_input";
}
