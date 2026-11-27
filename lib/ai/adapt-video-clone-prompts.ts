import "server-only";

import { z } from "zod/v4";
import { generateStructuredObject } from "@/lib/ai/providers/text/registry";
import type { TextMessagePart } from "@/lib/ai/providers/text/types";
import {
  addVideoCloneTakes,
  keepsOriginal,
  MAX_STORY_SECONDS,
  MAX_TAKE_SECONDS,
  retimeParts,
  type VideoClone,
  type VideoCloneTakeAnalysis,
  videoCloneStory,
  videoCloneTakeAnalysisSchema,
} from "@/lib/content-workflows/video-clone";
import { getS3Config } from "@/lib/env";
import { getObject, parseStorageObjectFromUrl } from "@/lib/storage";
import { downloadRemoteBytes } from "@/lib/storage/download-video";

const MAX_ATTACHMENT_IMAGE_BYTES = 20 * 1024 * 1024;

function isOwnS3SignedUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const s3 = getS3Config();
    const internalOrigin = new URL(s3.endpoint).origin;
    const publicOrigin = new URL(s3.publicEndpoint).origin;
    return parsed.origin === internalOrigin || parsed.origin === publicOrigin;
  } catch {
    return false;
  }
}

function extractOwnS3Object(
  rawUrl: string,
): { bucket: string; path: string } | null {
  const stored = parseStorageObjectFromUrl(rawUrl);
  if (stored) return stored;
  if (!isOwnS3SignedUrl(rawUrl)) return null;
  try {
    const parsed = new URL(rawUrl);
    const bucket = getS3Config().bucket;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === bucket && parts.length > 1) {
      return { bucket, path: parts.slice(1).join("/") };
    }
  } catch {
    return null;
  }
  return null;
}

/** Images for the text/vision model, each after its label, loaded via S3 or SSRF-safe download. */
async function labeledImages(
  attachments: { label: string; what: string; url: string }[],
): Promise<TextMessagePart[]> {
  const parts = await Promise.all(
    attachments.map(async ({ label, what, url }) => {
      const ownObject = extractOwnS3Object(url);
      let data: Uint8Array;
      let mediaType = "image/jpeg";
      if (ownObject) {
        data = await getObject(ownObject.path, ownObject.bucket);
        if (url.toLowerCase().endsWith(".png")) mediaType = "image/png";
        else if (url.toLowerCase().endsWith(".webp")) mediaType = "image/webp";
      } else {
        const downloaded = await downloadRemoteBytes(url, {
          label: what,
          maxBytes: MAX_ATTACHMENT_IMAGE_BYTES,
          timeoutMs: 30_000,
        });
        data = downloaded.bytes;
        mediaType = downloaded.contentType || "image/jpeg";
      }
      return [
        { type: "text" as const, text: label },
        {
          type: "image" as const,
          data,
          mediaType,
        },
      ];
    }),
  );
  return parts.flat();
}

/**
 * Applies the user's requested changes, the recast characters, and our products to the selected
 * takes' prompts. All takes go in as context so the rewritten script stays coherent.
 */
export async function adaptVideoClonePrompts(input: {
  plan: VideoClone;
  takeIndexes: number[];
  changes: string;
  /** Character id -> signed URL of the avatar that plays them. */
  cast: Map<string, string>;
  /** Signed image URLs; product N is `{{productN}}`. */
  products: { name: string; url: string }[];
  /** Take index -> the product numbers the user pinned on it. */
  pinned: Map<number, number[]>;
}): Promise<Map<number, string>> {
  const creatorId = input.plan.vibe.characters.find(
    (character) => character.reference === "creator",
  )?.id;
  const castToken = (id: string) =>
    id === creatorId ? "{{creator}}" : `{{cast:${id}}}`;
  const attachments = [
    ...[...input.cast].map(([id, url]) => ({
      label: `CAST IMAGE ${castToken(id)} plays ${id}:`,
      what: `the avatar for ${id}`,
      url,
    })),
    ...input.products.map((product, i) => ({
      label: `OUR PRODUCT {{product${i + 1}}} (file "${product.name}"):`,
      what: `product image "${product.name}"`,
      url: product.url,
    })),
  ];
  const images = await labeledImages(attachments);
  const productCount = input.products.length;

  const output = await generateStructuredObject({
    system: [
      "You adapt video prompts from a shot-by-shot clone plan of a short-form video.",
      "Rewrite only the takes listed under TAKES TO REWRITE. The requested changes win over the original: they may change the story, the dialogue, the setting, or the cast. Keep what they don't touch: framing, camera, the 'Part N (a-bs)' labels, hard cuts, and timing (every line must still fit its part's seconds).",
      "Dialogue: keep every original line exactly as spoken, word for word, unless the requested changes ask for different lines.",
      "A rewritten line keeps its speaker and roughly its length; read ALL TAKES so the script still flows as one story.",
      ...(input.cast.size > 0
        ? [
            `The attached CAST IMAGES are who plays ${[...input.cast.keys()].map((id) => `${id} (${castToken(id)})`).join(", ")}. Write the character's token wherever they appear, in place of their face, hair, and build; keep their wardrobe and props unless the requested changes say otherwise, and fit pronouns to the person in the image.`,
          ]
        : []),
      "Characters without a cast image get no token (never {{creator}} or {{cast:...}} for them): describe each in full with ONE fixed visual description (from CAST, adjusted by the requested changes) repeated word for word in every take so they look the same.",
      productCount > 0
        ? `OUR PRODUCTS are the attached images, {{product1}} to {{product${productCount}}}. A take listed under PRODUCTS PER TAKE shows exactly those of ours, even where the original shows no product: work them in naturally (held, worn, on the counter) without changing the action. Elsewhere, wherever the original shows its product (written {{product}} or described in words), show the closest of ours instead, e.g. a ring for a ring, and write its token; the requested changes win when they say which. A product keeps its token in every take. The first time a take shows a product, follow its token with a few words of what it looks like (e.g. "{{product2}}, gold hoop earrings"). Never write {{product}}.`
        : "There is no product image: describe our product in words, never write {{product}}.",
      "No on-screen text, captions, logos, or UI in the video. English prompt.",
    ].join("\n"),
    parts: [
      {
        type: "text",
        text: [
          `VIDEO: ${input.plan.vibe.format}. ${input.plan.vibe.summary}`,
          `PRODUCT: ${productCount > 0 ? "see OUR PRODUCTS" : "none given; keep the product generic"}`,
          `CAST: ${JSON.stringify(input.plan.vibe.characters)}`,
          `REQUESTED CHANGES: ${input.changes || "none"}`,
          `ALL TAKES (context):\n${input.plan.takes.map((take) => `Take ${take.index} (${take.seconds}s): ${take.analysis.prompt}`).join("\n\n")}`,
          `TAKES TO REWRITE: ${input.takeIndexes.join(", ")}`,
          ...(input.pinned.size > 0
            ? [
                `PRODUCTS PER TAKE: ${[...input.pinned]
                  .map(
                    ([index, numbers]) =>
                      `Take ${index}: ${numbers.map((n) => `{{product${n}}}`).join(", ")}`,
                  )
                  .join("; ")}`,
              ]
            : []),
        ].join("\n\n"),
      },
      ...images,
    ],
    schema: z.object({
      takes: z.array(z.object({ index: z.number().int(), prompt: z.string() })),
    }),
    schemaName: "videoClonePrompts",
    reasoningEffort: "low",
  });
  return new Map(
    output.takes
      .filter((take) => input.takeIndexes.includes(take.index))
      .map((take) => [take.index, take.prompt]),
  );
}

/**
 * Rewrites one take's prompt to speak the user's own script lines, so they can
 * tweak a take before paying for its render. Everything else changes from the render's Changes.
 */
export async function reviseVideoCloneTakePrompt(input: {
  plan: VideoClone;
  takeIndex: number;
  /** The user's edited lines; the prompt must speak exactly these. */
  dialogue: VideoCloneTakeAnalysis["dialogue"];
}) {
  const take = input.plan.takes.find((item) => item.index === input.takeIndex);
  if (!take) throw new Error("Unknown take.");
  return generateStructuredObject({
    system: [
      "You edit one take's prompt in a shot-by-shot clone plan of a short-form video.",
      "Make the prompt speak the NEW LINES: they are the user's own words, so keep them word for word. Change only what they need; keep everything else as written: framing, camera, the 'Part N (a-bs)' labels, hard cuts, {{creator}}, {{cast:...}}, and {{product}} tokens, and character descriptions.",
      "Every spoken line goes in the prompt in quotes with who says it, in the part where it fits; a part's lines must fit its seconds (about 2.5 words per second). Read ALL TAKES so the script still flows as one story.",
      "Return the full new prompt and the take's dialogue: every line spoken, in order, with its speaker id from CAST. No on-screen text, captions, logos, or UI in the video.",
    ].join("\n"),
    parts: [
      {
        type: "text",
        text: [
          `VIDEO: ${input.plan.vibe.format}. ${input.plan.vibe.summary}`,
          `CAST: ${JSON.stringify(input.plan.vibe.characters)}`,
          `ALL TAKES (context):\n${input.plan.takes.map((item) => `Take ${item.index} (${item.seconds}s): ${item.analysis.prompt}`).join("\n\n")}`,
          `TAKE ${take.index} (${take.seconds}s) PROMPT:\n${take.analysis.prompt}`,
          `TAKE ${take.index} DIALOGUE: ${JSON.stringify(take.analysis.dialogue)}`,
          `NEW LINES: ${JSON.stringify(input.dialogue)}`,
        ].join("\n\n"),
      },
    ],
    schema: z.object({
      prompt: z.string(),
      dialogue: videoCloneTakeAnalysisSchema.shape.dialogue,
    }),
    schemaName: "videoCloneTakeRevision",
    reasoningEffort: "low",
  });
}

/** Our product as a rewrite sees it: the product folder's photos (signed URLs). */
export type VideoCloneProductContext = {
  images: { name: string; url: string }[];
};

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Applies the user's changes before any render.
 */
export async function applyVideoCloneChanges(input: {
  plan: VideoClone;
  changes: string;
  product: VideoCloneProductContext;
}) {
  const { plan } = input;
  const story = videoCloneStory(plan);
  const context = [
    `VIDEO: ${plan.vibe.format}. ${plan.vibe.summary}`,
    `CURRENT LOOK: ${plan.vibe.visualStyle}`,
    `CAST: ${JSON.stringify(plan.vibe.characters)}`,
    `PRODUCT: ${input.product.images.length > 0 ? "see the OUR PRODUCT photos" : "none given"}`,
  ];
  const productImages = await labeledImages(
    input.product.images.map((image, i) => ({
      label: `OUR PRODUCT photo ${i + 1} (file "${image.name}"):`,
      what: `product image "${image.name}"`,
      url: image.url,
    })),
  );
  const output = await generateStructuredObject({
    system: [
      "You rewrite a shot-by-shot clone plan of a short-form video: per take (one AI video generation, Seedance or Wan, up to 30s), its prompt and the lines spoken in it. STORY lists every shot in the order the video plays them.",
      "Apply the CHANGES. A change to the look (aesthetic, era, film or camera format, color, lighting, camera work, setting, wardrobe, props, mood) goes into the prompts only: rewrite each affected prompt's visual description so the generation looks that way, e.g. 'VHS 80s sitcom' means 4:3-feeling soft analog video, tracking noise, warm flat multi-cam studio lighting, a sitcom set. Keep the lines word for word for those.",
      "Takes are rendered separately, so a person's look or a place must read the same everywhere it appears: a change to one applies, in the same words, to every take showing it.",
      "Change the lines only when the CHANGES ask about the words (reword, a new script, tone of the jokes, a product plug, another language), or when a word would no longer make sense (a hotel line in a gym). Then update the quoted lines in the prompt to match.",
      `A little more or less time for a beat: stretch or trim existing parts. Return that take's partSeconds (every part's new length in seconds, in order) and rewrite its 'Part N (a-bs)' labels to the new times; a take is at most ${MAX_TAKE_SECONDS}s. Added time continues that shot in the same place with the same people, outfits, and light.`,
      `More than existing parts can hold (a longer script, new beats, a product plug, "add 30 seconds", "make it 6 minutes"): add takes. Deliver the time asked: "add 30 seconds" means about 30s of added takes; a target length counts the whole video (STORY runs ${story.at(-1)?.end ?? 0}s now), at most ${MAX_STORY_SECONDS}s. Each added take is one generation of up to ${MAX_TAKE_SECONDS}s, played right after one STORY shot (after; 0 = the very start; several after one shot play in the order given), with its parts (1-8 shots of 2-8s each, hard cuts between) and every line spoken in it, about 2.5 words per second. Stay in the original's world unless the CHANGES ask otherwise: its places (sceneId from SCENES), its people in their looks, its style, the same pacing. In shows, list every CONTINUITY label the take shows, so it's rendered to match. The story must still flow as one video: an added take picks up from the shot before it and leads into the one after. "At the end" means before a closing end card or product shot (often KEEP ORIGINAL), which stays last.`,
      "A change to the story (a beat moved, a reveal later, a new opening, a twist) reworks every take it touches, take 1 included, so the whole video reads as one new story. A take with original footage is rewritten in place (prompt, lines, timing). ADDED takes are written again as added takes, each played after a shot that stays (or 0), with replaces = the ADDED takes whose place it takes; their shots leave STORY.",
      `Takes are generations, not beats: fewer, fuller takes keep faces, outfits, and sets consistent. Whenever you add or write again ADDED takes, pack each run of consecutive ADDED takes in STORY into as few takes as hold it, each close to ${MAX_TAKE_SECONDS}s (only the last of a run shorter), split between lines, never mid-speech. Write the run's other ADDED takes again for that: one take's replaces can list several (a merge), several takes can list the same one (a split). An ADDED take never plays in pieces around another take.`,
      "Our product: PRODUCT, the OUR PRODUCT photos, and any product or offer the CHANGES name (a discount, a code, a launch). To plug it, the lines say what it is and why it's worth it in the speaker's own voice (claims and offers only from those), and beats show it, written {{product}}. Never name the original's brand.",
      "Keep what the CHANGES don't touch as written: the 'Part N (a-bs)' labels and timing, hard cuts, shot order, {{creator}}, {{cast:...}}, and {{product}} tokens, and character descriptions. Every spoken line stays in the prompt in quotes with who says it; a part's lines must fit its seconds. No on-screen text, captions, logos, or UI in the video.",
      "Takes marked KEEP ORIGINAL use the original footage and sound: never change them, and keep the rest consistent with them.",
      "Return only the existing takes you change, each with its full new prompt, its dialogue only if its lines changed (every line, in order, with its speaker id from CAST; otherwise null), and its partSeconds only if its timing changed (otherwise null); the added takes; and a one-sentence summary of what you changed, for the user, in plain words (no {{tokens}}).",
    ].join("\n"),
    parts: [
      {
        type: "text",
        text: [
          ...context,
          `SCENES: ${JSON.stringify(plan.scenes)}`,
          `CONTINUITY: ${JSON.stringify((plan.continuity ?? []).map(({ label }) => label))}`,
          `STORY:\n${story.map((slot) => `shot ${slot.shot}: take ${slot.take} part ${(plan.takes.find((take) => take.index === slot.take)?.parts.findIndex((part) => part.shot === slot.shot) ?? 0) + 1}, ${round(slot.end - slot.start)}s, scene ${slot.sceneId ?? "?"}`).join("\n")}`,
          `TAKES:\n${plan.takes
            .map(
              (take) =>
                `Take ${take.index} (${take.seconds}s)${keepsOriginal(take) ? " KEEP ORIGINAL" : ""}${take.videoUrl ? "" : " ADDED"}\nPART SECONDS: ${JSON.stringify(take.parts.map((part) => round(part.takeEnd - part.takeStart)))}\nPROMPT: ${take.analysis.prompt}\nDIALOGUE: ${JSON.stringify(take.analysis.dialogue)}`,
            )
            .join("\n\n")}`,
          `CHANGES: ${input.changes}`,
        ].join("\n\n"),
      },
      ...productImages,
    ],
    schema: z.object({
      summary: z.string(),
      takes: z.array(
        z.object({
          index: z.number().int(),
          prompt: z.string(),
          dialogue: videoCloneTakeAnalysisSchema.shape.dialogue.nullable(),
          partSeconds: z.array(z.number()).nullable(),
        }),
      ),
      added: z.array(
        z.object({
          after: z.number().int(),
          replaces: z
            .array(z.number().int())
            .describe("the ADDED takes whose place this one takes, else []"),
          sceneId: z.string().nullable(),
          shows: z.array(z.string()),
          characters: z.array(z.string()).describe("CAST ids on screen"),
          description: z.string().describe("one line: what happens"),
          difficulty: z.enum(["easy", "hard"]),
          parts: z.array(
            z.object({
              seconds: z.number(),
              beat: z
                .string()
                .describe("one shot: framing, camera, and what happens"),
            }),
          ),
          dialogue: videoCloneTakeAnalysisSchema.shape.dialogue,
        }),
      ),
    }),
    schemaName: "videoCloneChanges",
    reasoningEffort: "low",
  });
  // Edits the model may still echo for a kept or unknown take, or one written again below, are dropped.
  const replaced = new Set(output.added.flatMap((take) => take.replaces));
  const takes = output.takes.flatMap((revised) => {
    const take = plan.takes.find(
      (item) =>
        item.index === revised.index &&
        !keepsOriginal(item) &&
        !replaced.has(item.index),
    );
    if (!take) return [];
    const { partSeconds } = revised;
    if (
      partSeconds &&
      (partSeconds.length !== take.parts.length ||
        partSeconds.some((seconds) => !(seconds > 0)) ||
        partSeconds.reduce((sum, seconds) => sum + seconds, 0) >
          MAX_TAKE_SECONDS)
    ) {
      throw new Error(
        `Model retimed take ${take.index} to something it can't render (other parts, or past ${MAX_TAKE_SECONDS}s). Try again, or ask for less time.`,
      );
    }
    return [
      {
        index: take.index,
        prompt: revised.prompt,
        dialogue: revised.dialogue,
        parts: partSeconds ? retimeParts(take.parts, partSeconds) : null,
      },
    ];
  });
  if (output.added.length === 0) {
    return { summary: output.summary, takes, addition: null };
  }

  const retimed = {
    ...plan,
    takes: plan.takes.map((take) => {
      const parts = takes.find((item) => item.index === take.index)?.parts;
      return parts ? { ...take, parts } : take;
    }),
  };
  // Placement and length are checked before paying for the prompts.
  addVideoCloneTakes(
    retimed,
    output.added.map((take) => ({
      ...take,
      partSeconds: take.parts.map((part) => part.seconds),
      analysis: null,
    })),
  );
  const added = await Promise.all(
    output.added.map(async (take) => {
      const prompt = await writeAddedTakePrompt({
        plan,
        context,
        take,
        changes: input.changes,
      });
      return {
        after: take.after,
        replaces: take.replaces,
        sceneId: take.sceneId,
        shows: take.shows,
        partSeconds: take.parts.map((part) => part.seconds),
        analysis: {
          description: take.description,
          shotType: "",
          camera: "",
          action: take.parts.map((part) => part.beat).join(" "),
          charactersInShot: take.characters,
          needsCreatorReference: prompt.includes("{{creator}}"),
          needsProductReference: prompt.includes("{{product"),
          dialogue: take.dialogue,
          onScreenText: "",
          difficulty: take.difficulty,
          difficultyReason: "",
          notes: `Added by the changes: ${input.changes}`,
          prompt,
        },
      };
    }),
  );
  return {
    summary: output.summary,
    takes,
    addition: addVideoCloneTakes(retimed, added),
  };
}

/** The prompt of one added take, in the look, places, and people of the rest. */
async function writeAddedTakePrompt(input: {
  plan: VideoClone;
  /** VIDEO, CURRENT LOOK, CAST, and PRODUCT lines. */
  context: string[];
  take: {
    sceneId: string | null;
    parts: { seconds: number; beat: string }[];
    dialogue: VideoCloneTakeAnalysis["dialogue"];
  };
  changes: string;
}) {
  const { plan, take } = input;
  const scene = plan.scenes.find((item) => item.id === take.sceneId);
  const references = plan.takes
    .filter(
      (item) =>
        item.videoUrl &&
        item.parts.some((part) => part.sceneId === take.sceneId),
    )
    .slice(0, 2);
  let at = 0;
  const parts = take.parts.map((part, k) => {
    const label = `Part ${k + 1} (${round(at)}-${round((at += part.seconds))}s)`;
    return `${label}: ${part.beat}`;
  });
  const tokens = plan.vibe.characters.flatMap((character) =>
    character.reference === "creator"
      ? [`{{creator}} is ${character.id} (${character.role})`]
      : [],
  );
  const output = await generateStructuredObject({
    system: [
      "You write the prompt for one take added to a shot-by-shot clone plan of a short-form video. It must look like the rest of the video: the same style, places, people, and outfits.",
      "Vertical 9:16, realistic footage in the CURRENT LOOK. Write each part under its label exactly as given ('Part N (a-bs): ...') and end every part but the last with 'Hard cut.'; each part is one shot: framing, camera, setting, lighting, and the action beat by beat.",
      `${tokens.length > 0 ? "Each person under PEOPLE WITH AN IMAGE is written as their token every time they appear or speak (e.g. '{{cast:partner}}: \"line\"'), never by name: never describe their face, hair, or build, but always their outfit and accessories, in the same words as CAST. Everyone else gets" : "Everyone gets"} their full CAST description each time. Our product is {{product}}, followed the first time by a few words of what it looks like.`,
      "Every line goes in quotes with who says it, in the part where it's said, and fits that part's seconds. End with one line on delivery: the dialogue is natural and conversational, real people talking, each line answering the last, never clipped or robotic; listeners keep their mouths closed; natural micro-movements (blinks, small head tilts, breaths between phrases). No on-screen text, captions, subtitles, logos, or UI.",
    ].join("\n"),
    parts: [
      {
        type: "text",
        text: [
          ...input.context,
          `PLACE: ${scene ? `${scene.location} (cast: ${scene.cast})` : "a new place the CHANGES ask for"}`,
          ...(references.length > 0
            ? [
                `HOW THIS PLACE IS WRITTEN ELSEWHERE:\n${references.map((item) => item.analysis.prompt).join("\n\n")}`,
              ]
            : []),
          `CHANGES BEHIND THIS TAKE: ${input.changes}`,
          ...(tokens.length > 0
            ? [`PEOPLE WITH AN IMAGE:\n${tokens.join("\n")}`]
            : []),
          `PARTS:\n${parts.join("\n")}`,
          `LINES: ${JSON.stringify(take.dialogue)}`,
        ].join("\n\n"),
      },
    ],
    schema: z.object({ prompt: z.string() }),
    schemaName: "videoCloneAddedTake",
    reasoningEffort: "low",
  });
  return output.prompt;
}
