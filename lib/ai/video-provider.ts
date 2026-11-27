import "server-only";

export {
  getActiveVideoProvider,
  getPublicVideoProviderInfo,
  getVideoProviderById,
  listVideoProviders,
  resolveActiveVideoProvider,
  resolveModelForProvider,
  resolveVideoProviderContext,
} from "@/lib/ai/providers/video/registry";
export type {
  PublicVideoProviderInfo,
  VideoGenerationProvider,
  VideoModelSpec,
  VideoProviderCapabilities,
  VideoProviderContext,
} from "@/lib/ai/providers/video/types";
