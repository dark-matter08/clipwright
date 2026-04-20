import { runClipwright } from "../lib/ipc";
import type { ProjectState } from "../lib/types";

const STAGES: { key: string; label: string; cmd: string }[] = [
  { key: "record", label: "RECORD", cmd: "record" },
  { key: "segments", label: "SEGMENTS", cmd: "segments" },
  { key: "keyframes", label: "KEYFRAMES", cmd: "keyframes" },
  { key: "script-init", label: "SCRIPT", cmd: "script init" },
  { key: "tts", label: "TTS", cmd: "tts" },
  { key: "caption", label: "CAPTION", cmd: "caption" },
  { key: "outro", label: "OUTRO", cmd: "outro" },
  { key: "render", label: "RENDER", cmd: "render" },
];

export function PipelineBar({
  project,
  activeRun,
  setActiveRun,
}: {
  project: ProjectState;
  activeRun: number | null;
  setActiveRun: (id: number | null) => void;
  onReload: () => Promise<void>;
}) {
  async function run(cmd: string) {
    if (activeRun !== null) return;
    const id = await runClipwright(project.path, cmd);
    setActiveRun(id);
  }

  return (
    <div className="grid grid-cols-2 gap-1 border-b border-border p-2">
      {STAGES.map((s) => (
        <button
          key={s.key}
          disabled={activeRun !== null}
          onClick={() => run(s.cmd)}
          className="rounded border border-border bg-panel px-2 py-1 font-mono text-[11px] hover:border-accent hover:text-accent disabled:opacity-40"
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
