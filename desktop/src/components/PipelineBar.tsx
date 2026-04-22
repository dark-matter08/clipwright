import { useEffect, useRef, useState } from "react";
import { runClipwright } from "../lib/ipc";
import type { VideoState } from "../lib/types";
import { I } from "../lib/icons";

type Step = { key: string; label: string; cmd: string; hint: string; icon: React.ReactNode };

const ITERATION: Step[] = [
  { key: "tts", label: "TTS", cmd: "tts", hint: "Synthesize voiceover for every clip", icon: <I.Mic size={12} /> },
  { key: "caption", label: "CAPTION", cmd: "caption", hint: "Render per-clip caption frames", icon: <I.Captions size={12} /> },
  { key: "render", label: "RENDER", cmd: "render", hint: "Compose out/final.mp4", icon: <I.Scissors size={12} /> },
];

const BUILD: Step[] = [
  { key: "record", label: "Record", cmd: "record", hint: "Run browse-plan.json against a live browser", icon: <I.MousePointerClick size={12} /> },
  { key: "segments", label: "Segments", cmd: "segments", hint: "Compute out/segments.json from moments", icon: <I.Split size={12} /> },
  { key: "keyframes", label: "Keyframes", cmd: "keyframes", hint: "Compute out/camera.json zoom curves", icon: <I.ZoomIn size={12} /> },
  { key: "script-init", label: "Script init", cmd: "script init", hint: "Seed script.json skeleton", icon: <I.FileText size={12} /> },
  { key: "outro", label: "Outro", cmd: "outro", hint: "Render the brand outro card", icon: <I.Sparkles size={12} /> },
];

export function PipelineBar({
  projectPath,
  video,
  activeRun,
  setActiveRun,
  onOpenEditor,
}: {
  projectPath: string;
  video: VideoState;
  activeRun: number | null;
  setActiveRun: (id: number | null) => void;
  onReload: () => Promise<void>;
  onOpenEditor?: () => void;
}) {
  const [buildOpen, setBuildOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!buildOpen) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setBuildOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [buildOpen]);

  async function run(cmd: string) {
    if (activeRun !== null) return;
    setBuildOpen(false);
    const id = await runClipwright(projectPath, cmd, video.slug);
    setActiveRun(id);
  }

  const disabled = activeRun !== null;

  return (
    <div className="flex flex-col gap-2 border-b border-border bg-panel/30 p-2">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase text-muted">
        <span className="flex items-center gap-1.5">
          <I.GitBranch size={11} className="text-accent/70" /> pipeline · {video.slug}
        </span>
        <span className="flex items-center gap-1.5 text-accent">
          <I.Hourglass size={10} /> {video.phase}
        </span>
      </div>

      <div>
        <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted/70">
          iteration
        </div>
        <div className="flex gap-1">
          {ITERATION.map((s) => (
            <button
              key={s.key}
              disabled={disabled}
              onClick={() => run(s.cmd)}
              title={s.hint}
              className="flex flex-1 items-center justify-center gap-1.5 rounded border border-border bg-panel px-2 py-1.5 font-mono text-[11px] hover:border-accent hover:text-accent disabled:opacity-40"
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted/70">
          full build
        </div>
        <div className="flex gap-1">
          <div ref={menuRef} className="relative flex-1">
            <button
              disabled={disabled}
              onClick={() => setBuildOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded border border-border bg-panel px-2 py-1.5 font-mono text-[11px] text-muted hover:border-accent hover:text-accent disabled:opacity-40"
            >
              <span className="flex items-center gap-1.5">
                <I.GitBranch size={12} /> BUILD
              </span>
              <I.ChevronDown size={12} />
            </button>
            {buildOpen && (
              <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded border border-border bg-panel shadow-lg">
                {BUILD.map((s) => (
                  <button
                    key={s.key}
                    disabled={disabled}
                    onClick={() => run(s.cmd)}
                    className="flex w-full items-start gap-2 border-b border-border/50 px-2 py-1.5 text-left font-mono last:border-b-0 hover:bg-accent/10 disabled:opacity-40"
                  >
                    <span className="mt-0.5 text-accent/80">{s.icon}</span>
                    <span className="flex-1">
                      <span className="block text-[11px] text-fg">{s.label}</span>
                      <span className="block text-[9px] text-muted">{s.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            disabled={disabled}
            onClick={() => run("run")}
            title="Chain segments → keyframes → script → tts → caption → render"
            className="flex flex-1 items-center justify-center gap-1.5 rounded border border-accent bg-accent/10 px-2 py-1.5 font-mono text-[11px] text-accent hover:bg-accent/20 disabled:opacity-40"
          >
            <I.Play size={12} />
            <span>RUN ALL</span>
          </button>
        </div>
      </div>

      {onOpenEditor && (
        <button
          onClick={onOpenEditor}
          disabled={!video.hasSegments}
          title={video.hasSegments ? "Open in the timeline editor" : "Build segments first to enable the editor"}
          className="flex items-center justify-center gap-1.5 rounded border border-accent2/60 bg-accent2/5 px-2 py-1.5 font-mono text-[11px] text-accent2 hover:bg-accent2/10 disabled:opacity-40"
        >
          <I.Video size={12} />
          <span>OPEN EDITOR ›</span>
        </button>
      )}
    </div>
  );
}
