"use client";

import NiceModal from "@ebay/nice-modal-react";
import type { PlayerRef } from "@remotion/player";
import type { inferRouterOutputs } from "@trpc/server";
import {
  CameraIcon,
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  ImagePlusIcon,
  InfoIcon,
  LayersIcon,
  LoaderCircleIcon,
  PackageIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  UserRoundIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useRouter } from "next/navigation";
import * as React from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { ConfirmationModal } from "@/components/confirmation-modal";
import type { PreviewClip } from "@/components/organization/video-clone-preview";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { storageConfig } from "@/config/storage.config";
import {
  DEFAULT_VIDEO_CLONE_MODEL,
  DEFAULT_VIDEO_PROVIDER,
  isAddedPart,
  isInstagramUrl,
  isTikTokUrl,
  keepsOriginal,
  MAX_PICKED_FRAMES,
  MAX_VIDEO_CLONE_PRODUCTS,
  VIDEO_CLONE_MODEL_IDS,
  VIDEO_CLONE_MODELS,
  type VideoCloneEditClip,
  type VideoCloneModel,
  type VideoCloneVerdict,
  type VideoProvider,
  videoCloneEditClips,
  videoCloneMismatch,
  videoCloneRenders,
  videoCloneRenderUsd,
  videoCloneStory,
  videoCloneStoryTime,
} from "@/lib/content-workflows/video-clone";
import { uploadImageFile } from "@/lib/storage/upload-image-file";
import { cn, getErrorMessage } from "@/lib/utils";
import { trpc } from "@/trpc/client";
import type { AppRouter } from "@/trpc/routers/app";

type Outputs = inferRouterOutputs<AppRouter>;
type Plan = Outputs["videoClone"]["get"];
type Take = Plan["takes"][number];
type ProductOption = Outputs["videoClone"]["products"][number];
/** A part where it plays on the story clock (videoCloneStory). */
type Slot = Take["parts"][number] & {
  take: number;
  start: number;
  end: number;
};

/** The live preview's frame rate: the stitch's. */
const PREVIEW_FPS = 30;
// Remotion loads only here, in the browser, so other pages importing this file stay light.
const ClonePreview = dynamic(
  () =>
    import("@/components/organization/video-clone-preview").then(
      (mod) => mod.ClonePreview,
    ),
  { ssr: false },
);

const VERDICT: Record<
  VideoCloneVerdict,
  { label: string; text: string; className: string }
> = {
  clone: {
    label: "Clone",
    text: "Mostly reproducible with AI video.",
    className: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/25",
  },
  skip: {
    label: "Skip",
    text: "Too much has to be filmed or edited by hand.",
    className: "bg-amber-400/10 text-amber-300 ring-amber-400/25",
  },
};
const LABEL =
  "block font-mono text-[#77777E] text-[10px] uppercase tracking-[0.14em]";
const PILL =
  "inline-flex h-6 items-center gap-1.5 rounded-full border border-[#2A2A2F] bg-[#111113] px-2.5 text-[#D4D4D8] text-xs";
const CHIP =
  "flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors";
const CHIP_ON = "border-[#FFE229]/60 bg-[#FFE229]/[0.08] text-[#F4F4F5]";
const CHIP_OFF =
  "border-[#232327] text-[#A8A8AE] hover:border-[#3A3A40] hover:text-[#F4F4F5]";
/** A setting in the floating toolbar; opens its popover. The toolbar floats over the page on its shadow. */
const TOOL =
  "flex h-9 shrink-0 items-center gap-2 rounded-full border border-[#2E2E33] bg-[#18181B] pr-3 pl-1.5 font-medium text-[#F4F4F5] text-xs transition duration-200 hover:border-[#3A3A40] active:scale-[0.98] data-[state=open]:border-[#FFE229]/60 data-[state=open]:ring-2 data-[state=open]:ring-[#FFE229]/15";
const RENDER_LABEL = {
  new: "Render",
  generating: "Rendering…",
  done: "Re-render",
  failed: "Re-render",
} as const;
/** Reveal on mount; delays are set inline. */
const ENTER =
  "fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-500 motion-reduce:animate-none";
/** A big vertical player, or the box standing in for one; sized to clear the floating toolbar. */
const VIEWER =
  "mx-auto aspect-[9/16] h-[clamp(360px,calc(100vh-28rem),720px)] max-w-full rounded-xl bg-black object-contain";

const clock = (value: number) => {
  const whole = Math.floor(value);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};
const usd = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });
const renderCost = (
  takes: { seconds: number; model?: VideoCloneModel }[],
  provider: VideoProvider,
) => usd.format(videoCloneRenderUsd(takes, provider));

/** A take, or a shot of it redone alone, is rendering. */
const isRendering = (take: Take) =>
  [take.generation, ...take.parts.map((part) => part.generation)].some(
    (generation) => generation?.status === "generating",
  );

export function VideoCloneVerdictBadge({
  verdict,
}: {
  verdict: VideoCloneVerdict;
}) {
  const { label, text, className } = VERDICT[verdict];
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2.5 font-medium text-xs ring-1 ring-inset",
        className,
      )}
      title={text}
    >
      {label}
    </span>
  );
}

/** The clone page: the original next to every take, each take's script, products, and renders. */
export function VideoCloneDetail({ templateId }: { templateId: string }) {
  const { data: plan, error } = trpc.videoClone.get.useQuery(
    { id: templateId },
    {
      // Renders, stitching, and rewrites land in the background; poll only while one runs.
      refetchInterval: (query) =>
        query.state.data?.edit?.status === "stitching" ||
        query.state.data?.rewrite?.status === "rewriting" ||
        query.state.data?.takes.some(isRendering)
          ? 5000
          : false,
    },
  );
  if (error) {
    return <p className="p-6 text-destructive text-sm">{error.message}</p>;
  }
  if (!plan) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 p-6">
        <div className="h-24 w-2/3 animate-pulse rounded-2xl bg-[#0D0D0F]" />
        <div className="h-72 animate-pulse rounded-2xl border border-[#1C1C1F] bg-[#0D0D0F]" />
      </div>
    );
  }
  return <CloneEditor plan={plan} />;
}

function CloneEditor({ plan }: { plan: Plan }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const provider =
    trpc.videoClone.provider.useQuery().data?.provider ??
    DEFAULT_VIDEO_PROVIDER;
  const faces = trpc.face.list.useQuery().data ?? [];
  const products = trpc.videoClone.products.useQuery().data;
  const folders = [...new Set((products ?? []).map(({ folder }) => folder))];
  // Start from the latest render's settings so a re-render matches the takes already done.
  const [settings, setSettings] = React.useState(() => {
    const latest = plan.takes
      .flatMap((take) => take.generation ?? [])
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return {
      cast: latest?.cast ?? {},
      // Before any render, the folder the latest change was written for.
      productFolder:
        (latest ? latest.productFolder : plan.rewrite?.productFolder) ?? "",
    };
  });
  // Changes rewrite the script first, so the user can read and fix it before paying for a render.
  const [changes, setChanges] = React.useState("");
  const folderImages = (products ?? []).filter(
    (product) => product.folder === settings.productFolder,
  );
  const addProductFolder = trpc.videoClone.addProduct.useMutation();
  const [draggingProduct, setDraggingProduct] = React.useState(false);
  const [addingProduct, setAddingProduct] = React.useState(false);
  /** Dropped photos become our product: a new product folder named after the first one, picked here. */
  const addProduct = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      toast.error("Drop photos of your product.");
      return;
    }
    if (images.length > MAX_VIDEO_CLONE_PRODUCTS) {
      toast.error(`Up to ${MAX_VIDEO_CLONE_PRODUCTS} photos per product.`);
      return;
    }
    setAddingProduct(true);
    try {
      const assets = await Promise.all(images.map(uploadImageFile));
      const { folder } = await addProductFolder.mutateAsync({
        assets: assets.map(({ name, storageKey }) => ({ name, storageKey })),
      });
      await utils.videoClone.products.invalidate();
      setSettings((current) => ({ ...current, productFolder: folder }));
    } catch (error) {
      toast.error(getErrorMessage(error) || "Couldn't add the product.");
    } finally {
      setAddingProduct(false);
    }
  };
  // Kept in the plan's cast order. A cast face plays the part.
  const recast = (characterId: string, faceId: string | null) =>
    setSettings((current) => ({
      ...current,
      cast: Object.fromEntries(
        plan.vibe.characters.flatMap(({ id }) => {
          const value = id === characterId ? faceId : current.cast[id];
          return value ? [[id, value]] : [];
        }),
      ),
    }));
  const createFace = trpc.face.create.useMutation();
  const [addingFace, setAddingFace] = React.useState(false);
  /** An uploaded photo becomes a face (Faces on the home page) and plays the character. */
  const addFace = async (characterId: string, file: File) => {
    setAddingFace(true);
    try {
      const { storageKey } = await uploadImageFile(file);
      const { id } = await createFace.mutateAsync({
        name:
          file.name
            .replace(/\.[^.]*$/u, "")
            .trim()
            .slice(0, 100) || "Face",
        storageKey,
      });
      await utils.face.list.invalidate();
      recast(characterId, id);
    } catch (error) {
      toast.error(getErrorMessage(error) || "Couldn't add the face.");
    } finally {
      setAddingFace(false);
    }
  };
  const generate = trpc.videoClone.generate.useMutation({
    onSuccess: () => utils.videoClone.invalidate(),
    onError: (mutationError) => toast.error(mutationError.message),
  });
  const remove = trpc.videoClone.delete.useMutation();
  const burnText = trpc.videoClone.setBurnText.useMutation({
    onSuccess: () => utils.videoClone.get.invalidate({ id: plan.id }),
    onError: (error) => toast.error(error.message),
  });
  const applyChanges = trpc.videoClone.applyChanges.useMutation({
    onSuccess: async ({ startedAt }) => {
      watchedRewrite.current = startedAt;
      setChanges("");
      await utils.videoClone.get.invalidate({ id: plan.id });
    },
    onError: (mutationError) => toast.error(mutationError.message),
  });
  // Changes apply in the background (big ones take minutes); the page polls until they land.
  const rewrite = plan.rewrite;
  const rewriting = applyChanges.isPending || rewrite?.status === "rewriting";
  /** The rewrite whose outcome this page owes a toast: one it started, or found running. */
  const watchedRewrite = React.useRef(
    rewrite?.status === "rewriting" ? rewrite.startedAt : null,
  );
  React.useEffect(() => {
    if (
      !rewrite ||
      rewrite.status === "rewriting" ||
      rewrite.startedAt !== watchedRewrite.current
    ) {
      return;
    }
    watchedRewrite.current = null;
    if (rewrite.status === "failed") {
      toast.error(rewrite.error ?? "Couldn't apply the change.");
      return;
    }
    const changed = rewrite.changed ?? [];
    const retimed = rewrite.retimed ?? [];
    const added = rewrite.added ?? [];
    if (changed.length === 0 && added.length === 0) {
      toast.info("Nothing needed to change.");
      return;
    }
    // The prompts aren't shown on the page, so say what changed in them.
    toast.success(rewrite.summary, {
      description: [
        changed.length > 0
          ? `${changed.length === 1 ? "Take" : "Takes"} ${changed.join(", ")}: ${rewrite.linesChanged ? "check the new lines" : "lines unchanged"}`
          : null,
        retimed.length > 0
          ? `new timing for ${retimed.length === 1 ? "take" : "takes"} ${retimed.join(", ")}`
          : null,
        added.length > 0
          ? `${added.length} new ${added.length === 1 ? "take" : "takes"} (${added.join(", ")}), +${clock(rewrite.addedSeconds ?? 0)}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }, [rewrite]);

  const render = (
    takeIndexes: number[],
    shot?: number,
    frames: string[] = [],
  ) =>
    generate.mutate({
      templateId: plan.id,
      takeIndexes,
      cast: settings.cast,
      changes: "",
      productFolder: settings.productFolder || null,
      shot,
      frames,
    });

  const renderable = plan.takes.filter(
    (take) => !keepsOriginal(take) && take.generation?.status !== "generating",
  );
  const kept = plan.takes.filter(keepsOriginal).length;
  const rendered = plan.takes.filter(
    (take) => take.generation?.status === "done",
  ).length;
  // The page runs on the story clock: the video as it plays now, added takes included.
  const slots = React.useMemo(
    () => videoCloneStory({ takes: plan.takes, story: plan.story }),
    [plan.takes, plan.story],
  );
  const duration = slots.at(-1)?.end || plan.durationSeconds;
  // Takes in the order they first play, so added ones sit where they play.
  const takes = React.useMemo(() => {
    const first = new Map<number, number>();
    for (const slot of slots) {
      if (!first.has(slot.take)) first.set(slot.take, slot.start);
    }
    return [...plan.takes].sort(
      (a, b) => (first.get(a.index) ?? 0) - (first.get(b.index) ?? 0),
    );
  }, [plan.takes, slots]);
  const total = clock(Math.round(duration));
  const scriptWords = plan.takes.reduce(
    (sum, take) =>
      sum +
      take.analysis.dialogue.reduce(
        (count, line) => count + line.text.split(/\s+/u).filter(Boolean).length,
        0,
      ),
    0,
  );

  const [selected, setSelected] = React.useState<number | null>(null);
  /** The timeline clip whose dialog is open. */
  const [clip, setClip] = React.useState<Slot | null>(null);
  const [activeTake, setActiveTake] = React.useState<number | null>(null);
  const originalRef = React.useRef<HTMLVideoElement>(null);
  /** The live preview's player, once its lazily loaded bundle mounts. */
  const [player, setPlayer] = React.useState<PlayerRef | null>(null);
  const playheadRef = React.useRef<HTMLDivElement>(null);
  /** Where the playhead is on the story clock, for the ↑/↓ jumps. */
  const storyTime = React.useRef(0);
  /** While the timeline is hovered: where both players stood before, to go back to. */
  const skimRef = React.useRef<{ original?: number; frame?: number } | null>(
    null,
  );
  const edit = plan.edit;
  const generating = plan.takes.some(isRendering);
  // The edit as it plays now, each part from its own file, cut as the stitch cuts it (planned cuts
  // until a render's first stitch finds its own): the live preview and the clip dialog play it.
  const segments = React.useMemo(
    () =>
      videoCloneEditClips(
        { takes: plan.takes, story: plan.story },
        (url, planned) => plan.renderCuts?.[url] ?? planned,
      ),
    [plan.takes, plan.story, plan.renderCuts],
  );
  // The preview's times map onto the story clock like a stitched edit's parts.
  const previewParts = React.useMemo(
    () =>
      segments.map(({ part, editStart, editEnd }) => ({
        shot: part.shot,
        srcStart: part.srcStart,
        srcEnd: part.srcEnd,
        start: editStart,
        end: editEnd,
      })),
    [segments],
  );
  const previewClips = React.useMemo(() => {
    const clips: PreviewClip[] = [];
    for (const segment of segments) {
      const src = segment.src ?? plan.sourceVideoUrl;
      const from = Math.round(segment.editStart * PREVIEW_FPS);
      const length = Math.round(segment.editEnd * PREVIEW_FPS) - from;
      const trimBefore = Math.round(segment.start * PREVIEW_FPS);
      if (!src || length <= 0) continue;
      const last = clips.at(-1);
      // A take's parts run on in its file: one clip, so the cut between them doesn't reload it.
      if (
        last?.src === src &&
        last.from + last.durationInFrames === from &&
        last.trimBefore + last.durationInFrames === trimBefore
      ) {
        last.durationInFrames += length;
      } else {
        clips.push({ src, from, durationInFrames: length, trimBefore });
      }
    }
    return clips;
  }, [segments, plan.sourceVideoUrl]);
  // Takes with a render in the preview; the rest play the original's footage, or nothing yet.
  const playing = new Set(
    segments.flatMap((segment) => (segment.src ? [segment.take] : [])),
  );
  const stillOriginal = plan.takes
    .filter((take) => take.videoUrl && !playing.has(take.index))
    .map((take) => take.index);
  const notInEdit = plan.takes
    .filter((take) => !take.videoUrl && !playing.has(take.index))
    .map((take) => take.index);

  // The playhead follows whichever player played last, every frame while it plays, outside React.
  React.useEffect(() => {
    type Clock = {
      time: () => number;
      paused: () => boolean;
      parts: typeof previewParts | undefined;
      on: (
        event: "play" | "pause" | "seeked",
        listener: () => void,
      ) => () => void;
    };
    const original = plan.sourceVideoUrl ? originalRef.current : null;
    const clocks: Clock[] = [];
    if (original) {
      clocks.push({
        time: () => original.currentTime,
        paused: () => original.paused,
        parts: undefined,
        on: (event, listener) => {
          original.addEventListener(event, listener);
          return () => original.removeEventListener(event, listener);
        },
      });
    }
    if (player) {
      clocks.push({
        time: () => player.getCurrentFrame() / PREVIEW_FPS,
        paused: () => !player.isPlaying(),
        parts: previewParts,
        on: (event, listener) => {
          player.addEventListener(event, listener);
          return () => player.removeEventListener(event, listener);
        },
      });
    }
    let lead = clocks.find((clock) => !clock.paused()) ?? clocks.at(-1);
    let frame = 0;
    const paint = () => {
      // Hovering the timeline moves the players, not the playhead.
      if (!lead || skimRef.current) return;
      const time = videoCloneStoryTime(slots, lead.parts, lead.time(), "story");
      storyTime.current = time;
      if (playheadRef.current) {
        playheadRef.current.style.left = `${(time / duration) * 100}%`;
      }
      setActiveTake(
        time > 0
          ? (slots.find((slot) => time >= slot.start && time < slot.end)
              ?.take ?? null)
          : null,
      );
    };
    const loop = () => {
      paint();
      frame = requestAnimationFrame(loop);
    };
    const cleanups = clocks.flatMap((clock) => [
      clock.on("play", () => {
        lead = clock;
        cancelAnimationFrame(frame);
        loop();
      }),
      // The other player may still be playing: it takes over.
      clock.on("pause", () => {
        cancelAnimationFrame(frame);
        lead = clocks.find((other) => !other.paused()) ?? lead;
        if (lead && !lead.paused()) loop();
        else paint();
      }),
      clock.on("seeked", () => {
        if (lead === clock) paint();
      }),
    ]);
    // Re-run mid-play (new renders landed): keep following.
    if (lead && !lead.paused()) loop();
    else paint();
    return () => {
      cancelAnimationFrame(frame);
      for (const cleanup of cleanups) cleanup();
    };
  }, [slots, duration, plan.sourceVideoUrl, player, previewParts]);

  // Both players to the same moment of the story.
  const moveTo = (time: number) => {
    if (originalRef.current) {
      originalRef.current.currentTime = videoCloneStoryTime(
        slots,
        undefined,
        time,
        "video",
      );
    }
    player?.seekTo(
      Math.round(
        videoCloneStoryTime(slots, previewParts, time, "video") * PREVIEW_FPS,
      ),
    );
  };
  const seek = (time: number) => {
    skimRef.current = null;
    moveTo(time);
  };
  // Hovering the timeline while paused, both players show the frame under the pointer; when it
  // leaves (null), they go back to where they stood. Space plays from the hovered frame.
  const skim = (time: number | null) => {
    const original = originalRef.current;
    const before = skimRef.current;
    if (time === null) {
      skimRef.current = null;
      if (original && before?.original !== undefined) {
        original.currentTime = before.original;
      }
      if (before?.frame !== undefined) player?.seekTo(before.frame);
      return;
    }
    if (player?.isPlaying() || (original && !original.paused)) return;
    skimRef.current = {
      original: before ? before.original : original?.currentTime,
      frame: before ? before.frame : player?.getCurrentFrame(),
    };
    moveTo(time);
  };
  // Space plays and pauses the clone (else the original); ↑/↓ jump to the previous/next cut.
  const onKey = React.useRef<(event: KeyboardEvent) => void>(undefined);
  onKey.current = (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      target?.closest(
        "input, textarea, select, video, [contenteditable=true], [role=dialog], [role=menu]",
      )
    ) {
      return;
    }
    const original = originalRef.current;
    if (event.key === " ") {
      event.preventDefault();
      // Hovering: play from the hovered frame, where the players already are.
      skimRef.current = null;
      // A focused button would also press when the key comes up.
      if (target instanceof HTMLButtonElement) target.blur();
      if (player?.isPlaying() || (original && !original.paused)) {
        player?.pause();
        original?.pause();
      } else if (player) {
        player.play();
      } else {
        void original?.play();
      }
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const now = storyTime.current;
      const starts = slots.map((slot) => slot.start);
      const next =
        event.key === "ArrowDown"
          ? starts.find((start) => start > now + 0.05)
          : [...starts].reverse().find((start) => start < now - 0.05);
      if (next !== undefined) seek(next);
    }
  };
  React.useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey.current?.(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const openTake = (index: number) => {
    setSelected(index);
    // After the rows finish expanding, so the scroll lands where the take ends up.
    window.setTimeout(
      () =>
        document
          .getElementById(`video-clone-take-${index}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      300,
    );
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:py-8">
      <header className="fade-in slide-in-from-bottom-1 flex animate-in items-start gap-4 duration-500">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <VideoCloneVerdictBadge verdict={plan.verdict} />
            <span className={cn(PILL, "capitalize")}>{plan.vibe.format}</span>
            <span className="ml-1.5 font-mono text-[#626269] text-[11px] tabular-nums">
              {total} · {plan.takes.length}{" "}
              {plan.takes.length === 1 ? "take" : "takes"} · {rendered}/
              {plan.takes.length} rendered
            </span>
          </div>
          <h1 className="text-balance font-semibold text-2xl text-[#F4F4F5] tracking-tight">
            {plan.name}
          </h1>
          <p className="max-w-3xl text-pretty text-[#A8A8AE] text-[15px] leading-relaxed">
            {plan.vibe.summary}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <VibeInfo vibe={plan.vibe} />
          <button
            aria-label="Delete this clone"
            className="grid size-8 place-items-center rounded-full text-[#626269] transition-colors hover:bg-rose-500/10 hover:text-rose-300"
            onClick={() =>
              NiceModal.show(ConfirmationModal, {
                title: "Delete this clone?",
                message:
                  "Its takes, scripts, and renders go away for good. Renders still running finish unsaved.",
                confirmLabel: "Delete clone",
                destructive: true,
                onConfirm: async () => {
                  await remove.mutateAsync({ id: plan.id });
                  toast.success("Clone deleted.");
                  router.push("/");
                },
              })
            }
            type="button"
          >
            <Trash2Icon className="size-4" />
          </button>
        </div>
      </header>

      <section
        className={cn(
          "grid gap-4 rounded-2xl border border-[#1C1C1F] bg-[#0B0B0C] p-4",
          plan.sourceVideoUrl && "sm:grid-cols-2",
        )}
      >
        {plan.sourceVideoUrl ? (
          <figure className="min-w-0 space-y-3">
            <figcaption className="flex h-8 items-center gap-2">
              <span className="font-medium text-[#F4F4F5] text-sm">
                Original
              </span>
              {plan.sourceUrl.startsWith("http") ? (
                <a
                  className="inline-flex items-center gap-1 text-[#8AB4FF] text-xs transition-colors hover:text-[#B3CDFF]"
                  href={plan.sourceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {isTikTokUrl(plan.sourceUrl) ? "TikTok" : null}
                  {isInstagramUrl(plan.sourceUrl) ? "Instagram" : null}
                  <ExternalLinkIcon className="size-3" />
                </a>
              ) : (
                <span className="text-[#626269] text-xs">Uploaded file</span>
              )}
            </figcaption>
            {/* biome-ignore lint/a11y/useMediaCaption: source social video, its script is listed below */}
            <video
              className={VIEWER}
              controls
              playsInline
              preload="metadata"
              ref={originalRef}
              src={plan.sourceVideoUrl}
            />
          </figure>
        ) : null}
        <figure className="min-w-0 space-y-3">
          <figcaption className="flex h-8 items-center gap-2">
            <span className="font-medium text-[#F4F4F5] text-sm">Clone</span>
            <span className="min-w-0 flex-1 truncate text-[#77777E] text-xs">
              {edit?.status === "stitching" && !generating ? (
                <span className="inline-flex items-center gap-1 text-[#FFE229]">
                  <LoaderCircleIcon className="size-3 animate-spin" />
                  Stitching the download…
                </span>
              ) : null}
              {edit?.status === "failed" ? (
                <span className="text-rose-300" title={edit.error}>
                  Couldn't stitch the download
                </span>
              ) : null}
              {edit?.status !== "stitching" &&
              edit?.status !== "failed" &&
              playing.size > 0
                ? `${stillOriginal.length > 0 ? `${stillOriginal.length === 1 ? "Take" : "Takes"} ${stillOriginal.join(", ")} still original` : "Every take rendered"}${notInEdit.length > 0 ? ` · new ${notInEdit.length === 1 ? "take" : "takes"} ${notInEdit.join(", ")} not in it yet` : ""}`
                : null}
            </span>
            {edit?.videoUrl && edit.textVideoUrl ? (
              <div
                className="inline-flex h-8 shrink-0 items-center gap-1.5 text-[#D4D4D8] text-xs"
                title="Burns the takes' on-screen text into Download and posts; drafts of this clone follow."
              >
                <Checkbox
                  checked={plan.burnText === true}
                  className="border-[#3A3A40] data-[state=checked]:border-[#FFE229] data-[state=checked]:bg-[#FFE229] data-[state=checked]:text-[#09090A]"
                  disabled={burnText.isPending}
                  id="video-clone-burn-text"
                  onCheckedChange={(checked) =>
                    burnText.mutate({ id: plan.id, burnText: checked === true })
                  }
                />
                <label
                  className="cursor-pointer"
                  htmlFor="video-clone-burn-text"
                >
                  On-screen text
                </label>
              </div>
            ) : null}
            {edit?.videoUrl ? (
              <a
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[#232327] px-3 text-[#D4D4D8] text-xs transition-colors hover:border-[#3A3A40] hover:text-[#F4F4F5]"
                download={`${plan.name}.mp4`}
                href={(plan.burnText && edit.textVideoUrl) || edit.videoUrl}
              >
                <DownloadIcon className="size-3.5" />
                Download
              </a>
            ) : null}
          </figcaption>
          {playing.size > 0 ? (
            <div className={cn(VIEWER, "overflow-hidden")}>
              <ClonePreview
                clips={previewClips}
                fps={PREVIEW_FPS}
                playerRef={setPlayer}
              />
            </div>
          ) : (
            <div
              className={cn(
                VIEWER,
                "grid place-items-center p-6 text-center text-[#77777E] text-sm",
              )}
            >
              Render the takes below; the clone plays here.
            </div>
          )}
        </figure>
      </section>

      <Panel meta={`${total} · ${slots.length} shots`} title="Timeline">
        <Timeline
          activeTake={activeTake}
          duration={duration}
          onOpen={(slot) => {
            setSelected(slot.take);
            setClip(slot);
          }}
          onSeek={seek}
          onSkim={skim}
          plan={plan}
          playheadRef={playheadRef}
          products={products}
          selected={selected}
          slots={slots}
        />
      </Panel>
      {clip ? (
        <ClipDialog
          busy={generate.isPending}
          clip={clip}
          key={clip.shot}
          onClose={() => setClip(null)}
          onRender={render}
          plan={plan}
          provider={provider}
          segments={segments}
        />
      ) : null}

      <Panel meta={`${scriptWords} words`} title="Script">
        <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
          <ol className="divide-y divide-[#1C1C1F]">
            {takes.map((take) => (
              <TakeRow
                busy={generate.isPending}
                key={take.index}
                onRender={() => render([take.index])}
                onRenderShot={(shot) => render([take.index], shot)}
                onToggle={() =>
                  setSelected((current) =>
                    current === take.index ? null : take.index,
                  )
                }
                open={selected === take.index}
                products={products}
                take={take}
                templateId={plan.id}
              />
            ))}
          </ol>
          <aside className="hidden border-[#1C1C1F] border-l xl:block">
            <div className="sticky top-0 max-h-screen overflow-y-auto p-5">
              <div className="flex items-baseline justify-between">
                <span className={LABEL}>Full script</span>
                <span className="font-mono text-[#4A4A50] text-[11px] tabular-nums">
                  {scriptWords} words
                </span>
              </div>
              <div className="mt-3 space-y-1 rounded-xl bg-[#0B0B0C] p-2">
                {takes.map((take) =>
                  take.analysis.dialogue.length > 0 ? (
                    <button
                      className={cn(
                        "block w-full rounded-lg p-2 text-left text-sm leading-relaxed transition-colors",
                        selected === take.index
                          ? "bg-[#FFE229]/[0.06] text-[#F4F4F5]"
                          : "text-[#A8A8AE] hover:bg-white/[0.03] hover:text-[#D4D4D8]",
                      )}
                      key={take.index}
                      onClick={() => openTake(take.index)}
                      type="button"
                    >
                      {take.analysis.dialogue.map((line, i) => (
                        <span key={i}>
                          {line.speaker !==
                          take.analysis.dialogue[i - 1]?.speaker ? (
                            <span className="mr-1.5 font-mono text-[#626269] text-[10px] uppercase tracking-[0.1em]">
                              {line.speaker}
                            </span>
                          ) : null}
                          {line.text}{" "}
                        </span>
                      ))}
                    </button>
                  ) : null,
                )}
              </div>
            </div>
          </aside>
        </div>
        <p className="border-[#1C1C1F] border-t px-5 py-2.5 text-right text-[#626269] text-xs">
          Click any line to edit · it saves when you leave it, no render
        </p>
      </Panel>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping photos is a pointer shortcut; the product popover's file picker is keyboard-reachable. */}
      <div
        className={cn(
          "fade-in slide-in-from-bottom-4 sticky bottom-4 z-20 flex animate-in flex-wrap items-center gap-1.5 rounded-2xl border p-2 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.08)] transition-colors duration-500",
          draggingProduct
            ? "border-[#FFE229] bg-[#FFE229]/[0.08]"
            : "border-[#232327] bg-[#111113]",
        )}
        // Photos dropped anywhere on the toolbar (or its open popovers) become our product.
        onDragLeave={(event) => {
          if (
            !(
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )
          )
            setDraggingProduct(false);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDraggingProduct(true);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDraggingProduct(false);
          void addProduct(Array.from(event.dataTransfer.files));
        }}
      >
        {plan.vibe.characters.map((character) => {
          const faceId = settings.cast[character.id];
          const face = faces.find((item) => item.id === faceId);
          return (
            <Popover key={character.id}>
              <PopoverTrigger asChild>
                <button
                  className={TOOL}
                  title={`${character.id}: ${character.role}`}
                  type="button"
                >
                  {face ? (
                    <img
                      alt=""
                      className="size-6 rounded-full object-cover"
                      src={face.imageUrl}
                    />
                  ) : (
                    <span className="grid size-6 place-items-center rounded-full border border-[#3A3A40] border-dashed text-[#77777E]">
                      <UserRoundIcon className="size-3" />
                    </span>
                  )}
                  <span className="max-w-28 truncate">
                    {face ? face.name : character.id}
                  </span>
                  {character.reference === "creator" ? (
                    <span
                      className="size-1.5 rounded-full bg-amber-500"
                      title="Main character"
                    />
                  ) : null}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-80 space-y-3 border-[#232327] bg-[#0D0D0F] p-3"
                side="top"
              >
                <div>
                  <p className="flex items-center gap-1.5 text-[#F4F4F5] text-sm">
                    {character.id}
                    {character.reference === "creator" ? (
                      <span className="rounded bg-[#FFE229]/15 px-1 py-px font-medium text-[#FFE229] text-[10px]">
                        main
                      </span>
                    ) : null}
                  </p>
                  <p className="text-[#77777E] text-xs leading-snug">
                    {character.role}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <FaceOption
                    label="Original"
                    onClick={() => recast(character.id, null)}
                    selected={!faceId}
                    title={`Keep as described: ${character.description}`}
                  >
                    <span className="grid size-9 place-items-center rounded-full border border-[#3A3A40] border-dashed text-[#77777E]">
                      <UserRoundIcon className="size-4" />
                    </span>
                  </FaceOption>
                  {faces.map((item) => (
                    <FaceOption
                      key={item.id}
                      label={item.name}
                      onClick={() => recast(character.id, item.id)}
                      selected={faceId === item.id}
                      title={`${item.name} plays ${character.id}`}
                    >
                      <img
                        alt=""
                        className="size-9 rounded-full object-cover"
                        src={item.imageUrl}
                      />
                    </FaceOption>
                  ))}
                  <label
                    className="group flex w-16 shrink-0 cursor-pointer flex-col items-center gap-1.5"
                    title={`Upload a photo of who plays ${character.id}: one person, face clearly visible.`}
                  >
                    <span className="grid size-9 place-items-center rounded-full border border-[#3A3A40] border-dashed text-[#77777E] transition-colors group-hover:border-[#77777E] group-hover:text-[#F4F4F5]">
                      {addingFace ? (
                        <LoaderCircleIcon className="size-4 animate-spin" />
                      ) : (
                        <PlusIcon className="size-4" />
                      )}
                    </span>
                    <span className="w-full truncate text-center text-[#77777E] text-[11px]">
                      Upload
                    </span>
                    <input
                      accept="image/*"
                      className="sr-only"
                      disabled={addingFace}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void addFace(character.id, file);
                      }}
                      type="file"
                    />
                  </label>
                </div>
              </PopoverContent>
            </Popover>
          );
        })}

        <Popover>
          <PopoverTrigger asChild>
            <button className={cn(TOOL, "pl-3")} type="button">
              {addingProduct ? (
                <LoaderCircleIcon className="size-3.5 animate-spin text-[#A8A8AE]" />
              ) : (
                <PackageIcon className="size-3.5 text-[#A8A8AE]" />
              )}
              {folderImages.length > 0 && !draggingProduct ? (
                <span className="-space-x-1.5 flex">
                  {folderImages.slice(0, 3).map((image) => (
                    <Image
                      alt=""
                      className="size-5 rounded-full object-cover ring-2 ring-[#18181B]"
                      height={20}
                      key={image.id}
                      src={image.url}
                      width={20}
                    />
                  ))}
                </span>
              ) : null}
              <span className="max-w-32 truncate">
                {draggingProduct
                  ? "Drop it here"
                  : settings.productFolder || "Drop a product"}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-80 space-y-3 border-[#232327] bg-[#0D0D0F] p-3"
            side="top"
          >
            <label
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-xl border border-dashed p-3 text-[#626269] text-xs leading-snug transition-colors",
                draggingProduct
                  ? "border-[#FFE229] bg-[#FFE229]/[0.06]"
                  : "border-[#3A3A40] focus-within:border-[#FFE229]/60 hover:border-[#FFE229]/60",
              )}
            >
              {addingProduct ? (
                <LoaderCircleIcon className="size-5 shrink-0 animate-spin text-[#FFE229]" />
              ) : (
                <ImagePlusIcon className="size-5 shrink-0 text-[#A8A8AE]" />
              )}
              <span>
                <span className="block text-[#F4F4F5] text-sm">
                  {addingProduct
                    ? "Adding your product…"
                    : "Drop product photos"}
                </span>
                Or click to choose: up to {MAX_VIDEO_CLONE_PRODUCTS} photos of
                one product, saved as a new product.
              </span>
              <input
                accept="image/*"
                className="sr-only"
                disabled={addingProduct}
                multiple
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  void addProduct(files);
                }}
                type="file"
              />
            </label>
            {folders.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {["", ...folders].map((folder) => {
                  const on = settings.productFolder === folder;
                  return (
                    <button
                      aria-pressed={on}
                      className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}
                      key={folder}
                      onClick={() =>
                        setSettings((current) => ({
                          ...current,
                          productFolder: folder,
                        }))
                      }
                      type="button"
                    >
                      {on ? <CheckIcon className="size-3.5" /> : null}
                      {folder || "None"}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {folderImages.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {folderImages.map((image, i) => (
                  <Image
                    alt={image.name}
                    className={cn(
                      ENTER,
                      "size-10 rounded-lg object-cover ring-1 ring-[#232327]",
                    )}
                    height={40}
                    key={image.id}
                    src={image.url}
                    style={{ animationDelay: `${i * 40}ms` }}
                    title={image.name}
                    width={40}
                  />
                ))}
              </div>
            ) : null}
            <p className="text-[#626269] text-xs leading-snug">
              The product's photos replace the original's product wherever it
              shows; images pinned on a take always go in that take.
            </p>
          </PopoverContent>
        </Popover>

        <textarea
          aria-label="Changes for every take"
          className="field-sizing-content max-h-28 min-h-9 min-w-48 flex-1 resize-none rounded-xl border border-transparent bg-transparent px-3 py-2 text-[#F4F4F5] text-sm outline-none transition-colors placeholder:text-[#626269] hover:bg-white/[0.04] focus:border-[#3A3A40] focus:bg-[#0B0B0C] disabled:opacity-60"
          disabled={rewriting}
          maxLength={2000}
          onChange={(event) => setChanges(event.target.value)}
          placeholder={
            rewrite?.status === "rewriting"
              ? `Applying “${rewrite.changes}”…`
              : "Ask for a change: new lines, plug our product, add 30 seconds, a VHS 80s look…"
          }
          rows={1}
          value={changes}
        />
        {rewriting ? (
          <span
            className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-white/[0.06] px-4 font-medium text-[#A8A8AE] text-xs"
            title="Opus rewrites the script in the background; a longer video takes a few minutes. You can leave the page."
          >
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            Rewriting the script…
          </span>
        ) : null}
        {!rewriting && changes.trim() ? (
          <Button
            className="fade-in zoom-in-95 h-9 shrink-0 animate-in rounded-full bg-[#FFE229] px-4 font-medium text-[#09090B] duration-200 hover:bg-[#FFE229]/90 active:scale-[0.98] dark:bg-[#FFE229] dark:text-[#09090B] dark:hover:bg-[#FFE229]/90"
            onClick={() =>
              applyChanges.mutate({
                templateId: plan.id,
                changes: changes.trim(),
                // What "our product" is, when the change plugs it.
                productFolder: settings.productFolder || null,
              })
            }
            title="Rewrites the prompts and, if asked, the lines, timing, and added takes; nothing renders yet."
            type="button"
          >
            <CheckIcon />
            Submit change
          </Button>
        ) : null}
        {!rewriting && !changes.trim() ? (
          <Button
            className="h-9 shrink-0 rounded-full bg-[#FFE229] px-4 font-medium text-[#09090B] transition-transform hover:bg-[#FFE229]/90 active:scale-[0.98] disabled:bg-[#2E2E33] disabled:text-[#77777E] dark:bg-[#FFE229] dark:text-[#09090B] dark:hover:bg-[#FFE229]/90"
            disabled={renderable.length === 0}
            loading={generate.isPending}
            onClick={() => render(renderable.map((take) => take.index))}
            title={
              kept > 0
                ? `${kept} ${kept === 1 ? "take keeps" : "takes keep"} the original footage.`
                : undefined
            }
            type="button"
          >
            {generate.isPending ? null : <SparklesIcon />}
            Render {renderable.length}{" "}
            {renderable.length === 1 ? "take" : "takes"} ·{" "}
            {renderCost(renderable, provider)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** A card section whose body folds away; overflow only clips while it moves, so sticky children work. */
function Panel({
  children,
  meta,
  title,
}: {
  children: React.ReactNode;
  meta: string;
  title: string;
}) {
  const [open, setOpen] = React.useState(true);
  const [settled, setSettled] = React.useState(true);
  return (
    <section className="rounded-2xl border border-[#1C1C1F] bg-[#0D0D0F]">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-2xl px-5 py-3.5 text-left transition-colors hover:bg-white/[0.015]"
        onClick={() => {
          setOpen(!open);
          setSettled(false);
        }}
        type="button"
      >
        <span className="font-mono text-[#A8A8AE] text-[11px] uppercase tracking-[0.16em]">
          {title}
        </span>
        <span className="ml-auto truncate font-mono text-[#626269] text-[11px] tabular-nums">
          {meta}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 text-[#626269] transition-transform duration-300",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        inert={!open}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget) setSettled(true);
        }}
      >
        <div className={cn("min-h-0", !(open && settled) && "overflow-hidden")}>
          <div className="border-[#1C1C1F] border-t">{children}</div>
        </div>
      </div>
    </section>
  );
}

/** The video as it plays now on one clock: shots by take, on-screen text, pinned media, and the original's spoken lines. */
function Timeline({
  activeTake,
  duration,
  onOpen,
  onSeek,
  onSkim,
  plan,
  playheadRef,
  products,
  selected,
  slots,
}: {
  activeTake: number | null;
  /** The story's length; every lane runs on the story clock. */
  duration: number;
  /** Opens a clip's dialog: its prompt, frames to match, and a re-render. */
  onOpen: (slot: Slot) => void;
  onSeek: (time: number) => void;
  /** The story time under the pointer while it hovers the lanes; null when it leaves. */
  onSkim: (time: number | null) => void;
  plan: Plan;
  playheadRef: React.RefObject<HTMLDivElement | null>;
  products: ProductOption[] | undefined;
  selected: number | null;
  slots: Slot[];
}) {
  const utils = trpc.useUtils();
  const update = trpc.videoClone.updateTake.useMutation({
    onSuccess: () => utils.videoClone.get.invalidate({ id: plan.id }),
    onError: (error) => toast.error(error.message),
  });
  const hoverRef = React.useRef<HTMLDivElement>(null);
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const lanesRef = React.useRef<HTMLDivElement>(null);
  // 1 = the whole video fits; zoomed all the way in, about 4 seconds do.
  const [zoom, setZoom] = React.useState(1);
  const maxZoom = Math.max(1, duration / 4);
  /** Zooms by `factor`, holding the moment under `x` (the pointer, else the playhead) where it is on screen. */
  const zoomBy = (factor: number, x?: number) => {
    const scroller = scrollerRef.current;
    const before = lanesRef.current?.getBoundingClientRect();
    if (!scroller || !before) return;
    const point =
      x ??
      before.left +
        (Number.parseFloat(playheadRef.current?.style.left || "0") / 100) *
          before.width;
    const at = (point - before.left) / before.width;
    const next = Math.min(maxZoom, Math.max(1, zoom * factor));
    flushSync(() => setZoom(next));
    const after = lanesRef.current?.getBoundingClientRect();
    // All the way out, the whole video shows from its start.
    if (next === 1) scroller.scrollLeft = 0;
    else if (after)
      scroller.scrollLeft += after.left + at * after.width - point;
  };
  // Ctrl/⌘ + scroll (and trackpad pinch) zooms around the pointer; plain scroll still scrolls.
  const onWheel = React.useRef<(event: WheelEvent) => void>(undefined);
  onWheel.current = (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    // Knob: a mouse wheel notch (deltaY 100) zooms about 1.6×; a pinch sends many small deltas.
    zoomBy(Math.exp(-event.deltaY * 0.005), event.clientX);
  };
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const listener = (event: WheelEvent) => onWheel.current?.(event);
    // Not passive: the page mustn't zoom instead.
    scroller.addEventListener("wheel", listener, { passive: false });
    return () => scroller.removeEventListener("wheel", listener);
  }, []);
  const pct = (time: number) => (time / duration) * 100;
  // 1px gutters so neighbouring blocks read as separate.
  const span = (start: number, end: number) => ({
    left: `calc(${pct(start)}% + 1px)`,
    width: `calc(${pct(end - start)}% - 2px)`,
  });
  // About six labels across the visible stretch.
  const step =
    [1, 2, 5, 10, 15, 30, 60].find((s) => duration / zoom / s <= 6) ?? 120;
  const ticks = Array.from(
    { length: Math.floor(duration / step) + 1 },
    (_, i) => i * step,
  );
  const takeOf = new Map(plan.takes.map((take) => [take.index, take]));
  const firstShot = new Map(
    plan.takes.map((take) => [
      take.index,
      Math.min(...take.parts.map((part) => part.shot)),
    ]),
  );
  const productById = new Map(
    (products ?? []).map((product) => [product.id, product]),
  );
  const texts = plan.takes.filter((take) => take.analysis.onScreenText.trim());
  const lane = "relative h-8 rounded-lg bg-white/[0.02]";
  const empty =
    "absolute inset-y-0 left-2 flex items-center text-[#3A3A40] text-[11px]";

  return (
    <div className="px-5 pt-4 pb-4">
      <div className="overflow-x-auto" ref={scrollerRef}>
        <div className="flex min-w-[640px]" style={{ width: `${zoom * 100}%` }}>
          {/* Lane names (and the gap after them) stay put while a zoomed timeline scrolls under them. */}
          <div className="sticky left-0 z-20 w-[68px] shrink-0 space-y-1.5 bg-[#0D0D0F] pt-[30px] pr-3">
            {["Takes", "Text", "Media", "Voice"].map((label) => (
              <div
                className="flex h-8 items-center justify-end font-mono text-[#626269] text-[10px] uppercase tracking-[0.14em]"
                key={label}
              >
                {label}
              </div>
            ))}
          </div>
          <div
            className="relative min-w-0 flex-1 space-y-1.5"
            ref={lanesRef}
            onPointerLeave={() => {
              if (hoverRef.current) hoverRef.current.style.opacity = "0";
              onSkim(null);
            }}
            onPointerMove={(event) => {
              const line = hoverRef.current;
              if (!line) return;
              const box = event.currentTarget.getBoundingClientRect();
              const ratio = Math.min(
                1,
                Math.max(0, (event.clientX - box.left) / box.width),
              );
              line.style.left = `${ratio * 100}%`;
              line.style.opacity = "1";
              if (line.firstElementChild) {
                line.firstElementChild.textContent = clock(ratio * duration);
              }
              // Dragging the ruler seeks for good instead.
              if (event.buttons === 0) onSkim(ratio * duration);
            }}
          >
            <div className="relative h-6">
              {ticks.map((tick) => (
                <span
                  className="absolute top-0 h-3 border-[#2A2A2F] border-l pl-1 font-mono text-[#626269] text-[10px] tabular-nums leading-none"
                  key={tick}
                  style={{ left: `${pct(tick)}%` }}
                >
                  {clock(tick)}
                </span>
              ))}
              {duration - (ticks.at(-1) ?? 0) > step * 0.4 ? (
                <span className="absolute top-0 right-0 h-3 border-[#2A2A2F] border-r pr-1 font-mono text-[#626269] text-[10px] tabular-nums leading-none">
                  {clock(Math.round(duration))}
                </span>
              ) : null}
              <input
                aria-label="Scrub the reference"
                className="absolute inset-0 size-full cursor-col-resize opacity-0"
                defaultValue={0}
                max={duration}
                min={0}
                onChange={(event) => onSeek(Number(event.target.value))}
                step={0.01}
                type="range"
              />
            </div>

            <div className={lane}>
              {slots.map((slot) => {
                const slotTake = takeOf.get(slot.take);
                const kept = !slotTake || keepsOriginal(slotTake);
                // The whole take, or this shot alone, rendering again.
                const rendering =
                  !kept &&
                  [slotTake.generation, slot.generation].some(
                    (generation) => generation?.status === "generating",
                  );
                const status = kept ? undefined : slotTake.generation?.status;
                const off = kept
                  ? undefined
                  : videoCloneMismatch(slotTake, slot);
                // Renders of the take plus this shot's own: what its dialog picks from.
                const versions = kept
                  ? 0
                  : videoCloneRenders(slotTake).length +
                    videoCloneRenders(slot).length;
                let bar = "bg-[#3A3A40]";
                if (status === "done") bar = "bg-[#FFE229]";
                if (rendering) bar = "animate-pulse bg-[#FFE229]/60";
                if (status === "failed") bar = "bg-rose-400";
                if (off && !rendering) bar = "bg-amber-400";
                let tone =
                  "border-[#232327] bg-[#111113] text-[#A8A8AE] hover:border-[#3A3A40] hover:text-[#F4F4F5]";
                if (activeTake === slot.take) {
                  tone = "border-[#3A3A40] bg-[#18181B] text-[#F4F4F5]";
                }
                if (selected === slot.take) {
                  tone =
                    "border-[#FFE229]/50 bg-[#FFE229]/[0.09] text-[#F4F4F5]";
                }
                return (
                  <button
                    className={cn(
                      "absolute inset-y-0 flex items-center gap-1 overflow-hidden rounded-md border pr-1.5 pl-3 text-left text-[11px] transition duration-200 hover:-translate-y-px",
                      tone,
                      // Added by changes: nothing of the original plays there.
                      isAddedPart(slot) && "border-dashed",
                      rendering && "border-[#FFE229]/40 text-[#FFE229]",
                    )}
                    key={slot.shot}
                    onClick={() => {
                      onOpen(slot);
                      onSeek(slot.start);
                    }}
                    style={span(slot.start, slot.end)}
                    title={`${slot.start.toFixed(1)}s–${slot.end.toFixed(1)}s · take ${slot.take}${isAddedPart(slot) ? " · new" : ""}${rendering ? " · rendering" : ""}${versions > 1 ? ` · ${versions} versions to pick from` : ""}${off ? ` · off from the original: ${off}` : ""} · click to fix this clip`}
                    type="button"
                  >
                    {rendering ? (
                      <span className="absolute inset-0 animate-pulse bg-[#FFE229]/[0.07]" />
                    ) : null}
                    <span
                      className={cn(
                        "absolute inset-y-1.5 left-1 w-0.5 rounded-full",
                        bar,
                      )}
                    />
                    {rendering ? (
                      <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
                    ) : null}
                    {/* The label keeps its room; on a narrow clip the version count is what's clipped. */}
                    <span className="max-w-full shrink-0 truncate">
                      {firstShot.get(slot.take) === slot.shot
                        ? `Take ${slot.take}`
                        : slot.take}
                    </span>
                    {versions > 1 ? (
                      <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-1 font-mono text-[#77777E] text-[10px] tabular-nums">
                        <LayersIcon className="size-2.5" />
                        {versions}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className={lane}>
              {texts.length === 0 ? (
                <span className={empty}>No on-screen text</span>
              ) : null}
              {texts.map((take) => {
                // The stitched edit's text plays across the whole take (videoCloneTextOverlays).
                const own = slots.filter((slot) => slot.take === take.index);
                if (own.length === 0) return null;
                const start = Math.min(...own.map((slot) => slot.start));
                const end = Math.max(...own.map((slot) => slot.end));
                return (
                  <button
                    className="absolute inset-y-1 min-w-6 truncate rounded-md bg-[#F4F4F5] px-2 text-left font-medium text-[#09090A] text-[11px] shadow-sm transition duration-200 hover:-translate-y-px hover:bg-white"
                    key={take.index}
                    onClick={() => onSeek(start)}
                    style={span(start, end)}
                    title={take.analysis.onScreenText}
                    type="button"
                  >
                    {take.analysis.onScreenText}
                  </button>
                );
              })}
            </div>

            <div className={lane}>
              {plan.takes.some(
                (take) =>
                  take.products?.length || take.analysis.needsProductReference,
              ) ? null : (
                <span className={empty}>Hover a shot to pin an image</span>
              )}
              {slots.map((slot) => {
                const take = takeOf.get(slot.take);
                if (!take) return null;
                const pinned = take.products ?? [];
                const first = firstShot.get(slot.take) === slot.shot;
                let chip = (
                  <span className="grid h-6 w-full place-items-center rounded-md border border-[#3A3A40] border-dashed text-[#77777E] opacity-0 transition-opacity duration-200 group-hover/media:opacity-100">
                    <PlusIcon className="size-3" />
                  </span>
                );
                if (first && take.analysis.needsProductReference) {
                  chip = (
                    <span className="flex h-6 max-w-full items-center truncate rounded-md border border-orange-300/30 border-dashed px-1.5 text-[11px] text-orange-200/70">
                      product
                    </span>
                  );
                }
                if (first && pinned.length > 0) {
                  chip = (
                    <span className="flex h-6 max-w-full items-center gap-1 overflow-hidden rounded-md border border-orange-300/30 bg-orange-300/10 pr-1.5 pl-0.5 text-[11px] text-orange-200">
                      <span className="flex -space-x-1.5">
                        {pinned.slice(0, 3).map((id) => {
                          const product = productById.get(id);
                          return product ? (
                            <Image
                              alt=""
                              className="size-5 rounded object-cover ring-1 ring-[#0D0D0F]"
                              height={20}
                              key={id}
                              src={product.url}
                              width={20}
                            />
                          ) : null;
                        })}
                      </span>
                      {pinned.length}
                    </span>
                  );
                }
                return (
                  <ProductPicker
                    disabled={update.isPending}
                    key={slot.shot}
                    onChange={(ids) =>
                      update.mutate({
                        templateId: plan.id,
                        takeIndex: take.index,
                        products: ids,
                      })
                    }
                    options={products}
                    selected={pinned}
                  >
                    <button
                      aria-label={`Pin an image on take ${take.index}`}
                      className="group/media absolute inset-y-0 flex items-center px-0.5"
                      style={span(slot.start, slot.end)}
                      title={`Take ${take.index}: pin a product photo`}
                      type="button"
                    >
                      {chip}
                    </button>
                  </ProductPicker>
                );
              })}
            </div>

            <div className={lane}>
              {plan.vibe.transcript.length === 0 ? (
                <span className={empty}>No one speaks</span>
              ) : null}
              {plan.vibe.transcript.map((line) => {
                // The original's lines, where its footage plays in the story now.
                const start = videoCloneStoryTime(
                  slots,
                  undefined,
                  line.start,
                  "story",
                );
                const end = videoCloneStoryTime(
                  slots,
                  undefined,
                  line.end,
                  "story",
                );
                return (
                  <button
                    className="absolute inset-y-1 min-w-6 truncate rounded-md border border-sky-400/20 bg-sky-400/[0.08] px-2 text-left text-[11px] text-sky-200 transition duration-200 hover:-translate-y-px hover:bg-sky-400/15"
                    key={`${line.start}-${line.speaker}`}
                    onClick={() => onSeek(start)}
                    style={span(start, end)}
                    title={`${line.speaker}: ${line.text}`}
                    type="button"
                  >
                    “{line.text}”
                  </button>
                );
              })}
            </div>

            <div
              className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-[#FFE229] shadow-[0_0_8px_rgba(255,226,41,0.55)] before:absolute before:-top-1 before:-left-[3px] before:size-[7px] before:rounded-full before:bg-[#FFE229]"
              ref={playheadRef}
              style={{ left: 0 }}
            />
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-0 w-px bg-white/15 opacity-0 transition-opacity duration-150"
              ref={hoverRef}
            >
              <span className="absolute top-0 -translate-x-1/2 rounded bg-[#1C1C1F] px-1 py-px font-mono text-[#C9C9CE] text-[10px] tabular-nums leading-none" />
            </div>
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 pl-[68px] text-[#626269] text-[11px]">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-[#FFE229]" />
          rendered
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 animate-pulse rounded-full bg-[#FFE229]/60" />
          rendering
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-[#3A3A40]" />
          not yet
        </span>
        <span className="flex items-center gap-1.5">
          <LayersIcon className="size-2.5" />
          versions to pick from
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          Drag the ruler to scrub · Ctrl/⌘ + scroll to zoom
          <button
            aria-label="Zoom out"
            className="grid size-6 place-items-center rounded-full text-[#77777E] transition-colors hover:bg-white/[0.06] hover:text-[#F4F4F5] disabled:opacity-30"
            disabled={zoom <= 1}
            onClick={() => zoomBy(1 / 1.5)}
            type="button"
          >
            <ZoomOutIcon className="size-3.5" />
          </button>
          <input
            aria-label="Zoom"
            className="w-24 accent-[#FFE229]"
            max={Math.log(maxZoom)}
            min={0}
            onChange={(event) =>
              zoomBy(Math.exp(Number(event.target.value)) / zoom)
            }
            step={0.01}
            type="range"
            value={Math.log(zoom)}
          />
          <button
            aria-label="Zoom in"
            className="grid size-6 place-items-center rounded-full text-[#77777E] transition-colors hover:bg-white/[0.06] hover:text-[#F4F4F5] disabled:opacity-30"
            disabled={zoom >= maxZoom}
            onClick={() => zoomBy(1.5)}
            type="button"
          >
            <ZoomInIcon className="size-3.5" />
          </button>
        </span>
      </div>
    </div>
  );
}

/** A clip clicked on the timeline: its take's prompt to fix, frames of the video to match, and a re-render. */
function ClipDialog({
  busy,
  clip,
  onClose,
  onRender,
  plan,
  provider,
  segments,
}: {
  busy: boolean;
  clip: Slot;
  onClose: () => void;
  /** Renders the take, or only its shot, matching the picked frames (/storage URLs). */
  onRender: (
    takeIndexes: number[],
    shot: number | undefined,
    frames: string[],
  ) => void;
  plan: Plan;
  provider: VideoProvider;
  /** The edit as it plays now (videoCloneEditClips). */
  segments: VideoCloneEditClip[];
}) {
  const utils = trpc.useUtils();
  const update = trpc.videoClone.updateTake.useMutation({
    onSuccess: () => utils.videoClone.get.invalidate({ id: plan.id }),
    onError: (error) => toast.error(error.message),
  });
  const take = plan.takes.find((item) => item.index === clip.take);
  const [prompt, setPrompt] = React.useState(take?.analysis.prompt ?? "");
  const [frames, setFrames] = React.useState<string[]>([]);
  const [grabbing, setGrabbing] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const pick = trpc.videoClone.pickRender.useMutation({
    onSuccess: async ({ picked }) => {
      await utils.videoClone.get.invalidate({ id: plan.id });
      if (picked) toast.success("Re-stitching the clone with it.");
    },
    onError: (error) => toast.error(error.message),
  });
  /** A version playing in the dialog's player instead of the stitched clone. */
  const [preview, setPreview] = React.useState<{
    key: string;
    label: string;
    src?: string;
    at: number;
  } | null>(null);
  if (!take) return null;

  const position = take.parts.findIndex((part) => part.shot === clip.shot);
  const part = take.parts[position];
  const kept = keepsOriginal(take);
  const off = kept || !part ? undefined : videoCloneMismatch(take, part);
  const redoable =
    !kept && take.generation?.status === "done" && take.parts.length > 1;
  const blocked = busy || kept || isRendering(take) || update.isPending;
  const sentPrompt = (part?.generation ?? take.generation)?.prompt;
  // Frames come from the file this clip plays now (else the original), opened on the clip.
  const live = segments.find((segment) => segment.part.shot === clip.shot);
  const source = live?.src ?? (plan.sourceVideoUrl || undefined);
  const at = live
    ? (live.start + live.end) / 2
    : (clip.srcStart + clip.srcEnd) / 2;
  const takeRender =
    take.generation?.status === "done" ? take.generation.videoUrl : undefined;
  // What this clip plays in the edit: its own render, else the take render picked for it, else the take's.
  const inEdit =
    part?.generation?.status === "done"
      ? part.generation.videoUrl
      : (part?.takeRender ?? takeRender);
  // Another take render, or a pick on any of its shots: "Whole take" sets the take back to one render.
  const takePicked = take.parts.some(
    (item) => item.takeRender || item.generation?.status === "done",
  );
  const made = (render: { model?: VideoCloneModel; startedAt: string }) =>
    `${VIDEO_CLONE_MODELS[render.model ?? DEFAULT_VIDEO_CLONE_MODEL].label} · ${new Date(render.startedAt).toLocaleString()}`;
  // This clip's versions: its piece of each take render, then each render of it alone.
  const versions =
    kept || !part
      ? []
      : [
          ...videoCloneRenders(take).map((render, k) => ({
            label: `Take v${k + 1}`,
            note: made(render),
            url: render.videoUrl,
            at: part.takeStart,
            fromTake: true,
          })),
          ...videoCloneRenders(part).map((render, k) => ({
            label: `Redo ${k + 1}`,
            note: made(render),
            url: render.videoUrl,
            at: 0,
            fromTake: false,
          })),
        ];
  const playing = preview?.src ?? source;

  const savePrompt = async () => {
    const next = prompt.trim();
    if (next && next !== take.analysis.prompt) {
      await update.mutateAsync({
        templateId: plan.id,
        takeIndex: take.index,
        prompt: next,
      });
    }
  };
  /** The paused frame, uploaded as a still the render must match. */
  const grab = async () => {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    video.pause();
    setGrabbing(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      const { promise, resolve } = Promise.withResolvers<Blob | null>();
      canvas.toBlob(resolve, "image/jpeg", 0.92);
      const blob = await promise;
      if (!blob) throw new Error("Couldn't read the frame.");
      const { storageKey } = await uploadImageFile(
        new File([blob], "frame.jpg", { type: "image/jpeg" }),
      );
      setFrames((current) => [
        ...current,
        `/storage/${storageConfig.bucketNames.images}/${storageKey}`,
      ]);
    } catch (error) {
      toast.error(getErrorMessage(error) || "Couldn't attach the frame.");
    } finally {
      setGrabbing(false);
    }
  };
  const go = async (shot?: number) => {
    try {
      await savePrompt();
    } catch {
      return;
    }
    onRender([take.index], shot, frames);
    onClose();
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-4xl gap-0 overflow-y-auto border-[#232327] bg-[#0D0D0F] p-0 text-[#F4F4F5]">
        <DialogHeader className="border-[#1C1C1F] border-b px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base">
            Take {take.index} · shot {position + 1}
            <RenderStatus
              generation={part?.generation ?? take.generation}
              kept={kept}
            />
          </DialogTitle>
          <DialogDescription className="line-clamp-2 text-[#77777E] text-xs">
            {clock(clip.start)}–{clock(clip.end)} · {take.analysis.description}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 p-5 sm:grid-cols-[220px_minmax(0,1fr)]">
          <section className="space-y-2.5">
            <div className="flex items-baseline justify-between">
              <h3 className={LABEL}>Frames to match</h3>
              {playing ? (
                <span className="text-[#626269] text-[11px]">
                  {preview?.label ?? (live?.src ? "Clone" : "Original")}
                </span>
              ) : null}
            </div>
            {playing ? (
              <>
                {/* biome-ignore lint/a11y/useMediaCaption: frame picker; the script is on the page */}
                <video
                  className="aspect-[9/16] w-full rounded-xl bg-black object-contain"
                  controls
                  crossOrigin="anonymous"
                  // A new player per version, so it seeks even when two share a file.
                  key={preview?.key ?? "clone"}
                  onLoadedMetadata={(event) => {
                    event.currentTarget.currentTime = preview ? preview.at : at;
                    // Picked to compare: it plays right away, with its sound.
                    if (preview) {
                      void event.currentTarget.play().catch(() => undefined);
                    }
                  }}
                  playsInline
                  preload="auto"
                  ref={videoRef}
                  src={playing}
                />
                <button
                  className="flex h-8 w-full items-center justify-center gap-1.5 rounded-full border border-[#2E2E33] text-[#D4D4D8] text-xs transition-colors hover:border-[#3A3A40] hover:text-[#F4F4F5] disabled:pointer-events-none disabled:opacity-40"
                  disabled={grabbing || frames.length >= MAX_PICKED_FRAMES}
                  onClick={() => void grab()}
                  type="button"
                >
                  {grabbing ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                  ) : (
                    <CameraIcon className="size-3.5" />
                  )}
                  Attach this frame
                </button>
              </>
            ) : (
              <p className="rounded-xl border border-[#232327] border-dashed p-3 text-[#77777E] text-xs">
                Render a take first; then pick frames of the video here.
              </p>
            )}
            {frames.length > 0 ? (
              <div className="flex gap-2">
                {frames.map((url) => (
                  <span className="relative" key={url}>
                    <Image
                      alt="Picked frame"
                      className="h-24 w-[54px] rounded-lg object-cover ring-1 ring-[#FFE229]/60"
                      height={96}
                      src={url}
                      width={54}
                    />
                    <button
                      aria-label="Remove this frame"
                      className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-[#18181B] text-[#A8A8AE] ring-1 ring-[#3A3A40] transition-colors hover:text-[#F4F4F5]"
                      onClick={() =>
                        setFrames((current) =>
                          current.filter((other) => other !== url),
                        )
                      }
                      type="button"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <p className="text-[#626269] text-xs leading-snug">
              Pause where the people and the place look right, then attach it;
              the render matches up to {MAX_PICKED_FRAMES} frames.
            </p>
          </section>

          <section className="flex min-w-0 flex-col gap-2.5">
            <div className="flex items-baseline justify-between">
              <h3 className={LABEL}>Prompt</h3>
              <span className="text-[#626269] text-[11px]">
                {update.isPending ? "Saving…" : "Saves when you leave it"}
              </span>
            </div>
            <textarea
              aria-label={`Take ${take.index}'s prompt`}
              className="min-h-80 flex-1 resize-y rounded-xl border border-[#232327] bg-[#0B0B0C] p-3 font-mono text-[#D4D4D8] text-xs leading-relaxed outline-none transition-colors focus:border-[#3A3A40]"
              onBlur={() => void savePrompt().catch(() => undefined)}
              onChange={(event) => setPrompt(event.target.value)}
              value={prompt}
            />
            {sentPrompt && sentPrompt !== take.analysis.prompt ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-[#77777E] transition-colors hover:text-[#D4D4D8]">
                  As sent to the model on the last render
                </summary>
                <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[#0B0B0C] p-3 font-mono text-[#A8A8AE]">
                  {sentPrompt}
                </p>
              </details>
            ) : null}
            {(part?.generation ?? take.generation)?.status === "failed" ? (
              <p className="rounded-xl border border-[#3A1D22] bg-[#140B0D] px-3 py-2 text-rose-300 text-xs">
                {(part?.generation ?? take.generation)?.error}
              </p>
            ) : null}
            {off ? (
              <p className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-amber-200 text-xs">
                Off from the original: {off} Fix the prompt, then render it
                again.
              </p>
            ) : null}
          </section>
        </div>

        {versions.length > 1 ? (
          <section className="space-y-2 border-[#1C1C1F] border-t px-5 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <h3 className={LABEL}>Versions of this clip</h3>
              <span className="text-[#626269] text-[11px]">
                Click one to play it above; Use puts it in this clip.
              </span>
            </div>
            <ol className="flex gap-2 overflow-x-auto pb-1">
              {versions.map((option) => {
                const previewing = preview?.key === option.url;
                const used = option.url === inEdit;
                return (
                  <li className="w-20 shrink-0 space-y-1.5" key={option.url}>
                    <button
                      aria-label={`Play ${option.label}`}
                      className={cn(
                        "relative block h-[142px] w-20 overflow-hidden rounded-lg bg-[#111113] ring-1 ring-[#232327] transition duration-200 hover:ring-[#3A3A40]",
                        used && "ring-[#FFE229]/60",
                        previewing && "ring-2 ring-[#F4F4F5]",
                      )}
                      onClick={() =>
                        setPreview(
                          previewing
                            ? null
                            : {
                                key: option.url,
                                label: `Shot ${position + 1} · ${option.label}`,
                                src: option.url,
                                at: option.at,
                              },
                        )
                      }
                      title={option.note}
                      type="button"
                    >
                      <video
                        className="pointer-events-none size-full object-cover"
                        muted
                        playsInline
                        preload="metadata"
                        src={`${option.url}#t=${(option.at + 0.1).toFixed(2)}`}
                      />
                    </button>
                    <div className="font-mono text-[#77777E] text-[10px]">
                      {option.label}
                    </div>
                    <button
                      className={cn(
                        "flex h-7 w-full items-center justify-center gap-1 rounded-full border border-[#2E2E33] text-[#A8A8AE] text-[11px] transition-colors hover:border-[#3A3A40] hover:text-[#F4F4F5] disabled:pointer-events-none",
                        used
                          ? "border-[#FFE229]/40 text-[#FFE229]"
                          : "disabled:opacity-40",
                      )}
                      disabled={used || pick.isPending || isRendering(take)}
                      onClick={() =>
                        pick.mutate({
                          templateId: plan.id,
                          takeIndex: take.index,
                          shot: clip.shot,
                          videoUrl: option.url,
                        })
                      }
                      type="button"
                    >
                      {used ? (
                        <>
                          <CheckIcon className="size-3" />
                          In clone
                        </>
                      ) : (
                        "Use"
                      )}
                    </button>
                    {option.fromTake &&
                    (option.url !== takeRender || takePicked) ? (
                      <button
                        className="w-full text-[#77777E] text-[10px] transition-colors hover:text-[#F4F4F5] disabled:opacity-40"
                        disabled={pick.isPending || isRendering(take)}
                        onClick={() =>
                          pick.mutate({
                            templateId: plan.id,
                            takeIndex: take.index,
                            videoUrl: option.url,
                          })
                        }
                        title={`Every shot of take ${take.index} plays ${option.label}; the shots' own picks reset.`}
                        type="button"
                      >
                        Whole take
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2 border-[#1C1C1F] border-t px-5 py-3">
          {kept ? (
            <span className="mr-auto text-[#77777E] text-xs">
              Keeps the original footage; pick a model in the take's ⋯ menu to
              render it.
            </span>
          ) : null}
          {redoable && part ? (
            <button
              className="flex h-9 items-center gap-1.5 rounded-full border border-[#2E2E33] px-4 text-[#D4D4D8] text-xs transition-colors hover:border-[#3A3A40] hover:text-[#F4F4F5] disabled:pointer-events-none disabled:opacity-40"
              disabled={blocked}
              onClick={() => void go(clip.shot)}
              title="Redoes just this shot; it matches the rest of the take."
              type="button"
            >
              <SparklesIcon className="size-3.5" />
              Redo this shot ·{" "}
              {renderCost(
                [{ seconds: part.takeEnd - part.takeStart, model: take.model }],
                provider,
              )}
            </button>
          ) : null}
          <Button
            className="h-9 rounded-full bg-[#FFE229] px-4 font-medium text-[#09090B] text-xs hover:bg-[#FFE229]/90 disabled:opacity-40 dark:bg-[#FFE229] dark:text-[#09090B] dark:hover:bg-[#FFE229]/90"
            disabled={blocked}
            onClick={() => void go()}
            type="button"
          >
            <SparklesIcon />
            {RENDER_LABEL[take.generation?.status ?? "new"]} take {take.index} ·{" "}
            {renderCost([take], provider)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A take changes added, before its render: nothing to show yet. */
function NewTakeArt() {
  return (
    <div className="grid size-full place-items-center bg-[repeating-linear-gradient(135deg,#111113_0_8px,#151518_8px_16px)] text-[#FFE229]/70">
      <SparklesIcon className="size-4" />
    </div>
  );
}

function RenderStatus({
  generation,
  kept,
}: {
  generation: Take["generation"];
  kept: boolean;
}) {
  if (kept) {
    return (
      <span className="text-[#A8A8AE] text-[11px]">Keeps the original</span>
    );
  }
  if (generation?.status === "generating") {
    return (
      <span className="inline-flex items-center gap-1 text-[#FFE229] text-[11px]">
        <LoaderCircleIcon className="size-3 animate-spin" />
        Rendering
      </span>
    );
  }
  if (generation?.status === "failed") {
    return <span className="text-[11px] text-rose-300">Render failed</span>;
  }
  if (generation?.status === "done") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
        <CheckIcon className="size-3" />
        Rendered
      </span>
    );
  }
  return <span className="text-[#626269] text-[11px]">Not rendered</span>;
}

/** About the original: the vibe Gemini read off it. */
function VibeInfo({ vibe }: { vibe: Plan["vibe"] }) {
  const rows = [
    ["Hook", vibe.hook],
    ["Look", vibe.visualStyle],
    ["Setting", vibe.setting],
    ["Pacing", vibe.pacing],
    ["Audio", vibe.audio],
    ["On-screen text", vibe.onScreenText],
    ["Product", vibe.product.description],
  ].filter(([, text]) => text?.trim());
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="About the original"
          className="grid size-8 shrink-0 place-items-center rounded-full text-[#626269] transition-colors hover:bg-white/[0.04] hover:text-[#F4F4F5] data-[state=open]:bg-white/[0.04] data-[state=open]:text-[#F4F4F5]"
          type="button"
        >
          <InfoIcon className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 space-y-3 border-[#232327] bg-[#0D0D0F] p-4"
      >
        {rows.map(([label, text]) => (
          <div className="space-y-0.5" key={label}>
            <p className={LABEL}>{label}</p>
            <p className="text-[#C9C9CE] text-sm leading-snug">{text}</p>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function TakeRow({
  busy,
  onRender,
  onRenderShot,
  onToggle,
  open,
  products,
  take,
  templateId,
}: {
  busy: boolean;
  onRender: () => void;
  /** Redoes one part of this take alone, by its shot. */
  onRenderShot: (shot: number) => void;
  onToggle: () => void;
  open: boolean;
  products: ProductOption[] | undefined;
  take: Take;
  templateId: string;
}) {
  const utils = trpc.useUtils();
  const provider =
    trpc.videoClone.provider.useQuery().data?.provider ??
    DEFAULT_VIDEO_PROVIDER;
  const update = trpc.videoClone.updateTake.useMutation({
    onSuccess: () => utils.videoClone.get.invalidate({ id: templateId }),
    onError: (error) => toast.error(error.message),
  });
  // Drafts are null until edited, so a saved change from the server shows through.
  const [lines, setLines] = React.useState<string[] | null>(null);
  // The drafts a save sent, and whether a line was left while it ran (saved right after).
  const sent = React.useRef<string[] | null>(null);
  const [queued, setQueued] = React.useState(false);
  const revise = trpc.videoClone.reviseTake.useMutation({
    onSuccess: async () => {
      await utils.videoClone.get.invalidate({ id: templateId });
      // Lines typed meanwhile stay, minus the ones the save cut.
      setLines((current) =>
        !current || current === sent.current
          ? null
          : current.filter((_, i) => sent.current?.[i]?.trim() !== ""),
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const removeTake = trpc.videoClone.removeTake.useMutation({
    onSuccess: async () => {
      await utils.videoClone.get.invalidate({ id: templateId });
      toast.success(`Take ${take.index} removed.`);
    },
    onError: (error) => toast.error(error.message),
  });

  const { analysis, generation } = take;
  const kept = keepsOriginal(take);
  const takeRender =
    !kept && generation?.status === "done" ? generation.videoUrl : undefined;
  // The menu's one choice: a model, or the original footage.
  const choice = kept ? "original" : (take.model ?? DEFAULT_VIDEO_CLONE_MODEL);
  const pinned = take.products ?? [];
  const productById = new Map(
    (products ?? []).map((product) => [product.id, product]),
  );
  /** Saves the edited lines once one is left; a cleared line is cut. */
  const saveLines = () => {
    if (!lines?.some((text, i) => text.trim() !== analysis.dialogue[i]?.text)) {
      return;
    }
    if (revise.isPending) {
      setQueued(true);
      return;
    }
    sent.current = lines;
    revise.mutate({
      templateId,
      takeIndex: take.index,
      dialogue: analysis.dialogue.flatMap((line, i) => {
        const text = (lines[i] ?? line.text).trim();
        return text ? [{ ...line, text }] : [];
      }),
    });
  };
  React.useEffect(() => {
    if (queued && !revise.isPending) {
      setQueued(false);
      saveLines();
    }
  });

  return (
    <li
      className={cn(
        "scroll-mt-6 transition-colors duration-300",
        open && "bg-white/[0.015]",
      )}
      id={`video-clone-take-${take.index}`}
    >
      <div className="flex gap-4 px-5 py-4">
        <button
          aria-expanded={open}
          aria-label={`${open ? "Close" : "Open"} take ${take.index}`}
          className={cn(
            "relative h-[78px] w-11 shrink-0 overflow-hidden rounded-lg bg-[#111113] ring-1 ring-[#232327] transition duration-200 hover:ring-[#3A3A40] active:scale-95",
            open && "ring-[#FFE229]/70 hover:ring-[#FFE229]",
          )}
          onClick={onToggle}
          type="button"
        >
          {(!kept && generation?.status === "done" && generation.videoUrl) ||
          take.videoUrl ? (
            <video
              className="size-full object-cover"
              muted
              playsInline
              preload="metadata"
              src={`${!kept && generation?.status === "done" && generation.videoUrl ? generation.videoUrl : take.videoUrl}#t=0.1`}
            />
          ) : (
            <NewTakeArt />
          )}
        </button>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-start gap-3">
            <button
              className="min-w-0 flex-1 text-left"
              onClick={onToggle}
              type="button"
            >
              <span className="flex items-center gap-2">
                <span className="font-medium text-[#F4F4F5] text-sm">
                  Take {take.index}
                  {take.videoUrl ? null : (
                    <span className="ml-1.5 rounded-full bg-[#FFE229]/10 px-1.5 py-px font-normal text-[#FFE229] text-[10px] ring-1 ring-[#FFE229]/25">
                      New
                    </span>
                  )}
                </span>
                <RenderStatus generation={generation} kept={kept} />
              </span>
              <span className="mt-0.5 line-clamp-2 block text-[#77777E] text-[13px] leading-snug">
                {analysis.description}
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-1">
              {revise.isPending ? (
                <span className="inline-flex items-center gap-1 text-[#77777E] text-[11px]">
                  <LoaderCircleIcon className="size-3 animate-spin" />
                  Saving
                </span>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label={`More for take ${take.index}`}
                    className="grid size-8 place-items-center rounded-full text-[#77777E] transition-colors hover:bg-white/[0.06] hover:text-[#F4F4F5] data-[state=open]:bg-white/[0.06] data-[state=open]:text-[#F4F4F5]"
                    type="button"
                  >
                    <EllipsisIcon className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-64 border-[#232327] bg-[#0D0D0F]"
                >
                  {kept ? null : (
                    <>
                      <DropdownMenuItem
                        disabled={busy || generation?.status === "generating"}
                        onSelect={onRender}
                      >
                        <SparklesIcon />
                        {RENDER_LABEL[generation?.status ?? "new"]} this take
                        <DropdownMenuShortcut>
                          {renderCost([take], provider)}
                        </DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuLabel className="font-mono font-normal text-[#77777E] text-[10px] uppercase tracking-[0.14em]">
                    Made with
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    onValueChange={(value) => {
                      if (value === "original") {
                        update.mutate({
                          templateId,
                          takeIndex: take.index,
                          keepOriginal: true,
                        });
                        return;
                      }
                      const model = VIDEO_CLONE_MODEL_IDS.find(
                        (id) => id === value,
                      );
                      if (model) {
                        update.mutate({
                          templateId,
                          takeIndex: take.index,
                          model,
                          keepOriginal: false,
                        });
                      }
                    }}
                    value={choice}
                  >
                    {[
                      ...VIDEO_CLONE_MODEL_IDS.map((id) => ({
                        value: id,
                        label: VIDEO_CLONE_MODELS[id].label,
                        note: `$${VIDEO_CLONE_MODELS[id].usdPerSecond[provider]}/s`,
                      })),
                      // A take changes added has no original footage to keep.
                      ...(take.videoUrl
                        ? [
                            {
                              value: "original",
                              label: "Keep original",
                              note: "free",
                            },
                          ]
                        : []),
                    ].map((option) => (
                      <DropdownMenuRadioItem
                        disabled={
                          update.isPending ||
                          generation?.status === "generating"
                        }
                        key={option.value}
                        value={option.value}
                      >
                        <CheckIcon
                          className={cn(
                            "absolute left-2.5 size-3.5 text-[#FFE229] transition-opacity",
                            option.value === choice
                              ? "opacity-100"
                              : "opacity-0",
                          )}
                        />
                        {option.label}
                        <DropdownMenuShortcut>
                          {option.note}
                        </DropdownMenuShortcut>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  {take.videoUrl ? null : (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-rose-300 focus:text-rose-200"
                        disabled={removeTake.isPending}
                        onSelect={() =>
                          NiceModal.show(ConfirmationModal, {
                            title: `Remove take ${take.index}?`,
                            message:
                              "Its script and any render go away; the rest of the video stays.",
                            confirmLabel: "Remove take",
                            destructive: true,
                            onConfirm: async () => {
                              await removeTake.mutateAsync({
                                templateId,
                                takeIndex: take.index,
                              });
                            },
                          })
                        }
                      >
                        <Trash2Icon />
                        Remove take
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                aria-label={`${open ? "Close" : "Open"} take ${take.index}`}
                className="grid size-8 place-items-center rounded-full text-[#626269] transition-colors hover:bg-white/[0.04] hover:text-[#F4F4F5]"
                onClick={onToggle}
                type="button"
              >
                <ChevronDownIcon
                  className={cn(
                    "size-4 transition-transform duration-300",
                    open && "rotate-180",
                  )}
                />
              </button>
            </div>
          </div>

          {analysis.dialogue.length === 0 ? (
            <p className="px-2 text-[#626269] text-sm">
              No one speaks in this take.
            </p>
          ) : (
            <ol className="-mx-2 space-y-0.5">
              {analysis.dialogue.map((line, i) => {
                const value = lines?.[i] ?? line.text;
                return (
                  <li
                    className="grid gap-x-2 sm:grid-cols-[88px_minmax(0,1fr)]"
                    key={i}
                  >
                    <span
                      className="truncate px-2 pt-1.5 font-mono text-[#626269] text-[10px] uppercase tracking-[0.1em] sm:px-0 sm:text-right"
                      title={line.speaker}
                    >
                      {line.speaker === analysis.dialogue[i - 1]?.speaker
                        ? ""
                        : line.speaker}
                    </span>
                    <textarea
                      aria-label={`Line ${i + 1}, ${line.speaker}`}
                      className={cn(
                        "field-sizing-content block w-full resize-none rounded-lg border border-transparent bg-transparent px-2 py-1 text-[#E4E4E7] text-[15px] leading-relaxed outline-none transition-colors placeholder:text-[#4A4A50] hover:bg-white/[0.03] focus:border-[#2E2E33] focus:bg-[#0B0B0C]",
                        value.trim() !== line.text &&
                          "bg-[#FFE229]/[0.05] hover:bg-[#FFE229]/[0.07]",
                      )}
                      onChange={(event) =>
                        setLines(
                          analysis.dialogue.map((other, k) =>
                            k === i
                              ? event.target.value
                              : (lines?.[k] ?? other.text),
                          ),
                        )
                      }
                      onBlur={saveLines}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          setLines(
                            lines?.map((text, k) =>
                              k === i ? line.text : text,
                            ) ?? null,
                          );
                        }
                      }}
                      placeholder="Cleared lines are cut"
                      rows={1}
                      value={value}
                    />
                  </li>
                );
              })}
            </ol>
          )}

          <div
            className={cn(
              "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
              open
                ? "grid-rows-[1fr] opacity-100"
                : "grid-rows-[0fr] opacity-0",
            )}
            inert={!open}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="space-y-5 px-px pt-3 pb-1">
                {generation?.status === "failed" ? (
                  <p className="rounded-xl border border-[#3A1D22] bg-[#140B0D] px-3 py-2 text-rose-300 text-xs">
                    {generation.error}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-start gap-5">
                  <div className="flex gap-2">
                    <figure className="space-y-1.5">
                      {take.videoUrl ? (
                        // biome-ignore lint/a11y/useMediaCaption: reference clip; its script is listed above
                        <video
                          className="h-60 w-[135px] rounded-xl bg-black object-cover"
                          controls
                          preload="metadata"
                          src={take.videoUrl}
                        />
                      ) : (
                        <div className="grid h-60 w-[135px] place-items-center rounded-xl border border-[#232327] border-dashed px-3 text-center text-[#77777E] text-[11px]">
                          Added by your changes; the original has no such shot
                        </div>
                      )}
                      <figcaption className={LABEL}>Original</figcaption>
                    </figure>
                    <figure className="space-y-1.5">
                      {!kept &&
                      generation?.status === "done" &&
                      generation.videoUrl ? (
                        // biome-ignore lint/a11y/useMediaCaption: generated take; its prompt is listed below
                        <video
                          className="h-60 w-[135px] rounded-xl bg-black object-cover ring-1 ring-[#FFE229]/60"
                          controls
                          preload="metadata"
                          src={generation.videoUrl}
                        />
                      ) : (
                        <div className="grid h-60 w-[135px] place-items-center rounded-xl border border-[#232327] border-dashed px-3 text-center text-[#77777E] text-[11px]">
                          {kept ? "Keeps the original footage" : null}
                          {!kept && generation?.status === "generating" ? (
                            <span>
                              <LoaderCircleIcon className="mx-auto mb-1.5 size-4 animate-spin text-[#FFE229]" />
                              Rendering, a few minutes
                            </span>
                          ) : null}
                          {!kept && generation?.status === "failed" ? (
                            <span className="text-rose-300">Render failed</span>
                          ) : null}
                          {kept || generation ? null : "Not rendered yet"}
                        </div>
                      )}
                      <figcaption className={LABEL}>Clone</figcaption>
                    </figure>
                  </div>

                  <div className="min-w-0 flex-1 basis-64 space-y-5">
                    {take.parts.length > 1 ? (
                      <section className="space-y-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <h3 className={LABEL}>Shots</h3>
                          <span className="text-[#626269] text-[11px]">
                            {takeRender
                              ? "One shot off? Redo just that one; it matches the rest of the take."
                              : "Render the take first; then any shot can be redone alone."}
                          </span>
                        </div>
                        <ol className="flex gap-2 overflow-x-auto pb-1">
                          {take.parts.map((part, k) => {
                            const own = part.generation;
                            const middle = (
                              (part.takeStart + part.takeEnd) /
                              2
                            ).toFixed(2);
                            let preview = take.videoUrl
                              ? `${take.videoUrl}#t=${middle}`
                              : undefined;
                            if (own?.status === "done" && own.videoUrl) {
                              preview = `${own.videoUrl}#t=0.1`;
                            } else if (part.takeRender ?? takeRender) {
                              preview = `${part.takeRender ?? takeRender}#t=${middle}`;
                            }
                            const badge =
                              "absolute top-1 left-1 inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] backdrop-blur-sm";
                            return (
                              <li
                                className="w-20 shrink-0 space-y-1.5"
                                key={part.shot}
                              >
                                <div className="relative h-[142px] w-20 overflow-hidden rounded-lg bg-[#111113] ring-1 ring-[#232327]">
                                  {preview ? (
                                    <video
                                      className="size-full object-cover"
                                      muted
                                      playsInline
                                      preload="metadata"
                                      src={preview}
                                    />
                                  ) : (
                                    <NewTakeArt />
                                  )}
                                  {own?.status === "generating" ? (
                                    <span
                                      className={cn(badge, "text-[#FFE229]")}
                                    >
                                      <LoaderCircleIcon className="size-3 animate-spin" />
                                      Rendering
                                    </span>
                                  ) : null}
                                  {own?.status === "failed" ? (
                                    <span
                                      className={cn(badge, "text-rose-300")}
                                      title={own.error}
                                    >
                                      Failed
                                    </span>
                                  ) : null}
                                  {own?.status === "done" ? (
                                    <span
                                      className={cn(badge, "text-[#F4F4F5]")}
                                    >
                                      <span className="size-1.5 rounded-full bg-[#FFE229]" />
                                      Redone
                                    </span>
                                  ) : null}
                                </div>
                                <div className="flex justify-between font-mono text-[#77777E] text-[10px] tabular-nums">
                                  <span>Shot {k + 1}</span>
                                  <span>
                                    {(part.takeEnd - part.takeStart).toFixed(1)}
                                    s
                                  </span>
                                </div>
                                <button
                                  className="flex h-7 w-full items-center justify-center gap-1 rounded-full border border-[#2E2E33] text-[#A8A8AE] text-[11px] transition-colors hover:border-[#3A3A40] hover:text-[#F4F4F5] disabled:pointer-events-none disabled:opacity-40"
                                  disabled={
                                    busy || !takeRender || isRendering(take)
                                  }
                                  onClick={() => onRenderShot(part.shot)}
                                  title={
                                    own?.status === "failed"
                                      ? own.error
                                      : `Redo shot ${k + 1} alone, billed its own seconds (4s minimum).`
                                  }
                                  type="button"
                                >
                                  <SparklesIcon className="size-3" />
                                  {renderCost(
                                    [
                                      {
                                        seconds: part.takeEnd - part.takeStart,
                                        model: take.model,
                                      },
                                    ],
                                    provider,
                                  )}
                                </button>
                              </li>
                            );
                          })}
                        </ol>
                      </section>
                    ) : null}
                    <section className="space-y-2">
                      <h3 className={LABEL}>Media in this take</h3>
                      <div className="flex flex-wrap items-center gap-2">
                        {pinned.map((id) => {
                          const product = productById.get(id);
                          return (
                            <span
                              className="fade-in zoom-in-95 flex animate-in items-center gap-2 rounded-full border border-orange-300/25 bg-orange-300/[0.06] py-1 pr-2 pl-1 text-[#C9C9CE] text-xs duration-200"
                              key={id}
                            >
                              {product ? (
                                <Image
                                  alt=""
                                  className="size-6 rounded-full object-cover"
                                  height={24}
                                  src={product.url}
                                  width={24}
                                />
                              ) : null}
                              <span className="max-w-40 truncate">
                                {product?.name ?? "Photo outside your products"}
                              </span>
                              <button
                                aria-label={`Remove ${product?.name ?? "image"}`}
                                className="text-[#77777E] transition-colors hover:text-[#F4F4F5] disabled:opacity-40"
                                disabled={update.isPending}
                                onClick={() =>
                                  update.mutate({
                                    templateId,
                                    takeIndex: take.index,
                                    products: pinned.filter(
                                      (other) => other !== id,
                                    ),
                                  })
                                }
                                type="button"
                              >
                                <XIcon className="size-3" />
                              </button>
                            </span>
                          );
                        })}
                        <ProductPicker
                          disabled={update.isPending}
                          onChange={(ids) =>
                            update.mutate({
                              templateId,
                              takeIndex: take.index,
                              products: ids,
                            })
                          }
                          options={products}
                          selected={pinned}
                        >
                          <button
                            className="flex h-8 items-center gap-1.5 rounded-full border border-[#2E2E33] border-dashed px-3 text-[#A8A8AE] text-xs transition-colors hover:border-[#3A3A40] hover:text-[#F4F4F5]"
                            type="button"
                          >
                            <PlusIcon className="size-3.5" />
                            Add image
                          </button>
                        </ProductPicker>
                      </div>
                      {pinned.length === 0 ? (
                        <p className="text-[#626269] text-xs">
                          {analysis.needsProductReference
                            ? "The original shows its product here; the folder's closest match fills in unless you pin one."
                            : "Pin a product photo to show it in this take."}
                        </p>
                      ) : null}
                    </section>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

/** One face in the "who plays who" row: an avatar, or the original as described. */
function FaceOption({
  children,
  label,
  onClick,
  selected,
  title,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  selected: boolean;
  title: string;
}) {
  return (
    <button
      aria-pressed={selected}
      className="group flex w-16 shrink-0 flex-col items-center gap-1.5"
      onClick={onClick}
      title={title}
      type="button"
    >
      <span
        className={cn(
          "rounded-full ring-2 ring-offset-2 ring-offset-[#0D0D0F] transition duration-200 group-active:scale-95",
          selected
            ? "ring-[#FFE229]"
            : "ring-transparent group-hover:ring-[#3A3A40]",
        )}
      >
        {children}
      </span>
      <span
        className={cn(
          "w-full truncate text-center text-[11px] transition-colors",
          selected ? "text-[#F4F4F5]" : "text-[#77777E]",
        )}
      >
        {label}
      </span>
    </button>
  );
}

/** Product photos, by product, toggled on and off a take; `children` is the trigger. */
function ProductPicker({
  children,
  disabled,
  onChange,
  options,
  selected,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onChange: (ids: string[]) => void;
  options: ProductOption[] | undefined;
  selected: string[];
}) {
  const byFolder = new Map<string, ProductOption[]>();
  for (const option of options ?? []) {
    byFolder.set(option.folder, [
      ...(byFolder.get(option.folder) ?? []),
      option,
    ]);
  }
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 border-[#232327] bg-[#0D0D0F] p-3"
      >
        {options === undefined ? (
          <LoaderCircleIcon className="mx-auto size-4 animate-spin text-[#77777E]" />
        ) : null}
        {options?.length === 0 ? (
          <p className="text-[#A8A8AE] text-xs leading-relaxed">
            Drop your product photos or screenshots on the toolbar's Products
            chip to pin them here.
          </p>
        ) : null}
        {options?.length ? (
          <div className="max-h-80 space-y-3 overflow-y-auto">
            {[...byFolder].map(([folder, images]) => (
              <div key={folder}>
                <p className="mb-1.5 font-mono text-[#77777E] text-[10px] uppercase tracking-[0.14em]">
                  {folder}
                </p>
                <div className="grid grid-cols-4 gap-1.5">
                  {images.map((image) => {
                    const on = selected.includes(image.id);
                    return (
                      <button
                        aria-label={image.name}
                        aria-pressed={on}
                        className={cn(
                          "relative aspect-square overflow-hidden rounded-lg ring-1 ring-[#232327] transition duration-200 hover:scale-[1.03] disabled:opacity-40 disabled:hover:scale-100",
                          on && "ring-2 ring-[#FFE229]",
                        )}
                        disabled={
                          disabled ||
                          (!on && selected.length >= MAX_VIDEO_CLONE_PRODUCTS)
                        }
                        key={image.id}
                        onClick={() =>
                          onChange(
                            on
                              ? selected.filter((id) => id !== image.id)
                              : [...selected, image.id],
                          )
                        }
                        title={image.name}
                        type="button"
                      >
                        <Image
                          alt=""
                          className="object-cover"
                          fill
                          sizes="72px"
                          src={image.url}
                        />
                        {on ? (
                          <span className="zoom-in-50 absolute top-1 right-1 grid size-4 animate-in place-items-center rounded-full bg-[#FFE229] text-[#09090A] duration-150">
                            <CheckIcon className="size-3" />
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
