// Render dialog — SRS §F-RND-3 + §8.5.1's [▶ Render] CTA.
//
// Triggers `clipwright render-final` which renders each segment (using
// per-segment cache when possible) and concats into `out/final.mp4`.
// Surfaces the path on success so users can reveal it in Finder.

import { useState } from "react";
import { renderFinal } from "../lib/tauri";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

interface Props {
  onClose: () => void;
}

export function RenderDialog({ onClose }: Props) {
  const project = useApp((s) => s.project);
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ path: string } | null>(null);
  const [force, setForce] = useState(false);

  if (!project || !project.video) return null;
  const video = project.video;
  const segs = video.segments;

  async function start() {
    setBusy(true);
    try {
      const r = await renderFinal(project!.project_dir, video.video_id, force);
      loadProject(r.project);
      setDone({ path: r.final_path });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-bg shadow-2xl">
        <header className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <h2 className="text-base font-medium">Render</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-3 px-5 py-4">
          {done ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-ok">✓ Rendered to:</p>
              <code className="rounded bg-bg-inset px-2 py-1.5 font-mono text-[11px] text-fg">
                {done.path}
              </code>
              <p className="text-xs text-fg-muted">
                Reveal it in Finder, or run{" "}
                <code className="font-mono">clipwright render-final --project {project.project_dir}</code>{" "}
                from a terminal to reproduce.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-fg-subtle">
                Will render {segs.length} segment{segs.length === 1 ? "" : "s"} and
                concat to <code className="font-mono">out/final.mp4</code>.
                Per-segment caches mean only edited segments re-render.
              </p>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-fg-subtle">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  className="accent-accent"
                />
                Force re-render every segment (bypass cache)
              </label>
              {busy && (
                <div className="flex items-center gap-2 rounded bg-bg-inset px-3 py-2 text-xs text-fg-muted">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
                  Rendering — this may take a while on the first pass.
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
          >
            {done ? "Close" : "Cancel"}
          </button>
          {!done && (
            <button
              type="button"
              onClick={start}
              disabled={busy || segs.length === 0}
              className={cn(
                "rounded px-4 py-1.5 text-xs font-medium transition-colors",
                "disabled:cursor-not-allowed disabled:bg-bg-raised disabled:text-fg-muted",
                "enabled:bg-accent enabled:text-bg enabled:hover:bg-accent-hover",
              )}
            >
              {busy ? "Rendering…" : "Render"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
