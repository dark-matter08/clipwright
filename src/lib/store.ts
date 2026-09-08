// Zustand store. Holds the currently-open project, the currently-loaded
// video inside it, selected segment, undo/redo stacks, and view state.
//
// v2 schema introduces a two-level hierarchy: a project contains N videos
// and each video has its own timeline. The store models that by keeping
// `project` + `video` separate — every editor operation reads `video`,
// not `project.timeline` (which no longer exists).
//
// Mutation flow (segment edits):
//   1. Pure transform on the Video (via `lib/timeline.ts`).
//   2. Current Video pushed to `past[]`; `future[]` cleared.
//   3. New Video applied locally + persisted via `saveVideo()`.
//
// Undo/redo rotates the past/future stacks of Video snapshots.

import { create } from "zustand";
import {
  deleteVideo as deleteVideoCmd,
  finalExists as finalExistsCmd,
  listVideos as listVideosCmd,
  loadVideo as loadVideoCmd,
  saveVideo as saveVideoCmd,
} from "./tauri";
import type { StreamToolUse } from "../components/ClaudeRail";
import * as TL from "./timeline";
import type { ProjectState, Video } from "./types";

export type ViewMode = "hub" | "workspace";

/** Per-video Claude rail runtime state.
 *
 *  Previously each ClaudeRail kept `busy / pending / streamText /
 *  streamTools` in local React state. That made parallel chats
 *  impossible — the moment the user switched videos, all in-flight
 *  state disappeared from the UI and a fresh empty rail appeared.
 *  The Tauri side already supports concurrent chats per video
 *  (sessions, cancellation, and chat logs are all keyed by
 *  `video_id`); only the React layer was the bottleneck.
 *
 *  Now the rail reads its slice of this map by the currently-shown
 *  `video_id` and a single global stream-event listener (mounted in
 *  `Workspace.tsx`) routes events from EVERY in-flight turn into the
 *  matching slice. Result: send a turn on video A, switch to B, send
 *  another turn on B; both keep running; switch back and you see
 *  each video's stream where you left it. */
export interface ChatRuntime {
  /** True while a turn for this video is in flight on the Tauri side. */
  busy: boolean;
  /** Epoch ms when the current turn started — drives the elapsed timer. */
  busyStartedAt: number | null;
  /** Optimistic "user just sent this" bubble; cleared when the assistant
   *  reply lands in chat history. */
  pending: { role: "user"; text: string } | null;
  /** Accumulated streaming assistant text from `claude:turn` events. */
  streamText: string;
  /** Tool-use chips streamed from the assistant; status flips when the
   *  matching tool_result lands. */
  streamTools: StreamToolUse[];
  /** Half-typed message that travels with the video. Switching videos
   *  no longer wipes your draft; you can park a half-thought on one
   *  video, work on another, and come back. */
  draft: string;
}

export function emptyChatRuntime(): ChatRuntime {
  return {
    busy: false,
    busyStartedAt: null,
    pending: null,
    streamText: "",
    streamTools: [],
    draft: "",
  };
}


/** Transcript view modes, inspired by Claude Code desktop's rail menu.
 *  Each mode is a different lens on the same underlying `Turn[]`:
 *
 *  - `normal`   — user/assistant bubbles, tool calls folded inline as
 *                 chips on the assistant side. The default.
 *  - `thinking` — Normal + reveals any thinking blocks above each
 *                 assistant reply (extended-thinking turns).
 *  - `verbose`  — flat event list with timestamps, raw JSON drawers
 *                 per tool, every text block as its own row.
 *                 Debugging view.
 *  - `summary`  — user message + 1-line gist of the assistant reply
 *                 + tool-count chip. Skimming view; great for long
 *                 sessions you want to navigate.
 */
export type TranscriptView = "normal" | "thinking" | "verbose" | "summary";

/** Font size knob for the transcript. Scales the whole transcript
 *  body without affecting headers / picker UI. */
export type TranscriptFontSize = "sm" | "md" | "lg";

const TRANSCRIPT_VIEW_KEY = "clipwright.transcriptView";
const TRANSCRIPT_FONT_KEY = "clipwright.transcriptFontSize";

function loadTranscriptView(): TranscriptView {
  try {
    const v = window.localStorage.getItem(TRANSCRIPT_VIEW_KEY);
    if (v === "normal" || v === "thinking" || v === "verbose" || v === "summary") {
      return v;
    }
  } catch {
    /* SSR / quota — fall through */
  }
  return "normal";
}

function loadTranscriptFont(): TranscriptFontSize {
  try {
    const v = window.localStorage.getItem(TRANSCRIPT_FONT_KEY);
    if (v === "sm" || v === "md" || v === "lg") return v;
  } catch {
    /* fall through */
  }
  return "md";
}


/** One persisted error record. We don't truncate the message — the
 *  user needs the full stack trace to file a useful bug report. */
export interface ErrorRecord {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Full error message; multiline allowed. */
  message: string;
  /** Where it originated. "claude" = Claude rail subprocess, "tauri" =
   *  an invoke() failure, "schema" = on-disk JSON load, etc. Lets the
   *  user filter mentally. Defaults to "unknown". */
  source: string;
}

const ERROR_HISTORY_CAP = 50;

const HISTORY_LIMIT = 50;
const TIMELINE_MIN_PX = 6;
const TIMELINE_MAX_PX = 60;
const TIMELINE_DEFAULT_PX = 18;
const TIMELINE_ZOOM_STEP = 1.25;

interface AppState {
  view: ViewMode;
  project: ProjectState | null;
  selectedSegmentId: string | null;
  claudeRailOpen: boolean;
  /** Persona panel visibility. Shares the right-hand rail slot with
   *  the Claude rail — opening one closes the other, because both
   *  want the same width and having both open would squeeze the
   *  preview to nothing. */
  personaRailOpen: boolean;
  /** Bottom timeline visibility. Collapsed leaves only its header
   *  strip, which buys ~180px of height for whichever side rail is
   *  open — the persona builder in particular is a tall form. */
  timelineCollapsed: boolean;
  error: string | null;
  /** Persistent error history. Every `setError(msg)` with a non-null
   *  message appends an entry here. The banner can be dismissed, but
   *  the history survives so the user can copy the message into a bug
   *  report — without this, the prior single-line banner would clear
   *  on dismiss and the user had no way to retrieve the message.
   *  Capped at 50 entries (FIFO) to keep memory bounded. */
  errorHistory: ErrorRecord[];
  /** Per-video Claude rail runtime, keyed by `video_id`. Survives video
   *  switches so concurrent chats stay visible. Lazily populated on
   *  first send / first stream event for a video. */
  chatRuntime: Record<string, ChatRuntime>;
  /** Active transcript view mode (Normal / Thinking / Verbose /
   *  Summary). Persisted to localStorage — view prefs travel with
   *  the user across projects, not per-project. */
  transcriptView: TranscriptView;
  /** Transcript body font size. Persisted same way as the mode. */
  transcriptFontSize: TranscriptFontSize;
  pxPerSec: number | null;
  /** Per-video undo/redo stacks of Video snapshots. */
  past: Video[];
  future: Video[];
  pendingAskSegmentId: string | null;
  /** Inspector drawer visibility. Off by default so the Preview pane
   *  fills the middle area; opens via TopBar toggle, segment
   *  double-click, or the context menu's "Inspect" action. Persists
   *  per session in-memory only — every fresh project open starts
   *  closed so we don't surprise the user with a half-screen panel. */
  inspectorOpen: boolean;

  // ── Playback (CapCut-style scrubber + timeline sync) ────────────────
  //
  // `playbackTime` is the current `<video>.currentTime` in seconds —
  // updated by the Preview pane via `onTimeUpdate`, read by the
  // Timeline to draw a playhead at the right horizontal position.
  //
  // `playbackPlaying` mirrors the <video>'s play/pause state.
  //
  // `seekRequest` is a one-shot signal: when the user clicks/drags the
  // timeline, we set `seekRequest = { time, token }` so the Preview's
  // <video> watches it and calls `currentTime = time`. The token bumps
  // every request so identical times still re-trigger (e.g. clicking
  // the same playhead twice while paused).
  //
  // `playbackMode` mirrors Preview's Segment/Final selector — both
  // components need to know which timebase the playhead refers to.
  playbackTime: number;
  playbackPlaying: boolean;
  seekRequest: { time: number; token: number } | null;
  /** One-shot signal asking the Preview's <video> to play/pause.
   *  Token-bumped on every request so React picks it up even when the
   *  desired state already matches `playbackPlaying`. */
  playPauseRequest: { play: boolean; token: number } | null;
  playbackMode: "final" | "raw";
  /** Bumps when any source the final mp4 depends on changes (TTS
   *  regen, captions regen, manifest edit). The Preview reads it to
   *  decide whether to surface a "final is stale — re-render"
   *  banner. Resets when `markFinalFresh()` fires from a successful
   *  final render. Per-video so switching videos doesn't carry
   *  stale flags across. */
  finalStaleToken: Record<string, number>;
  /** Whether the currently-loaded video has `out/final/<id>.mp4` on
   *  disk. `null` = haven't probed yet (treat as "unknown" — UI keeps
   *  current behavior). `true`/`false` after `refreshFinalAvailable()`
   *  runs. Per-video, keyed by video_id, so flipping videos doesn't
   *  carry stale state. */
  finalAvailable: Record<string, boolean>;

  // navigation
  setView: (view: ViewMode) => void;
  loadProject: (state: ProjectState) => void;
  closeProject: () => void;
  selectSegment: (id: string | null) => void;
  selectRelative: (offset: number) => void;
  toggleClaudeRail: () => void;
  togglePersonaRail: () => void;
  toggleTimelineCollapsed: () => void;
  setError: (msg: string | null, source?: string) => void;
  /** Drop all persisted error records (after a user reviewed them). */
  clearErrorHistory: () => void;
  /** Mutate one slice of `chatRuntime`. Auto-creates an empty slice
   *  on first use so callers don't have to seed it before the first
   *  send. */
  updateChatRuntime: (
    videoId: string,
    patch: Partial<ChatRuntime> | ((prev: ChatRuntime) => Partial<ChatRuntime>),
  ) => void;
  setTranscriptView: (mode: TranscriptView) => void;
  setTranscriptFontSize: (size: TranscriptFontSize) => void;
  askClaudeForSegment: (segId: string) => void;
  clearPendingAsk: () => void;
  /** Toggle inspector drawer visibility. */
  toggleInspector: () => void;
  /** Set inspector visibility explicitly. Pass `true` from
   *  double-click handlers so they always *open* (vs toggle). */
  setInspectorOpen: (open: boolean) => void;

  // video switching
  switchVideo: (videoId: string) => Promise<void>;
  /** Delete a video and its artifacts. Refuses if it's the last video.
   *  Lands the workspace on a surviving video automatically. */
  deleteVideo: (videoId: string) => Promise<void>;

  // timeline mutations — operate on the currently-loaded video
  splitSelected: () => Promise<void>;
  deleteSelected: () => Promise<void>;
  duplicateSelected: () => Promise<void>;
  mergeSelected: (direction: "prev" | "next") => Promise<void>;
  moveSelected: (direction: "prev" | "next") => Promise<void>;

  // history
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // timeline zoom
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;

  // playback
  setPlaybackTime: (t: number) => void;
  setPlaybackPlaying: (playing: boolean) => void;
  /** Request the <video> element to seek to `t` seconds. Bumps the
   *  token so the Preview's effect re-fires even if `t` matches the
   *  current value (lets clicks on the current playhead re-seek). */
  requestSeek: (t: number) => void;
  /** Ask Preview's <video> to call play()/pause(). Token-bumped so
   *  the same request can fire twice in a row. */
  requestPlayPause: (play: boolean) => void;
  setPlaybackMode: (mode: "final" | "raw") => void;
  /** Bump the stale token for a given video — caller signals "an
   *  underlying source has changed; the final mp4 no longer reflects
   *  the project state". */
  markFinalStale: (videoId: string) => void;
  /** Reset the stale token to its baseline after a successful final
   *  render — the Preview's banner disappears. */
  markFinalFresh: (videoId: string) => void;
  /** Re-probe whether `out/final/<videoId>.mp4` exists on disk and
   *  store the answer in `finalAvailable[videoId]`. Called on project
   *  load, after switching videos, and after a successful final
   *  render. Safe to call repeatedly. */
  refreshFinalAvailable: (videoId: string) => Promise<void>;
}

async function persistVideo(
  projectDir: string,
  video: Video,
  onError: (msg: string) => void,
): Promise<boolean> {
  try {
    await saveVideoCmd(projectDir, video.video_id, video);
    return true;
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

export const useApp = create<AppState>((set, get) => ({
  view: "hub",
  project: null,
  selectedSegmentId: null,
  claudeRailOpen: true,
  personaRailOpen: false,
  timelineCollapsed: false,
  error: null,
  errorHistory: [],
  chatRuntime: {},
  transcriptView: loadTranscriptView(),
  transcriptFontSize: loadTranscriptFont(),
  pxPerSec: null,
  past: [],
  future: [],
  pendingAskSegmentId: null,
  inspectorOpen: false,
  playbackTime: 0,
  playbackPlaying: false,
  seekRequest: null,
  playPauseRequest: null,
  playbackMode: "final",
  finalStaleToken: {},
  finalAvailable: {},

  setView: (view) => set({ view }),

  loadProject: (state) => {
    set({
      project: state,
      view: "workspace",
      selectedSegmentId: state.video?.segments[0]?.id ?? null,
      past: [],
      future: [],
      error: null,
    });
    // Fire-and-forget probe so Final-mode UI can hide its tracks if
    // there's no rendered mp4 yet. Failures fall back to "unknown".
    const vid = state.video?.video_id;
    if (vid) void useApp.getState().refreshFinalAvailable(vid);
  },

  closeProject: () =>
    set({
      project: null,
      view: "hub",
      selectedSegmentId: null,
      past: [],
      future: [],
    }),

  selectSegment: (id) => set({ selectedSegmentId: id }),

  selectRelative: (offset) => {
    const { project, selectedSegmentId } = get();
    if (!project?.video) return;
    const next = TL.neighborId(project.video, selectedSegmentId, offset);
    if (next) set({ selectedSegmentId: next });
  },

  toggleClaudeRail: () =>
    set((s) => ({
      claudeRailOpen: !s.claudeRailOpen,
      // Opening Claude closes Persona (and vice versa) — one rail
      // slot, so the alternative is two panels fighting over it.
      personaRailOpen: s.claudeRailOpen ? s.personaRailOpen : false,
    })),
  toggleTimelineCollapsed: () =>
    set((s) => ({ timelineCollapsed: !s.timelineCollapsed })),
  togglePersonaRail: () =>
    set((s) => ({
      personaRailOpen: !s.personaRailOpen,
      claudeRailOpen: s.personaRailOpen ? s.claudeRailOpen : false,
    })),
  setError: (msg, source = "unknown") =>
    set((s) => {
      // Null = dismiss the banner. We DO NOT clear errorHistory here —
      // the whole point of the history is that dismissing the banner
      // doesn't lose the message. Use `clearErrorHistory()` explicitly
      // when the user reviewed them.
      if (msg === null) return { error: null };
      const record: ErrorRecord = {
        ts: new Date().toISOString(),
        message: String(msg),
        source,
      };
      const history = [...s.errorHistory, record];
      // FIFO cap so a session that hits many transient errors doesn't
      // blow memory; oldest drops first.
      const trimmed =
        history.length > ERROR_HISTORY_CAP
          ? history.slice(history.length - ERROR_HISTORY_CAP)
          : history;
      return { error: msg, errorHistory: trimmed };
    }),
  clearErrorHistory: () => set({ errorHistory: [] }),
  updateChatRuntime: (videoId, patch) =>
    set((s) => {
      const prev = s.chatRuntime[videoId] ?? emptyChatRuntime();
      const delta = typeof patch === "function" ? patch(prev) : patch;
      return {
        chatRuntime: {
          ...s.chatRuntime,
          [videoId]: { ...prev, ...delta },
        },
      };
    }),
  setTranscriptView: (mode) => {
    try {
      window.localStorage.setItem(TRANSCRIPT_VIEW_KEY, mode);
    } catch {
      /* ignore quota / SSR */
    }
    set({ transcriptView: mode });
  },
  setTranscriptFontSize: (size) => {
    try {
      window.localStorage.setItem(TRANSCRIPT_FONT_KEY, size);
    } catch {
      /* ignore */
    }
    set({ transcriptFontSize: size });
  },
  askClaudeForSegment: (segId) =>
    set({ pendingAskSegmentId: segId, claudeRailOpen: true }),
  clearPendingAsk: () => set({ pendingAskSegmentId: null }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),

  // --- video switching ---

  switchVideo: async (videoId) => {
    const { project, setError } = get();
    if (!project) return;
    if (project.current_video_id === videoId) return;
    try {
      // Refresh BOTH the per-video manifest and the catalog. Without
      // the catalog refresh, a `createVideo` + `switchVideo` sequence
      // leaves `project.videos` stale — the sidebar then doesn't show
      // the row the user just created. Doing both in parallel keeps
      // the round-trip cheap.
      const [video, videos] = await Promise.all([
        loadVideoCmd(project.project_dir, videoId),
        listVideosCmd(project.project_dir),
      ]);
      set({
        project: {
          ...project,
          current_video_id: videoId,
          video,
          videos,
        },
        selectedSegmentId: video.segments[0]?.id ?? null,
        past: [],
        future: [],
      });
      // Re-probe final-mp4 existence for the newly-selected video so
      // the Timeline knows whether to show its tracks in final mode.
      void get().refreshFinalAvailable(videoId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  },

  deleteVideo: async (videoId) => {
    const { project, setError } = get();
    if (!project) return;
    try {
      const refreshed = await deleteVideoCmd(project.project_dir, videoId);
      set({
        project: refreshed,
        // Undo history is per-video; switching to a different one
        // invalidates the snapshots. Clearing here mirrors switchVideo.
        past: [],
        future: [],
        selectedSegmentId: refreshed.video?.segments[0]?.id ?? null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  },

  // --- timeline mutations ---

  splitSelected: async () => {
    const { project, selectedSegmentId } = get();
    if (!project?.video || !selectedSegmentId) return;
    const seg = TL.findSegment(project.video, selectedSegmentId);
    if (!seg || seg.target_duration < 1.0) return;
    await applyMutation((video) => TL.splitSegment(video, selectedSegmentId), set, get);
  },

  deleteSelected: async () => {
    const { project, selectedSegmentId } = get();
    if (!project?.video || !selectedSegmentId) return;
    const idx = project.video.segments.findIndex((s) => s.id === selectedSegmentId);
    await applyMutation(
      (video) => TL.deleteSegment(video, selectedSegmentId),
      set,
      get,
      (nextVideo) => {
        const newSel = nextVideo.segments[Math.max(0, idx - 1)]?.id ?? null;
        return { selectedSegmentId: newSel };
      },
    );
  },

  duplicateSelected: async () => {
    const { selectedSegmentId } = get();
    if (!selectedSegmentId) return;
    await applyMutation(
      (video) => TL.duplicateSegment(video, selectedSegmentId),
      set,
      get,
    );
  },

  mergeSelected: async (direction) => {
    const { selectedSegmentId } = get();
    if (!selectedSegmentId) return;
    await applyMutation(
      (video) => TL.mergeSegment(video, selectedSegmentId, direction),
      set,
      get,
    );
  },

  moveSelected: async (direction) => {
    const { selectedSegmentId } = get();
    if (!selectedSegmentId) return;
    await applyMutation(
      (video) => TL.moveSegment(video, selectedSegmentId, direction),
      set,
      get,
    );
  },

  // --- history ---

  undo: async () => {
    const { project, past } = get();
    if (!project?.video || past.length === 0) return;
    const previous = past[past.length - 1]!;
    const newPast = past.slice(0, -1);
    const future = [project.video, ...get().future].slice(0, HISTORY_LIMIT);
    set({
      project: { ...project, video: previous },
      past: newPast,
      future,
    });
    await persistVideo(project.project_dir, previous, (m) => set({ error: m }));
  },

  redo: async () => {
    const { project, future } = get();
    if (!project?.video || future.length === 0) return;
    const next = future[0]!;
    const newFuture = future.slice(1);
    const past = [...get().past, project.video].slice(-HISTORY_LIMIT);
    set({
      project: { ...project, video: next },
      past,
      future: newFuture,
    });
    await persistVideo(project.project_dir, next, (m) => set({ error: m }));
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  // --- zoom ---

  zoomIn: () => {
    const cur = get().pxPerSec ?? TIMELINE_DEFAULT_PX;
    set({ pxPerSec: Math.min(TIMELINE_MAX_PX, cur * TIMELINE_ZOOM_STEP) });
  },
  zoomOut: () => {
    const cur = get().pxPerSec ?? TIMELINE_DEFAULT_PX;
    set({ pxPerSec: Math.max(TIMELINE_MIN_PX, cur / TIMELINE_ZOOM_STEP) });
  },
  zoomReset: () => set({ pxPerSec: null }),

  // ── Playback ────────────────────────────────────────────────────────
  setPlaybackTime: (t) => set({ playbackTime: Math.max(0, t) }),
  setPlaybackPlaying: (playing) => set({ playbackPlaying: playing }),
  requestSeek: (t) =>
    set((state) => ({
      seekRequest: {
        time: Math.max(0, t),
        // Token mirrors a monotonic counter so identical times still
        // trigger the Preview's useEffect when the user re-clicks the
        // current playhead position.
        token: (state.seekRequest?.token ?? 0) + 1,
      },
      // Optimistically move the playhead — Preview's onTimeUpdate
      // will reconcile once the video catches up. Without this the
      // playhead would visually lag the click by one frame.
      playbackTime: Math.max(0, t),
    })),
  requestPlayPause: (play) =>
    set((state) => ({
      playPauseRequest: {
        play,
        token: (state.playPauseRequest?.token ?? 0) + 1,
      },
    })),
  setPlaybackMode: (mode) =>
    set({
      playbackMode: mode,
      // Reset the playhead when modes swap — the timebases are
      // different (per-segment local vs final whole-video) so the
      // previous time isn't meaningful.
      playbackTime: 0,
      seekRequest: null,
    }),
  markFinalStale: (videoId) =>
    set((s) => ({
      finalStaleToken: {
        ...s.finalStaleToken,
        [videoId]: (s.finalStaleToken[videoId] ?? 0) + 1,
      },
    })),
  markFinalFresh: (videoId) =>
    set((s) => {
      const { [videoId]: _drop, ...rest } = s.finalStaleToken;
      return { finalStaleToken: rest };
    }),
  refreshFinalAvailable: async (videoId) => {
    const { project } = get();
    if (!project?.project_dir || !videoId) return;
    try {
      const exists = await finalExistsCmd(project.project_dir, videoId);
      set((s) => ({
        finalAvailable: { ...s.finalAvailable, [videoId]: exists },
      }));
    } catch {
      // Probe failures are non-fatal: leave the entry unset so the UI
      // falls back to "unknown" (the conservative behavior keeps tracks
      // visible rather than hiding them on a transient error).
    }
  },
}));

async function applyMutation(
  transform: (video: Video) => Video,
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  postUpdate?: (next: Video) => Partial<AppState>,
): Promise<void> {
  const { project, past } = get();
  if (!project?.video) return;
  const current = project.video;
  const next = transform(current);
  if (next === current) return;
  if (segmentsEqual(next, current)) return;

  const newPast = [...past, current].slice(-HISTORY_LIMIT);
  set({
    project: { ...project, video: next },
    past: newPast,
    future: [],
    ...(postUpdate ? postUpdate(next) : {}),
  });
  await persistVideo(project.project_dir, next, (m) => set({ error: m }));
}

function segmentsEqual(a: Video, b: Video): boolean {
  return JSON.stringify(a.segments) === JSON.stringify(b.segments);
}
