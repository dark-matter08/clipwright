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
  Search,
  Trash2,
  Video as VideoIcon,
  X,
} from "lucide-react";
import { createVideo, listSkills, type Skill } from "../lib/tauri";
import type { VideoMeta } from "../lib/types";
import { sanitizeVideoId } from "../lib/timeline";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { RecordVideoDialog } from "./RecordVideoDialog";

export function VideoSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const project = useApp((s) => s.project);
  // A video is "running" when it has an in-flight Claude turn. Turns are
  // per-video and survive switching away, so at two dozen videos the
  // ones actually working on something have to be findable without
  // scrolling the whole list.
  const chatRuntime = useApp((s) => s.chatRuntime);
  const [query, setQuery] = useState("");
  const [grouping, setGrouping] = useState<Grouping>("running");
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

  const running = project.videos.filter((v) => chatRuntime[v.video_id]?.busy);
  const projectPersona = project.project.persona_id ?? "";
  const matching = project.videos.filter((v) => matchesQuery(v, query));
  const groups = groupVideos(matching, grouping, chatRuntime, projectPersona);

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
        title={
          `${project.videos.length} video${project.videos.length === 1 ? "" : "s"}` +
          (running.length > 0 ? ` · ${running.length} running` : "") +
          " — click to expand"
        }
        className="flex h-full w-full flex-col items-center justify-start gap-2 border-r border-border-subtle bg-bg-subtle py-3 text-fg-muted transition-colors hover:text-fg"
      >
        <span className="relative">
          <Film size={18} strokeWidth={1.75} />
          {/* Collapsing the sidebar shouldn't hide the fact that Claude
           *  is mid-turn somewhere — that's exactly when you'd wonder
           *  whether to wait. */}
          {running.length > 0 && (
            <span className="absolute -right-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-accent" />
          )}
        </span>
        <span className="font-mono text-[10px]">{project.videos.length}</span>
        {running.length > 0 && (
          <span className="font-mono text-[9px] text-accent">
            {running.length}▶
          </span>
        )}
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
        {project.videos.length > 0 && (
          <div className="mb-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-1 rounded border border-border-subtle bg-bg-inset px-1.5">
              <Search size={11} strokeWidth={2} className="shrink-0 text-fg-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search videos…"
                className="min-w-0 flex-1 bg-transparent py-1 text-xs text-fg placeholder:text-fg-muted focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="shrink-0 text-fg-muted hover:text-fg"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-0.5">
              {GROUPINGS.map((g) => (
                <button
                  key={g.value}
                  type="button"
                  onClick={() => setGrouping(g.value)}
                  title={g.hint}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                    grouping === g.value
                      ? "bg-accent/15 text-fg"
                      : "text-fg-muted hover:bg-bg-raised hover:text-fg",
                  )}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {matching.length === 0 && project.videos.length > 0 && (
          <p className="px-2 py-1 text-xs text-fg-muted">
            No videos match "{query}".
          </p>
        )}

        {groups.map((group) => (
          <section key={group.label} className="mb-2">
            {/* The header is dropped when there's only one bucket — a
             *  lone "Idle · 24" heading over the whole list is noise. */}
            {groups.length > 1 && (
              <h3
                className={cn(
                  "px-2 pb-1 text-[10px] font-medium uppercase tracking-wider",
                  group.label === "Running" ? "text-accent" : "text-fg-muted",
                )}
              >
                {group.label} · {group.items.length}
              </h3>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.items.map((v) => (
                <VideoRow
                  key={v.video_id}
                  video={v}
                  isCurrent={v.video_id === current}
                  onlyVideo={onlyVideo}
                  startedAt={chatRuntime[v.video_id]?.busyStartedAt ?? null}
                  onSelect={() => void switchVideo(v.video_id)}
                  onDelete={() =>
                    setDeleteTarget({ id: v.video_id, title: v.title || v.video_id })
                  }
                />
              ))}
            </ul>
          </section>
        ))}
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

// ---------------------------------------------------------------------------
// Search + grouping
// ---------------------------------------------------------------------------

/** How to bucket the list.
 *
 *  No "template" option: templates bind at the *project* level, so every
 *  video in one project shares them and the grouping would always
 *  produce a single bucket. Add it the day per-video templates exist. */
export type Grouping = "running" | "created" | "persona" | "status";

const GROUPINGS: { value: Grouping; label: string; hint: string }[] = [
  { value: "running", label: "Activity", hint: "What Claude is working on now" },
  { value: "created", label: "Date", hint: "When the video was created" },
  { value: "persona", label: "Persona", hint: "Which persona writes it" },
  { value: "status", label: "Status", hint: "How far through the build it is" },
];

function matchesQuery(v: VideoMeta, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    v.title.toLowerCase().includes(q) || v.video_id.toLowerCase().includes(q)
  );
}

/** Build status from the cheap signals we already have. A real answer
 *  would run the doctor per video; at two dozen videos that's two dozen
 *  subprocesses to render a sidebar. Segment count and the presence of
 *  a final render separate the states that matter when you're deciding
 *  what to work on next. */
function statusOf(v: VideoMeta): string {
  if (v.n_segments === 0) return "Empty";
  if (v.has_final) return "Rendered";
  return "In progress";
}

function dateBucket(createdAt: number): string {
  if (!createdAt) return "Undated";
  const days = (Date.now() / 1000 - createdAt) / 86400;
  if (days < 1) return "Today";
  if (days < 7) return "This week";
  if (days < 30) return "This month";
  return "Older";
}

const ORDER: Record<Grouping, string[]> = {
  running: ["Running", "Idle"],
  created: ["Today", "This week", "This month", "Older", "Undated"],
  status: ["In progress", "Rendered", "Empty"],
  persona: [],
};

export function groupVideos(
  videos: VideoMeta[],
  grouping: Grouping,
  chatRuntime: Record<string, { busy?: boolean }>,
  projectPersona: string,
): { label: string; items: VideoMeta[] }[] {
  const buckets = new Map<string, VideoMeta[]>();
  for (const v of videos) {
    let key: string;
    switch (grouping) {
      case "running":
        key = chatRuntime[v.video_id]?.busy ? "Running" : "Idle";
        break;
      case "created":
        key = dateBucket(v.created_at);
        break;
      case "status":
        key = statusOf(v);
        break;
      case "persona":
        key = v.persona_id || projectPersona || "No persona";
        break;
    }
    const list = buckets.get(key);
    if (list) list.push(v);
    else buckets.set(key, [v]);
  }

  const known = ORDER[grouping];
  const keys = [...buckets.keys()].sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    // Known buckets keep their declared order (Today before Older);
    // anything else — persona names — sorts alphabetically, with the
    // "no persona" catch-all last since it's the absence of a choice.
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    if (a === "No persona") return 1;
    if (b === "No persona") return -1;
    return a.localeCompare(b);
  });

  return keys.map((label) => ({ label, items: buckets.get(label) ?? [] }));
}


/** One video in the list.
 *
 *  Extracted when the list grew groups — the row markup was inline in a
 *  `.map()` and would have had to be duplicated across Running and Idle.
 *
 *  CSS gotcha preserved from the inline version: `truncate` on a flex
 *  child only kicks in when the child can shrink below its content
 *  width, so the button needs `min-w-0` and each text span needs
 *  `w-full truncate`. Without it a long manhwa title overflows the rail
 *  instead of ellipsing. */
function VideoRow({
  video: v,
  isCurrent,
  onlyVideo,
  startedAt,
  onSelect,
  onDelete,
}: {
  video: VideoMeta;
  isCurrent: boolean;
  onlyVideo: boolean;
  /** Non-null while a Claude turn is in flight — drives the badge. */
  startedAt: number | null;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const running = startedAt !== null;
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onSelect}
        title={`${v.title || v.video_id}\n${v.video_id} · ${v.n_segments} segment${v.n_segments === 1 ? "" : "s"}${running ? "\nClaude is working on this video" : ""}`}
        className={cn(
          "flex w-full min-w-0 flex-col items-start gap-0.5 rounded py-1.5 pl-2 pr-7 text-left transition-colors",
          isCurrent
            ? "bg-accent/15 text-fg"
            : "text-fg-subtle hover:bg-bg-raised hover:text-fg",
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          {running && <RunningBadge startedAt={startedAt} />}
          <span className="block min-w-0 flex-1 truncate text-sm font-medium">
            {v.title || v.video_id}
          </span>
        </span>
        <span className="block w-full truncate font-mono text-[10px] text-fg-muted">
          {v.video_id} · {v.n_segments} segment{v.n_segments === 1 ? "" : "s"}
        </span>
      </button>
      {/* Trash icon — hover-revealed on the row; click stages the delete
       *  in `deleteTarget`, which opens the confirm dialog. Disabled
       *  (with tooltip) when this is the last video. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (onlyVideo) return;
          onDelete();
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
}

/** Pulsing dot + elapsed seconds for a video with a turn in flight.
 *
 *  The elapsed count is the point: a dot alone tells you something is
 *  happening, but not whether it's been thinking for four seconds or
 *  four minutes — which is the difference between waiting and going to
 *  look at what's stuck. */
function RunningBadge({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
  );
  useEffect(() => {
    setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    const id = window.setInterval(
      () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))),
      1000,
    );
    return () => window.clearInterval(id);
  }, [startedAt]);

  const label = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m` : `${elapsed}s`;
  return (
    <span
      title={`Claude has been working for ${elapsed}s`}
      className="flex shrink-0 items-center gap-1 rounded bg-accent/15 px-1 py-px font-mono text-[9px] text-accent"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      {label}
    </span>
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

  // Group by source so the skills that ship with the repo — the
  // vendored Remotion set, which is what you actually want on a video
  // whose render backend IS Remotion — sit at the top instead of
  // sorting alphabetically into the middle of ~50 user-level skills.
  // Without this you had to know a skill's name to filter for it.
  const skillGroups = useMemo(
    () =>
      [
        {
          key: "project" as const,
          label: "Project",
          hint: "Vendored in this repo — Remotion skills live here",
        },
        {
          key: "user" as const,
          label: "User",
          hint: "From ~/.claude/skills",
        },
      ]
        .map((g) => ({
          ...g,
          items: filteredSkills.filter((s) => s.source === g.key),
        }))
        .filter((g) => g.items.length > 0),
    [filteredSkills],
  );

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
          <div className="max-h-56 overflow-y-auto rounded">
            {filteredSkills.length === 0 ? (
              <p className="px-1 py-1 text-[10px] text-fg-muted">
                No skills match "{filter}".
              </p>
            ) : (
              skillGroups.map((group) => (
                <section key={group.key}>
                  {/* Sticky so the group stays identifiable while you
                   *  scroll a long user-level list. */}
                  <h4
                    title={group.hint}
                    className="sticky top-0 z-10 bg-bg-inset px-1 pb-0.5 pt-1 text-[9px] uppercase tracking-wider text-fg-muted"
                  >
                    {group.label} · {group.items.length}
                  </h4>
                  <ul className="flex flex-col">
                    {group.items.map((s) => {
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
                </section>
              ))
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
