import { z } from "zod/v4";

/** Seedance 2.5 renders 4-30s per generation (Wan 3.0 2-30s); takes are planned for Seedance. */
export const SEEDANCE_MIN_SECONDS = 4;
export const MAX_TAKE_SECONDS = 30;
/** How long changes can grow a video: TikTok's 10-minute upload limit. */
export const MAX_STORY_SECONDS = 600;
// ponytail: guess at how many cuts Seedance can land in one take; tune once real drafts come back.
export const MAX_CUTS_PER_SECOND = 1;

export const VIDEO_CLONE_DIFFICULTIES = ["easy", "hard", "manual"] as const;
export type VideoCloneDifficulty = (typeof VIDEO_CLONE_DIFFICULTIES)[number];
export const VIDEO_CLONE_VERDICTS = ["clone", "skip"] as const;
export type VideoCloneVerdict = (typeof VIDEO_CLONE_VERDICTS)[number];
/** Product photos one render can reference (Seedance takes up to 30 images). */
export const MAX_VIDEO_CLONE_PRODUCTS = 10;

/** Canonical model identifiers stored in clone plans, decoupled from provider-specific slugs. */
export const DEFAULT_VIDEO_MODEL_ID = "seedance-2.5";
export const LEGACY_VIDEO_MODEL_ALIASES: Record<string, string> = {
  "bytedance/seedance-2-5": "seedance-2.5",
  "wan/3-0-video": "wan-3.0",
};

export type VideoCloneModel = string;

/** Normalizes legacy provider-prefixed model slugs onto canonical model IDs. */
export function normalizeVideoModelId(model?: string | null): string {
  const trimmed = model?.trim();
  if (!trimmed) return DEFAULT_VIDEO_MODEL_ID;
  return LEGACY_VIDEO_MODEL_ALIASES[trimmed] ?? trimmed;
}

export type VideoModelPricingSpec = {
  id: string;
  aliases?: readonly string[];
  minSeconds: number;
  maxSeconds: number;
  usdPerSecond: number;
};

// The .describe() texts double as Gemini instructions: these schemas are its response formats.
export const videoCloneVibeSchema = z.object({
  format: z
    .string()
    .describe(
      "e.g. street interview, talking head, green screen, b-roll montage, or a mix",
    ),
  summary: z.string(),
  hook: z.string().describe("what grabs attention in the first 3 seconds"),
  visualStyle: z
    .string()
    .describe("device/camera feel, framing habits, color, lighting, realism"),
  setting: z.string(),
  pacing: z.string(),
  audio: z.string().describe("dialogue, voiceover, music, ambience"),
  onScreenText: z
    .string()
    .describe(
      "caption/overlay style; these are added in editing, not generated",
    ),
  characters: z.array(
    z.object({
      id: z
        .string()
        .describe("short stable id like interviewer, guest_1, presenter"),
      role: z.string(),
      description: z
        .string()
        .describe(
          "detailed, reusable visual description: build, hair, wardrobe, accessories",
        ),
      reference: z
        .enum(["creator", "none"])
        .describe(
          "creator = the main on-camera person our account's creator will replace",
        ),
    }),
  ),
  product: z.object({ present: z.boolean(), description: z.string() }),
  transcript: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      speaker: z.string(),
      text: z.string(),
    }),
  ),
});
export type VideoCloneVibe = z.infer<typeof videoCloneVibeSchema>;

export const videoCloneTakeAnalysisSchema = z.object({
  description: z.string(),
  shotType: z
    .string()
    .describe(
      "wide, medium, close-up, over-the-shoulder, screen recording, end card, ...",
    ),
  camera: z.string().describe("angle, movement, lens feel"),
  action: z.string().describe("beat-by-beat what happens in each part"),
  charactersInShot: z.array(z.string()).describe("character ids from the vibe"),
  needsCreatorReference: z.boolean(),
  needsProductReference: z.boolean(),
  dialogue: z
    .array(z.object({ speaker: z.string(), text: z.string() }))
    .describe("exact words spoken in this clip"),
  onScreenText: z
    .string()
    .describe(
      "text visible in the original clip; it will be re-added in editing",
    ),
  difficulty: z
    .enum(VIDEO_CLONE_DIFFICULTIES)
    .describe(
      "easy: AI video should nail it in 1-2 tries. hard: likely to fail or need several retries. manual: an AI video model should not invent it; film or edit it instead",
    ),
  difficultyReason: z
    .string()
    .describe("the specific thing that makes it hard or manual; empty if easy"),
  notes: z
    .string()
    .describe(
      "if manual: how we should source this instead; otherwise risks to watch",
    ),
  prompt: z.string().describe("the Seedance 2.5 prompt"),
});
export type VideoCloneTakeAnalysis = z.infer<
  typeof videoCloneTakeAnalysisSchema
>;

export const videoCloneGenerationSchema = z.object({
  status: z.enum(["generating", "done", "failed"]),
  /** What the video model received: after the requested changes and reference wiring. */
  prompt: z.string(),
  videoUrl: z.string().optional(),
  error: z.string().optional(),
  /** Character id -> the face that played them. Absent on renders made before these were recorded. */
  cast: z.record(z.string(), z.string().uuid()).optional(),
  changes: z.string(),
  productFolder: z.string().nullable().optional(),
  /** Canonical model ID used for this render. */
  model: z.string().min(1).max(120).optional(),
  /** Provider plugin ID that executed this render. */
  providerId: z.string().min(1).max(80).optional(),
  /** Durable render_attempts ID linking this generation to Postgres reconciliation. */
  attemptId: z.string().uuid().optional(),
  /**
   * Parts (by shot) this render stages differently from the original: another action, camera
   * side, or listener (checkVideoCloneRender). Absent = not checked.
   */
  mismatches: z
    .array(z.object({ shot: z.number().int(), issue: z.string() }))
    .optional(),
  startedAt: z.string(),
});
export type VideoCloneGeneration = z.infer<typeof videoCloneGenerationSchema>;

const videoClonePartSchema = z.object({
  shot: z.number().int(),
  sceneId: z.string().nullable(),
  /** Where the part sits in the original video. */
  srcStart: z.number(),
  srcEnd: z.number(),
  /** Where the part sits inside its take (the one generation); longer than its source when extended. */
  takeStart: z.number(),
  takeEnd: z.number(),
  /** This part rendered alone, replacing its piece of the take's render. Cleared when the take renders again. */
  generation: videoCloneGenerationSchema.optional(),
  /**
   * An earlier render of its take (videoUrl) whose piece of this part plays instead of the
   * current render's, unless the part's own render does. Cleared when the take renders again.
   */
  takeRender: z.string().optional(),
  /** Earlier renders of this part alone, kept to switch back to (videoCloneRenders). */
  renders: z.array(videoCloneGenerationSchema).optional(),
});
export type VideoClonePart = z.infer<typeof videoClonePartSchema>;

/** Things that must look the same wherever they show: a person's look, a set, a prop. */
export const videoCloneContinuitySchema = z.array(
  z.object({
    label: z
      .string()
      .describe(
        "short name without details, e.g. 'the woman's evening outfit', 'the living room', 'the man's look', 'the red car'; the details come from a frame of an earlier render",
      ),
    shots: z.array(z.number().int()).describe("every shot index showing it"),
    /** Absent on plans analyzed before it was asked; the analysis requires it. */
    bestShot: z
      .number()
      .int()
      .optional()
      .describe(
        "the shot showing it most clearly and completely: a person's whole outfit facing the camera, the widest view of a place",
      ),
  }),
);
export type VideoCloneContinuity = z.infer<typeof videoCloneContinuitySchema>;
/** Earlier-render frames one take references for continuity, on top of cast and products. */
export const MAX_CONTINUITY_FRAMES = 4;
/** Frames the user picks off the timeline for one render to match (clip dialog). */
export const MAX_PICKED_FRAMES = 3;

export const videoCloneSchema = z.object({
  /** The TikTok/Instagram link, or the /storage URL of an uploaded file. */
  sourceUrl: z.string(),
  sourceVideoUrl: z.string(),
  durationSeconds: z.number(),
  vibe: videoCloneVibeSchema,
  scenes: z.array(
    z.object({ id: z.string(), location: z.string(), cast: z.string() }),
  ),
  /** Absent on plans analyzed before continuity was tracked. */
  continuity: videoCloneContinuitySchema.optional(),
  /**
   * Every part's shot in the order the video plays them, once changes added takes; absent = the
   * original's order. See videoCloneStory.
   */
  story: z.array(z.number().int()).optional(),
  takes: z.array(
    z.object({
      index: z.number().int(),
      seconds: z.number(),
      /** The take's original footage; absent on takes changes added, whose parts have no source (isAddedPart). */
      videoUrl: z.string().optional(),
      parts: z.array(videoClonePartSchema),
      analysis: videoCloneTakeAnalysisSchema,
      /** Asset IDs of our product photos this take must show, on top of any render folder. */
      products: z
        .array(z.string().uuid())
        .max(MAX_VIDEO_CLONE_PRODUCTS)
        .optional(),
      /** Canonical model ID the next render uses; absent = active provider's default. */
      model: z.string().min(1).max(120).optional(),
      /** Not rendered: the edit uses the original's footage. Absent = only manual takes; see keepsOriginal. */
      keepOriginal: z.boolean().optional(),
      /** The render the edit uses: the latest, unless an earlier one was picked back. */
      generation: videoCloneGenerationSchema.optional(),
      /** Earlier renders, kept to switch back to (videoCloneRenders). */
      renders: z.array(videoCloneGenerationSchema).optional(),
    }),
  ),
  verdict: z.enum(VIDEO_CLONE_VERDICTS),
  /** The latest toolbar change, applied in the background (rewrite-video-clone): big ones take minutes. */
  rewrite: z
    .object({
      status: z.enum(["rewriting", "done", "failed"]),
      changes: z.string(),
      /** The product folder it was written for; the toolbar starts from it until a render says otherwise. */
      productFolder: z.string().nullable().optional(),
      startedAt: z.string(),
      error: z.string().optional(),
      /** What it did, once done. */
      summary: z.string().optional(),
      changed: z.array(z.number().int()).optional(),
      linesChanged: z.boolean().optional(),
      retimed: z.array(z.number().int()).optional(),
      added: z.array(z.number().int()).optional(),
      addedSeconds: z.number().optional(),
    })
    .optional(),
  /**
   * The renders cut into one video: every part in story order, from its take's render, or from
   * the original where the take isn't rendered yet (added parts not rendered yet are left out).
   */
  edit: z
    .object({
      status: z.enum(["stitching", "done", "failed"]),
      /** Monotonic revision counter to prevent stale stitch commits from overwriting newer edits. */
      revision: z.number().int().optional(),
      /** Kept while a re-stitch runs, so the last edit stays watchable. */
      videoUrl: z.string().optional(),
      /** The same edit with the takes' on-screen text burned in (videoCloneTextOverlays), for downloads and posts when `burnText` is on; absent when it has none. */
      textVideoUrl: z.string().optional(),
      error: z.string().optional(),
      /** Take indexes whose render the edit uses; the rest is original footage. */
      rendered: z.array(z.number().int()),
      /**
       * Where each part plays in the edit, in story order: renders follow their own cuts, so the
       * edit's times drift from the plan's. Absent = the original's times.
       */
      parts: z
        .array(
          z.object({
            /** Absent on edits stitched before parts were tracked by shot. */
            shot: z.number().int().optional(),
            srcStart: z.number(),
            srcEnd: z.number(),
            start: z.number(),
            end: z.number(),
          }),
        )
        .optional(),
      startedAt: z.string(),
    })
    .optional(),
  /** Download and posts use the edit with on-screen text burned in (`edit.textVideoUrl`); off by default. */
  burnText: z.boolean().optional(),
  /** Each render's cuts and length by file, as the stitch found them, so the page's live preview cuts the same edit. */
  renderCuts: z
    .record(
      z.string(),
      z.object({ cuts: z.array(z.number()), duration: z.number() }),
    )
    .optional(),
});
export type VideoClone = z.infer<typeof videoCloneSchema>;

export const generateVideoCloneInputSchema = z.object({
  organizationId: z.string().uuid(),
  templateId: z.string().uuid(),
  takeIndexes: z.array(z.number().int().positive()).min(1).max(60),
  /** Character id (the plan's vibe.characters) -> the face (faces table) that plays them; the rest keep their description. */
  cast: z.record(z.string().max(100), z.string().uuid()).default({}),
  /** Free-text edits for every selected take: the script ("reword it", "a new script"), setting, wardrobe... */
  changes: z.string().trim().max(2000),
  /** Gallery folder whose images are our products; null leaves our product out. */
  productFolder: z.string().trim().min(1).max(200).nullable().default(null),
  /** Renders only this part (its `shot`) of the one selected take, matching the take's render. */
  shot: z.number().int().positive().optional(),
  /** Stills the user picked off the timeline (/storage URLs of uploads) every selected take must match. */
  frames: z.array(z.string()).max(MAX_PICKED_FRAMES).default([]),
  startedAt: z.string(),
});

/** A toolbar change applied in the background (rewrite-video-clone). */
export const rewriteVideoCloneInputSchema = z.object({
  organizationId: z.string().uuid(),
  templateId: z.string().uuid(),
  changes: generateVideoCloneInputSchema.shape.changes.min(1),
  /** The toolbar's product folder: what "our product" is when the change plugs it. */
  productFolder: generateVideoCloneInputSchema.shape.productFolder,
  startedAt: z.string(),
});

/** One take's editable fields, from the clone page. */
export const videoCloneTakeEditSchema = z.object({
  templateId: z.string().uuid(),
  takeIndex: z.number().int().positive(),
  prompt: z.string().trim().min(1).max(10_000).optional(),
  dialogue: videoCloneTakeAnalysisSchema.shape.dialogue.max(100).optional(),
  products: z.array(z.string().uuid()).max(MAX_VIDEO_CLONE_PRODUCTS).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  keepOriginal: z.boolean().optional(),
});

export const analyzeVideoCloneInputSchema = z.object({
  organizationId: z.string().uuid(),
  sourceUrl: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
});

export const round = (value: number) => Math.round(value * 100) / 100;

const hostOf = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
};
const isHost = (value: string, domain: string) => {
  const host = hostOf(value);
  return host === domain || Boolean(host?.endsWith(`.${domain}`));
};
export const isTikTokUrl = (value: string) => isHost(value, "tiktok.com");
export const isInstagramUrl = (value: string) => isHost(value, "instagram.com");
export const videoCloneUrlSchema = z
  .string()
  .trim()
  .refine(
    (value) => isTikTokUrl(value) || isInstagramUrl(value),
    "Use a TikTok or Instagram link.",
  )
  // Same post, same analysis: tracking params must not defeat the cache.
  .transform((value) => {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  });

export function videoCloneSourceName(url: string): string {
  const path = new URL(url).pathname.split("/").filter(Boolean);
  if (isTikTokUrl(url)) {
    const handle = path.find((part) => part.startsWith("@"));
    return handle ? `${handle} · TikTok video` : "TikTok video";
  }
  return `Instagram · ${path.at(-1) ?? "video"}`;
}

export type CutShot = { index: number; start: number; end: number };

/** Spans between cuts; a span longer than one take is split evenly. */
export function shotsFromCuts(cuts: number[], duration: number): CutShot[] {
  const bounds = [0, ...cuts.filter((t) => t > 0 && t < duration), duration];
  const shots: CutShot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i] as number;
    const b = bounds[i + 1] as number;
    const pieces = Math.ceil((b - a) / MAX_TAKE_SECONDS);
    for (let p = 0; p < pieces; p++) {
      shots.push({
        index: shots.length + 1,
        start: round(a + ((b - a) * p) / pieces),
        end: round(a + ((b - a) * (p + 1)) / pieces),
      });
    }
  }
  return shots;
}

export type PlannedTake = {
  index: number;
  seconds: number;
  parts: VideoClonePart[];
};

/**
 * One take = one video generation. A video that fits one generation (30s) renders as one
 * take in story order: separate generations drift apart (outfits, faces, sets), even inside
 * one plan. Longer videos group a scene's shots (same place, same moment) in one take in
 * story order, so people, location, and voices match. Takes under Seedance's 4s minimum
 * (flash cuts, montage micro-shots) are pooled wherever they sit, so a 0.5s shot doesn't pay
 * for 4s and no clip is too short for Gemini (it rejects clips under ~0.5s).
 */
export function buildTakes(
  shots: CutShot[],
  sceneOf: (shotIndex: number) => string | undefined,
): PlannedTake[] {
  const length = (group: CutShot[]) =>
    group.reduce((sum, shot) => sum + shot.end - shot.start, 0);
  const toTakes = (groups: CutShot[][]) =>
    groups.map((group, i) => {
      let at = 0;
      const parts = group.map((shot) => {
        const takeStart = at;
        at += shot.end - shot.start;
        return {
          shot: shot.index,
          sceneId: sceneOf(shot.index) ?? null,
          srcStart: shot.start,
          srcEnd: shot.end,
          takeStart: round(takeStart),
          takeEnd: round(at),
        };
      });
      return { index: i + 1, seconds: round(at), parts };
    });
  if (length(shots) <= MAX_TAKE_SECONDS) return toTakes([shots]);
  const byScene = new Map<string, CutShot[][]>(); // insertion order = first appearance
  for (const shot of shots) {
    const id = sceneOf(shot.index) ?? `shot-${shot.index}`;
    const groups = byScene.get(id) ?? [[]];
    byScene.set(id, groups);
    if (
      length(groups.at(-1) ?? []) + shot.end - shot.start >
      MAX_TAKE_SECONDS
    ) {
      groups.push([]);
    }
    groups.at(-1)?.push(shot);
  }
  const packed: CutShot[][] = [];
  let pool: CutShot[] | null = null;
  for (const group of [...byScene.values()].flat()) {
    if (length(group) >= SEEDANCE_MIN_SECONDS) {
      packed.push([...group]);
      continue;
    }
    if (!pool) {
      pool = [];
      packed.push(pool);
    }
    pool.push(...group);
    if (length(pool) >= SEEDANCE_MIN_SECONDS) pool = null;
  }
  // A leftover pool still under 4s joins the shortest other take that has room.
  const leftover = pool;
  const hosts = packed.filter((group) => group !== leftover);
  if (leftover && hosts.length > 0) {
    const host = hosts.reduce((best, group) =>
      length(group) < length(best) ? group : best,
    );
    if (length(host) + length(leftover) <= MAX_TAKE_SECONDS) {
      host.push(...leftover);
      packed.splice(packed.indexOf(leftover), 1);
    }
  }
  return toTakes(packed);
}

/** The seconds a take is rendered (and billed) for within a model's bounds. */
export const renderSecondsForModel = (
  seconds: number,
  minSeconds = SEEDANCE_MIN_SECONDS,
  maxSeconds = MAX_TAKE_SECONDS,
) => Math.min(maxSeconds, Math.max(minSeconds, Math.ceil(seconds)));

/** The seconds a take is rendered (and billed) for: its length rounded up, 4s minimum. */
export const renderSeconds = (seconds: number) =>
  renderSecondsForModel(seconds, SEEDANCE_MIN_SECONDS, MAX_TAKE_SECONDS);

function findPricingSpec(
  models: readonly VideoModelPricingSpec[],
  modelId: string | null | undefined,
  defaultModelId: string,
): VideoModelPricingSpec | undefined {
  const normalized = normalizeVideoModelId(modelId ?? defaultModelId);
  return (
    models.find(
      (item) =>
        item.id === normalized ||
        item.aliases?.includes(modelId ?? "") ||
        item.aliases?.includes(normalized),
    ) ?? models.find((item) => item.id === defaultModelId)
  );
}

/** Estimates USD render cost using provider-declared model capabilities and per-second rates. */
export function estimateVideoCloneRenderUsd(
  takes: { seconds: number; model?: string | null }[],
  models: readonly VideoModelPricingSpec[],
  defaultModelId = DEFAULT_VIDEO_MODEL_ID,
): number {
  return takes.reduce((sum, take) => {
    const spec = findPricingSpec(models, take.model, defaultModelId);
    if (!spec) return sum;
    return (
      sum +
      renderSecondsForModel(take.seconds, spec.minSeconds, spec.maxSeconds) *
        spec.usdPerSecond
    );
  }, 0);
}

/** Gemini judges content; packing many cuts into one take is a difficulty it can't see. */
export const hasTooManyCuts = (take: PlannedTake) =>
  (take.parts.length - 1) / take.seconds > MAX_CUTS_PER_SECOND;

type ContinuityTake = { index: number; parts: VideoClonePart[] };
const shows = (take: ContinuityTake, element: VideoCloneContinuity[number]) =>
  take.parts.some((part) => element.shots.includes(part.shot));

/** Whether two takes show something that must look the same in both. */
export const sharesContinuity = (
  a: ContinuityTake,
  b: ContinuityTake,
  continuity: VideoCloneContinuity = [],
) => continuity.some((element) => shows(a, element) && shows(b, element));

/**
 * The frames of rendered takes that a render (a take, or one part redone alone) should match:
 * for each element it shows, a frame from the first source showing it. There, the element's
 * best shot, else the part sharing its frame with the fewest other elements (a person alone
 * shows their whole look), then the longest. Elements on one frame share it.
 */
export function continuityFrames(
  parts: VideoClonePart[],
  /** Rendered takes in priority order, whose look wins; only the parts that stay in the edit. */
  sources: ContinuityTake[],
  continuity: VideoCloneContinuity = [],
) {
  const showing = (
    part: VideoClonePart,
    element: VideoCloneContinuity[number],
  ) => element.shots.includes(part.shot);
  const frames = new Map<
    string,
    { take: number; shot: number; labels: string[] }
  >();
  for (const element of continuity) {
    if (!parts.some((part) => showing(part, element))) continue;
    const source = sources.find((take) =>
      take.parts.some((part) => showing(part, element)),
    );
    if (!source) continue;
    const crowd = (part: VideoClonePart) =>
      continuity.filter((other) => showing(part, other)).length;
    const [part] = source.parts
      .filter((item) => showing(item, element))
      .sort(
        (a, b) =>
          Number(b.shot === element.bestShot) -
            Number(a.shot === element.bestShot) ||
          crowd(a) - crowd(b) ||
          b.takeEnd - b.takeStart - (a.takeEnd - a.takeStart),
      );
    if (!part) continue;
    const key = `${source.index}@${part.shot}`;
    const frame = frames.get(key) ?? {
      take: source.index,
      shot: part.shot,
      labels: [],
    };
    frame.labels.push(element.label);
    frames.set(key, frame);
  }
  return [...frames.values()].slice(0, MAX_CONTINUITY_FRAMES);
}

/**
 * Our products for one render, numbered as `{{productN}}` (position N): the folder's photos,
 * then the pinned ones not already in it. Also returns each take's pinned numbers.
 */
export function numberVideoCloneProducts<Image extends { url: string }>(
  folder: Image[],
  pins: (Image & { id: string })[],
  takes: { index: number; products?: string[] }[],
) {
  const products: Image[] = [
    ...folder,
    ...pins.filter((pin) => !folder.some((image) => image.url === pin.url)),
  ];
  const pinned = new Map(
    takes.flatMap((take) => {
      const numbers = (take.products ?? []).flatMap((id) => {
        const pin = pins.find((image) => image.id === id);
        return pin
          ? [products.findIndex((image) => image.url === pin.url) + 1]
          : [];
      });
      return numbers.length > 0 ? [[take.index, numbers] as const] : [];
    }),
  );
  return { products, pinned };
}

export type TakePromptReferences = {
  creator?: string;
  /** Character id -> avatar URL. */
  cast?: Map<string, string>;
  products: string[];
  /** Frames of earlier renders this take must match (continuityFrames). */
  frames?: string[];
  /** The plan's characters, for the people without an image. */
  characters?: Omit<VideoCloneVibe["characters"][number], "role">[];
  /** The original's product, for a product without an image. */
  product?: VideoCloneVibe["product"];
};

/**
 * Resolves `{{creator}}`, `{{cast:<id>}}`, `{{productN}}`, and `{{frameN}}` tokens in a take's
 * prompt against available reference image URLs and formats slots using the active model's
 * token dialect. Dedupes URLs in order of first mention and enforces the model's `maxImages`.
 */
export function resolveTakePromptReferences(
  prompt: string,
  references: TakePromptReferences,
  dialect: {
    formatImageToken: (slot: number) => string;
    maxImages: number;
    modelLabel: string;
  },
): { prompt: string; imageUrls: string[] } {
  const imageUrls: string[] = [];
  // Keyed by URL: the same avatar playing two characters is one reference image.
  const slots = new Map<string, string>();
  const text = prompt
    .replaceAll("{{product}}", "{{product1}}")
    .replace(
      /\{\{(creator|cast:([\w-]+)|product(\d+)|frame(\d+))\}\}/gu,
      (_token, name: string, castId?: string, n?: string, frame?: string) => {
        let url: string | undefined;
        let fallback: string;
        if (name === "creator" || castId) {
          url = castId ? references.cast?.get(castId) : references.creator;
          const person = references.characters?.find((character) =>
            castId
              ? character.id === castId
              : character.reference === "creator",
          );
          fallback =
            person?.description.replace(/[.\s]+$/u, "") ?? "the person";
        } else if (frame) {
          url = references.frames?.[Number(frame) - 1];
          fallback = "an earlier shot";
        } else {
          url = references.products[Number(n) - 1];
          fallback = references.product?.present
            ? references.product.description.replace(/[.\s]+$/u, "")
            : "the product";
        }

        if (!url) return fallback;
        let slot = slots.get(url);
        if (!slot) {
          imageUrls.push(url);
          slot = dialect.formatImageToken(imageUrls.length);
          slots.set(url, slot);
        }
        return slot;
      },
    );

  if (imageUrls.length > dialect.maxImages) {
    throw new Error(
      `${dialect.modelLabel} takes up to ${dialect.maxImages} reference images; this take uses ${imageUrls.length}.`,
    );
  }

  return { prompt: text, imageUrls };
}

// A take prompt's part labels: "Part 2 (5.9-12.1s):".
const PART_LABEL = /Part (\d+) \([^)]*\)[:.]?\s*/gu;

/**
 * The take prompt with each part's staging after its 'Part N (a-bs)' label (after the whole
 * prompt without labels). Gemini works out where the camera stands and who a line is said to, then
 * leaves them out of its prompt, and Seedance invents what it isn't told (a phone call).
 */
export function stageVideoClonePrompt(
  prompt: string,
  staging: { part: number; camera: string; saidTo: string }[],
) {
  const note = (part: number) => {
    const stage = staging.find((item) => item.part === part);
    const [camera, saidTo] = [stage?.camera, stage?.saidTo].map((text = "") =>
      text.trim().replace(/[.\s]+$/u, ""),
    );
    return [camera && `Camera: ${camera}.`, saidTo && `Said to: ${saidTo}.`]
      .filter(Boolean)
      .join(" ");
  };
  if (!/Part \d+ \(/u.test(prompt)) {
    const text = note(1);
    return text ? `${prompt.trim()}\n\n${text}` : prompt;
  }
  return prompt.replace(PART_LABEL, (label, n: string) => {
    const text = note(Number(n));
    return text ? `${label}${text} ` : label;
  });
}

/**
 * Why this part, as the edit plays it, stages the moment unlike the original: from the check of
 * its own render, the take render picked for it, or the take's render. Undefined when it matches
 * or wasn't checked.
 */
export function videoCloneMismatch(
  take: {
    generation?: VideoCloneGeneration;
    renders?: VideoCloneGeneration[];
  },
  part: Pick<VideoClonePart, "shot" | "generation" | "takeRender">,
) {
  let render = take.generation;
  if (part.generation?.status === "done") render = part.generation;
  else if (part.takeRender) {
    render = [take.generation, ...(take.renders ?? [])].find(
      (item) => item?.videoUrl === part.takeRender,
    );
  }
  if (render?.status !== "done") return undefined;
  return render.mismatches?.find((item) => item.shot === part.shot)?.issue;
}

/**
 * One part of a take's prompt, to render that part alone: the prompt's lead-in (look, format)
 * and that part's 'Part N (a-bs)' section, as one shot. Null when the prompt has no Part labels.
 */
export function videoClonePartPrompt(
  prompt: string,
  /** The part's position in its take, from 0. */
  position: number,
  seconds: number,
) {
  const labels = [...prompt.matchAll(PART_LABEL)];
  const [first] = labels;
  const label = labels.find((match) => Number(match[1]) === position + 1);
  if (!first || !label || labels.length < 2) return null;
  const next = labels.find((match) => match.index > label.index);
  const body = prompt
    .slice(label.index + label[0].length, next?.index)
    .trim()
    .replace(/\s*Hard cut\.?$/iu, "");
  return [
    prompt.slice(0, first.index).trim(),
    body,
    `One continuous shot, no cuts; its action plays out over the first ${seconds}s.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A take's prompt speaking its edited lines, with no rewrite: each changed line goes where the
 * prompt quotes the old one, searched in order. Null when that can't work: a line cut or added,
 * or an old line the prompt doesn't quote word for word.
 */
export function sayVideoCloneLines(
  prompt: string,
  before: { text: string }[],
  after: { text: string }[],
) {
  if (after.length !== before.length) return null;
  let text = prompt;
  let from = 0;
  for (const [i, line] of before.entries()) {
    const next = after[i]?.text.trim() ?? "";
    const at = text.indexOf(line.text, from);
    if (next === line.text) {
      if (at !== -1) from = at + line.text.length;
      continue;
    }
    if (!next || at === -1) return null;
    text = `${text.slice(0, at)}${next}${text.slice(at + line.text.length)}`;
    from = at + next.length;
  }
  return text;
}

/** A take's parts at new lengths (seconds, in order), back to back. */
export function retimeParts(parts: VideoClonePart[], seconds: number[]) {
  let at = 0;
  return parts.map((part, k) => {
    const takeStart = round(at);
    at += seconds[k] ?? part.takeEnd - part.takeStart;
    return { ...part, takeStart, takeEnd: round(at) };
  });
}

/**
 * Manual takes (screen recordings, end cards) keep the original footage unless a model is picked
 * or they were rendered anyway.
 */
export const keepsOriginal = (take: {
  keepOriginal?: boolean;
  analysis: { difficulty: VideoCloneDifficulty };
  generation?: unknown;
}) =>
  take.keepOriginal ??
  (take.analysis.difficulty === "manual" && !take.generation);

/**
 * The plan with renders and stitches whose run died without saying so (a canceled or crashed run
 * never reaches its catch) marked failed, so they can run again. A live run renders its takes in
 * rounds, each <=45 minutes, then stitches: an hour per take, plus one, bounds it.
 */
export function settleDeadRenders(video: VideoClone, now = Date.now()) {
  const cutoff = now - (video.takes.length + 1) * 60 * 60 * 1000;
  const settle = (generation: VideoCloneGeneration | undefined) =>
    generation?.status === "generating" &&
    Date.parse(generation.startedAt) < cutoff
      ? {
          ...generation,
          status: "failed" as const,
          error: "The render stopped without finishing.",
        }
      : generation;
  return {
    ...video,
    takes: video.takes.map((take) => ({
      ...take,
      generation: settle(take.generation),
      parts: take.parts.map((part) => ({
        ...part,
        generation: settle(part.generation),
      })),
    })),
    edit:
      video.edit?.status === "stitching" &&
      Date.parse(video.edit.startedAt) < cutoff
        ? {
            ...video.edit,
            status: "failed" as const,
            error: "The stitch stopped without finishing.",
          }
        : video.edit,
  };
}

/** Every finished render of a take or of a part redone alone, oldest first: the kept ones and the current one. */
export const videoCloneRenders = (item: {
  generation?: VideoCloneGeneration;
  renders?: VideoCloneGeneration[];
}) =>
  [...(item.renders ?? []), ...(item.generation ? [item.generation] : [])]
    .flatMap(({ videoUrl, ...render }) =>
      render.status === "done" && videoUrl ? [{ ...render, videoUrl }] : [],
    )
    .filter(
      (render, k, all) =>
        all.findIndex((other) => other.videoUrl === render.videoUrl) === k,
    );

/** A render's detected cuts and its length, in seconds. */
export type RenderCuts = { cuts: number[]; duration: number };
// Knob: past this, a detected cut isn't the planned one; Seedance moved that cut further or left it out.
const MAX_CUT_DRIFT = 2;

/**
 * Pairs the planned cuts with the detected ones in order, with the least total drift: a detected
 * cut paired with none is extra (Seedance cut inside a part); a planned cut with no detected one
 * within MAX_CUT_DRIFT keeps its planned time.
 * ponytail: absolute drift; Seedance stretching a long take by more than MAX_CUT_DRIFT unpairs its late cuts.
 */
function alignCuts(planned: number[], found: number[]) {
  // cost[i][j]: the best pairing of the first i planned cuts within the first j found.
  const cost = Array.from({ length: planned.length + 1 }, (_, i) =>
    Array.from({ length: found.length + 1 }, () => i * MAX_CUT_DRIFT),
  );
  const at = (i: number, j: number) => cost[i]?.[j] ?? Number.POSITIVE_INFINITY;
  /** Planned cut i-1 paired with found cut j-1; the fill and the walk back must agree. */
  const paired = (i: number, j: number) => {
    const drift = Math.abs(
      (planned[i - 1] as number) - (found[j - 1] as number),
    );
    return drift < MAX_CUT_DRIFT
      ? at(i - 1, j - 1) + drift
      : Number.POSITIVE_INFINITY;
  };
  for (let i = 1; i <= planned.length; i++) {
    for (let j = 1; j <= found.length; j++) {
      (cost[i] as number[])[j] = Math.min(
        at(i - 1, j) + MAX_CUT_DRIFT,
        at(i, j - 1),
        paired(i, j),
      );
    }
  }
  const cuts = [...planned];
  for (let i = planned.length, j = found.length; i > 0; ) {
    if (j > 0 && at(i, j) === at(i, j - 1)) {
      j--;
    } else if (j > 0 && at(i, j) === paired(i, j)) {
      cuts[i - 1] = found[j - 1] as number;
      i--;
      j--;
    } else {
      i--;
    }
  }
  // A planned time left between moved neighbors can fall out of order; no part may be empty.
  for (let k = 1; k < cuts.length; k++) {
    cuts[k] = Math.max(cuts[k] as number, round((cuts[k - 1] as number) + 0.1));
  }
  return cuts;
}

/**
 * Where each part plays in its take's render. Seedance rarely cuts exactly at the planned times:
 * with one detected cut per part boundary they're taken in order, else paired by alignCuts, so a
 * part never keeps a slice of its neighbor's shot. The last part plays to the render's end:
 * Seedance paces lines its own way and renders whole seconds, so its last line often ends past the
 * planned length.
 */
export function renderPartSpans(parts: VideoClonePart[], render: RenderCuts) {
  const planned = parts.slice(1).map((part) => part.takeStart);
  const cuts =
    render.cuts.length === planned.length
      ? render.cuts
      : alignCuts(planned, render.cuts);
  return parts.map((_, k) => ({
    start: cuts[k - 1] ?? 0,
    end: cuts[k] ?? round(render.duration),
  }));
}

/** A part changes added: no footage in the original, only an empty span where it was inserted. */
export const isAddedPart = (part: { srcStart: number; srcEnd: number }) =>
  part.srcEnd <= part.srcStart;

/**
 * The video as it plays now: every part in story order (`story`, else the original's), each at
 * its planned length (takeStart-takeEnd) on the story clock (`start`-`end`).
 */
export function videoCloneStory<Part extends VideoClonePart>(plan: {
  story?: number[];
  takes: { index: number; parts: Part[] }[];
}) {
  const slots = plan.takes.flatMap((take) =>
    take.parts.map((part) => ({ ...part, take: take.index })),
  );
  const order =
    plan.story ??
    [...slots].sort((a, b) => a.srcStart - b.srcStart).map(({ shot }) => shot);
  let at = 0;
  return order.flatMap((shot) => {
    const slot = slots.find((item) => item.shot === shot);
    if (!slot) return [];
    const start = at;
    at += slot.takeEnd - slot.takeStart;
    return [{ ...slot, start: round(start), end: round(at) }];
  });
}

/**
 * Converts a time between the story clock (videoCloneStory) and a video playing it: the original
 * (no `edit`; an added part sits at the spot it was inserted) or the stitched edit, through its
 * parts (added parts not rendered yet aren't in it).
 */
export function videoCloneStoryTime(
  story: {
    shot: number;
    srcStart: number;
    srcEnd: number;
    start: number;
    end: number;
  }[],
  edit: NonNullable<VideoClone["edit"]>["parts"] | undefined,
  time: number,
  to: "story" | "video",
) {
  const pairs = edit
    ? edit.flatMap((part) => {
        // Edits stitched before parts carried their shot played the original's parts.
        const slot = story.find((item) =>
          part.shot === undefined
            ? item.srcStart === part.srcStart
            : item.shot === part.shot,
        );
        return slot ? [{ video: part, story: slot }] : [];
      })
    : story.map((slot) => ({
        video: { start: slot.srcStart, end: slot.srcEnd },
        story: slot,
      }));
  const spans = pairs
    .map(({ video, story: slot }) =>
      to === "story"
        ? {
            from: video.start,
            until: video.end,
            into: slot.start,
            intoEnd: slot.end,
          }
        : {
            from: slot.start,
            until: slot.end,
            into: video.start,
            intoEnd: video.end,
          },
    )
    // An empty span (an added part in the original) holds no time to convert from.
    .filter((span) => span.until > span.from)
    .sort((a, b) => a.from - b.from);
  const span = spans.find((item) => time < item.until) ?? spans.at(-1);
  if (!span) return time;
  const clamped = Math.min(Math.max(time, span.from), span.until);
  return (
    span.into +
    ((clamped - span.from) * (span.intoEnd - span.into)) /
      (span.until - span.from)
  );
}

/** A take changes add, placed right after a shot (0: the very start). */
export type AddedVideoCloneTake<Analysis = VideoCloneTakeAnalysis> = {
  after: number;
  /** Takes changes added whose place this one takes (several merge them); their shots leave the story. */
  replaces?: number[];
  sceneId: string | null;
  /** Continuity labels it shows, so its render references frames of the takes showing them. */
  shows: string[];
  partSeconds: number[];
  analysis: Analysis;
};

/**
 * Adds takes to a plan: each one's parts get new shots that play right after `after` (in the
 * order given when several follow one shot), an empty source span at that spot (isAddedPart), and
 * join the continuity elements they show. Takes listed in `replaces` (added ones only) leave the
 * story and continuity first; each index goes to the first take naming it, and the ones no take
 * gets are `removed`. Returns the new takes, story, continuity, and removed indexes.
 * Throws on what can't render: an unknown shot, an empty take or one past MAX_TAKE_SECONDS, a
 * video past MAX_STORY_SECONDS, replacing a take with original footage.
 */
export function addVideoCloneTakes<Analysis>(
  plan: {
    story?: number[];
    takes: { index: number; parts: VideoClonePart[] }[];
    continuity?: VideoCloneContinuity;
  },
  added: AddedVideoCloneTake<Analysis>[],
) {
  const replaced = new Set(added.flatMap((take) => take.replaces ?? []));
  for (const replaces of replaced) {
    const take = plan.takes.find((item) => item.index === replaces);
    if (!take?.parts.every(isAddedPart)) {
      throw new Error(
        `Take ${replaces} can't be written again: only a take changes added can.`,
      );
    }
  }
  const unclaimed = new Set(replaced);
  const gone = new Set(
    plan.takes.flatMap((take) =>
      replaced.has(take.index) ? take.parts.map((part) => part.shot) : [],
    ),
  );
  const story = videoCloneStory({
    ...plan,
    takes: plan.takes.filter((take) => !replaced.has(take.index)),
  });
  const order = story.map(({ shot }) => shot);
  const anchors = new Map(story.map((slot) => [slot.shot, slot.srcEnd]));
  /** Shot `after` -> the last shot added behind it so far, so takes keep the order given. */
  const behind = new Map<number, number>();
  const continuity = plan.continuity?.map((element) => ({
    ...element,
    shots: element.shots.filter((shot) => !gone.has(shot)),
  }));
  // Replaced takes' shot numbers aren't reused: the last edit still names them.
  let shot = Math.max(
    0,
    ...plan.takes.flatMap((take) => take.parts.map((part) => part.shot)),
  );
  let index = Math.max(0, ...plan.takes.map((take) => take.index));
  const takes = added.map((take) => {
    const anchor = take.after === 0 ? 0 : anchors.get(take.after);
    if (anchor === undefined) {
      throw new Error(`There's no shot ${take.after} to add a take after.`);
    }
    const seconds = take.partSeconds.reduce((sum, value) => sum + value, 0);
    if (
      take.partSeconds.length === 0 ||
      take.partSeconds.some((value) => !(value > 0)) ||
      seconds > MAX_TAKE_SECONDS
    ) {
      throw new Error(
        `An added take must run 0-${MAX_TAKE_SECONDS}s; one came back at ${round(seconds)}s.`,
      );
    }
    const parts = retimeParts(
      take.partSeconds.map(() => ({
        shot: ++shot,
        sceneId: take.sceneId,
        srcStart: anchor,
        srcEnd: anchor,
        takeStart: 0,
        takeEnd: 0,
      })),
      take.partSeconds,
    );
    const previous = behind.get(take.after) ?? take.after;
    order.splice(
      previous === 0 ? 0 : order.indexOf(previous) + 1,
      0,
      ...parts.map((part) => part.shot),
    );
    behind.set(take.after, shot);
    for (const element of continuity ?? []) {
      if (take.shows.includes(element.label)) {
        element.shots.push(...parts.map((part) => part.shot));
      }
    }
    return {
      // Set.delete: the first replaced index no earlier take got.
      index:
        take.replaces?.find((replaces) => unclaimed.delete(replaces)) ??
        ++index,
      seconds: round(seconds),
      parts,
      analysis: take.analysis,
    };
  });
  const total =
    (story.at(-1)?.end ?? 0) +
    takes.reduce((sum, take) => sum + take.seconds, 0);
  if (total > MAX_STORY_SECONDS) {
    throw new Error(
      `That makes the video ${Math.round(total)}s; it can run up to ${MAX_STORY_SECONDS / 60} minutes.`,
    );
  }
  return { takes, story: order, continuity, removed: [...unclaimed] };
}

/**
 * Lays out the stitched edit: every part in story order, cut from its own render when it was
 * redone alone, else from the take render picked for it or the take's render (renderPartSpans),
 * else from the source, with where it plays in the edit. Added parts not rendered yet have
 * nothing to play and are left out.
 */
export function layoutVideoCloneEdit(
  plan: {
    story?: number[];
    takes: { index: number; parts: VideoClonePart[] }[];
  },
  /** Take index -> its render's cuts. */
  renders: Map<number, RenderCuts>,
  /** Shot -> the length of its part's own render, for parts redone alone. */
  redone = new Map<number, number>(),
  /** Shot -> the cuts of the earlier take render picked for it (`takeRender`). */
  picked = new Map<number, RenderCuts>(),
) {
  const spans = new Map(
    plan.takes.flatMap((take) =>
      take.parts.flatMap((part, k) => {
        const render = picked.get(part.shot) ?? renders.get(take.index);
        const span = render && renderPartSpans(take.parts, render)[k];
        return span ? [[part.shot, span] as const] : [];
      }),
    ),
  );
  let at = 0;
  return videoCloneStory(plan).flatMap((part) => {
    const own = redone.get(part.shot);
    const span = spans.get(part.shot);
    let piece: { from: "part" | "take" | "source"; start: number; end: number };
    if (own !== undefined) {
      const end = round(Math.min(part.takeEnd - part.takeStart, own));
      piece = { from: "part", start: 0, end };
    } else if (span) {
      piece = { from: "take", ...span };
    } else if (!isAddedPart(part)) {
      piece = { from: "source", start: part.srcStart, end: part.srcEnd };
    } else {
      return [];
    }
    const editStart = at;
    at += piece.end - piece.start;
    return [
      {
        ...piece,
        take: part.take,
        part,
        editStart: round(editStart),
        editEnd: round(at),
      },
    ];
  });
}

/**
 * The file each part of the edit plays from: take index -> its render (`takes`), shot -> its own
 * render (`redone`) or the earlier take render picked for it (`picked`). Takes that keep the
 * original have none.
 */
export function videoCloneEditSources(plan: { takes: VideoClone["takes"] }) {
  const takes = new Map<number, string>();
  const redone = new Map<number, string>();
  const picked = new Map<number, string>();
  for (const take of plan.takes) {
    if (keepsOriginal(take)) continue;
    if (take.generation?.status === "done" && take.generation.videoUrl) {
      takes.set(take.index, take.generation.videoUrl);
    }
    for (const part of take.parts) {
      if (part.generation?.status === "done" && part.generation.videoUrl) {
        redone.set(part.shot, part.generation.videoUrl);
      } else if (part.takeRender) {
        picked.set(part.shot, part.takeRender);
      }
    }
  }
  return { takes, redone, picked };
}

/** A part where it plays in the edit (`editStart`-`editEnd`), cut from `src` (none = the original) between `start` and `end`. */
export type VideoCloneEditClip = {
  take: number;
  part: VideoClonePart & { take: number; start: number; end: number };
  from: "part" | "take" | "source";
  start: number;
  end: number;
  editStart: number;
  editEnd: number;
  src: string | undefined;
};

/**
 * The edit as it plays (layoutVideoCloneEdit), each part with the file it's cut from (`src`;
 * none = the original). `cutsOf` gives a file's cuts and length; `planned` is what the plan
 * expects when they aren't known yet: the take's planned cuts, or a redone part's planned length.
 * The stitch and the page's live preview both cut through here.
 */
export function videoCloneEditClips(
  plan: { story?: number[]; takes: VideoClone["takes"] },
  cutsOf: (url: string, planned: RenderCuts) => RenderCuts,
): VideoCloneEditClip[] {
  const sources = videoCloneEditSources(plan);
  const takeOf = new Map(
    plan.takes.flatMap((take) => take.parts.map((part) => [part.shot, take])),
  );
  const planned = (take: VideoClone["takes"][number] | undefined) => ({
    cuts: take?.parts.slice(1).map((part) => part.takeStart) ?? [],
    duration: take?.seconds ?? 0,
  });
  const segments = layoutVideoCloneEdit(
    plan,
    new Map(
      [...sources.takes].map(([index, url]) => [
        index,
        cutsOf(url, planned(plan.takes.find((take) => take.index === index))),
      ]),
    ),
    new Map(
      [...sources.redone].map(([shot, url]) => {
        const part = takeOf.get(shot)?.parts.find((item) => item.shot === shot);
        const length = part ? part.takeEnd - part.takeStart : 0;
        return [shot, cutsOf(url, { cuts: [], duration: length }).duration];
      }),
    ),
    new Map(
      [...sources.picked].map(([shot, url]) => [
        shot,
        cutsOf(url, planned(takeOf.get(shot))),
      ]),
    ),
  );
  return segments.map((segment) => {
    const { shot } = segment.part;
    let src: string | undefined;
    if (segment.from === "part") src = sources.redone.get(shot);
    if (segment.from === "take") {
      src = sources.picked.get(shot) ?? sources.takes.get(segment.take);
    }
    return { ...segment, src };
  });
}

/** Most characters on screen at once; longer text plays in turns. */
const MAX_OVERLAY_CHARS = 90;

/**
 * The takes' on-screen text (the Timeline's Text lane) over the stitched edit: each take's text
 * plays across its rendered parts, in turns when the original showed several captions (split on
 * " / ", ";", line breaks) or more than fits one screen, each turn as long as its share of the
 * characters. Original footage already shows its text, so it gets none.
 */
// ponytail: the analysis has no per-caption timing, so turns are spread evenly; time them if they drift from the lines.
export function videoCloneTextOverlays(
  takes: { index: number; analysis: { onScreenText: string } }[],
  /** The edit's layout (layoutVideoCloneEdit). */
  segments: {
    take: number;
    from: "part" | "take" | "source";
    editStart: number;
    editEnd: number;
  }[],
) {
  return takes.flatMap((take) => {
    const shown = segments.filter(
      (segment) => segment.take === take.index && segment.from !== "source",
    );
    if (shown.length === 0) return [];
    const turns = take.analysis.onScreenText
      .split(/\s\/\s|;|\n/u)
      .flatMap((caption) => {
        const chunks: string[] = [];
        for (const word of caption.split(/\s+/u).filter(Boolean)) {
          const last = chunks.at(-1);
          if (last && last.length + word.length < MAX_OVERLAY_CHARS) {
            chunks[chunks.length - 1] = `${last} ${word}`;
          } else {
            chunks.push(word);
          }
        }
        return chunks;
      });
    const start = Math.min(...shown.map((segment) => segment.editStart));
    const end = Math.max(...shown.map((segment) => segment.editEnd));
    const characters = turns.reduce((sum, turn) => sum + turn.length, 0);
    let at = start;
    return turns.map((text) => {
      const from = at;
      at += ((end - start) * text.length) / characters;
      return { text, start: round(from), end: round(at) };
    });
  });
}

/**
 * Whole-video call from the share of manual seconds; hard takes are still rendered.
 * ponytail: fixed threshold; tune once real Seedance pass rates come back.
 */
export function videoCloneVerdict(
  takes: { seconds: number; analysis: { difficulty: VideoCloneDifficulty } }[],
): VideoCloneVerdict {
  if (difficultyShares(takes).manual > 0.4) return "skip";
  return "clone";
}

export function difficultyShares(
  takes: { seconds: number; analysis: { difficulty: VideoCloneDifficulty } }[],
): Record<VideoCloneDifficulty, number> {
  const total = takes.reduce((sum, take) => sum + take.seconds, 0) || 1;
  const share = (difficulty: VideoCloneDifficulty) =>
    takes
      .filter((take) => take.analysis.difficulty === difficulty)
      .reduce((sum, take) => sum + take.seconds, 0) / total;
  return { easy: share("easy"), hard: share("hard"), manual: share("manual") };
}
