import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Clip } from "../lib/types";
import { saveScriptClip, runClipwright } from "../lib/ipc";
import { I } from "../lib/icons";
import { cn } from "../lib/cn";

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
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
  const rateColor =
    rate > 4.5 ? "text-accent2" : rate < 2.0 ? "text-muted" : "text-accent";

  // Approximate caption chunks from the script so the preview feels real even
  // before `caption` has run. 2–4 words per chunk keeps the mockup rhythm.
  const chunks = text
    .split(/\s+/)
    .filter(Boolean)
    .reduce<string[]>((acc, w, i) => {
      const group = Math.floor(i / 3);
      acc[group] = (acc[group] ? acc[group] + " " : "") + w;
      return acc;
    }, []);

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.play();
      setPlaying(true);
    } else {
      a.pause();
      setPlaying(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header chip row */}
      <div className="flex items-center justify-between border-b border-border bg-panel/40 px-4 py-2 font-mono text-[10px] uppercase text-muted">
        <span className="flex items-center gap-2">
          <I.Focus size={11} className="text-accent/80" />
          <span>clip detail</span>
          <span className="text-muted/60">//</span>
          <span className="text-fg">{clip.id}</span>
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <I.Hash size={10} /> {words}w
          </span>
          <span className={cn("flex items-center gap-1", rateColor)}>
            <I.Zap size={10} /> {rate.toFixed(2)} w/s
          </span>
          <span className="flex items-center gap-1 text-accent">
            <I.Clock size={10} /> target {clip.target_seconds.toFixed(2)}s
          </span>
        </span>
      </div>

      <div className="p-4 font-mono text-sm">
        {/* Chapter heading */}
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase text-muted">chapter</div>
            <h2 className="mt-1 truncate text-xl font-medium text-fg">{clip.chapter}</h2>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase text-muted">target</div>
            <div className="mt-1 font-mono text-xl text-accent">
              {clip.target_seconds.toFixed(2)}
              <span className="ml-1 text-xs text-accent/60">s</span>
            </div>
          </div>
        </div>

        {/* Hint */}
        <div className="mt-4">
          <label className="flex items-center gap-1.5 text-[11px] uppercase text-muted">
            <I.Info size={11} /> hint
          </label>
          <p className="mt-1 rounded border border-border bg-panel/40 p-2.5 text-xs text-muted">
            {clip.hint || "(none — Claude will improvise from segment moments)"}
          </p>
        </div>

        {/* Narration */}
        <div className="mt-4">
          <label className="flex items-center justify-between text-[11px] uppercase text-muted">
            <span className="flex items-center gap-1.5">
              <I.Pencil size={11} /> narration
            </span>
            {dirty && (
              <span className="flex items-center gap-1 normal-case text-[10px] text-accent2">
                <I.CirclePlay size={10} /> unsaved
              </span>
            )}
          </label>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
            rows={5}
            placeholder="// click a chapter — claude will seed this from segment moments"
            className="mt-1 w-full rounded border border-border bg-panel p-3 font-mono text-sm leading-relaxed text-fg focus:border-accent focus:outline-none"
          />
        </div>

        {/* Audio / waveform */}
        <div className="mt-4 rounded border border-border bg-panel/40 p-3">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-[11px] uppercase text-muted">
              <I.Waves size={11} /> audio · {clip.id}.mp3
            </label>
            <button
              onClick={togglePlay}
              className="flex items-center gap-1.5 rounded border border-border px-2 py-0.5 text-[10px] uppercase text-muted hover:border-accent hover:text-accent"
              title="Play / pause"
            >
              {playing ? <I.Pause size={10} /> : <I.Play size={10} />}
              <span>{playing ? "pause" : "play"}</span>
            </button>
          </div>
          <audio
            ref={audioRef}
            key={audioUrl}
            src={audioUrl}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            controls
            className="mt-2 w-full"
          />
        </div>

        {/* Caption preview */}
        {chunks.length > 0 && text && (
          <div className="mt-4">
            <label className="flex items-center gap-1.5 text-[11px] uppercase text-muted">
              <I.Captions size={11} /> caption preview
              <span className="normal-case text-muted/60">· split ≈ 3 words</span>
            </label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chunks.map((c, i) => (
                <span
                  key={i}
                  className="rounded border border-border bg-panel px-2 py-0.5 text-[11px] text-fg"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            onClick={save}
            disabled={!dirty}
            className="flex items-center gap-1.5 rounded border border-border bg-panel px-3 py-1.5 text-xs hover:border-accent hover:text-accent disabled:opacity-40"
          >
            <I.Save size={12} /> SAVE
          </button>
          <button
            onClick={() => regen("tts")}
            disabled={activeRun !== null}
            className="flex items-center gap-1.5 rounded border border-border bg-panel px-3 py-1.5 text-xs hover:border-accent hover:text-accent disabled:opacity-40"
          >
            <I.Mic size={12} /> REGEN AUDIO
          </button>
          <button
            onClick={() => regen("caption")}
            disabled={activeRun !== null}
            className="flex items-center gap-1.5 rounded border border-border bg-panel px-3 py-1.5 text-xs hover:border-accent hover:text-accent disabled:opacity-40"
          >
            <I.Captions size={12} /> REGEN CAPTIONS
          </button>
          <button
            onClick={() => regen("render")}
            disabled={activeRun !== null}
            className="flex items-center gap-1.5 rounded border border-accent2 bg-accent2/10 px-3 py-1.5 text-xs text-accent2 hover:bg-accent2/20 disabled:opacity-40"
          >
            <I.RefreshCw size={12} /> RE-RENDER
          </button>
        </div>
      </div>
    </div>
  );
}
