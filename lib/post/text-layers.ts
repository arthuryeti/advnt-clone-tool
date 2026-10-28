export const SLIDE_TEXT_LAYER_FONT_FAMILIES = [
  "geist",
  "display",
  "serif",
  "mono",
] as const;

export type SlideTextLayerFontFamily =
  (typeof SLIDE_TEXT_LAYER_FONT_FAMILIES)[number];

export const SLIDESHOW_TEXT_PRESET_TYPES = ["background", "shadow"] as const;
export type SlideshowTextPresetType =
  (typeof SLIDESHOW_TEXT_PRESET_TYPES)[number];

export type SlideTextShadow = {
  color: string;
  opacity: number;
  blur: number;
  offsetX: number;
  offsetY: number;
};

export type AccountSlideshowTextPreset = {
  type: SlideshowTextPresetType;
  shadow: SlideTextShadow;
};

export type SlideTextLayer = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontFamily: SlideTextLayerFontFamily;
  textColor: string;
  backgroundColor: string | null;
  backgroundOpacity: number;
  textShadow: SlideTextShadow | null;
  textAlign: "left" | "center" | "right";
  isPrimary: boolean;
};

export const DEFAULT_SLIDE_TEXT_LAYER_ID = "primary";
export const DEFAULT_SLIDE_TEXT_LAYER_FONT_SIZE = 0.042;
export const BACKGROUND_SLIDE_TEXT_LAYER_FONT_SIZE = 0.038;
export const DEFAULT_SLIDE_TEXT_LAYER_WIDTH = 0.75;
export const DEFAULT_SLIDE_TEXT_LAYER_TEXT_COLOR = "#ffffff";
export const DEFAULT_SLIDE_TEXT_SHADOW: SlideTextShadow = {
  color: "#000000",
  opacity: 0.7,
  blur: 4,
  offsetX: 0,
  offsetY: 1,
};
export const DEFAULT_ACCOUNT_SLIDESHOW_TEXT_PRESET: AccountSlideshowTextPreset =
  {
    type: "background",
    shadow: DEFAULT_SLIDE_TEXT_SHADOW,
  };

export const SLIDE_TEXT_LAYER_FONT_OPTIONS: Array<{
  value: SlideTextLayerFontFamily;
  label: string;
  cssFamily: string;
  canvasFamily: string;
  weight: number;
}> = [
  {
    value: "geist",
    label: "Geist",
    cssFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
    canvasFamily: "GeistOverlay",
    weight: 700,
  },
  {
    value: "display",
    label: "Display",
    cssFamily: "var(--font-bebas-neue), Impact, sans-serif",
    canvasFamily: "Impact, Arial, sans-serif",
    weight: 400,
  },
  {
    value: "serif",
    label: "Serif",
    cssFamily: "Georgia, Times New Roman, serif",
    canvasFamily: 'Georgia, "Times New Roman", serif',
    weight: 700,
  },
  {
    value: "mono",
    label: "Mono",
    cssFamily: "var(--font-jetbrains-mono), ui-monospace, monospace",
    canvasFamily: '"Courier New", monospace',
    weight: 700,
  },
];

export function createDefaultSlideTextLayer(
  text: string,
  input?: Partial<SlideTextLayer> & {
    preset?: AccountSlideshowTextPreset | null;
  },
): SlideTextLayer {
  const { preset, ...overrides } = input ?? {};

  return {
    id: DEFAULT_SLIDE_TEXT_LAYER_ID,
    text: normalizeLayerText(text),
    x: 0.5,
    y: 0.5,
    width: DEFAULT_SLIDE_TEXT_LAYER_WIDTH,
    fontSize: DEFAULT_SLIDE_TEXT_LAYER_FONT_SIZE,
    fontFamily: "geist",
    textColor: DEFAULT_SLIDE_TEXT_LAYER_TEXT_COLOR,
    backgroundColor: null,
    backgroundOpacity: 1,
    textShadow: null,
    textAlign: "center",
    isPrimary: true,
    ...getSlideTextLayerPresetStyle(
      preset ?? DEFAULT_ACCOUNT_SLIDESHOW_TEXT_PRESET,
    ),
    ...overrides,
  };
}

export function duplicateSlideTextLayer(layer: SlideTextLayer): SlideTextLayer {
  return {
    ...layer,
    id:
      globalThis.crypto?.randomUUID?.() ??
      `layer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    x: Math.min(0.9, layer.x + 0.04),
    y: Math.min(0.9, layer.y + 0.04),
    isPrimary: false,
  };
}

export function normalizeSlideTextLayers(
  textLayers: unknown,
  fallbackText: string,
): unknown {
  if (Array.isArray(textLayers) && textLayers.length > 0) {
    return textLayers;
  }

  return [createDefaultSlideTextLayer(fallbackText)];
}

export function getSlidePlainText(input: {
  textLayers?: Array<Pick<SlideTextLayer, "text">>;
  text?: string;
}): string {
  const layerText = input.textLayers
    ?.map((layer) => layer.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  if (layerText && layerText.length > 0) {
    return layerText;
  }

  return input.text?.trim() ?? "";
}

export function getPrimarySlideText(input: {
  textLayers?: Array<Pick<SlideTextLayer, "text" | "isPrimary">>;
  text?: string;
}): string {
  const primaryText = input.textLayers
    ?.find((layer) => layer.isPrimary)
    ?.text.trim();

  if (primaryText && primaryText.length > 0) {
    return primaryText;
  }

  const firstLayerText = input.textLayers?.[0]?.text.trim();

  if (firstLayerText && firstLayerText.length > 0) {
    return firstLayerText;
  }

  return input.text?.trim() ?? "";
}

export function getTextLayerFontOption(fontFamily: SlideTextLayerFontFamily) {
  return (
    SLIDE_TEXT_LAYER_FONT_OPTIONS.find(
      (option) => option.value === fontFamily,
    ) ?? SLIDE_TEXT_LAYER_FONT_OPTIONS[0]!
  );
}

export function normalizeAccountSlideshowTextPreset(
  preset: AccountSlideshowTextPreset | null | undefined,
): AccountSlideshowTextPreset {
  if (!preset) {
    return DEFAULT_ACCOUNT_SLIDESHOW_TEXT_PRESET;
  }

  return {
    type: preset.type,
    shadow: normalizeSlideTextShadow(preset.shadow),
  };
}

export function getSlideTextLayerPresetStyle(
  preset: AccountSlideshowTextPreset,
): Partial<SlideTextLayer> {
  if (preset.type === "shadow") {
    return {
      textColor: "#ffffff",
      backgroundColor: null,
      backgroundOpacity: 1,
      textShadow: normalizeSlideTextShadow(preset.shadow),
    };
  }

  return {
    fontSize: BACKGROUND_SLIDE_TEXT_LAYER_FONT_SIZE,
    textColor: "#000000",
    backgroundColor: "#ffffff",
    backgroundOpacity: 1,
    textShadow: null,
  };
}

export function normalizeSlideTextShadow(
  shadow: SlideTextShadow | null | undefined,
): SlideTextShadow {
  return {
    color: normalizeHexColor(shadow?.color, DEFAULT_SLIDE_TEXT_SHADOW.color),
    opacity: clampNumber(
      shadow?.opacity ?? DEFAULT_SLIDE_TEXT_SHADOW.opacity,
      0,
      1,
    ),
    blur: clampNumber(shadow?.blur ?? DEFAULT_SLIDE_TEXT_SHADOW.blur, 0, 32),
    offsetX: clampNumber(
      shadow?.offsetX ?? DEFAULT_SLIDE_TEXT_SHADOW.offsetX,
      -24,
      24,
    ),
    offsetY: clampNumber(
      shadow?.offsetY ?? DEFAULT_SLIDE_TEXT_SHADOW.offsetY,
      -24,
      24,
    ),
  };
}

export function getTextShadowCss(shadow: SlideTextShadow): string {
  const color = hexToRgba(shadow.color, shadow.opacity);
  const outlineShadows = [
    `1.5px 0 1px ${color}`,
    `-1.5px 0 1px ${color}`,
    `0 1.5px 1px ${color}`,
    `0 -1.5px 1px ${color}`,
    `1.5px 1.5px 1px ${color}`,
    `-1.5px 1.5px 1px ${color}`,
    `1.5px -1.5px 1px ${color}`,
    `-1.5px -1.5px 1px ${color}`,
  ];

  return [
    ...outlineShadows,
    `${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${color}`,
  ].join(", ");
}

export function hexToRgba(hex: string, opacity: number): string {
  const normalized = normalizeHexColor(
    hex,
    DEFAULT_SLIDE_TEXT_SHADOW.color,
  ).replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

export function normalizeLayerText(text: string): string {
  return text.replace(/\s+$/u, "").trimStart() || "Slide text unavailable.";
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function normalizeHexColor(value: string | null | undefined, fallback: string) {
  return value && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
}
