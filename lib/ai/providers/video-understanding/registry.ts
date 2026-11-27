import "server-only";

import { ProviderError } from "@/lib/ai/errors";
import { geminiVideoUnderstandingProvider } from "@/lib/ai/providers/video-understanding/gemini";
import { openrouterVideoUnderstandingProvider } from "@/lib/ai/providers/video-understanding/openrouter";
import { surplusVideoUnderstandingProvider } from "@/lib/ai/providers/video-understanding/surplus";
import type {
  VideoUnderstandingContext,
  VideoUnderstandingProvider,
} from "@/lib/ai/providers/video-understanding/types";
import {
  getOptionalEnv,
  getVideoAnalysisModelOverride,
  getVideoAnalysisProviderId,
} from "@/lib/env";

const VIDEO_UNDERSTANDING_PROVIDERS: readonly VideoUnderstandingProvider[] = [
  geminiVideoUnderstandingProvider,
  openrouterVideoUnderstandingProvider,
  surplusVideoUnderstandingProvider,
];

const PROVIDER_MAP = new Map(
  VIDEO_UNDERSTANDING_PROVIDERS.map((provider) => [provider.id, provider]),
);

export function listVideoUnderstandingProviders(): readonly VideoUnderstandingProvider[] {
  return VIDEO_UNDERSTANDING_PROVIDERS;
}

export function getVideoUnderstandingProviderById(
  id: string,
): VideoUnderstandingProvider {
  const provider = PROVIDER_MAP.get(id.trim().toLowerCase());
  if (!provider) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: id,
      message: `Unknown video analysis provider "${id}". Registered: ${VIDEO_UNDERSTANDING_PROVIDERS.map((p) => p.id).join(", ")}.`,
    });
  }
  return provider;
}

export function getActiveVideoUnderstandingProvider(): VideoUnderstandingProvider {
  const explicit = getVideoAnalysisProviderId();
  if (explicit) {
    return getVideoUnderstandingProviderById(explicit);
  }
  for (const candidate of VIDEO_UNDERSTANDING_PROVIDERS) {
    if (getOptionalEnv(candidate.apiKeyEnvVar)) {
      return candidate;
    }
  }
  throw new ProviderError({
    kind: "auth",
    provider: "video-understanding",
    message:
      "Video analysis isn't set up yet: set GEMINI_API_KEY, OPENROUTER_API_KEY, or SURPLUS_API_KEY (or set VIDEO_ANALYSIS_PROVIDER).",
  });
}

export function resolveVideoUnderstandingContext(
  provider: VideoUnderstandingProvider,
): VideoUnderstandingContext {
  const apiKey = getOptionalEnv(provider.apiKeyEnvVar);
  if (!apiKey) {
    throw new ProviderError({
      kind: "auth",
      provider: provider.id,
      message: `Video analysis isn't set up yet: set ${provider.apiKeyEnvVar} for ${provider.label}.`,
    });
  }
  const baseUrl =
    getOptionalEnv(provider.baseUrlEnvVar) ?? provider.defaultBaseUrl;
  const model = getVideoAnalysisModelOverride() ?? provider.defaultModel;
  return { apiKey, baseUrl, model };
}

export function resolveActiveVideoUnderstandingProvider(): {
  provider: VideoUnderstandingProvider;
  ctx: VideoUnderstandingContext;
} {
  const provider = getActiveVideoUnderstandingProvider();
  const ctx = resolveVideoUnderstandingContext(provider);
  return { provider, ctx };
}
