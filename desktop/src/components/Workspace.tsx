// Project Workspace — SRS §8.5. Five regions:
//   left rail: Videos sidebar (NEW for v2 — switch between videos in
//   one project), then the four-region editor (preview + inspector +
//   timeline + Claude rail) + status bar.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { useApp } from "../lib/store";
import { applyStreamEvent, ClaudeRail } from "./ClaudeRail";
import { PersonaRail } from "./PersonaRail";
import type { ClaudeStreamEvent, StreamToolUse } from "./ClaudeRail";
import { Inspector } from "./Inspector";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { TopBar } from "./TopBar";
import { StatusBar } from "./StatusBar";
import { VideoSidebar } from "./VideoSidebar";
import { cn } from "../lib/cn";

// Claude rail width bookends. 280px is the smallest the markdown +
// question cards stay readable at; 720px is roughly half a 14" laptop
// screen — beyond that the middle pane gets squeezed.
const RAIL_DEFAULT_WIDTH = 340;
const RAIL_MIN_WIDTH = 280;
const RAIL_MAX_WIDTH = 720;
const RAIL_WIDTH_KEY = "clipwright.claudeRailWidth";

function loadRailWidth(): number {
  try {
    const raw = window.localStorage.getItem(RAIL_WIDTH_KEY);
    if (!raw) return RAIL_DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return RAIL_DEFAULT_WIDTH;
    return Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, n));
  } catch {
    return RAIL_DEFAULT_WIDTH;
  }
}

export function Workspace() {
  const project = useApp((s) => s.project);
  const railOpen = useApp((s) => s.claudeRailOpen);
  const personaOpen = useApp((s) => s.personaRailOpen);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [railWidth, setRailWidth] = useState<number>(() => loadRailWidth());
  const [dragging, setDragging] = useState(false);
  // Track drag origin so we resize relative to the click point — this
  // avoids the rail "jumping" on first move when the pointer isn't
  // exactly on the handle edge.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Persist width changes. Debounced via the setTimeout trick — we don't
  // need to write on every pointermove tick.
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth));
      } catch {
        /* ignore quota / SSR */
      }
    }, 150);
    return () => window.clearTimeout(id);
  }, [railWidth]);

  // Pointer-capture-style drag: while the handle is held we listen on
  // window for move/up so dragging continues even if the cursor strays
  // off the 4px-wide handle.
  const onHandleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!railOpen) return;
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: railWidth };
      setDragging(true);
    },
    [railOpen, railWidth],
  );

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      // Pulling the handle LEFT widens the rail (it's anchored to the
      // right edge of the window), so subtract the delta.
      const delta = e.clientX - drag.startX;
      const next = Math.max(
        RAIL_MIN_WIDTH,
        Math.min(RAIL_MAX_WIDTH, drag.startWidth - delta),
      );
      setRailWidth(next);
    }
    function onUp() {
      dragRef.current = null;
      setDragging(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  // Global `claude:turn` stream listener — mounted ONCE while a project
  // is open, routes every event into the matching per-video chatRuntime
  // slice. Previously this lived in ClaudeRail (one listener per
  // currently-visible video). That meant: switch videos mid-turn and
  // the stream for the prior video stopped landing in store; no way
  // to see two in-flight chats at once. Now the listener doesn't
  // care which video is visible — events for video A keep populating
  // `chatRuntime[A]` even while the user works on video B.
  const updateChatRuntime = useApp((s) => s.updateChatRuntime);
  useEffect(() => {
    if (!project?.project_dir) return;
    let cancelled = false;
    const unlisten = listen<ClaudeStreamEvent>("claude:turn", (e) => {
      if (cancelled) return;
      const { video_id, payload } = e.payload;
      if (!video_id) return;
      // `applyStreamEvent` was written against React setters; adapt by
      // routing each setState callback through the store's per-video
      // patch action. The two-step shape (text setter + tools setter)
      // is preserved verbatim so the existing stream-event tests stay
      // valid.
      const setStreamText = (
        updater: string | ((prev: string) => string),
      ) => {
        updateChatRuntime(video_id, (prev) => ({
          streamText:
            typeof updater === "function" ? updater(prev.streamText) : updater,
        }));
      };
      const setStreamTools = (
        updater:
          | StreamToolUse[]
          | ((prev: StreamToolUse[]) => StreamToolUse[]),
      ) => {
        updateChatRuntime(video_id, (prev) => ({
          streamTools:
            typeof updater === "function" ? updater(prev.streamTools) : updater,
        }));
      };
      applyStreamEvent(payload, setStreamText, setStreamTools);
    });
    return () => {
      cancelled = true;
      void unlisten.then((un) => un());
    };
  }, [project?.project_dir, updateChatRuntime]);

  if (!project) return null;

  return (
    <div className={`flex h-full w-full flex-col ${dragging ? "select-none" : ""}`}>
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {/* Far-left: Videos rail */}
        <div
          className={
            sidebarCollapsed
              ? "w-[44px] shrink-0 transition-[width] duration-slow"
              : "w-[200px] shrink-0 transition-[width] duration-slow"
          }
        >
          <VideoSidebar
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed((v) => !v)}
          />
        </div>

        {/* Middle: Preview on the left, Inspector pushes in from the
         *  right when open. NOT an overlay — the Preview narrows to
         *  make room for the Inspector. This way the Preview is
         *  always fully visible (just smaller) and nothing overlaps
         *  the Claude rail. Width transitions smoothly so the open/
         *  close feels like a panel sliding out, not a modal. */}
        <div className="flex min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1">
            <Preview />
          </div>
          <InspectorDrawer />
        </div>

        {/* Right: Claude rail. Width is user-resizable when open; the
         *  collapsed state is fixed at 36px (only the toggle strip).
         *  The transition is suppressed while dragging so the rail
         *  tracks the pointer 1:1 instead of easing behind it. */}
        <aside
          style={{ width: railOpen || personaOpen ? railWidth : 36 }}
          className={`relative shrink-0 border-l border-border-subtle bg-bg-subtle ${
            dragging ? "" : "transition-[width] duration-slow"
          }`}
        >
          {(railOpen || personaOpen) && (
            <ResizeHandle dragging={dragging} onPointerDown={onHandleDown} />
          )}
          {/* One slot, two tenants. Persona wins when open because the
           *  store guarantees they're mutually exclusive; the collapsed
           *  strip stays Claude's, since that's the rail users toggle
           *  constantly and expect to find on the edge. */}
          {personaOpen ? (
            <PersonaRail collapsed={false} />
          ) : (
            <ClaudeRail collapsed={!railOpen} />
          )}
        </aside>
      </div>

      {/* Bottom: timeline full width. Height accommodates all three
       *  track lanes (video 52 + audio 32 + captions 28) plus the
       *  ruler, header, and padding — see Timeline.tsx for the
       *  per-track height map. */}
      <div className="h-[220px] shrink-0 border-t border-border-subtle bg-bg-subtle">
        <Timeline />
      </div>

      <StatusBar />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector drawer — slides in from the right edge of the middle column
// ---------------------------------------------------------------------------
//
// The Inspector used to live as a fixed bottom panel under the Preview,
// permanently eating ~30% of vertical real estate. Most users don't
// want it open most of the time — selecting a segment is enough; the
// detailed trim/voiceover/captions form is a "when I need to edit this
// one thing" surface.
//
// Now it's an overlay drawer:
//   - Anchored to the right edge of the middle column (between the
//     Preview and the Claude rail), absolute-positioned so the Preview
//     keeps its full size even when the drawer is up.
//   - Slides in/out with a translate-x transition.
//   - Width: 420px (room for the labeled trim/voiceover/captions
//     fieldsets without horizontal cramping).
//   - Triggers: TopBar "Inspect" button, segment double-click in the
//     Timeline, the segment context menu, or Escape to close.

const INSPECTOR_WIDTH = 420;

function InspectorDrawer() {
  const open = useApp((s) => s.inspectorOpen);
  const setOpen = useApp((s) => s.setInspectorOpen);
  const selectedId = useApp((s) => s.selectedSegmentId);

  // ESC closes the drawer — convention for any modal-ish surface.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  return (
    <aside
      aria-hidden={!open}
      style={{
        width: open ? INSPECTOR_WIDTH : 0,
      }}
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden",
        "border-l border-border-subtle bg-bg-subtle",
        "transition-[width] duration-200 ease-out",
      )}
    >
      {/* Inner wrapper at fixed width so the content doesn't reflow
       *  as the outer aside animates from 0 → 420. Without this fixed
       *  width the form labels would dance during the transition. */}
      <div style={{ width: INSPECTOR_WIDTH }} className="flex h-full flex-col">
        <header className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle px-3">
          <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
            Inspector{selectedId ? ` · ${selectedId}` : ""}
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close inspector"
            title="Close (Esc)"
            className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Inspector />
        </div>
      </div>
    </aside>
  );
}

// Thin draggable strip on the left edge of the Claude rail. Sits in a
// 6px-wide hit zone (generous enough to grab without pixel-hunting)
// with a 1px visible line that brightens on hover/drag. Anchored
// absolute inside the rail's `relative` aside so it doesn't push content.
function ResizeHandle({
  dragging,
  onPointerDown,
}: {
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Claude rail"
      title="Drag to resize"
      onPointerDown={onPointerDown}
      className={`absolute left-0 top-0 z-10 h-full w-1.5 cursor-ew-resize ${
        dragging ? "bg-accent/60" : "bg-transparent hover:bg-accent/30"
      } transition-colors`}
    />
  );
}
