import {
  getTextLayerFontOption,
  hexToRgba,
  type SlideTextLayer,
} from "./text-layers";

type SlideTextCanvasContext = {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  lineJoin: CanvasLineJoin;
  lineWidth: number;
  shadowBlur: number;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  beginPath(): void;
  closePath(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
  lineTo(x: number, y: number): void;
  measureText(text: string): TextMetrics;
  moveTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
};

function stripEmoji(text: string) {
  return text.replaceAll(/\p{Extended_Pictographic}/gu, "").trim();
}

function getTextOutlineOffset(fontSize: number) {
  return Math.max(1.5, fontSize * 0.06);
}

function getTextOutlineWidth(fontSize: number) {
  return Math.max(1.5, fontSize * 0.05);
}

function breakLongWord(
  context: SlideTextCanvasContext,
  word: string,
  maxWidth: number,
) {
  const segments: string[] = [];
  let currentSegment = "";

  for (const character of word) {
    const candidate = `${currentSegment}${character}`;

    if (
      currentSegment.length > 0 &&
      context.measureText(candidate).width > maxWidth
    ) {
      segments.push(currentSegment);
      currentSegment = character;
      continue;
    }

    currentSegment = candidate;
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
}

function wrapText(
  context: SlideTextCanvasContext,
  text: string,
  input: {
    font: string;
    maxWidth: number;
  },
) {
  context.font = input.font;
  const cleanText = stripEmoji(text);
  const manualLines = cleanText.split("\n");
  const lines: string[] = [];

  for (const manualLine of manualLines) {
    const trimmedLine = manualLine.trim();

    if (trimmedLine.length === 0) {
      lines.push("");
      continue;
    }

    if (context.measureText(trimmedLine).width <= input.maxWidth) {
      lines.push(trimmedLine);
      continue;
    }

    const words = trimmedLine.split(/\s+/);
    let currentLine = "";

    for (const word of words) {
      const candidate =
        currentLine.length > 0 ? `${currentLine} ${word}` : word;

      if (context.measureText(candidate).width <= input.maxWidth) {
        currentLine = candidate;
        continue;
      }

      if (currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = "";
      }

      if (context.measureText(word).width <= input.maxWidth) {
        currentLine = word;
        continue;
      }

      const segments = breakLongWord(context, word, input.maxWidth);
      const [firstSegment, ...remainingSegments] = segments;

      if (firstSegment) {
        lines.push(firstSegment);
      }

      if (remainingSegments.length > 0) {
        lines.push(...remainingSegments.slice(0, -1));
        currentLine = remainingSegments.at(-1) ?? "";
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
  }

  return lines;
}

export function drawSlideTextOverlay(input: {
  context: SlideTextCanvasContext;
  width: number;
  height: number;
  textLayers: SlideTextLayer[];
}) {
  for (const layer of input.textLayers) {
    drawTextLayer({ ...input, layer });
  }
}

function drawTextLayer(input: {
  context: SlideTextCanvasContext;
  width: number;
  height: number;
  layer: SlideTextLayer;
}) {
  const { context, width, height, layer } = input;
  const fontOption = getTextLayerFontOption(layer.fontFamily);
  const fontSize = Math.round(width * layer.fontSize);
  const maxWidth = width * layer.width;
  const paddingX = Math.round(fontSize * 0.3);
  const lineHeight = fontSize * 1.5;
  const font = `${fontOption.weight} ${fontSize}px ${fontOption.canvasFamily}`;
  const hasBackground = Boolean(layer.backgroundColor);
  const lines = wrapText(context, layer.text, {
    font,
    maxWidth: hasBackground ? maxWidth - paddingX * 2 : maxWidth,
  });
  const totalTextHeight = lines.length * lineHeight;
  const containerLeft = clamp(
    layer.x * width - maxWidth / 2,
    0,
    width - maxWidth,
  );
  const top = clamp(
    layer.y * height - totalTextHeight / 2,
    0,
    height - totalTextHeight,
  );

  context.font = font;
  context.textAlign = layer.textAlign;
  context.textBaseline = "top";
  context.fillStyle = layer.textColor;

  for (const [index, line] of lines.entries()) {
    if (line.length === 0) {
      continue;
    }

    const lineWidth = Math.min(
      context.measureText(line).width,
      hasBackground ? maxWidth - paddingX * 2 : maxWidth,
    );
    const lineTop = top + index * lineHeight;
    const backgroundWidth = Math.min(lineWidth + paddingX * 2, maxWidth);
    const backgroundLeft = getAlignedLineLeft({
      containerLeft,
      containerWidth: maxWidth,
      lineWidth: backgroundWidth,
      align: layer.textAlign,
    });
    const textX = getAlignedTextX({
      left: hasBackground ? backgroundLeft : containerLeft,
      width: hasBackground ? backgroundWidth : maxWidth,
      paddingX: hasBackground ? paddingX : 0,
      align: layer.textAlign,
    });

    if (hasBackground && layer.backgroundColor) {
      context.fillStyle = layer.backgroundColor;
      roundedRect(
        context,
        backgroundLeft,
        lineTop,
        backgroundWidth,
        lineHeight,
        fontSize * 0.08,
      );
      context.fill();
      context.fillStyle = layer.textColor;
    }

    const textTop = lineTop + (lineHeight - fontSize) / 2;

    if (layer.textShadow) {
      const outlineColor = hexToRgba(
        layer.textShadow.color,
        layer.textShadow.opacity,
      );
      const outlineOffset = getTextOutlineOffset(fontSize);
      const outlineOffsets: Array<readonly [number, number]> = [
        [outlineOffset, 0],
        [-outlineOffset, 0],
        [0, outlineOffset],
        [0, -outlineOffset],
        [outlineOffset, outlineOffset],
        [-outlineOffset, outlineOffset],
        [outlineOffset, -outlineOffset],
        [-outlineOffset, -outlineOffset],
      ];

      context.fillStyle = outlineColor;
      for (const [offsetX, offsetY] of outlineOffsets) {
        context.fillText(line, textX + offsetX, textTop + offsetY);
      }

      context.strokeStyle = outlineColor;
      context.lineJoin = "round";
      context.lineWidth = getTextOutlineWidth(fontSize);
      context.strokeText(line, textX, textTop);
      context.fillStyle = layer.textColor;

      const shadowScale = width / 320;
      context.shadowColor = outlineColor;
      context.shadowBlur = layer.textShadow.blur * shadowScale;
      context.shadowOffsetX = layer.textShadow.offsetX * shadowScale;
      context.shadowOffsetY = layer.textShadow.offsetY * shadowScale;
    }

    context.fillText(line, textX, textTop);

    if (layer.textShadow) {
      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
    }
  }
}

function getAlignedTextX(input: {
  left: number;
  width: number;
  paddingX: number;
  align: CanvasTextAlign;
}) {
  if (input.align === "left") {
    return input.left + input.paddingX;
  }

  if (input.align === "right") {
    return input.left + input.width - input.paddingX;
  }

  return input.left + input.width / 2;
}

function getAlignedLineLeft(input: {
  containerLeft: number;
  containerWidth: number;
  lineWidth: number;
  align: CanvasTextAlign;
}) {
  if (input.align === "left") {
    return input.containerLeft;
  }

  if (input.align === "right") {
    return input.containerLeft + input.containerWidth - input.lineWidth;
  }

  return input.containerLeft + (input.containerWidth - input.lineWidth) / 2;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function roundedRect(
  context: SlideTextCanvasContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);

  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height,
  );
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}
