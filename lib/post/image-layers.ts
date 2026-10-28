export type SlideImageLayer = {
  id: string;
  imageUrl: string;
  x: number;
  y: number;
  width: number;
  opacity: number;
};

export const MIN_SLIDE_IMAGE_LAYER_WIDTH = 0.08;
export const MAX_SLIDE_IMAGE_LAYER_WIDTH = 0.8;
export const DEFAULT_SLIDE_IMAGE_LAYER_WIDTH = 0.28;

export function createSlideImageLayer(imageUrl: string): SlideImageLayer {
  return {
    id:
      globalThis.crypto?.randomUUID?.() ??
      `image-layer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    imageUrl,
    x: 0.5,
    y: 0.5,
    width: DEFAULT_SLIDE_IMAGE_LAYER_WIDTH,
    opacity: 1,
  };
}

export function normalizeSlideImageLayers(
  imageLayers: unknown,
): SlideImageLayer[] {
  if (!Array.isArray(imageLayers)) {
    return [];
  }

  return imageLayers.filter(isSlideImageLayer);
}

function isSlideImageLayer(layer: unknown): layer is SlideImageLayer {
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) {
    return false;
  }

  const candidate = layer as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    typeof candidate.imageUrl === "string" &&
    candidate.imageUrl.trim().length > 0 &&
    typeof candidate.x === "number" &&
    candidate.x >= 0 &&
    candidate.x <= 1 &&
    typeof candidate.y === "number" &&
    candidate.y >= 0 &&
    candidate.y <= 1 &&
    typeof candidate.width === "number" &&
    candidate.width >= MIN_SLIDE_IMAGE_LAYER_WIDTH &&
    candidate.width <= MAX_SLIDE_IMAGE_LAYER_WIDTH &&
    typeof candidate.opacity === "number" &&
    candidate.opacity >= 0 &&
    candidate.opacity <= 1
  );
}
