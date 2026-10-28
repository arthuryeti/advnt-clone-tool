"use client";

import {
  FilmIcon,
  LinkIcon,
  LoaderCircleIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { toast } from "sonner";
import { VideoCloneVerdictBadge } from "@/components/organization/video-clone-detail";
import { Button } from "@/components/ui/button";
import { videoCloneUrlSchema } from "@/lib/content-workflows/video-clone";
import { uploadImageFile } from "@/lib/storage/upload-image-file";
import { uploadVideoFile } from "@/lib/storage/upload-video-file";
import { getErrorMessage } from "@/lib/utils";
import { trpc } from "@/trpc/client";

const CARD = "rounded-2xl border border-[#1C1C1F] bg-[#0B0B0C] p-5";
const LABEL =
  "font-mono text-[#77777E] text-[10px] uppercase tracking-[0.14em]";
const INPUT =
  "h-10 w-full rounded-xl border border-[#232327] bg-[#111113] px-3 text-[#F4F4F5] text-sm outline-none placeholder:text-[#626269] focus:border-[#FFE229]/60";
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

const clock = (seconds: number) => {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** Home: start a clone from a link or a video file, follow its analysis, open the plans, manage faces. */
export function CloneList() {
  const utils = trpc.useUtils();
  const clones = trpc.videoClone.list.useQuery();
  const runs = trpc.videoClone.runs.useQuery(undefined, {
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === "running") ? 3000 : false,
  });
  // A finished analysis is a new plan in the list.
  const done = runs.data?.filter((run) => run.status === "done").length ?? 0;
  React.useEffect(() => {
    if (done > 0) void utils.videoClone.list.invalidate();
  }, [done, utils]);
  const visibleRuns = runs.data?.filter((run) => run.status !== "done") ?? [];

  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-8 sm:px-6">
      <header className="space-y-1">
        <h1 className="font-semibold text-2xl text-[#F4F4F5] tracking-tight">
          Video clones
        </h1>
        <p className="text-[#A8A8AE] text-sm">
          Paste a TikTok or Instagram video, or upload one: it's split into
          shots and takes you can recast, rewrite, and render.
        </p>
      </header>

      <NewClone onStarted={() => void utils.videoClone.runs.invalidate()} />

      {visibleRuns.length > 0 ? (
        <section className="space-y-2">
          <h2 className={LABEL}>Analyzing</h2>
          {visibleRuns.map((run) => (
            <div className={CARD} key={run.id}>
              <div className="flex items-center justify-between gap-4">
                <p className="truncate font-medium text-[#F4F4F5] text-sm">
                  {run.name}
                </p>
                <span className="shrink-0 font-mono text-[#77777E] text-xs">
                  {run.status === "failed" ? "Failed" : run.label}
                </span>
              </div>
              {run.status === "failed" ? (
                <p className="mt-2 text-rose-300 text-xs">{run.error}</p>
              ) : (
                <div className="mt-3 h-1 overflow-hidden rounded-full bg-[#1C1C1F]">
                  <div
                    className="h-full rounded-full bg-[#FFE229] transition-[width] duration-700"
                    style={{ width: `${Math.max(run.progress, 3)}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className={LABEL}>Clones</h2>
        {clones.data?.length === 0 ? (
          <p className="text-[#626269] text-sm">No clones yet.</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {clones.data?.map((clone) => (
            <Link
              className={`${CARD} block space-y-3 transition-colors hover:border-[#3A3A40]`}
              href={`/clones/${clone.id}`}
              key={clone.id}
            >
              <div className="flex items-center gap-2">
                <VideoCloneVerdictBadge verdict={clone.verdict} />
                <span className="font-mono text-[#626269] text-[11px] tabular-nums">
                  {clock(clone.durationSeconds)} · {clone.takes}{" "}
                  {clone.takes === 1 ? "take" : "takes"}
                </span>
                {clone.editVideoUrl ? (
                  <FilmIcon
                    aria-label="Has a stitched edit"
                    className="ml-auto size-3.5 text-[#77777E]"
                  />
                ) : null}
              </div>
              <p className="line-clamp-2 font-medium text-[#F4F4F5] text-sm">
                {clone.name}
              </p>
              <p className="text-[#626269] text-xs">
                {clone.createdAt.toLocaleDateString()}
              </p>
            </Link>
          ))}
        </div>
      </section>

      <Faces />
    </main>
  );
}

function NewClone({ onStarted }: { onStarted: () => void }) {
  const [url, setUrl] = React.useState("");
  const [name, setName] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const prepare = trpc.videoClone.prepareVideoUpload.useMutation();
  const start = trpc.videoClone.start.useMutation({
    onSuccess: () => {
      toast.success("Analyzing the video; it takes 1-3 minutes.");
      setUrl("");
      setName("");
      setFile(null);
      onStarted();
    },
    onError: (error) => toast.error(error.message),
  });
  const link = url.trim() ? videoCloneUrlSchema.safeParse(url) : null;

  const submit = async () => {
    if (file) {
      if (file.size > MAX_VIDEO_BYTES) {
        toast.error("Videos up to 50 MB.");
        return;
      }
      setUploading(true);
      try {
        const { storageKey } = await uploadVideoFile(file, (input) =>
          prepare.mutateAsync(input),
        );
        start.mutate({
          source: { storageKey },
          name: name || file.name.replace(/\.[^.]*$/u, ""),
        });
      } catch (error) {
        toast.error(getErrorMessage(error) || "Couldn't upload the video.");
      } finally {
        setUploading(false);
      }
      return;
    }
    if (!link?.success) {
      toast.error(
        link?.error.issues[0]?.message ?? "Paste a link or pick a file.",
      );
      return;
    }
    start.mutate({ source: { url: link.data }, name: name || undefined });
  };

  return (
    <form
      className={`${CARD} space-y-3`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className={LABEL}>New clone</h2>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <LinkIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-[#626269]" />
          <input
            className={`${INPUT} pl-9`}
            disabled={Boolean(file)}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.tiktok.com/@user/video/…"
            value={url}
          />
        </label>
        <label className="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-[#232327] border-dashed px-4 text-[#A8A8AE] text-sm transition-colors hover:border-[#3A3A40] hover:text-[#F4F4F5]">
          <UploadIcon className="size-4" />
          <span className="max-w-48 truncate">
            {file ? file.name : "Upload video"}
          </span>
          <input
            accept="video/mp4,video/quicktime,video/webm"
            className="sr-only"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
            type="file"
          />
        </label>
        {file ? (
          <Button
            className="h-10 rounded-xl"
            onClick={() => setFile(null)}
            type="button"
            variant="ghost"
          >
            Clear file
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={INPUT}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name (optional)"
          value={name}
        />
        <Button
          className="h-10 shrink-0 rounded-xl bg-[#FFE229] px-5 font-medium text-[#09090B] hover:bg-[#FFE229]/90"
          disabled={!(file || url.trim())}
          loading={uploading || start.isPending}
          type="submit"
        >
          Start
        </Button>
      </div>
    </form>
  );
}

/** Faces that can play characters in renders; also added from a clone's "Who plays who". */
function Faces() {
  const utils = trpc.useUtils();
  const faces = trpc.face.list.useQuery();
  const [adding, setAdding] = React.useState(false);
  const create = trpc.face.create.useMutation();
  const remove = trpc.face.delete.useMutation({
    onSuccess: () => utils.face.list.invalidate(),
    onError: (error) => toast.error(error.message),
  });
  const add = async (files: File[]) => {
    setAdding(true);
    try {
      for (const file of files) {
        const { storageKey } = await uploadImageFile(file);
        await create.mutateAsync({
          name:
            file.name
              .replace(/\.[^.]*$/u, "")
              .trim()
              .slice(0, 100) || "Face",
          storageKey,
        });
      }
      await utils.face.list.invalidate();
    } catch (error) {
      toast.error(getErrorMessage(error) || "Couldn't add the face.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="space-y-2">
      <h2 className={LABEL}>Faces</h2>
      <p className="text-[#626269] text-xs">
        Photos of the people who play your clones' characters: one person, face
        clearly visible.
      </p>
      <div className="flex flex-wrap gap-3">
        {faces.data?.map((face) => (
          <figure className="group relative w-20 space-y-1.5" key={face.id}>
            <img
              alt={face.name}
              className="size-20 rounded-2xl border border-[#1C1C1F] object-cover"
              src={face.imageUrl}
            />
            <figcaption className="truncate text-center text-[#A8A8AE] text-[11px]">
              {face.name}
            </figcaption>
            <button
              aria-label={`Delete ${face.name}`}
              className="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-black/70 text-[#A8A8AE] opacity-0 transition-opacity hover:text-rose-300 group-hover:opacity-100"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: face.id })}
              type="button"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </figure>
        ))}
        <label className="grid size-20 cursor-pointer place-items-center rounded-2xl border border-[#232327] border-dashed text-[#77777E] transition-colors hover:border-[#3A3A40] hover:text-[#F4F4F5]">
          {adding ? (
            <LoaderCircleIcon className="size-5 animate-spin" />
          ) : (
            <PlusIcon className="size-5" />
          )}
          <input
            accept="image/*"
            className="sr-only"
            disabled={adding}
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length > 0) void add(files);
            }}
            type="file"
          />
        </label>
      </div>
    </section>
  );
}
