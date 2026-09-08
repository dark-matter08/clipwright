// Preview pane — SRS §8.5.2 / F-PRV-*.
//
// Two modes, no overlap:
//
//   * **Final** (always present, default): plays the assembled
//     `out/final/<video_id>.mp4`. The whole video is one continuous
//     file, so `<video>.currentTime` IS the timeline time — no
//     conversion. When the file is missing, we show a "Render to
//     preview" placeholder; the user is expected to click Render in
//     the top bar (no on-the-fly source-segment concatenation
//     anymore — see the Final/Segment merge note below).
//
//   * **Raw** (only when `rawSourcePath` is non-null): plays the
//     unedited source mp4 end-to-end. Useful for confirming the
//     underlying material before/after editing. The Preview emits
//     timeline-coordinate `playbackTime` updates by walking
//     segments and mapping the playing source-time back to a
//     timeline offset, so the Timeline playhead still highlights
//     which segment is currently being shown.
//
// Why no Segment mode anymore: it was redundant. Its job — "see
// this one clip from source, pause at the end" — overlapped with
// (a) Final mode for projects with a rendered mp4, and (b) Raw
// mode for projects with a recording source. It also caused a
// real bug: Final-mode pause-at-end was inherited from the
// Segment-mode plumbing, so clicking Play in Final paused at the
// boundary of whichever segment was selected. The two-mode layout
// removes the conflict and the bug at once.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

type LoadState = "loading" | "ready" | "missing";

type PreviewMode = "final" | "raw";

export function Preview() {
  const project = useApp((s) => s.project);
  const selectedId = useApp((s) => s.selectedSegmentId);

  // Playback state is shared with the Timeline so the playhead and
  // scrubber can sync — Preview is authoritative for currentTime
  // (it owns the <video>); Timeline reads + writes via seek requests.
  const setPlaybackTime = useApp((s) => s.setPlaybackTime);
  const setPlaybackPlaying = useApp((s) => s.setPlaybackPlaying);
  const setPlaybackMode = useApp((s) => s.setPlaybackMode);
  const seekRequest = useApp((s) => s.seekRequest);
  const playPauseRequest = useApp((s) => s.playPauseRequest);
  const finalStaleToken = useApp((s) => s.finalStaleToken);
  const finalIsStale = (project?.video?.video_id ?? "") in finalStaleToken;

  const videoRef = useRef<HTMLVideoElement>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  // Render-token bumps to bust the <video>'s URL cache after a
  // regenerate elsewhere — currently nothing drives this from the
  // Preview pane (the TopBar Render owns final renders) but the
  // <video> still picks up the suffix.
  const [renderToken] = useState(0);
  const [mode, setMode] = useState<PreviewMode>("final");

  // Mirror the local mode into the store so the Timeline knows which
  // timebase the playhead is plotted against (currently only used
  // for the Raw-mode track-hiding, but the indirection is cheap).
  useEffect(() => {
    setPlaybackMode(mode);
  }, [mode, setPlaybackMode]);

  // Raw mode is only meaningful when there's a single discoverable
  // source video for the project — typical for upload/record flows
  // where every segment slices the same mp4. For panel-based
  // projects (manhwa-recap) every segment has a different image
  // source so "the raw video" doesn't exist as a concept.
  //
  // Heuristic: all recording-kind segments share the same
  // `source` field AND that source ends in a video extension.
  const rawSourcePath = useMemo<string | null>(() => {
    const segments = project?.video?.segments ?? [];
    if (segments.length === 0) return null;
    const first = segments[0]!;
    if (first.kind !== "recording") return null;
    const lower = first.source.toLowerCase();
    const isVideo = [".mp4", ".mov", ".webm", ".m4v"].some((ext) =>
      lower.endsWith(ext),
    );
    if (!isVideo) return null;
    // Multi-source projects (B-roll alongside main) would be
    // misleading if we showed Raw pointing at just one of them.
    const allSame = segments.every(
      (s) => s.kind !== "recording" || s.source === first.source,
    );
    if (!allSame) return null;
    return first.source;
  }, [project?.video?.segments]);

  // If the user was in Raw mode and then switches to a project that
  // doesn't have a coherent single source, fall back to Final so the
  // toggle UI matches reality.
  useEffect(() => {
    if (mode === "raw" && !rawSourcePath) setMode("final");
  }, [mode, rawSourcePath]);

  const mp4Path = useMemo(() => {
    if (!project || !project.video) return null;
    if (mode === "final") {
      return joinPath(project.project_dir, [
        "out",
        "final",
        `${project.video.video_id}.mp4`,
      ]);
    }
    // mode === "raw"
    if (!rawSourcePath) return null;
    return joinPath(project.project_dir, [rawSourcePath]);
  }, [project, mode, rawSourcePath]);

  // convertFileSrc + a cachebuster so the <video> reloads after a re-render
  // produces a new file with the same path.
  const videoSrc = useMemo(() => {
    if (!mp4Path) return null;
    return `${convertFileSrc(mp4Path)}?v=${renderToken}`;
  }, [mp4Path, renderToken]);

  // Reset load state when the source changes.
  useEffect(() => {
    setLoadState("loading");
  }, [videoSrc]);

  // Force the <video> to reload when the path changes (mode flip or
  // render token bump).
  useEffect(() => {
    if (videoRef.current) videoRef.current.load();
  }, [videoSrc]);

  // When the user clicks a segment in the Timeline, the store fires
  // a seek request with the segment's start (timeline seconds). In
  // Final mode, timeline-time IS video-time, so seeking is a 1:1
  // assignment. In Raw mode, we map timeline-time back to the source
  // video's timebase by walking segments.
  useEffect(() => {
    if (!seekRequest) return;
    const el = videoRef.current;
    if (!el) return;
    const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
    let target = seekRequest.time;
    if (mode === "raw" && project?.video) {
      // Timeline → source: walk segments, find the one containing
      // this timeline time, then map back into its source range.
      let cursor = 0;
      let mapped: number | null = null;
      for (const s of project.video.segments) {
        const next = cursor + s.target_duration;
        if (seekRequest.time >= cursor && seekRequest.time < next) {
          if (s.kind === "recording") {
            mapped = s.source_start + (seekRequest.time - cursor);
          }
          break;
        }
        cursor = next;
      }
      if (mapped != null) target = mapped;
    }
    el.currentTime = Math.max(0, Math.min(target, dur));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest?.token]);

  // Honor play/pause requests from the Timeline's transport buttons.
  // <video>.play() returns a Promise — we ignore rejections (autoplay
  // policy errors, etc.); the user can hit play again.
  useEffect(() => {
    if (!playPauseRequest) return;
    const el = videoRef.current;
    if (!el) return;
    if (playPauseRequest.play) {
      void el.play().catch(() => {
        /* autoplay block — surface via UI later */
      });
    } else {
      el.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playPauseRequest?.token]);

  // Highlight the segment under the playhead. Currently a no-op
  // visual change inside Preview — Timeline does its own playhead
  // rendering against the same store value — but we leave the
  // computation here so future "scrub through final and keep the
  // selected-segment indicator in sync" hooks have a place to live.
  const selectedExists = !!selectedId;

  const showPlaceholder = !videoSrc || loadState === "missing";

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border-subtle px-3 text-xs">
        <PreviewModeToggle
          value={mode}
          onChange={setMode}
          rawAvailable={rawSourcePath !== null}
        />
        <span className="ml-auto truncate font-mono text-[10px] text-fg-muted">
          {mp4Path ? mp4Path.split("/").slice(-3).join("/") : "—"}
        </span>
      </div>
      {finalIsStale && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-[11px] text-fg-subtle"
        >
          <AlertTriangle size={12} strokeWidth={2} className="shrink-0 text-warn" />
          <span>
            You regenerated TTS or captions. The currently-playing video
            still has the old audio/captions — click{" "}
            <span className="font-medium text-accent">Render</span> in the
            top bar to bake the new content into a fresh final mp4.
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <PreviewFrame aspect={project?.project.aspect ?? "9:16"}>
          {!showPlaceholder ? (
            <video
              ref={videoRef}
              src={videoSrc ?? undefined}
              controls
              preload="metadata"
              playsInline
              className="h-full w-full bg-black object-contain"
              onLoadedMetadata={() => setLoadState("ready")}
              onError={() => setLoadState("missing")}
              // Stream every timeupdate (~4× per second) into the
              // store so the Timeline's playhead tracks playback live.
              //
              // Timebase mapping per mode:
              //   - Final: 1:1 (video time IS timeline time). The
              //     whole final.mp4 is one continuous file; no
              //     pause-at-end, no segment boundaries to honor.
              //   - Raw: walk segments to find the one whose source
              //     range contains the current videoT, then map
              //     `cursor + (videoT - source_start)`. If videoT
              //     is in a gap (material edited out), leave the
              //     playhead where it was — gives the "highlight my
              //     edit" effect as raw plays past cut-out regions.
              onTimeUpdate={(e) => {
                const videoT = e.currentTarget.currentTime;
                if (mode === "final") {
                  setPlaybackTime(videoT);
                } else if (mode === "raw" && project?.video) {
                  let cursor = 0;
                  let matched: number | null = null;
                  for (const s of project.video.segments) {
                    if (
                      s.kind === "recording" &&
                      videoT >= s.source_start &&
                      videoT < s.source_end
                    ) {
                      matched = cursor + (videoT - s.source_start);
                      break;
                    }
                    cursor += s.target_duration;
                  }
                  if (matched != null) setPlaybackTime(matched);
                }
              }}
              onPlay={() => setPlaybackPlaying(true)}
              onPause={() => setPlaybackPlaying(false)}
              onSeeked={(e) => {
                const videoT = e.currentTarget.currentTime;
                if (mode === "final") {
                  setPlaybackTime(videoT);
                } else if (mode === "raw" && project?.video) {
                  let cursor = 0;
                  let matched: number | null = null;
                  for (const s of project.video.segments) {
                    if (
                      s.kind === "recording" &&
                      videoT >= s.source_start &&
                      videoT < s.source_end
                    ) {
                      matched = cursor + (videoT - s.source_start);
                      break;
                    }
                    cursor += s.target_duration;
                  }
                  if (matched != null) setPlaybackTime(matched);
                }
              }}
            />
          ) : (
            <PlaceholderCard
              mode={mode}
              aspect={project?.project.aspect ?? "9:16"}
              hasSegments={(project?.video?.segments?.length ?? 0) > 0}
              hasSelection={selectedExists}
            />
          )}
        </PreviewFrame>
      </div>
      {/* Footer — compact so it never wraps even when the drawer is
       *  open and the Preview is narrow. */}
      <div className="flex h-8 shrink-0 items-center gap-2 overflow-hidden border-t border-border-subtle px-3 text-[10px] text-fg-muted">
        <span className="shrink-0 font-mono">{project?.project.fps ?? 30} fps</span>
        {mode === "raw" && (
          <>
            <span className="shrink-0">·</span>
            <span className="shrink-0 font-mono uppercase tracking-wider">
              raw source · unedited
            </span>
          </>
        )}
        {mode === "final" && (
          <>
            <span className="shrink-0">·</span>
            <span className="shrink-0 font-mono uppercase tracking-wider">
              final · {project?.video?.video_id ?? "—"}
            </span>
          </>
        )}
        <span
          className="ml-auto min-w-0 truncate text-right"
          title="Use the Render button in the top bar to regenerate the final mp4"
        >
          <span className="text-accent">Render</span> in the top bar to regenerate
        </span>
      </div>
    </div>
  );
}

function PreviewModeToggle({
  value,
  onChange,
  rawAvailable,
}: {
  value: PreviewMode;
  onChange: (m: PreviewMode) => void;
  rawAvailable: boolean;
}) {
  return (
    <div className="flex items-center rounded border border-border-subtle bg-bg-inset p-0.5">
      <ToggleOption
        label="Final"
        active={value === "final"}
        onClick={() => onChange("final")}
        hint="Play the assembled out/final/<video>.mp4 — what you ship."
      />
      {rawAvailable && (
        <ToggleOption
          label="Raw"
          active={value === "raw"}
          onClick={() => onChange("raw")}
          hint="Play the unedited source video. Timeline playhead tracks which segment is on screen."
        />
      )}
    </div>
  );
}

function ToggleOption({
  label,
  active,
  onClick,
  hint,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
        active ? "bg-accent/15 text-fg" : "text-fg-muted hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Aspect-correct preview container. Fills the available space, then clamps
 * by `max-h/w-full` to letterbox/pillarbox. The trick: `aspect-ratio` plus
 * BOTH max constraints gives the largest box that fits within both — no
 * JS measurement, browser does the math.
 */
function PreviewFrame({
  aspect,
  children,
}: {
  aspect: string;
  children: React.ReactNode;
}) {
  const aspectClass =
    aspect === "9:16" ? "aspect-[9/16]"
    : aspect === "16:9" ? "aspect-[16/9]"
    : "aspect-square";
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded border border-border-subtle bg-bg-inset",
        // `h-full max-w-full` + aspect-ratio means: try to fill height; the
        // width is derived from the ratio and clamps to 100% if it would
        // exceed the parent. When width clamps, height shrinks to keep
        // aspect.
        "h-full max-h-full max-w-full",
        aspectClass,
      )}
    >
      {children}
    </div>
  );
}

function PlaceholderCard({
  mode,
  aspect,
  hasSegments,
  hasSelection,
}: {
  mode: PreviewMode;
  aspect: string;
  hasSegments: boolean;
  hasSelection: boolean;
}) {
  // Final-mode placeholders:
  //   * No segments yet              → tell the user to import/record
  //   * Segments exist, no final mp4 → render hint
  //
  // Raw-mode placeholder:
  //   * Source file failed to load   → "source unavailable"
  if (mode === "raw") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-bg-inset text-fg-muted">
        <span className="font-mono text-[10px] uppercase tracking-wider">{aspect}</span>
        <span className="text-sm">Source unavailable</span>
        <span className="px-4 text-center text-xs text-fg-muted/70">
          Couldn't load the raw source video. Make sure the imported
          file still exists under <span className="font-mono">sources/</span>.
        </span>
      </div>
    );
  }
  if (!hasSegments) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-bg-inset text-fg-muted">
        <span className="font-mono text-[10px] uppercase tracking-wider">{aspect}</span>
        <span className="text-sm">No video yet</span>
        <span className="px-4 text-center text-xs text-fg-muted/70">
          Import a video or record a session to seed segments, then
          click <span className="text-accent">Render</span> in the top
          bar to assemble the final.
        </span>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-bg-inset text-fg-muted">
      <span className="font-mono text-[10px] uppercase tracking-wider">{aspect}</span>
      <span className="text-sm">No final render yet</span>
      <span className="px-4 text-center text-xs text-fg-muted/70">
        Click <span className="font-medium text-accent">Render</span> in
        the top bar to assemble the segments
        {hasSelection ? " into a final mp4" : ""}.
      </span>
    </div>
  );
}

function joinPath(parent: string, parts: string[]): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const trimmed = parent.replace(/[\\/]+$/, "");
  return [trimmed, ...parts].join(sep);
}
