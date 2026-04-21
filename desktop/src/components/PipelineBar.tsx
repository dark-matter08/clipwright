import { useEffect, useRef, useState } from "react";
import { runClipwright } from "../lib/ipc";
import type { VideoState } from "../lib/types";

const ITERATION: { key: string; label: string; cmd: string; hint: string }[] = [
  { key: "tts", label: "TTS", cmd: "tts", hint: "Synthesize voiceover for every clip" },
  { key: "caption", label: "CAPTION", cmd: "caption", hint: "Render per-clip caption frames" },
  { key: "render", label: "RENDER", cmd: "render", hint: "Compose out/final.mp4" },
];

const BUILD: { key: string; label: string; cmd: string; hint: string }[] = [
  { key: "record", label: "Record", cmd: "record", hint: "Run browse-plan.json against a live browser" },
  { key: "segments", label: "Segments", cmd: "segments", hint: "Compute out/segments.json from moments" },
  { key: "keyframes", label: "Keyframes", cmd: "keyframes", hint: "Compute out/camera.json zoom curves" },
  { key: "script-init", label: "Script init", cmd: "script init", hint: "Seed script.json skeleton" },
  { key: "outro", label: "Outro", cmd: "outro", hint: "Render the brand outro card" },
];

export function PipelineBar({
  projectPath,
  video,
  activeRun,
  setActiveRun,
}: {
  projectPath: string;
  video: VideoState;
  activeRun: number | null;
  setActiveRun: (id: number | null) => void;
  onReload: () => Promise<void>;
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
    <div className="flex flex-col gap-2 border-b border-border p-2">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase text-muted">
        <span>pipeline · {video.slug}</span>
        <span className="text-accent">phase · {video.phase}</span>
      </div>

      <div className="flex gap-1">
        {ITERATION.map((s) => (
          <button
            key={s.key}
            disabled={disabled}
            onClick={() => run(s.cmd)}
            title={s.hint}
            className="flex-1 rounded border border-border bg-panel px-2 py-1.5 font-mono text-[11px] hover:border-accent hover:text-accent disabled:opacity-40"
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="flex gap-1">
        <div ref={menuRef} className="relative flex-1">
          <button
            disabled={disabled}
            onClick={() => setBuildOpen((v) => !v)}
            className="w-full rounded border border-border bg-panel px-2 py-1 font-mono text-[11px] text-muted hover:border-accent hover:text-accent disabled:opacity-40"
          >
            BUILD ▾
          </button>
          {buildOpen && (
            <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded border border-border bg-panel shadow-lg">
              {BUILD.map((s) => (
                <button
                  key={s.key}
                  disabled={disabled}
                  onClick={() => run(s.cmd)}
                  className="flex w-full flex-col items-start gap-0.5 border-b border-border/50 px-2 py-1.5 text-left font-mono hover:bg-accent/10 disabled:opacity-40"
                >
                  <span className="text-[11px] text-fg">{s.label}</span>
                  <span className="text-[9px] text-muted">{s.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          disabled={disabled}
          onClick={() => run("run")}
          title="Chain segments → keyframes → script → tts → caption → render"
          className="flex-1 rounded border border-accent bg-accent/10 px-2 py-1 font-mono text-[11px] text-accent hover:bg-accent/20 disabled:opacity-40"
        >
          RUN ALL ▸
        </button>
      </div>
    </div>
  );
}
