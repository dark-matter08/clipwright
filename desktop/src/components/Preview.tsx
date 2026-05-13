// Preview pane — SRS §8.5.2 / F-PRV-*.
//
// Plays the cached per-segment MP4 at `out/segments/<seg_id>.mp4` when
// available. "Render preview" triggers `clipwright render-segment` and
// reloads on completion. Source-scrubbing playback (raw source.mp4 with
// time offset) is a P2 polish item.
//
// The aspect-correct preview frame fills whatever space is available,
// pillarboxed/letterboxed by `aspect-ratio` + `max-h/w-full`. When no
// cached render exists yet we hide the native <video> chrome and show
// a placeholder card so the user isn't faced with a broken-video icon.

import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useApp } from "../lib/store";
import { renderSegment } from "../lib/tauri";
import { cn } from "../lib/cn";

type LoadState = "loading" | "ready" | "missing";

export function Preview() {
  const project = useApp((s) => s.project);
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const selectedId = useApp((s) => s.selectedSegmentId);
  const seg = project?.video?.segments.find((s) => s.id === selectedId) ?? null;

  const videoRef = useRef<HTMLVideoElement>(null);
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [renderToken, setRenderToken] = useState(0);

  const mp4Path = useMemo(() => {
    if (!project || !seg || !project.video) return null;
    return joinPath(project.project_dir, [
      "out",
      "segments",
      project.video.video_id,
      `${seg.id}.mp4`,
    ]);
  }, [project, seg]);

  // convertFileSrc + a cachebuster so the <video> reloads after a re-render
  // produces a new file with the same path.
  const videoSrc = useMemo(() => {
    if (!mp4Path) return null;
    return `${convertFileSrc(mp4Path)}?v=${renderToken}`;
  }, [mp4Path, renderToken]);

  // Reset load state when the segment or render token changes.
  useEffect(() => {
    setLoadState("loading");
  }, [videoSrc]);

  // Force the <video> to reload when the path or the render token changes.
  useEffect(() => {
    if (videoRef.current) videoRef.current.load();
  }, [videoSrc]);

  async function onRender() {
    if (!project || !seg || !project.video) return;
    setBusy(true);
    try {
      const state = await renderSegment(
        project.project_dir,
        project.video.video_id,
        seg.id,
        false,
      );
      loadProject(state);
      setRenderToken((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const showPlaceholder = !seg || !videoSrc || loadState === "missing";

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-bg">
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
            />
          ) : (
            <PlaceholderCard
              hasSegment={!!seg}
              aspect={project?.project.aspect ?? "9:16"}
            />
          )}
        </PreviewFrame>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border-subtle px-3 text-xs text-fg-muted">
        <span className="font-mono">{project?.project.fps ?? 30} fps</span>
        <span>·</span>
        <span className="truncate font-mono text-[10px]">
          {mp4Path ? mp4Path.split("/").slice(-3).join("/") : "—"}
        </span>
        <button
          type="button"
          disabled={!seg || busy}
          onClick={onRender}
          className={cn(
            "ml-auto rounded px-2 py-0.5 text-xs transition-colors",
            "disabled:cursor-not-allowed disabled:text-fg-muted",
            !busy && seg && "text-accent hover:bg-bg-raised",
          )}
        >
          {busy ? "rendering…" : "Render Preview"}
        </button>
      </div>
    </div>
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
  hasSegment,
  aspect,
}: {
  hasSegment: boolean;
  aspect: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-bg-inset text-fg-muted">
      <span className="font-mono text-[10px] uppercase tracking-wider">{aspect}</span>
      <span className="text-sm">
        {hasSegment ? "No render yet" : "Select a segment"}
      </span>
      {hasSegment && (
        <span className="text-xs text-fg-muted/70">
          Click <span className="font-medium text-accent">Render Preview</span> below
        </span>
      )}
    </div>
  );
}

function joinPath(parent: string, parts: string[]): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const trimmed = parent.replace(/[\\/]+$/, "");
  return [trimmed, ...parts].join(sep);
}
