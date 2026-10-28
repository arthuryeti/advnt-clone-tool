import "server-only";

import path from "node:path";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { drawSlideTextOverlay } from "@/lib/post/draw-slide-text-overlay";
import { resolveStorageDownloadUrl } from "@/lib/storage";
import type { SlideImageLayer } from "./image-layers";
import type { SlideTextLayer } from "./text-layers";

let overlayFontRegistered = false;

function getOverlayFontPath() {
  return path.join(process.cwd(), "fonts", "Geist-Bold.ttf");
}

function ensureOverlayFontRegistered() {
  if (overlayFontRegistered || GlobalFonts.has("GeistOverlay")) {
    overlayFontRegistered = true;
    return;
  }

  const fontKey = GlobalFonts.registerFromPath(
    getOverlayFontPath(),
    "GeistOverlay",
  );

  if (!fontKey) {
    throw new Error("Could not register overlay font.");
  }

  overlayFontRegistered = true;
}

async function drawImageOverlay(input: {
  context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>;
  width: number;
  height: number;
  imageLayers: SlideImageLayer[];
}) {
  for (const layer of input.imageLayers) {
    const imageUrl = await resolveStorageDownloadUrl(layer.imageUrl);
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(
        `Image layer fetch failed with status ${response.status}.`,
      );
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());
    const image = await loadImage(imageBuffer);
    const layerWidth = input.width * layer.width;
    const imageWidth = image.width || layerWidth;
    const imageHeight = image.height || layerWidth;
    const aspectRatio = imageHeight / imageWidth;
    const layerHeight = layerWidth * aspectRatio;
    const left = clamp(
      layer.x * input.width - layerWidth / 2,
      0,
      input.width - layerWidth,
    );
    const top = clamp(
      layer.y * input.height - layerHeight / 2,
      0,
      input.height - layerHeight,
    );

    input.context.save();
    input.context.globalAlpha = layer.opacity;
    input.context.drawImage(image, left, top, layerWidth, layerHeight);
    input.context.restore();
  }
}

export async function renderSlideTextOverlay(input: {
  imageUrl: string;
  textLayers: SlideTextLayer[];
  imageLayers?: SlideImageLayer[];
}) {
  ensureOverlayFontRegistered();

  const backgroundUrl = await resolveStorageDownloadUrl(input.imageUrl);
  const response = await fetch(backgroundUrl);

  if (!response.ok) {
    throw new Error(
      `Background image fetch failed with status ${response.status}.`,
    );
  }

  const imageBuffer = Buffer.from(await response.arrayBuffer());
  return renderSlideTextOverlayFromBuffer({
    imageBuffer,
    textLayers: input.textLayers,
    imageLayers: input.imageLayers,
  });
}

export async function renderSlideTextOverlayFromBuffer(input: {
  imageBuffer: Buffer;
  textLayers: SlideTextLayer[];
  imageLayers?: SlideImageLayer[];
}) {
  ensureOverlayFontRegistered();

  const imageBuffer = input.imageBuffer;
  const image = await loadImage(imageBuffer);
  const width = image.width || 1080;
  const height = image.height || 1350;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");

  context.drawImage(image, 0, 0, width, height);
  const scrim = context.createLinearGradient(0, 0, 0, height);
  scrim.addColorStop(0, "rgba(0, 0, 0, 0.2)");
  scrim.addColorStop(1, "rgba(0, 0, 0, 0.55)");
  context.fillStyle = scrim;
  context.fillRect(0, 0, width, height);
  await drawImageOverlay({
    context,
    width,
    height,
    imageLayers: input.imageLayers ?? [],
  });
  drawSlideTextOverlay({
    context,
    width,
    height,
    textLayers: input.textLayers,
  });

  return canvas.toBuffer("image/png");
}

/** Text layers alone on a transparent frame, to lay over a video. */
export function renderTextLayersImage(input: {
  width: number;
  height: number;
  textLayers: SlideTextLayer[];
}) {
  ensureOverlayFontRegistered();
  const canvas = createCanvas(input.width, input.height);
  drawSlideTextOverlay({ context: canvas.getContext("2d"), ...input });
  return canvas.toBuffer("image/png");
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}
