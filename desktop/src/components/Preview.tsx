// Preview pane — SRS §8.5.2 / F-PRV-*.
//
// Plays the cached per-segment MP4 at `out/segments/<seg_id>.mp4` when
// available. "Render preview" triggers `clipwright render-segment` and
// reloads on completion. Source-scrubbing playback (raw source.mp4 with
// time offset) is a P2 polish item.

import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useApp } from "../lib/store";
import { renderSegment } from "../lib/tauri";
import { cn } from "../lib/cn";

export function Preview() {
  const project = useApp((s) => s.project);
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const selectedId = useApp((s) => s.selectedSegmentId);
  const seg = project?.timeline.segments.find((s) => s.id === selectedId) ?? null;

  const videoRef = useRef<HTMLVideoElement>(null);
  const [busy, setBusy] = useState(false);
  const [renderToken, setRenderToken] = useState(0);

  const mp4Path = useMemo(() => {
    if (!project || !seg) return null;
    return joinPath(project.project_dir, ["out", "segments", `${seg.id}.mp4`]);
  }, [project, seg, renderToken]);

  const videoSrc = useMemo(() => {
    if (!mp4Path) return null;
    return convertFileSrc(mp4Path);
  }, [mp4Path]);

  // Force the <video> to reload when the path or the render token changes.
  useEffect(() => {
    if (videoRef.current) videoRef.current.load();
  }, [videoSrc, renderToken]);

  async function onRender() {
    if (!project || !seg) return;
    setBusy(true);
    try {
      const state = await renderSegment(project.project_dir, seg.id, false);
      loadProject(state);
      setRenderToken((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div className="flex flex-1 items-center justify-center p-6">
        <PreviewFrame aspect={project?.project.aspect ?? "9:16"}>
          {seg && videoSrc ? (
            <video
              ref={videoRef}
              src={videoSrc}
              controls
              preload="metadata"
              className="h-full w-full bg-black object-contain"
              onError={() => { /* swallow — handled by the "render preview" CTA */ }}
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-fg-muted">
              <span className="text-sm">
                {seg ? "No render yet — click Render Preview" : "Select a segment"}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted/60">
                {project?.project.aspect ?? "9:16"}
              </span>
            </div>
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

/** Aspect-correct framed container — matches what the final render will be. */
function PreviewFrame({ aspect, children }: { aspect: string; children: React.ReactNode }) {
  const dims = aspect === "9:16"
    ? "h-[480px] w-[270px]"
    : aspect === "16:9"
      ? "h-[270px] w-[480px]"
      : "h-[400px] w-[400px]"; // 1:1
  return (
    <div className={cn("overflow-hidden rounded border border-border-subtle bg-bg-inset", dims)}>
      {children}
    </div>
  );
}

function joinPath(parent: string, parts: string[]): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const trimmed = parent.replace(/[\\/]+$/, "");
  return [trimmed, ...parts].join(sep);
}
