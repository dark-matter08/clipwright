// Zustand store. Holds the currently-open project, selected segment,
// undo/redo stacks, and view state.
//
// Mutation flow:
//   1. Action computes new Timeline (pure, via `lib/timeline.ts`).
//   2. Current timeline pushed to `past[]`; `future[]` cleared.
//   3. New timeline applied + persisted via `saveTimeline()`.
//
// Undo/redo: rotate the past/future stacks. Each rotation persists.

import { create } from "zustand";
import { saveTimeline as saveTimelineCmd } from "./tauri";
import * as TL from "./timeline";
import type { ProjectState, Timeline } from "./types";

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
  pxPerSec: number | null; // null = auto-fit
  past: Timeline[];
  future: Timeline[];
  // when set, the next chat message is scoped to this segment (Mode B)
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

  // timeline mutations — all persist to disk
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

async function persistTimeline(
  projectDir: string,
  timeline: Timeline,
  onError: (msg: string) => void,
): Promise<boolean> {
  try {
    await saveTimelineCmd(projectDir, timeline);
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
      selectedSegmentId: state.timeline.segments[0]?.id ?? null,
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
    if (!project) return;
    const next = TL.neighborId(project.timeline, selectedSegmentId, offset);
    if (next) set({ selectedSegmentId: next });
  },

  toggleClaudeRail: () => set((s) => ({ claudeRailOpen: !s.claudeRailOpen })),
  setError: (msg) => set({ error: msg }),
  askClaudeForSegment: (segId) =>
    set({ pendingAskSegmentId: segId, claudeRailOpen: true }),
  clearPendingAsk: () => set({ pendingAskSegmentId: null }),

  // --- timeline mutations ---

  splitSelected: async () => {
    const { project, selectedSegmentId } = get();
    if (!project || !selectedSegmentId) return;
    const seg = TL.findSegment(project.timeline, selectedSegmentId);
    // refuse to split a segment shorter than 1s — produces unusable halves
    if (!seg || seg.target_duration < 1.0) return;
    await applyMutation((tl) => TL.splitSegment(tl, selectedSegmentId), set, get);
  },

  deleteSelected: async () => {
    const { project, selectedSegmentId } = get();
    if (!project || !selectedSegmentId) return;
    await applyMutation(
      (tl) => TL.deleteSegment(tl, selectedSegmentId),
      set,
      get,
      // after delete: select the previous segment (or first surviving one)
      (nextTl) => {
        const idx = project.timeline.segments.findIndex((s) => s.id === selectedSegmentId);
        const newSel = nextTl.segments[Math.max(0, idx - 1)]?.id ?? null;
        return { selectedSegmentId: newSel };
      },
    );
  },

  duplicateSelected: async () => {
    const { selectedSegmentId } = get();
    if (!selectedSegmentId) return;
    await applyMutation(
      (tl) => TL.duplicateSegment(tl, selectedSegmentId),
      set,
      get,
    );
  },

  mergeSelected: async (direction) => {
    const { selectedSegmentId } = get();
    if (!selectedSegmentId) return;
    await applyMutation(
      (tl) => TL.mergeSegment(tl, selectedSegmentId, direction),
      set,
      get,
    );
  },

  moveSelected: async (direction) => {
    const { selectedSegmentId } = get();
    if (!selectedSegmentId) return;
    await applyMutation(
      (tl) => TL.moveSegment(tl, selectedSegmentId, direction),
      set,
      get,
    );
  },

  // --- history ---

  undo: async () => {
    const { project, past } = get();
    if (!project || past.length === 0) return;
    const previous = past[past.length - 1]!;
    const newPast = past.slice(0, -1);
    const future = [project.timeline, ...get().future].slice(0, HISTORY_LIMIT);
    set({
      project: { ...project, timeline: previous },
      past: newPast,
      future,
    });
    await persistTimeline(project.project_dir, previous, (m) => set({ error: m }));
  },

  redo: async () => {
    const { project, future } = get();
    if (!project || future.length === 0) return;
    const next = future[0]!;
    const newFuture = future.slice(1);
    const past = [...get().past, project.timeline].slice(-HISTORY_LIMIT);
    set({
      project: { ...project, timeline: next },
      past,
      future: newFuture,
    });
    await persistTimeline(project.project_dir, next, (m) => set({ error: m }));
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

// Apply a pure mutation, persist, push to history, optionally adjust other state.
async function applyMutation(
  transform: (tl: Timeline) => Timeline,
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  postUpdate?: (next: Timeline) => Partial<AppState>,
): Promise<void> {
  const { project, past } = get();
  if (!project) return;
  const current = project.timeline;
  const next = transform(current);
  if (next === current) return;
  if (segmentsEqual(next, current)) return;

  const newPast = [...past, current].slice(-HISTORY_LIMIT);
  set({
    project: { ...project, timeline: next },
    past: newPast,
    future: [],
    ...(postUpdate ? postUpdate(next) : {}),
  });
  await persistTimeline(project.project_dir, next, (m) => set({ error: m }));
}

function segmentsEqual(a: Timeline, b: Timeline): boolean {
  // Cheap structural equality good enough for "did this op actually change anything".
  return JSON.stringify(a.segments) === JSON.stringify(b.segments);
}
