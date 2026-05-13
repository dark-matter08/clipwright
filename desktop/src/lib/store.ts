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
import { loadVideo as loadVideoCmd, saveVideo as saveVideoCmd } from "./tauri";
import * as TL from "./timeline";
import type { ProjectState, Video } from "./types";

export type ViewMode = "hub" | "workspace";

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
  error: string | null;
  pxPerSec: number | null;
  /** Per-video undo/redo stacks of Video snapshots. */
  past: Video[];
  future: Video[];
  pendingAskSegmentId: string | null;

  // navigation
  setView: (view: ViewMode) => void;
  loadProject: (state: ProjectState) => void;
  closeProject: () => void;
  selectSegment: (id: string | null) => void;
  selectRelative: (offset: number) => void;
  toggleClaudeRail: () => void;
  setError: (msg: string | null) => void;
  askClaudeForSegment: (segId: string) => void;
  clearPendingAsk: () => void;

  // video switching
  switchVideo: (videoId: string) => Promise<void>;

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
  error: null,
  pxPerSec: null,
  past: [],
  future: [],
  pendingAskSegmentId: null,

  setView: (view) => set({ view }),

  loadProject: (state) =>
    set({
      project: state,
      view: "workspace",
      selectedSegmentId: state.video?.segments[0]?.id ?? null,
      past: [],
      future: [],
      error: null,
    }),

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

  toggleClaudeRail: () => set((s) => ({ claudeRailOpen: !s.claudeRailOpen })),
  setError: (msg) => set({ error: msg }),
  askClaudeForSegment: (segId) =>
    set({ pendingAskSegmentId: segId, claudeRailOpen: true }),
  clearPendingAsk: () => set({ pendingAskSegmentId: null }),

  // --- video switching ---

  switchVideo: async (videoId) => {
    const { project, setError } = get();
    if (!project) return;
    if (project.current_video_id === videoId) return;
    try {
      const video = await loadVideoCmd(project.project_dir, videoId);
      set({
        project: { ...project, current_video_id: videoId, video },
        selectedSegmentId: video.segments[0]?.id ?? null,
        past: [],
        future: [],
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
