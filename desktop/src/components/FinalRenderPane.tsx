// FinalRenderPane — the "Screen 3" sub-view of Workspace. Shown when a video
// has a final.mp4 and the user hasn't selected a clip or file. Gives them a
// proper preview of the composed video plus three next-step actions: open in
// the timeline for polish, reveal the file in Finder/Explorer, or re-render.

import { useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { VideoState } from "../lib/types";
import { runClipwright } from "../lib/ipc";
import { I } from "../lib/icons";
import { cn } from "../lib/cn";

export function FinalRenderPane({
  projectPath,
  video,
  aspect,
  activeRun,
  setActiveRun,
  onOpenInTimeline,
}: {
  projectPath: string;
  video: VideoState;
  aspect: string;
  activeRun: number | null;
  setActiveRun: (id: number | null) => void;
  onOpenInTimeline: () => void;
}) {
  const finalPath = `${projectPath}/videos/${video.slug}/out/final.mp4`;
  const videoUrl = useMemo(() => convertFileSrc(finalPath), [finalPath]);

  const ratio =
    aspect === "16:9"
      ? "aspect-[16/9]"
      : aspect === "1:1"
        ? "aspect-square"
        : "aspect-[9/16]";

  const clipCount = video.script?.clips?.length ?? 0;
  const segmentCount = video.segments?.length ?? 0;

  async function reveal() {
    try {
      await revealItemInDir(finalPath);
    } catch {
      /* non-fatal — just ignore if the opener plugin isn't allowed */
    }
  }

  async function rerender() {
    if (activeRun !== null) return;
    const id = await runClipwright(projectPath, "render", video.slug);
    setActiveRun(id);
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-bg">
      <div className="flex items-center justify-between border-b border-border bg-panel/40 px-4 py-2 font-mono text-[10px] uppercase text-muted">
        <span className="flex items-center gap-1.5 text-accent">
          <I.Film size={12} />
          <span>final render // {video.slug}</span>
        </span>
        <span className="flex items-center gap-1.5 text-accent/80">
          <I.Check size={10} /> hasFinal
        </span>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6">
        <div
          className={cn(
            "relative max-h-[520px] overflow-hidden rounded-lg border border-border bg-black shadow-[0_0_80px_-20px_rgba(0,245,229,0.25)]",
            ratio,
            aspect === "9:16" ? "h-[520px]" : "w-full max-w-[720px]",
          )}
        >
          <video
            src={videoUrl}
            controls
            playsInline
            className="h-full w-full object-contain"
          />
        </div>

        <div className="grid w-full max-w-[720px] grid-cols-3 gap-2 font-mono text-[10px]">
          <MetaStat
            icon={<I.Scissors size={11} className="text-accent/80" />}
            label="clips"
            value={String(clipCount)}
          />
          <MetaStat
            icon={<I.Split size={11} className="text-accent/80" />}
            label="segments"
            value={String(segmentCount)}
          />
          <MetaStat
            icon={<I.Tag size={11} className="text-accent/80" />}
            label="aspect"
            value={aspect}
          />
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 font-mono">
          <button
            onClick={onOpenInTimeline}
            className="flex items-center gap-1.5 rounded border border-accent2/60 bg-accent2/5 px-3 py-1.5 text-[11px] uppercase text-accent2 hover:bg-accent2/10"
          >
            <I.Video size={12} /> open in timeline
          </button>
          <button
            onClick={reveal}
            className="flex items-center gap-1.5 rounded border border-border bg-panel px-3 py-1.5 text-[11px] uppercase text-muted hover:border-accent hover:text-accent"
          >
            <I.FolderOpen size={12} /> reveal in finder
          </button>
          <button
            onClick={rerender}
            disabled={activeRun !== null}
            className="flex items-center gap-1.5 rounded border border-border bg-panel px-3 py-1.5 text-[11px] uppercase text-muted hover:border-accent hover:text-accent disabled:opacity-40"
          >
            <I.RefreshCw size={12} /> re-render
          </button>
        </div>
      </div>
    </div>
  );
}

function MetaStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded border border-border bg-panel/40 px-3 py-2">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-[9px] uppercase text-muted/70">{label}</div>
        <div className="truncate text-fg">{value}</div>
      </div>
    </div>
  );
}
