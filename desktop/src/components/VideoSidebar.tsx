// Videos sidebar — far-left rail of the Workspace.
//
// Lists every video in the project. Click to switch the editor's focus.
// "+ New video" creates an empty video manifest and switches to it. The
// sidebar collapses to a thin strip via the title-bar toggle (icon-only
// when collapsed); on small windows it auto-collapses.

import { useMemo, useState } from "react";
import { createVideo } from "../lib/tauri";
import { sanitizeVideoId } from "../lib/timeline";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { RecordVideoDialog } from "./RecordVideoDialog";

export function VideoSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const project = useApp((s) => s.project);
  const switchVideo = useApp((s) => s.switchVideo);
  const setError = useApp((s) => s.setError);
  const [creating, setCreating] = useState(false);
  const [draftId, setDraftId] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [recordOpen, setRecordOpen] = useState(false);

  if (!project) return null;
  const current = project.current_video_id;

  async function onCreate() {
    const sanitized = sanitizeVideoId(draftId);
    if (!sanitized) return;
    try {
      await createVideo(project!.project_dir, sanitized, draftTitle.trim());
      // Switch into the new video; this also reloads the project state.
      await switchVideo(sanitized);
      setCreating(false);
      setDraftId("");
      setDraftTitle("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={`${project.videos.length} video${project.videos.length === 1 ? "" : "s"} — click to expand`}
        className="flex h-full w-full flex-col items-center justify-start gap-2 border-r border-border-subtle bg-bg-subtle py-3 text-fg-muted transition-colors hover:text-fg"
      >
        <span className="text-base">📹</span>
        <span className="font-mono text-[10px]">{project.videos.length}</span>
      </button>
    );
  }

  return (
    <aside className="flex h-full w-full flex-col border-r border-border-subtle bg-bg-subtle">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle px-3">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          Videos · {project.videos.length}
        </span>
        <button
          type="button"
          onClick={onToggle}
          title="Collapse"
          className="text-fg-muted transition-colors hover:text-fg"
        >
          ◀
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {project.videos.length === 0 && !creating && (
          <p className="px-2 py-1 text-xs text-fg-muted">
            No videos yet. Click "+ New" or import a video.
          </p>
        )}
        <ul className="flex flex-col gap-0.5">
          {project.videos.map((v) => (
            <li key={v.video_id}>
              <button
                type="button"
                onClick={() => void switchVideo(v.video_id)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors",
                  v.video_id === current
                    ? "bg-accent/15 text-fg"
                    : "text-fg-subtle hover:bg-bg-raised hover:text-fg",
                )}
              >
                <span className="truncate text-sm font-medium">{v.title || v.video_id}</span>
                <span className="font-mono text-[10px] text-fg-muted">
                  {v.video_id} · {v.n_segments} segment{v.n_segments === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="shrink-0 border-t border-border-subtle p-2">
        {creating ? (
          <CreateForm
            draftId={draftId}
            draftTitle={draftTitle}
            setDraftId={setDraftId}
            setDraftTitle={setDraftTitle}
            onCancel={() => setCreating(false)}
            onCreate={onCreate}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="w-full rounded border border-border-subtle bg-bg px-2 py-1.5 text-xs text-fg-subtle transition-colors hover:bg-bg-raised hover:text-fg focus:focus-ring"
            >
              + New video (empty)
            </button>
            <button
              type="button"
              onClick={() => setRecordOpen(true)}
              className="w-full rounded border border-border-subtle bg-bg px-2 py-1.5 text-xs text-fg-subtle transition-colors hover:bg-bg-raised hover:text-fg focus:focus-ring"
              title="Drive Playwright into a new video"
            >
              + Record video
            </button>
          </div>
        )}
      </div>
      {recordOpen && <RecordVideoDialog onClose={() => setRecordOpen(false)} />}
    </aside>
  );
}

function CreateForm({
  draftId,
  draftTitle,
  setDraftId,
  setDraftTitle,
  onCancel,
  onCreate,
}: {
  draftId: string;
  draftTitle: string;
  setDraftId: (v: string) => void;
  setDraftTitle: (v: string) => void;
  onCancel: () => void;
  onCreate: () => void | Promise<void>;
}) {
  const sanitized = useMemo(() => sanitizeVideoId(draftId), [draftId]);
  const showPreview = !!draftId.trim() && sanitized !== draftId;
  const canCreate = !!sanitized;
  return (
    <div className="flex flex-col gap-1.5">
      <input
        type="text"
        value={draftId}
        onChange={(e) => setDraftId(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canCreate) void onCreate();
          if (e.key === "Escape") onCancel();
        }}
        autoFocus
        placeholder="chapter-2-recap"
        className="w-full rounded border border-border-subtle bg-bg-inset px-2 py-1 font-mono text-xs text-fg placeholder:text-fg-muted focus:focus-ring"
      />
      {showPreview && (
        <p className="font-mono text-[10px] text-fg-muted">
          will be created as <span className="text-accent">{sanitized}</span>
        </p>
      )}
      {!!draftId.trim() && !sanitized && (
        <p className="font-mono text-[10px] text-warn">
          id must start with a letter; pick a different name
        </p>
      )}
      <input
        type="text"
        value={draftTitle}
        onChange={(e) => setDraftTitle(e.target.value)}
        placeholder="Title (optional)"
        className="w-full rounded border border-border-subtle bg-bg-inset px-2 py-1 text-xs text-fg placeholder:text-fg-muted focus:focus-ring"
      />
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-0.5 text-[11px] text-fg-muted hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={!canCreate}
          className="rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-bg disabled:bg-bg-raised disabled:text-fg-muted hover:bg-accent-hover"
        >
          Create
        </button>
      </div>
    </div>
  );
}
