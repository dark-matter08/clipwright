// Add Source dialog — SRS F-UPL-3 multi-source + multi-video.
//
// Two modes when the project already has at least one video:
//   1. "Append to current video" — adds the new source's segments to the
//      currently-loaded video's timeline (B-roll, intercut footage).
//   2. "Start a new video" — creates a new video deliverable inside the
//      project (e.g. Chapter 2 Recap in a manhwa-recap project).

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { addSource, pickVideoFile } from "../lib/tauri";
import { nextSuffixedId } from "../lib/timeline";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

interface Props {
  onClose: () => void;
}

type Mode = "append" | "new-video";

export function AddSourceDialog({ onClose }: Props) {
  const project = useApp((s) => s.project);
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const [mode, setMode] = useState<Mode>("append");
  const [videoPath, setVideoPath] = useState<string>("");
  const [newVideoId, setNewVideoId] = useState<string>("");
  const [newVideoTitle, setNewVideoTitle] = useState<string>("");
  const [autoSegment, setAutoSegment] = useState(true);
  const [sceneDetection, setSceneDetection] = useState(true);
  const [busy, setBusy] = useState(false);

  // When mode flips or the project changes, pre-fill a sensible new video id.
  useEffect(() => {
    if (mode !== "new-video" || !project) return;
    const existing = project.videos.map((v) => v.video_id);
    const seed = suggestVideoId(existing);
    if (!newVideoId) setNewVideoId(seed);
  }, [mode, project, newVideoId]);

  if (!project) return null;
  const currentVideoId = project.current_video_id;
  const submitDisabled =
    !videoPath ||
    busy ||
    (mode === "append" && !currentVideoId) ||
    (mode === "new-video" && !isValidVideoId(newVideoId));

  async function onPick() {
    const p = await pickVideoFile();
    if (p) setVideoPath(p);
  }

  async function onSubmit() {
    if (submitDisabled) return;
    setBusy(true);
    try {
      const targetVideoId =
        mode === "append" ? currentVideoId! : sanitizeVideoId(newVideoId);
      const state = await addSource({
        videoPath,
        projectDir: project!.project_dir,
        videoId: targetVideoId,
        videoTitle: mode === "new-video" ? newVideoTitle : "",
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

  const currentTitle = project.videos.find((v) => v.video_id === currentVideoId)?.title ?? currentVideoId;

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
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs uppercase tracking-wider text-fg-muted">Mode</span>
            <div className="grid grid-cols-2 gap-2">
              <ModeCard
                active={mode === "append"}
                onClick={() => setMode("append")}
                title="Add to current video"
                sub={currentVideoId ? `${currentTitle} (${currentVideoId})` : "no video open"}
                disabled={!currentVideoId}
              />
              <ModeCard
                active={mode === "new-video"}
                onClick={() => setMode("new-video")}
                title="Start a new video"
                sub="New deliverable inside this project"
              />
            </div>
          </div>

          <FieldRow label="Video file">
            <PathPicker value={videoPath} buttonLabel="Choose…" onPick={onPick}
                        placeholder="No file selected" />
          </FieldRow>

          {mode === "new-video" && (
            <>
              <FieldRow label="Video id">
                <TextInput value={newVideoId} onChange={setNewVideoId}
                           placeholder="chapter-2-recap" monospace />
                {!isValidVideoId(newVideoId) && newVideoId !== "" && (
                  <p className="mt-1 text-[11px] text-warn">
                    Must match <code className="font-mono">[a-z][a-z0-9_-]*</code> and be unique.
                  </p>
                )}
              </FieldRow>
              <FieldRow label="Video title">
                <TextInput value={newVideoTitle} onChange={setNewVideoTitle}
                           placeholder="Chapter 2 — The Return" />
              </FieldRow>
            </>
          )}

          <FieldRow label="Segmentation">
            <div className="flex flex-col gap-1.5 text-xs">
              <Checkbox checked={autoSegment} onChange={setAutoSegment}
                        label="Auto-segment" />
              <Checkbox checked={sceneDetection} onChange={setSceneDetection}
                        disabled={!autoSegment} label="Scene-change detection" />
            </div>
          </FieldRow>

          {busy && (
            <div className="flex items-center gap-2 rounded bg-bg-inset px-3 py-2 text-xs text-fg-muted">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" />
              {mode === "new-video" ? "Creating new video…" : "Adding source…"}
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
            {busy ? "Adding…" : mode === "new-video" ? "Create video" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ModeCard({
  active,
  onClick,
  title,
  sub,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  sub: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col items-start gap-0.5 rounded border p-3 text-left transition-colors",
        active
          ? "border-accent bg-bg-raised text-fg"
          : "border-border-subtle bg-bg-subtle text-fg-subtle hover:border-border",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="text-[11px] text-fg-muted">{sub}</span>
    </button>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[100px_1fr] items-start gap-3">
      <span className="pt-1.5 text-xs text-fg-muted">{label}</span>
      <div>{children}</div>
    </label>
  );
}

function PathPicker({
  value, placeholder, buttonLabel, onPick,
}: {
  value: string; placeholder: string; buttonLabel: string; onPick: () => void;
}) {
  return (
    <div className="flex items-stretch gap-1.5">
      <input
        type="text"
        readOnly
        value={value}
        placeholder={placeholder}
        className="w-full truncate rounded border border-border-subtle bg-bg-inset px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted"
      />
      <button
        type="button"
        onClick={onPick}
        className="shrink-0 rounded border border-border-subtle bg-bg-raised px-3 text-xs text-fg-subtle transition-colors hover:bg-bg-inset hover:text-fg focus:focus-ring"
      >
        {buttonLabel}
      </button>
    </div>
  );
}

function TextInput({
  value, onChange, placeholder, monospace,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string; monospace?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring",
        monospace && "font-mono",
      )}
    />
  );
}

function Checkbox({
  checked, onChange, label, disabled,
}: {
  checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean;
}) {
  return (
    <label className={cn("flex cursor-pointer items-center gap-2 text-fg-subtle",
                          disabled && "cursor-not-allowed opacity-50")}>
      <input type="checkbox" checked={checked} disabled={disabled}
             onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Video-id helpers (mirror Python's _sanitize_video_id / next_video_id)
// ---------------------------------------------------------------------------

const VIDEO_ID_RE = /^[a-z][a-z0-9_-]*$/;

function isValidVideoId(id: string): boolean {
  return VIDEO_ID_RE.test(id);
}

function sanitizeVideoId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function suggestVideoId(existing: string[]): string {
  // Use nextSuffixedId is for segments, not videos. Inline a video-N picker.
  const taken = new Set(existing);
  if (!taken.has("video-1") && existing.length === 0) return "video-1";
  for (let i = 2; i < 1000; i++) {
    const candidate = `chapter-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return "chapter-x";
}

// Suppress unused-import lint — keep available for future video-id auto-suggest.
void nextSuffixedId;
