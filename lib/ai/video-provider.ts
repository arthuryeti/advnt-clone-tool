import "server-only";

import {
  VIDEO_PROVIDER_LABELS,
  type VideoProvider,
} from "@/lib/content-workflows/video-clone";
import { env } from "@/lib/env";

const KEY: Record<VideoProvider, string | undefined> = {
  kie: env.KIE_API_KEY,
  revana: env.REVANA_API_KEY,
  sume: env.SUME_API_KEY,
};

/** Who renders takes (VIDEO_PROVIDER) and its key from the environment. */
export async function getVideoProvider() {
  const provider = env.VIDEO_PROVIDER;
  const apiKey = KEY[provider];
  if (!apiKey) {
    throw new Error(
      `Video generation isn't set up yet: set ${provider.toUpperCase()}_API_KEY for ${VIDEO_PROVIDER_LABELS[provider]}.`,
    );
  }
  return { provider, apiKey };
}
