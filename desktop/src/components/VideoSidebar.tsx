// Videos sidebar — far-left rail of the Workspace.
//
// Lists every video in the project. Click to switch the editor's focus.
// "+ New video" creates an empty video manifest and switches to it. The
// sidebar collapses to a thin strip via the title-bar toggle (icon-only
// when collapsed); on small windows it auto-collapses.

import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  Film,
  Plus,
  Trash2,
  Video as VideoIcon,
} from "lucide-react";
import { createVideo, listSkills, type Skill } from "../lib/tauri";
import { sanitizeVideoId } from "../lib/timeline";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { RecordVideoDialog } from "./RecordVideoDialog";

export function VideoSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const project = useApp((s) => s.project);
  const switchVideo = useApp((s) => s.switchVideo);
  const deleteVideo = useApp((s) => s.deleteVideo);
  const setError = useApp((s) => s.setError);
  const [creating, setCreating] = useState(false);
  const [draftId, setDraftId] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  // Pre-selected Claude Code skills to wire into the new video's
  // `recap_overrides.default_skills`. Empty by default; the user
  // checks them in the picker that appears after the title field.
  const [draftSkills, setDraftSkills] = useState<string[]>([]);
  const [recordOpen, setRecordOpen] = useState(false);
  // Currently-pending delete target. Non-null = ConfirmDialog open.
  // The dialog is the only path to actually invoke `deleteVideo`; the
  // trash button just stages the request.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  if (!project) return null;
  const current = project.current_video_id;
  const onlyVideo = project.videos.length <= 1;

  async function runDelete() {
    if (!deleteTarget) return;
    try {
      await deleteVideo(deleteTarget.id);
      setDeleteTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleteTarget(null);
    }
  }

  async function onCreate() {
    const sanitized = sanitizeVideoId(draftId);
    if (!sanitized) return;
    try {
      await createVideo(
        project!.project_dir,
        sanitized,
        draftTitle.trim(),
        draftSkills,
      );
      // Switch into the new video; this also reloads the project state.
      await switchVideo(sanitized);
      setCreating(false);
      setDraftId("");
      setDraftTitle("");
      setDraftSkills([]);
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
        <Film size={18} strokeWidth={1.75} />
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
          aria-label="Collapse videos sidebar"
          className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg"
        >
          <ChevronLeft size={14} strokeWidth={2} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {project.videos.length === 0 && !creating && (
          <p className="px-2 py-1 text-xs text-fg-muted">
            No videos yet. Click "+ New" or import a video.
          </p>
        )}
        <ul className="flex flex-col gap-0.5">
          {project.videos.map((v) => {
            const isCurrent = v.video_id === current;
            return (
              <li key={v.video_id} className="group relative">
                {/* Native `title` attribute on the button drives the
                 *  OS hover tooltip — long titles (e.g. "DemoRecap
                 *  — Pig Slaughtering") get truncated with ellipsis
                 *  in the row but are fully readable on hover. We
                 *  show both the title and the video_id in the
                 *  tooltip so the user always knows the on-disk
                 *  slug.
                 *
                 *  CSS gotcha: `truncate` on a flex child only kicks
                 *  in when the child has `min-w-0` so it can shrink
                 *  below its content width. Without it, the span
                 *  grows to fit "DemoRecap - Pig Slaughtering" on
                 *  one line and overflows or wraps. We add `min-w-0`
                 *  to the button (the flex parent of the title) AND
                 *  `w-full truncate` to each text span. */}
                <button
                  type="button"
                  onClick={() => void switchVideo(v.video_id)}
                  title={`${v.title || v.video_id}\n${v.video_id} · ${v.n_segments} segment${v.n_segments === 1 ? "" : "s"}`}
                  className={cn(
                    "flex w-full min-w-0 flex-col items-start gap-0.5 rounded py-1.5 pl-2 pr-7 text-left transition-colors",
                    isCurrent
                      ? "bg-accent/15 text-fg"
                      : "text-fg-subtle hover:bg-bg-raised hover:text-fg",
                  )}
                >
                  <span className="block w-full truncate text-sm font-medium">
                    {v.title || v.video_id}
                  </span>
                  <span className="block w-full truncate font-mono text-[10px] text-fg-muted">
                    {v.video_id} · {v.n_segments} segment{v.n_segments === 1 ? "" : "s"}
                  </span>
                </button>
                {/* Trash icon — hover-revealed on the row; click stages the
                 *  delete in `deleteTarget`, which opens the confirm dialog.
                 *  Disabled (with tooltip) when this is the last video. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onlyVideo) return;
                    setDeleteTarget({
                      id: v.video_id,
                      title: v.title || v.video_id,
                    });
                  }}
                  disabled={onlyVideo}
                  title={
                    onlyVideo
                      ? "Can't delete the project's only video. Create another first."
                      : "Delete this video"
                  }
                  className={cn(
                    "absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 transition-opacity",
                    "text-fg-muted opacity-0 hover:bg-bg-raised hover:text-warn group-hover:opacity-100 focus:opacity-100",
                    onlyVideo && "cursor-not-allowed hover:bg-transparent hover:text-fg-muted",
                  )}
                  aria-label={`Delete video ${v.video_id}`}
                >
                  <Trash2 size={14} strokeWidth={1.75} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="shrink-0 border-t border-border-subtle p-2">
        {creating ? (
          <CreateForm
            projectDir={project.project_dir}
            draftId={draftId}
            draftTitle={draftTitle}
            draftSkills={draftSkills}
            setDraftId={setDraftId}
            setDraftTitle={setDraftTitle}
            setDraftSkills={setDraftSkills}
            onCancel={() => {
              setCreating(false);
              setDraftSkills([]);
            }}
            onCreate={onCreate}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-1.5 rounded border border-border-subtle bg-bg px-2 py-1.5 text-xs text-fg-subtle transition-colors hover:bg-bg-raised hover:text-fg focus:focus-ring"
            >
              <Plus size={12} strokeWidth={2} />
              New video (empty)
            </button>
            <button
              type="button"
              onClick={() => setRecordOpen(true)}
              className="flex w-full items-center gap-1.5 rounded border border-border-subtle bg-bg px-2 py-1.5 text-xs text-fg-subtle transition-colors hover:bg-bg-raised hover:text-fg focus:focus-ring"
              title="Drive Playwright into a new video"
            >
              <VideoIcon size={12} strokeWidth={2} />
              Record video
            </button>
          </div>
        )}
      </div>
      {recordOpen && <RecordVideoDialog onClose={() => setRecordOpen(false)} />}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete video?"
        description={
          deleteTarget && (
            <span>
              About to delete{" "}
              <span className="font-medium text-fg">{deleteTarget.title}</span>{" "}
              <span className="font-mono text-[11px] text-fg-muted">
                ({deleteTarget.id})
              </span>{" "}
              and every per-video artifact it owns. This cannot be undone.
            </span>
          )
        }
        consequences={[
          "videos/<id>.json (manifest)",
          "voiceover/audio/<id>/ + voiceover/scripts/<id>.json",
          "captions/<id>/",
          "out/segments/<id>/ + out/final/<id>.mp4",
          "chat/sessions/<id>/ + .clipwright/claude-sessions/<id>.txt",
        ]}
        confirmLabel="Delete video"
        tone="danger"
        onConfirm={runDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </aside>
  );
}

function CreateForm({
  projectDir,
  draftId,
  draftTitle,
  draftSkills,
  setDraftId,
  setDraftTitle,
  setDraftSkills,
  onCancel,
  onCreate,
}: {
  projectDir: string;
  draftId: string;
  draftTitle: string;
  draftSkills: string[];
  setDraftId: (v: string) => void;
  setDraftTitle: (v: string) => void;
  setDraftSkills: (v: string[]) => void;
  onCancel: () => void;
  onCreate: () => void | Promise<void>;
}) {
  const sanitized = useMemo(() => sanitizeVideoId(draftId), [draftId]);
  const showPreview = !!draftId.trim() && sanitized !== draftId;
  const canCreate = !!sanitized;

  // Pull the skill catalog once on mount. The list is small (dozens
  // at most) and the form is short-lived, so we don't bother caching
  // beyond the component's lifecycle. Empty list silently falls
  // through to "no skill picker shown" — the user can still create
  // the video, just without pre-selecting any.
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    let cancelled = false;
    setSkillsLoading(true);
    listSkills(projectDir)
      .then((list) => {
        if (cancelled) return;
        setSkills(list);
      })
      .catch(() => {
        if (cancelled) return;
        setSkills([]);
      })
      .finally(() => {
        if (cancelled) return;
        setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  const filteredSkills = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [skills, filter]);

  function toggleSkill(name: string) {
    if (draftSkills.includes(name)) {
      setDraftSkills(draftSkills.filter((n) => n !== name));
    } else {
      setDraftSkills([...draftSkills, name]);
    }
  }

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

      {/* Skill picker — only renders when we found at least one
       *  skill on disk. The list scrolls; selected skills surface
       *  as small chips above the filter so the user can de-select
       *  without scrolling back to find them. */}
      {!skillsLoading && skills.length > 0 && (
        <div className="mt-1 flex flex-col gap-1 rounded border border-border-subtle bg-bg-inset p-1.5">
          <div className="flex items-center justify-between text-[10px] text-fg-muted">
            <span className="uppercase tracking-wider">
              Default skills · {draftSkills.length}/{skills.length}
            </span>
            {draftSkills.length > 0 && (
              <button
                type="button"
                onClick={() => setDraftSkills([])}
                className="text-fg-muted hover:text-fg"
              >
                clear
              </button>
            )}
          </div>
          {draftSkills.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {draftSkills.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggleSkill(name)}
                  title={`Remove ${name}`}
                  className="flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent hover:bg-accent/25"
                >
                  {name}
                  <span className="text-fg-muted">×</span>
                </button>
              ))}
            </div>
          )}
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter skills…"
            className="w-full rounded border border-border-subtle bg-bg px-1.5 py-0.5 text-[11px] text-fg placeholder:text-fg-muted focus:focus-ring"
          />
          <div className="max-h-40 overflow-y-auto rounded">
            {filteredSkills.length === 0 ? (
              <p className="px-1 py-1 text-[10px] text-fg-muted">
                No skills match "{filter}".
              </p>
            ) : (
              <ul className="flex flex-col">
                {filteredSkills.map((s) => {
                  const checked = draftSkills.includes(s.name);
                  return (
                    <li key={`${s.source}-${s.name}`}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-start gap-1.5 rounded px-1 py-0.5 transition-colors",
                          checked ? "bg-accent/10" : "hover:bg-bg-raised",
                        )}
                        title={s.description}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSkill(s.name)}
                          className="mt-[3px] accent-accent"
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="font-mono text-[11px] text-fg">
                            {s.name}
                            <span className="ml-1 text-[9px] uppercase tracking-wider text-fg-muted">
                              · {s.source}
                            </span>
                          </span>
                          {s.description && (
                            <span className="line-clamp-2 text-[10px] text-fg-muted">
                              {s.description}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <p className="text-[9px] text-fg-muted/70">
            Pre-selected skills get surfaced in Claude's system prompt
            for this video so they're invoked early in each turn.
          </p>
        </div>
      )}

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
