import "server-only";

import type { z } from "zod/v4";
import { ProviderError } from "@/lib/ai/errors";
import { anthropicTextProvider } from "@/lib/ai/providers/text/anthropic";
import { geminiTextProvider } from "@/lib/ai/providers/text/gemini";
import { openaiTextProvider } from "@/lib/ai/providers/text/openai";
import { openrouterTextProvider } from "@/lib/ai/providers/text/openrouter";
import { surplusTextProvider } from "@/lib/ai/providers/text/surplus";
import type {
  StructuredTextRequest,
  TextProvider,
  TextProviderContext,
} from "@/lib/ai/providers/text/types";
import {
  getOptionalEnv,
  getTextModelOverride,
  getTextProviderId,
} from "@/lib/env";

const TEXT_PROVIDERS: readonly TextProvider[] = [
  anthropicTextProvider,
  openaiTextProvider,
  openrouterTextProvider,
  geminiTextProvider,
  surplusTextProvider,
];

const PROVIDER_MAP = new Map(
  TEXT_PROVIDERS.map((provider) => [provider.id, provider]),
);

export function listTextProviders(): readonly TextProvider[] {
  return TEXT_PROVIDERS;
}

export function getTextProviderById(id: string): TextProvider {
  const provider = PROVIDER_MAP.get(id.trim().toLowerCase());
  if (!provider) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: id,
      message: `Unknown text provider "${id}". Registered: ${TEXT_PROVIDERS.map((p) => p.id).join(", ")}.`,
    });
  }
  return provider;
}

export function getActiveTextProvider(): TextProvider {
  const explicit = getTextProviderId();
  if (explicit) {
    return getTextProviderById(explicit);
  }
  for (const candidate of TEXT_PROVIDERS) {
    if (getOptionalEnv(candidate.apiKeyEnvVar)) {
      return candidate;
    }
  }
  throw new ProviderError({
    kind: "auth",
    provider: "text",
    message:
      "Text/rewrite AI isn't set up yet: set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, or SURPLUS_API_KEY (or set TEXT_PROVIDER).",
  });
}

export function resolveTextProviderContext(
  provider: TextProvider,
): TextProviderContext {
  const apiKey = getOptionalEnv(provider.apiKeyEnvVar);
  if (!apiKey) {
    throw new ProviderError({
      kind: "auth",
      provider: provider.id,
      message: `Text/rewrite AI isn't set up yet: set ${provider.apiKeyEnvVar} for ${provider.label}.`,
    });
  }
  const baseUrl =
    getOptionalEnv(provider.baseUrlEnvVar) ?? provider.defaultBaseUrl;
  const model = getTextModelOverride() ?? provider.defaultModel;
  return { apiKey, baseUrl, model };
}

export function resolveActiveTextProvider(): {
  provider: TextProvider;
  ctx: TextProviderContext;
} {
  const provider = getActiveTextProvider();
  const ctx = resolveTextProviderContext(provider);
  return { provider, ctx };
}

export async function generateStructuredObject<T extends z.ZodType>(
  request: StructuredTextRequest<T>,
): Promise<z.infer<T>> {
  const { provider, ctx } = resolveActiveTextProvider();
  return provider.generateStructured(ctx, request);
}
