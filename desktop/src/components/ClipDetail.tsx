import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Clip } from "../lib/types";
import { saveScriptClip, runClipwright } from "../lib/ipc";

export function ClipDetail({
  projectPath,
  videoSlug,
  clip,
  onReload,
  activeRun,
  setActiveRun,
}: {
  projectPath: string;
  videoSlug: string;
  clip: Clip;
  onReload: () => Promise<void>;
  activeRun: number | null;
  setActiveRun: (id: number | null) => void;
}) {
  const [text, setText] = useState(clip.text);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setText(clip.text);
    setDirty(false);
  }, [clip.id, clip.text]);

  const audioUrl = convertFileSrc(
    `${projectPath}/videos/${videoSlug}/out/audio/${clip.id}.mp3`,
  );

  async function save() {
    await saveScriptClip(projectPath, videoSlug, clip.id, text);
    setDirty(false);
    await onReload();
  }

  async function regen(cmd: string) {
    if (activeRun !== null) return;
    if (dirty) await save();
    const id = await runClipwright(projectPath, cmd, videoSlug, clip.id);
    setActiveRun(id);
  }

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const rate = words / clip.target_seconds;

  return (
    <div className="flex-1 overflow-y-auto p-4 font-mono text-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-accent">{clip.id}</h2>
        <span className="text-xs text-muted">
          {words}w · {rate.toFixed(2)}w/s · target {clip.target_seconds.toFixed(2)}s
        </span>
      </div>

      <div className="mt-3">
        <label className="text-[11px] uppercase text-muted">hint</label>
        <p className="mt-1 rounded border border-border bg-panel/40 p-2 text-xs text-muted">{clip.hint}</p>
      </div>

      <div className="mt-3">
        <label className="text-[11px] uppercase text-muted">narration</label>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
          rows={5}
          className="mt-1 w-full rounded border border-border bg-panel p-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
        />
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={save}
          disabled={!dirty}
          className="rounded border border-border bg-panel px-3 py-1 text-xs hover:border-accent hover:text-accent disabled:opacity-40"
        >
          SAVE
        </button>
        <button
          onClick={() => regen("tts")}
          disabled={activeRun !== null}
          className="rounded border border-border bg-panel px-3 py-1 text-xs hover:border-accent hover:text-accent disabled:opacity-40"
        >
          REGEN AUDIO
        </button>
        <button
          onClick={() => regen("caption")}
          disabled={activeRun !== null}
          className="rounded border border-border bg-panel px-3 py-1 text-xs hover:border-accent hover:text-accent disabled:opacity-40"
        >
          REGEN CAPTIONS
        </button>
        <button
          onClick={() => regen("render")}
          disabled={activeRun !== null}
          className="rounded border border-border bg-panel px-3 py-1 text-xs hover:border-accent hover:text-accent disabled:opacity-40"
        >
          RE-RENDER
        </button>
      </div>

      <div className="mt-4">
        <label className="text-[11px] uppercase text-muted">audio preview</label>
        <audio key={audioUrl} src={audioUrl} controls className="mt-1 w-full" />
      </div>
    </div>
  );
}
