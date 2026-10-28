import "server-only";

import { and, asc, desc, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import type { z } from "zod/v4";
import { storageConfig } from "@/config/storage.config";
import { getVideoProvider } from "@/lib/ai/video-provider";
import { db } from "@/lib/db";
import {
  contentTemplateTable,
  creativeAssetFolderTable,
  creativeAssetTable,
  faceTable,
} from "@/lib/db/schema";
import { getSignedUploadUrl } from "@/lib/storage";
import { getErrorMessage } from "@/lib/utils";
import type { analyzeVideoCloneTask } from "@/trigger/analyze-video-clone";
import type { generateVideoCloneTask } from "@/trigger/generate-video-clone";
import type { rewriteVideoCloneTask } from "@/trigger/rewrite-video-clone";
import { tasks, triggerTaskIds } from "@/trigger/shared";
import type { stitchVideoCloneTask } from "@/trigger/stitch-video-clone";
import {
  type generateVideoCloneInputSchema,
  keepsOriginal,
  MAX_VIDEO_CLONE_PRODUCTS,
  type rewriteVideoCloneInputSchema,
  settleDeadRenders,
  type VideoClone,
  type VideoCloneGeneration,
  type VideoCloneModel,
  type VideoClonePart,
  type VideoCloneTakeAnalysis,
  videoCloneRenders,
  videoCloneSourceName,
} from "./video-clone";

/**
 * Writes one field of one take in a single statement, so takes finishing at the same time
 * (or a regenerate racing a full run) never overwrite each other's results.
 */
async function setTakeField(
  templateId: string,
  takePosition: number,
  field: string,
  value: unknown,
): Promise<void> {
  await db
    .update(contentTemplateTable)
    .set({
      structure: sql`jsonb_set(${contentTemplateTable.structure}, ${`{video,takes,${takePosition},${field}}`}::text[], ${JSON.stringify(value)}::jsonb)`,
    })
    .where(eq(contentTemplateTable.id, templateId));
}

/**
 * `next` with the finished render at `path` (a take, or one of its parts) kept in that item's
 * `renders` unless it's there already, so a write over it never loses a paid render.
 */
const keepRender = (next: SQL, path: string) => {
  const stored = contentTemplateTable.structure;
  const renders = `{${path},renders}`;
  const kept = sql`coalesce(${stored} #> ${renders}::text[], '[]'::jsonb)`;
  const current = sql`(${stored} #> ${`{${path},generation}`}::text[])`;
  // A null value (nothing to keep) leaves `next` as it is.
  return sql`jsonb_set_lax(${next}, ${renders}::text[], case when ${current} ->> 'status' = 'done' and not ${kept} @> jsonb_build_array(jsonb_build_object('videoUrl', ${current} -> 'videoUrl')) then ${kept} || jsonb_build_array(${current}) end, true, 'return_target')`;
};

/** Writes a take's or part's render in one statement, keeping the one it replaces. */
async function setGeneration(
  templateId: string,
  path: string,
  generation: VideoCloneGeneration,
): Promise<void> {
  await db
    .update(contentTemplateTable)
    .set({
      structure: sql`jsonb_set(${keepRender(sql`${contentTemplateTable.structure}`, path)}, ${`{${path},generation}`}::text[], ${JSON.stringify(generation)}::jsonb)`,
    })
    .where(eq(contentTemplateTable.id, templateId));
}

/**
 * `next` with the part at `path` playing its own render (`generation`), else its piece of an
 * earlier take render (`takeRender`), else its piece of the take's render; the render it played
 * alone is kept (keepRender).
 */
const setPartSource = (
  next: SQL,
  path: string,
  source: { generation?: VideoCloneGeneration; takeRender?: string },
) => {
  const kept = keepRender(next, path);
  const own = source.generation
    ? sql`jsonb_set(${kept}, ${`{${path},generation}`}::text[], ${JSON.stringify(source.generation)}::jsonb)`
    : sql`${kept} #- ${`{${path},generation}`}::text[]`;
  return source.takeRender
    ? sql`jsonb_set(${own}, ${`{${path},takeRender}`}::text[], ${JSON.stringify(source.takeRender)}::jsonb)`
    : sql`${own} #- ${`{${path},takeRender}`}::text[]`;
};

export const setVideoCloneGeneration = (
  templateId: string,
  takePosition: number,
  generation: VideoCloneGeneration,
) => setGeneration(templateId, `video,takes,${takePosition}`, generation);

export const setVideoCloneTakeAnalysis = (
  templateId: string,
  takePosition: number,
  analysis: VideoCloneTakeAnalysis,
) => setTakeField(templateId, takePosition, "analysis", analysis);

/** One part's own render; it replaces that part's piece of the take's render in the edit. */
export const setVideoClonePartGeneration = (
  templateId: string,
  takePosition: number,
  partPosition: number,
  generation: VideoCloneGeneration,
) =>
  setGeneration(
    templateId,
    `video,takes,${takePosition},parts,${partPosition}`,
    generation,
  );

/**
 * Puts every part of a take back on the take's render (their own renders are kept to pick back):
 * they matched, or were picked over, the take render a new one replaces.
 */
export async function clearVideoClonePartGenerations(
  templateId: string,
  takePosition: number,
  partCount: number,
): Promise<void> {
  let structure = sql`${contentTemplateTable.structure}`;
  for (let k = 0; k < partCount; k++) {
    structure = setPartSource(
      structure,
      `video,takes,${takePosition},parts,${k}`,
      {},
    );
  }
  await db
    .update(contentTemplateTable)
    .set({ structure })
    .where(eq(contentTemplateTable.id, templateId));
}

/** A take's new part timing (an extended or shortened take) and its length. */
export async function setVideoCloneTakeTiming(
  templateId: string,
  takePosition: number,
  parts: VideoClonePart[],
): Promise<void> {
  await setTakeField(templateId, takePosition, "parts", parts);
  await setTakeField(
    templateId,
    takePosition,
    "seconds",
    parts.at(-1)?.takeEnd ?? 0,
  );
}

/** Writes the plan's stitched edit alone, so it never races the takes' own fields. */
export async function setVideoCloneEdit(
  templateId: string,
  edit: NonNullable<VideoClone["edit"]>,
): Promise<void> {
  await db
    .update(contentTemplateTable)
    .set({
      structure: sql`jsonb_set(${contentTemplateTable.structure}, '{video,edit}', ${JSON.stringify(edit)}::jsonb)`,
    })
    .where(eq(contentTemplateTable.id, templateId));
}

/** Turns the burned-in on-screen text on or off for Download. False when the plan isn't the organization's. */
export async function setVideoCloneBurnText(
  organizationId: string,
  templateId: string,
  burnText: boolean,
): Promise<boolean> {
  const updated = await db
    .update(contentTemplateTable)
    .set({
      structure: sql`jsonb_set(${contentTemplateTable.structure}, '{video,burnText}', ${JSON.stringify(burnText)}::jsonb)`,
    })
    .where(
      and(
        eq(contentTemplateTable.id, templateId),
        eq(contentTemplateTable.organizationId, organizationId),
      ),
    )
    .returning({ id: contentTemplateTable.id });
  return updated.length > 0;
}

/** Adds renders' cuts and lengths (by file) to the plan's, alone, so the page previews what the stitch cut. */
export async function addVideoCloneRenderCuts(
  templateId: string,
  renderCuts: NonNullable<VideoClone["renderCuts"]>,
): Promise<void> {
  await db
    .update(contentTemplateTable)
    .set({
      structure: sql`jsonb_set(${contentTemplateTable.structure}, '{video,renderCuts}', coalesce(${contentTemplateTable.structure} #> '{video,renderCuts}', '{}'::jsonb) || ${JSON.stringify(renderCuts)}::jsonb)`,
    })
    .where(eq(contentTemplateTable.id, templateId));
}

/** Writes the plan's background rewrite status alone. */
export async function setVideoCloneRewrite(
  templateId: string,
  rewrite: NonNullable<VideoClone["rewrite"]>,
): Promise<void> {
  await db
    .update(contentTemplateTable)
    .set({
      structure: sql`jsonb_set(${contentTemplateTable.structure}, '{video,rewrite}', ${JSON.stringify(rewrite)}::jsonb)`,
    })
    .where(eq(contentTemplateTable.id, templateId));
}

// A rewrite still "rewriting" after this died without saying so; another may start.
const REWRITE_STALE_MS = 15 * 60 * 1000;

/** Marks the plan rewriting, then applies the toolbar's change in the background (it can take minutes). */
export async function startVideoCloneRewrite(
  input: Omit<z.infer<typeof rewriteVideoCloneInputSchema>, "startedAt">,
): Promise<{ startedAt: string } | { error: string }> {
  const plan = await findVideoClone(input.organizationId, input.templateId);
  if (!plan) return { error: "Clone plan not found." };
  const running = plan.video.rewrite;
  if (
    running?.status === "rewriting" &&
    Date.now() - Date.parse(running.startedAt) < REWRITE_STALE_MS
  ) {
    return { error: "A change is still being applied; wait for it to finish." };
  }
  if (input.productFolder) {
    const found = await findProductImages(
      input.organizationId,
      input.productFolder,
    );
    if ("error" in found) return found;
  }
  const rewrite = {
    status: "rewriting" as const,
    changes: input.changes,
    productFolder: input.productFolder,
    startedAt: new Date().toISOString(),
  };
  await setVideoCloneRewrite(plan.id, rewrite);
  try {
    await tasks.trigger<typeof rewriteVideoCloneTask>(
      triggerTaskIds.rewriteVideoClone,
      { ...input, startedAt: rewrite.startedAt },
    );
    return { startedAt: rewrite.startedAt };
  } catch (error) {
    await setVideoCloneRewrite(plan.id, {
      ...rewrite,
      status: "failed",
      error: "Couldn't start applying the change.",
    });
    throw error;
  }
}

/** Re-stitches the edit from the plan's current renders; the last edit stays watchable meanwhile. */
export async function startVideoCloneStitch(
  organizationId: string,
  templateId: string,
  previous: VideoClone["edit"],
): Promise<void> {
  const edit = {
    videoUrl: previous?.videoUrl,
    textVideoUrl: previous?.textVideoUrl,
    rendered: previous?.rendered ?? [],
    parts: previous?.parts,
    startedAt: new Date().toISOString(),
  };
  await setVideoCloneEdit(templateId, { ...edit, status: "stitching" });
  try {
    await tasks.trigger<typeof stitchVideoCloneTask>(
      triggerTaskIds.stitchVideoClone,
      { organizationId, templateId },
    );
  } catch (error) {
    await setVideoCloneEdit(templateId, {
      ...edit,
      status: "failed",
      error: getErrorMessage(error) || "Couldn't start stitching.",
    });
  }
}

/** Edits one take's prompt, dialogue, pinned products, model, or whether it keeps the original footage. */
export async function updateVideoCloneTake(
  organizationId: string,
  input: {
    templateId: string;
    takeIndex: number;
    prompt?: string;
    dialogue?: VideoCloneTakeAnalysis["dialogue"];
    products?: string[];
    model?: VideoCloneModel;
    keepOriginal?: boolean;
  },
) {
  const plan = await findVideoClone(organizationId, input.templateId);
  if (!plan) return { error: "Clone plan not found." };
  const position = plan.video.takes.findIndex(
    (take) => take.index === input.takeIndex,
  );
  const previous = plan.video.takes[position];
  if (!previous) return { error: "Unknown take." };
  if (input.keepOriginal && !previous.videoUrl) {
    return {
      error: `Take ${previous.index} was added by your changes; it has no original footage to keep.`,
    };
  }
  const take = { ...previous };
  if (input.model) {
    take.model = input.model;
    await setTakeField(plan.id, position, "model", input.model);
  }
  if (input.keepOriginal !== undefined) {
    take.keepOriginal = input.keepOriginal;
    await setTakeField(plan.id, position, "keepOriginal", input.keepOriginal);
  }
  if (input.products) {
    const products = [...new Set(input.products)];
    const images = await findAssetImages(organizationId, products);
    if (images.length !== products.length) {
      return { error: "Products must be images from Assets." };
    }
    take.products = products;
    await setTakeField(plan.id, position, "products", products);
  }
  if (input.prompt !== undefined || input.dialogue !== undefined) {
    take.analysis = {
      ...previous.analysis,
      prompt: input.prompt ?? previous.analysis.prompt,
      dialogue: input.dialogue ?? previous.analysis.dialogue,
    };
    await setVideoCloneTakeAnalysis(plan.id, position, take.analysis);
  }
  // A rendered take switching between its render and the original changes the edit's footage.
  if (
    keepsOriginal(take) !== keepsOriginal(previous) &&
    previous.generation?.status === "done"
  ) {
    await startVideoCloneStitch(organizationId, plan.id, plan.video.edit);
  }
  return { take, previous };
}

/**
 * Puts a finished render back in the edit and re-stitches: one of a take's renders for the whole
 * take (its shots' picks go), or, for one shot (`shot`), its piece of any of the take's renders or
 * one of its own renders. Not while the take renders: its result would land over the pick.
 */
export async function pickVideoCloneRender(
  organizationId: string,
  input: {
    templateId: string;
    takeIndex: number;
    shot?: number;
    videoUrl: string;
  },
) {
  const plan = await findVideoClone(organizationId, input.templateId);
  if (!plan) return { error: "Clone plan not found." };
  const position = plan.video.takes.findIndex(
    (take) => take.index === input.takeIndex,
  );
  const take = plan.video.takes[position];
  if (!take) return { error: "Unknown take." };
  if (
    [take.generation, ...take.parts.map((part) => part.generation)].some(
      (generation) => generation?.status === "generating",
    )
  ) {
    return {
      error: `Take ${take.index} is rendering; pick a version once it's done.`,
    };
  }
  const current =
    take.generation?.status === "done" ? take.generation.videoUrl : undefined;
  const fromTake = videoCloneRenders(take).find(
    (render) => render.videoUrl === input.videoUrl,
  );
  if (input.shot === undefined) {
    if (!fromTake) return { error: "Unknown render." };
    const picks = take.parts.some(
      (part) => part.takeRender || part.generation?.status === "done",
    );
    if (fromTake.videoUrl === current && !picks) return { picked: false };
    await setVideoCloneGeneration(plan.id, position, fromTake);
    await clearVideoClonePartGenerations(plan.id, position, take.parts.length);
  } else {
    const k = take.parts.findIndex((part) => part.shot === input.shot);
    const part = take.parts[k];
    if (!part) return { error: "Unknown shot." };
    const own = videoCloneRenders(part).find(
      (render) => render.videoUrl === input.videoUrl,
    );
    if (!own && !fromTake) return { error: "Unknown render." };
    const playing =
      part.generation?.status === "done"
        ? part.generation.videoUrl
        : (part.takeRender ?? current);
    if (playing === input.videoUrl) return { picked: false };
    await db
      .update(contentTemplateTable)
      .set({
        structure: setPartSource(
          sql`${contentTemplateTable.structure}`,
          `video,takes,${position},parts,${k}`,
          // The take's current render needs no pick: the part plays it anyway.
          own
            ? { generation: own }
            : {
                takeRender:
                  input.videoUrl === current ? undefined : input.videoUrl,
              },
        ),
      })
      .where(eq(contentTemplateTable.id, plan.id));
  }
  if (!keepsOriginal(take)) {
    await startVideoCloneStitch(organizationId, plan.id, plan.video.edit);
  }
  return { picked: true };
}

/**
 * Adds the takes a change wrote (addVideoCloneTakes), with the story and continuity they join.
 * A take written again replaces the one with its index in place (renders write their take by
 * position), keeping its model and pinned products; its render goes with it. Takes merged away
 * (`removed`) go last, by index; not while anything renders.
 */
export async function addVideoCloneTakesToPlan(
  templateId: string,
  /** The plan's takes when the change started: positions hold, takes are only appended meanwhile. */
  current: VideoClone["takes"],
  addition: {
    takes: VideoClone["takes"];
    story: number[];
    continuity?: VideoClone["continuity"];
    removed: number[];
  },
): Promise<void> {
  const structure = sql`${contentTemplateTable.structure}`;
  const positions = new Map(
    current.map((take, position) => [take.index, position]),
  );
  const fresh = addition.takes.filter((take) => !positions.has(take.index));
  // Appended in place, so renders landing meanwhile keep their writes.
  let next = sql`jsonb_set(${structure}, '{video,takes}', (${structure} #> '{video,takes}') || ${JSON.stringify(fresh)}::jsonb)`;
  for (const take of addition.takes) {
    const position = positions.get(take.index);
    if (position === undefined) continue;
    const { model, products } = current[position] ?? {};
    next = sql`jsonb_set(${next}, ${`{video,takes,${position}}`}::text[], ${JSON.stringify({ model, products, ...take })}::jsonb)`;
  }
  if (addition.removed.length > 0) {
    next = sql`jsonb_set(${next}, '{video,takes}', coalesce((select jsonb_agg(take order by position) from jsonb_array_elements(${next} #> '{video,takes}') with ordinality as t(take, position) where not ${JSON.stringify(addition.removed)}::jsonb @> (take -> 'index')), '[]'::jsonb))`;
  }
  next = sql`jsonb_set(${next}, '{video,story}', ${JSON.stringify(addition.story)}::jsonb)`;
  if (addition.continuity) {
    next = sql`jsonb_set(${next}, '{video,continuity}', ${JSON.stringify(addition.continuity)}::jsonb)`;
  }
  await db
    .update(contentTemplateTable)
    .set({ structure: next })
    .where(eq(contentTemplateTable.id, templateId));
}

/**
 * Removes a take that changes added, and its shots from the story and continuity. Not while
 * anything renders: renders write their take by position.
 */
export async function removeVideoCloneTake(
  organizationId: string,
  templateId: string,
  takeIndex: number,
) {
  const plan = await findVideoClone(organizationId, templateId);
  if (!plan) return { error: "Clone plan not found." };
  const take = plan.video.takes.find((item) => item.index === takeIndex);
  if (!take) return { error: "Unknown take." };
  if (take.videoUrl) {
    return { error: "Only takes your changes added can be removed." };
  }
  if (
    plan.video.rewrite?.status === "rewriting" ||
    plan.video.takes.some((item) =>
      [item.generation, ...item.parts.map((part) => part.generation)].some(
        (generation) => generation?.status === "generating",
      ),
    )
  ) {
    return {
      error: "Wait for the renders and changes to finish, then remove it.",
    };
  }
  const shots = new Set(take.parts.map((part) => part.shot));
  const structure = sql`${contentTemplateTable.structure}`;
  let next = sql`jsonb_set(${structure}, '{video,takes}', ${JSON.stringify(plan.video.takes.filter((item) => item !== take))}::jsonb)`;
  if (plan.video.story) {
    next = sql`jsonb_set(${next}, '{video,story}', ${JSON.stringify(plan.video.story.filter((shot) => !shots.has(shot)))}::jsonb)`;
  }
  if (plan.video.continuity) {
    const continuity = plan.video.continuity.map((element) => ({
      ...element,
      shots: element.shots.filter((shot) => !shots.has(shot)),
    }));
    next = sql`jsonb_set(${next}, '{video,continuity}', ${JSON.stringify(continuity)}::jsonb)`;
  }
  await db
    .update(contentTemplateTable)
    .set({ structure: next })
    .where(eq(contentTemplateTable.id, plan.id));
  if (plan.video.edit?.rendered.includes(takeIndex)) {
    await startVideoCloneStitch(organizationId, plan.id, plan.video.edit);
  }
  return { removed: takeIndex };
}

/** Deletes the organization's clone plan; its stored clips stay, like a deleted post's images. */
export async function deleteVideoClone(
  organizationId: string,
  templateId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(contentTemplateTable)
    .where(
      and(
        eq(contentTemplateTable.id, templateId),
        eq(contentTemplateTable.organizationId, organizationId),
        eq(contentTemplateTable.format, "video"),
        sql`${contentTemplateTable.structure}->'video' is not null`,
      ),
    )
    .returning({ id: contentTemplateTable.id });
  return deleted.length > 0;
}

/** The organization's images among `ids`, e.g. a take's pinned products. */
export const findAssetImages = (organizationId: string, ids: string[]) =>
  ids.length === 0
    ? Promise.resolve([])
    : db
        .select({
          id: creativeAssetTable.id,
          name: creativeAssetTable.name,
          url: creativeAssetTable.url,
        })
        .from(creativeAssetTable)
        .where(
          and(
            eq(creativeAssetTable.organizationId, organizationId),
            inArray(creativeAssetTable.id, ids),
            eq(creativeAssetTable.mediaType, "image"),
          ),
        );

/** Product photos to pin on takes: the images in Assets folders, by folder. */
export const listVideoCloneProductOptions = (organizationId: string) =>
  db
    .select({
      id: creativeAssetTable.id,
      name: creativeAssetTable.name,
      url: creativeAssetTable.url,
      folder: creativeAssetFolderTable.name,
    })
    .from(creativeAssetTable)
    .innerJoin(
      creativeAssetFolderTable,
      eq(creativeAssetFolderTable.id, creativeAssetTable.folderId),
    )
    .where(
      and(
        eq(creativeAssetTable.organizationId, organizationId),
        eq(creativeAssetTable.mediaType, "image"),
      ),
    )
    .orderBy(
      asc(creativeAssetFolderTable.name),
      asc(creativeAssetTable.createdAt),
    );

/** The organization's clone plan, if the template is one. */
export async function findVideoClone(
  organizationId: string,
  templateId: string,
) {
  const template = await db.query.contentTemplateTable.findFirst({
    where: and(
      eq(contentTemplateTable.id, templateId),
      eq(contentTemplateTable.organizationId, organizationId),
    ),
    columns: { id: true, name: true, structure: true },
  });
  const video = template?.structure.video;
  return template && video
    ? {
        id: template.id,
        name: template.name,
        // A run that died never marks its takes failed; nothing else would let them render again.
        video: settleDeadRenders(video),
      }
    : undefined;
}

/** Our products for a render: the images in one gallery folder, oldest first. */
export async function findProductImages(
  organizationId: string,
  folderName: string,
): Promise<{ images: { name: string; url: string }[] } | { error: string }> {
  const folders = await db
    .select({
      id: creativeAssetFolderTable.id,
      name: creativeAssetFolderTable.name,
    })
    .from(creativeAssetFolderTable)
    .where(eq(creativeAssetFolderTable.organizationId, organizationId));
  const folder = folders.find((candidate) => candidate.name === folderName);
  if (!folder) {
    const names = folders.map((candidate) => `"${candidate.name}"`).join(", ");
    return {
      error: `No gallery folder named "${folderName}". Folders: ${names || "none yet"}.`,
    };
  }
  const images = await db.query.creativeAssetTable.findMany({
    where: and(
      eq(creativeAssetTable.organizationId, organizationId),
      eq(creativeAssetTable.folderId, folder.id),
      eq(creativeAssetTable.mediaType, "image"),
    ),
    columns: { name: true, url: true },
    orderBy: [asc(creativeAssetTable.createdAt)],
  });
  if (images.length === 0) {
    return { error: `"${folderName}" has no images to use as products.` };
  }
  if (images.length > MAX_VIDEO_CLONE_PRODUCTS) {
    return {
      error: `"${folderName}" has ${images.length} images; keep up to ${MAX_VIDEO_CLONE_PRODUCTS} product photos in it.`,
    };
  }
  return { images };
}

/** Marks the takes as rendering, then starts the Seedance run; each take's result lands on the plan. */
export async function startVideoCloneRender(
  input: Omit<z.infer<typeof generateVideoCloneInputSchema>, "startedAt">,
): Promise<{ runId: string } | { error: string }> {
  // Fails fast when the provider's key isn't set.
  const setupError = await getVideoProvider().then(
    () => null,
    (error: unknown) => getErrorMessage(error),
  );
  if (setupError) return { error: setupError };
  const plan = await findVideoClone(input.organizationId, input.templateId);
  if (!plan) return { error: "Clone plan not found." };
  const { takes } = plan.video;
  const characters = new Set(plan.video.vibe.characters.map(({ id }) => id));
  const unknown = Object.keys(input.cast).find((id) => !characters.has(id));
  if (unknown) {
    return {
      error: `No character "${unknown}" in this clone; its cast is ${[...characters].join(", ") || "empty"}.`,
    };
  }
  const faceIds = [...new Set(Object.values(input.cast))];
  const faces = await findFaces(input.organizationId, faceIds);
  if (faces.length !== faceIds.length) {
    return { error: "Face not found." };
  }
  if (input.productFolder) {
    const products = await findProductImages(
      input.organizationId,
      input.productFolder,
    );
    if ("error" in products) return products;
  }
  // Picked frames are stills the clip dialog uploaded (uploadImageFile); nothing else gets signed.
  const uploads = `/storage/${storageConfig.bucketNames.images}/creative-assets/uploads/`;
  if (
    input.frames.some(
      (url) =>
        !url.startsWith(uploads) ||
        !/^[0-9a-f-]{36}$/u.test(url.slice(uploads.length)),
    )
  ) {
    return { error: "Attach frames from the timeline." };
  }
  const positions = input.takeIndexes.map((index) =>
    takes.findIndex((take) => take.index === index),
  );
  if (positions.includes(-1)) return { error: "Unknown take." };
  const kept = takes.find(
    (take) => input.takeIndexes.includes(take.index) && keepsOriginal(take),
  );
  if (kept) {
    return {
      error: `Take ${kept.index} keeps its original footage; pick a model for it to render it.`,
    };
  }
  // A shot is redone alone to fit back into its take's render.
  const take = takes[positions[0] ?? -1];
  const redo = take?.parts.findIndex((part) => part.shot === input.shot);
  if (input.shot !== undefined) {
    if (!take || positions.length !== 1 || redo === -1) {
      return { error: "Pick one shot of one take." };
    }
    if (take.parts.length < 2) {
      return {
        error: `Take ${take.index} is a single shot; render the take instead.`,
      };
    }
    if (take.generation?.status !== "done") {
      return {
        error: `Render take ${take.index} first; a shot is redone to match its render.`,
      };
    }
  }

  // Mark the takes (or the shot) before the run starts so the page shows them rendering right away.
  const startedAt = new Date().toISOString();
  const mark = (generation: VideoCloneGeneration) =>
    Promise.all(
      positions.map((position) =>
        input.shot !== undefined && redo !== undefined
          ? setVideoClonePartGeneration(plan.id, position, redo, generation)
          : setVideoCloneGeneration(plan.id, position, generation),
      ),
    );
  const generation = {
    prompt: "",
    cast: input.cast,
    changes: input.changes,
    productFolder: input.productFolder,
    startedAt,
  };
  await mark({ ...generation, status: "generating" });
  try {
    const handle = await tasks.trigger<typeof generateVideoCloneTask>(
      triggerTaskIds.generateVideoClone,
      { ...input, startedAt },
    );
    return { runId: handle.id };
  } catch (error) {
    await mark({
      ...generation,
      status: "failed",
      error: "Couldn't start the render.",
    });
    throw error;
  }
}

/** The workspace's clone plans, newest first. */
export async function listVideoClones(organizationId: string) {
  const templates = await db.query.contentTemplateTable.findMany({
    where: and(
      eq(contentTemplateTable.organizationId, organizationId),
      ne(contentTemplateTable.status, "archived"),
    ),
    columns: { id: true, name: true, structure: true, createdAt: true },
    orderBy: [desc(contentTemplateTable.createdAt)],
  });
  return templates.flatMap(({ id, name, structure, createdAt }) => {
    const video = structure.video;
    return video
      ? [
          {
            id,
            name,
            verdict: video.verdict,
            sourceUrl: video.sourceUrl,
            durationSeconds: video.durationSeconds,
            takes: video.takes.length,
            createdAt,
            editVideoUrl: video.edit?.videoUrl ?? null,
          },
        ]
      : [];
  });
}

/** A presigned PUT for a source video upload; startVideoClone only takes keys shaped like these. */
export async function prepareVideoCloneUpload(
  organizationId: string,
  input: { extension: string; mimeType: string; sizeBytes: number },
) {
  const storageKey = `creative-assets/videos/${organizationId}/${crypto.randomUUID()}.${input.extension}`;
  const signedUrl = await getSignedUploadUrl(
    storageKey,
    storageConfig.bucketNames.images,
    input.mimeType,
    input.sizeBytes,
  );
  return { signedUrl, storageKey };
}

/** Analyzes a link or an uploaded video in the background (analyze-video-clone), which saves the plan. */
export async function startVideoClone(input: {
  organizationId: string;
  /** A link already normalized by videoCloneUrlSchema, or an upload key from prepareVideoCloneUpload. */
  source: { url: string } | { storageKey: string };
  name?: string;
}): Promise<{ id: string }> {
  let sourceUrl: string;
  if ("url" in input.source) {
    sourceUrl = input.source.url;
  } else {
    const ownUpload = new RegExp(
      `^creative-assets/videos/${input.organizationId}/[0-9a-f-]+\\.(mp4|mov|webm)$`,
      "u",
    );
    if (!ownUpload.test(input.source.storageKey)) {
      throw new Error("Unknown upload.");
    }
    sourceUrl = `/storage/${storageConfig.bucketNames.images}/${input.source.storageKey}`;
  }
  const name =
    input.name?.trim() ||
    ("url" in input.source
      ? videoCloneSourceName(sourceUrl)
      : "Uploaded video");
  return tasks.trigger<typeof analyzeVideoCloneTask>(
    triggerTaskIds.analyzeVideoClone,
    {
      organizationId: input.organizationId,
      sourceUrl,
      name: name.slice(0, 200),
    },
  );
}

// Keys uploadImageFile returns (app/api/storage/upload); nothing else gets saved as a photo.
const isUploadedImage = (storageKey: string) =>
  /^creative-assets\/uploads\/[0-9a-f-]{36}$/u.test(storageKey);

/** Product photos uploaded together become one product: a new folder named after the first photo. */
export async function addVideoCloneProduct(
  organizationId: string,
  assets: { name: string; storageKey: string }[],
): Promise<{ folder: string }> {
  if (!assets.every(({ storageKey }) => isUploadedImage(storageKey))) {
    throw new Error("Upload the photos first.");
  }
  const base =
    assets[0]?.name
      .replace(/\.[^.]*$/u, "")
      .trim()
      .slice(0, 70) || "Product";
  const taken = new Set(
    (
      await db
        .select({ name: creativeAssetFolderTable.name })
        .from(creativeAssetFolderTable)
        .where(eq(creativeAssetFolderTable.organizationId, organizationId))
    ).map(({ name }) => name),
  );
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base} ${n}`;
  await db.transaction(async (tx) => {
    const [folder] = await tx
      .insert(creativeAssetFolderTable)
      .values({ organizationId, name })
      .returning({ id: creativeAssetFolderTable.id });
    if (!folder) throw new Error("Couldn't save the product.");
    await tx.insert(creativeAssetTable).values(
      assets.map(({ name: fileName, storageKey }) => ({
        organizationId,
        folderId: folder.id,
        name: fileName,
        storageKey,
        url: `/storage/${storageConfig.bucketNames.images}/${storageKey}`,
      })),
    );
  });
  return { folder: name };
}

/** Faces that can play a character, oldest first. */
export const listFaces = (organizationId: string) =>
  db
    .select({
      id: faceTable.id,
      name: faceTable.name,
      imageUrl: faceTable.imageUrl,
    })
    .from(faceTable)
    .where(eq(faceTable.organizationId, organizationId))
    .orderBy(asc(faceTable.createdAt));

/** The workspace's faces among `ids`, e.g. a render's cast. */
export const findFaces = (organizationId: string, ids: string[]) =>
  ids.length === 0
    ? Promise.resolve([])
    : db
        .select({ id: faceTable.id, imageUrl: faceTable.imageUrl })
        .from(faceTable)
        .where(
          and(
            eq(faceTable.organizationId, organizationId),
            inArray(faceTable.id, ids),
          ),
        );

/** Saves an uploaded portrait (uploadImageFile) as a face. */
export async function createFace(
  organizationId: string,
  input: { name: string; storageKey: string },
): Promise<{ id: string }> {
  if (!isUploadedImage(input.storageKey)) {
    throw new Error("Upload the photo first.");
  }
  const [face] = await db
    .insert(faceTable)
    .values({
      organizationId,
      name: input.name,
      imageUrl: `/storage/${storageConfig.bucketNames.images}/${input.storageKey}`,
    })
    .returning({ id: faceTable.id });
  if (!face) throw new Error("Couldn't save the face.");
  return face;
}

/** Deletes a face; renders it played keep their videos. False when it isn't the workspace's. */
export async function deleteFace(
  organizationId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(faceTable)
    .where(
      and(eq(faceTable.id, id), eq(faceTable.organizationId, organizationId)),
    )
    .returning({ id: faceTable.id });
  return deleted.length > 0;
}
