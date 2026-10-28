"use client";

import { Player, type PlayerRef } from "@remotion/player";
import * as React from "react";
import {
  AbsoluteFill,
  Html5Video,
  prefetch,
  Sequence,
  useVideoConfig,
} from "remotion";

/** One file playing on the edit's clock, in frames: from `from`, starting `trimBefore` into the file. */
export type PreviewClip = {
  src: string;
  from: number;
  durationInFrames: number;
  trimBefore: number;
};

function Clips({ clips }: { clips: PreviewClip[] }) {
  // ponytail: every clip stays mounted (one <video> each, hidden at its nearest edge frame), so a
  // seek anywhere (hover, click, ↑/↓) lands on a loaded video instead of a black one. Mount only a
  // window around the playhead if edits grow to dozens of clips.
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill className="bg-black">
      {clips.map((clip) => (
        <Sequence
          durationInFrames={clip.durationInFrames}
          from={clip.from}
          key={`${clip.from}-${clip.src}`}
          postmountFor={durationInFrames}
          premountFor={durationInFrames}
        >
          <Html5Video
            pauseWhenBuffering
            src={clip.src}
            style={{ height: "100%", objectFit: "contain", width: "100%" }}
            trimBefore={clip.trimBefore}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

/**
 * The clone as it plays now, every clip from its own file: no stitch to wait for. Each file is
 * downloaded whole first (Remotion's prefetch; the videos then play its blob URL), so a jump
 * anywhere answers from memory instead of a range request through /storage.
 */
export function ClonePreview({
  clips,
  fps,
  playerRef,
}: {
  clips: PreviewClip[];
  fps: number;
  playerRef: React.Ref<PlayerRef>;
}) {
  const files = [...new Set(clips.map((clip) => clip.src))];
  const filesKey = files.join("\n");
  const downloads = React.useRef(new Map<string, { free: () => void }>());
  const [loaded, setLoaded] = React.useState(() => new Set<string>());
  React.useEffect(() => {
    for (const src of filesKey.split("\n")) {
      if (downloads.current.has(src)) continue;
      const download = prefetch(src, { method: "blob-url" });
      downloads.current.set(src, download);
      // One that won't download whole still plays, streamed.
      const settle = () => {
        if (downloads.current.get(src) !== download) return;
        setLoaded((done) => new Set(done).add(src));
      };
      download.waitUntilDone().then(settle, settle);
    }
  }, [filesKey]);
  // ponytail: files stay in memory until the page closes, so a version picked back plays at once;
  // free the ones no clip plays if long sessions get heavy.
  React.useEffect(() => {
    const current = downloads.current;
    return () => {
      for (const download of current.values()) download.free();
      current.clear();
    };
  }, []);
  // The clips shown are the last ones whose files are all here: a new render or pick joins once
  // downloaded, instead of swapping a video's file under it mid-play. Polling hands over equal
  // clips as new arrays; the key keeps the player from restarting its videos for those.
  const key = JSON.stringify(clips);
  const [shown, setShown] = React.useState<string | null>(null);
  if (shown !== key && files.every((src) => loaded.has(src))) setShown(key);
  const inputProps = React.useMemo(
    () => ({ clips: JSON.parse(shown ?? "[]") as PreviewClip[] }),
    [shown],
  );
  if (shown === null) {
    return (
      <div className="grid size-full place-items-center text-[#77777E] text-sm">
        Loading clips {files.filter((src) => loaded.has(src)).length}/
        {files.length}…
      </div>
    );
  }
  const last = inputProps.clips.at(-1);
  return (
    <Player
      acknowledgeRemotionLicense
      component={Clips}
      compositionHeight={1280}
      compositionWidth={720}
      controls
      durationInFrames={Math.max(
        1,
        last ? last.from + last.durationInFrames : 1,
      )}
      fps={fps}
      inputProps={inputProps}
      ref={playerRef}
      // The page's own Space shortcut plays and pauses.
      spaceKeyToPlayOrPause={false}
      style={{ height: "100%", width: "100%" }}
    />
  );
}
