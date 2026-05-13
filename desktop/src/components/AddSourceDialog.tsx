// Add Source dialog — SRS F-UPL-3 multi-source.
//
// Triggered from the TopBar when a project is open. Picks a video,
// invokes `clipwright import --add` via the Tauri command, and reloads
// the project so the new segments appear at the end of the timeline.

import { useState } from "react";
import { addSource, pickVideoFile } from "../lib/tauri";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

interface Props {
  onClose: () => void;
}

export function AddSourceDialog({ onClose }: Props) {
  const project = useApp((s) => s.project);
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const [videoPath, setVideoPath] = useState<string>("");
  const [autoSegment, setAutoSegment] = useState(true);
  const [sceneDetection, setSceneDetection] = useState(true);
  const [busy, setBusy] = useState(false);

  if (!project) return null;
  const submitDisabled = !videoPath || busy;

  async function onPick() {
    const p = await pickVideoFile();
    if (p) setVideoPath(p);
  }

  async function onSubmit() {
    if (submitDisabled) return;
    setBusy(true);
    try {
      const state = await addSource({
        videoPath,
        projectDir: project!.project_dir,
        autoSegment,
        sceneDetection,
      });
      loadProject(state);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-xl rounded-lg border border-border bg-bg shadow-2xl">
        <header className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <h2 className="text-base font-medium">Add source</h2>
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
          <p className="text-xs text-fg-muted">
            Append another video to <span className="font-mono">{project.project.title}</span>.
            New segments land at the end of the timeline; existing edits are
            untouched. The file becomes a sibling under{" "}
            <code className="font-mono">sources/</code> — assign segments to it
            from the Inspector's Trim group.
          </p>

          <label className="grid grid-cols-[100px_1fr] items-start gap-3">
            <span className="pt-1.5 text-xs text-fg-muted">Video file</span>
            <div className="flex items-stretch gap-1.5">
              <input
                type="text"
                readOnly
                value={videoPath}
                placeholder="No file selected"
                className="w-full truncate rounded border border-border-subtle bg-bg-inset px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted"
              />
              <button
                type="button"
                onClick={onPick}
                className="shrink-0 rounded border border-border-subtle bg-bg-raised px-3 text-xs text-fg-subtle transition-colors hover:bg-bg-inset hover:text-fg focus:focus-ring"
              >
                Choose…
              </button>
            </div>
          </label>

          <label className="grid grid-cols-[100px_1fr] items-start gap-3">
            <span className="pt-1.5 text-xs text-fg-muted">Segmentation</span>
            <div className="flex flex-col gap-1.5 text-xs">
              <label className="flex cursor-pointer items-center gap-2 text-fg-subtle">
                <input
                  type="checkbox"
                  checked={autoSegment}
                  onChange={(e) => setAutoSegment(e.target.checked)}
                  className="accent-accent"
                />
                Auto-segment
              </label>
              <label
                className={cn(
                  "flex cursor-pointer items-center gap-2 text-fg-subtle",
                  !autoSegment && "cursor-not-allowed opacity-50",
                )}
              >
                <input
                  type="checkbox"
                  checked={sceneDetection}
                  disabled={!autoSegment}
                  onChange={(e) => setSceneDetection(e.target.checked)}
                  className="accent-accent"
                />
                Scene-change detection
              </label>
            </div>
          </label>

          {busy && (
            <div className="flex items-center gap-2 rounded bg-bg-inset px-3 py-2 text-xs text-fg-muted">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
              Importing — auto-segmentation runs ffmpeg silence + scene detection.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled}
            className={cn(
              "rounded px-4 py-1.5 text-xs font-medium transition-colors",
              "disabled:cursor-not-allowed disabled:bg-bg-raised disabled:text-fg-muted",
              "enabled:bg-accent enabled:text-bg enabled:hover:bg-accent-hover",
            )}
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
