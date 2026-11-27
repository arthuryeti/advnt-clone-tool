import "server-only";

import { ProviderError } from "@/lib/ai/errors";
import { falVideoProvider } from "@/lib/ai/providers/video/fal";
import { kieVideoProvider } from "@/lib/ai/providers/video/kie";
import { revanaVideoProvider } from "@/lib/ai/providers/video/revana";
import { sumeVideoProvider } from "@/lib/ai/providers/video/sume";
import type {
  PublicVideoProviderInfo,
  VideoGenerationProvider,
  VideoModelSpec,
  VideoProviderContext,
} from "@/lib/ai/providers/video/types";
import { normalizeVideoModelId } from "@/lib/content-workflows/video-clone";
import { getOptionalEnv, getVideoProviderId } from "@/lib/env";

const VIDEO_PROVIDERS: readonly VideoGenerationProvider[] = [
  kieVideoProvider,
  revanaVideoProvider,
  sumeVideoProvider,
  falVideoProvider,
];

const PROVIDER_MAP = new Map<string, VideoGenerationProvider>(
  VIDEO_PROVIDERS.map((provider) => [provider.id, provider]),
);

export function listVideoProviders(): readonly VideoGenerationProvider[] {
  return VIDEO_PROVIDERS;
}

export function getVideoProviderById(id: string): VideoGenerationProvider {
  const provider = PROVIDER_MAP.get(id.trim().toLowerCase());
  if (!provider) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: id,
      message: `Unknown video provider "${id}". Registered: ${VIDEO_PROVIDERS.map((p) => p.id).join(", ")}.`,
    });
  }
  return provider;
}

export function getActiveVideoProvider(): VideoGenerationProvider {
  return getVideoProviderById(getVideoProviderId());
}

export function resolveVideoProviderContext(
  provider: VideoGenerationProvider,
): VideoProviderContext {
  const apiKey = getOptionalEnv(provider.apiKeyEnvVar);
  if (!apiKey) {
    throw new ProviderError({
      kind: "auth",
      provider: provider.id,
      message: `Video generation isn't set up yet: set ${provider.apiKeyEnvVar} for ${provider.label}.`,
    });
  }
  const baseUrl =
    getOptionalEnv(provider.baseUrlEnvVar) ?? provider.defaultBaseUrl;
  return { apiKey, baseUrl };
}

export function resolveActiveVideoProvider(): {
  provider: VideoGenerationProvider;
  ctx: VideoProviderContext;
} {
  const provider = getActiveVideoProvider();
  const ctx = resolveVideoProviderContext(provider);
  return { provider, ctx };
}

export function resolveModelForProvider(
  provider: VideoGenerationProvider,
  requestedModel?: string | null,
): VideoModelSpec {
  const normalized = normalizeVideoModelId(
    requestedModel ?? provider.defaultModelId,
  );
  const spec = provider.models.find(
    (model) =>
      model.id === normalized ||
      model.providerModelId === requestedModel ||
      model.aliases?.includes(requestedModel ?? "") ||
      model.aliases?.includes(normalized),
  );
  if (!spec) {
    throw new ProviderError({
      kind: "invalid_input",
      provider: provider.id,
      message: `Model "${requestedModel}" is not supported by ${provider.label}. Available: ${provider.models.map((m) => m.id).join(", ")}.`,
    });
  }
  return spec;
}

export function getPublicVideoProviderInfo(): PublicVideoProviderInfo {
  const provider = getActiveVideoProvider();
  return {
    id: provider.id,
    label: provider.label,
    defaultModelId: provider.defaultModelId,
    requiresPublicCallbackUrl: provider.capabilities.requiresPublicCallbackUrl,
    models: provider.models.map((model) => ({
      id: model.id,
      label: model.label,
      aliases: [...(model.aliases ?? [])],
      usdPerSecond: model.usdPerSecond,
      maxImages: model.maxImages,
      minSeconds: model.minSeconds,
      maxSeconds: model.maxSeconds,
    })),
  };
}
