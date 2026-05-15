// Timeline — multi-track view inspired by Remotion's timeline demo.
//
// Three horizontal tracks (Video / Audio / Captions) share a single
// time axis. Each segment renders as a block on each track at its
// cumulative time offset, so visually you see the same slice of time
// across all three rows aligned. The video block carries the label;
// the audio + caption blocks are lighter and just indicate the
// availability of those assets for that segment.
//
// Why three tracks and not five (camera, annotations, etc.): those are
// per-segment refs, not independent timelines. The three tracks shown
// here are the actual concurrent layers Remotion composes when
// rendering the final mp4 — video panel + voiceover audio + caption
// band. The Camera / Annotations / Trim controls stay in the Inspector
// where they belong (per-segment editing).
//
// The right-click context menu (Ask Claude, Split, Delete, Duplicate,
// Move) keeps working from any track — every block carries the same
// `onContextMenu` handler so the user can grab a segment from
// whichever lane is most visible.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Captions as CaptionsIcon,
  Film,
  Pause,
  Play,
  Volume2,
} from "lucide-react";
import type { Segment } from "../lib/types";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { getRecapConfig, saveVideo as saveVideoCmd } from "../lib/tauri";
import { SegmentContextMenu } from "./SegmentContextMenu";

type TrackKind = "video" | "audio" | "captions";

const MIN_PX_PER_SEC = 6;
const MAX_PX_PER_SEC = 60;
const DEFAULT_PX_PER_SEC = 18;
const TRACK_LABEL_WIDTH = 96;
const RULER_HEIGHT = 24;
// Distinct heights per track type — CapCut/Premiere style. Video is
// the tallest (the "primary" lane); audio + captions are shorter
// supporting lanes. Total stacked height with gaps stays around
// 130px so it fits the Workspace's fixed 160px bottom slot.
const TRACK_HEIGHTS: Record<TrackKind, number> = {
  video: 52,
  audio: 32,
  captions: 28,
};
const ICONS_BY_KIND = {
  video: Film,
  audio: Volume2,
  captions: CaptionsIcon,
} as const;

interface MenuState {
  segId: string;
  x: number;
  y: number;
}

interface PositionedSegment {
  seg: Segment;
  start: number; // seconds from t=0
  end: number;
}

export function Timeline() {
  const project = useApp((s) => s.project);
  const selectedId = useApp((s) => s.selectedSegmentId);
  const selectSegment = useApp((s) => s.selectSegment);
  const pxPerSecOverride = useApp((s) => s.pxPerSec);
  const past = useApp((s) => s.past.length);
  const future = useApp((s) => s.future.length);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);

  // Playback state shared with the Preview pane — playhead position
  // + click-to-seek both flow through these.
  const playbackTime = useApp((s) => s.playbackTime);
  const playbackPlaying = useApp((s) => s.playbackPlaying);
  const playbackMode = useApp((s) => s.playbackMode);
  const requestSeek = useApp((s) => s.requestSeek);
  const requestPlayPause = useApp((s) => s.requestPlayPause);
  const setInspectorOpen = useApp((s) => s.setInspectorOpen);
  // (Used to read `finalAvailable[video_id]` here to hide tracks in
  // Final mode when no rendered mp4 was on disk. We dropped that
  // gating: the user's mental model of Final = "the edit plan I'd
  // assemble" treats the tracks as always-meaningful, and the probe
  // didn't reliably refresh when Claude ran `render-final` via
  // subprocess. The store still tracks `finalAvailable` for other
  // consumers; this component just no longer gates on it.)

  const [menu, setMenu] = useState<MenuState | null>(null);
  const tracksAreaRef = useRef<HTMLDivElement>(null);
  // True while the user is dragging the playhead. We capture pointer
  // events to the document so a fast scrub doesn't drop motion when
  // the cursor leaves the timeline strip.
  const [scrubbing, setScrubbing] = useState(false);
  // Live width of the scrollable tracks area — drives the auto
  // pxPerSec calculation so the timeline fills the viewport. Updated
  // by a ResizeObserver on the tracks DOM node; recomputed when the
  // user opens/closes the Inspector drawer, expands the Claude rail,
  // or resizes the window. Starts at 0 so we render with the static
  // fallback density on the first paint, then snap to the measured
  // value once the observer fires.
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = tracksAreaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // `contentRect.width` excludes scrollbars + padding — same
        // box we lay segments inside, so the math comes out clean.
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const segments = project?.video?.segments ?? [];
  const total = segments.reduce((acc, s) => acc + s.target_duration, 0);
  const pxPerSec =
    pxPerSecOverride !== null
      ? pxPerSecOverride
      : autoDensity(segments, total, containerWidth);

  // Convert the segment list into time-positioned blocks once. Time is
  // cumulative across segments — we don't currently support source-
  // time playback (gaps between segments), so the "start" of seg N is
  // just the sum of target_duration for segs 0..N-1.
  const positioned: PositionedSegment[] = [];
  let cursor = 0;
  for (const seg of segments) {
    positioned.push({
      seg,
      start: cursor,
      end: cursor + seg.target_duration,
    });
    cursor += seg.target_duration;
  }
  const totalDuration = Math.max(cursor, 1);
  const trackWidth = totalDuration * pxPerSec;

  // ── Playhead positioning ─────────────────────────────────────────
  //
  // `playbackTime` from the store is always in TIMELINE seconds — the
  // Preview pane handles any source-vs-timeline timebase conversion
  // before writing into the store (see Preview.tsx's `onTimeUpdate`
  // for the segment-mode math). That keeps this side simple: the
  // playhead position is just `playbackTime * pxPerSec`, no mode-
  // specific branching needed.
  const globalPlayhead = playbackTime;
  const playheadLeft = Math.max(
    0,
    Math.min(globalPlayhead * pxPerSec, trackWidth),
  );

  // Translate a clientX on the tracks area into a global timeline
  // time. Subtracts the label gutter so the math is in "track space".
  const clientXToGlobalTime = useCallback(
    (clientX: number): number => {
      const el = tracksAreaRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left - TRACK_LABEL_WIDTH;
      return Math.max(0, Math.min(totalDuration, x / pxPerSec));
    },
    [pxPerSec, totalDuration],
  );

  // Map a click/scrub on the timeline to a seek request. The store's
  // `playbackTime` and the Preview pane's video element are always
  // expressed in TIMELINE seconds (Preview converts to source-time
  // internally for Raw mode), so this is now a 1:1 pass-through. As
  // a side effect, we also auto-select the segment under the cursor
  // so the Inspector + segment-aware UI track the user's intent.
  const seekToGlobalTime = useCallback(
    (globalTime: number) => {
      const hit = positioned.find(
        (p) => globalTime >= p.start && globalTime <= p.end,
      );
      if (hit && hit.seg.id !== selectedId) {
        selectSegment(hit.seg.id);
      }
      requestSeek(globalTime);
    },
    [positioned, requestSeek, selectedId, selectSegment],
  );

  // Drag-to-scrub. Listen on the window while a drag is active so the
  // cursor can leave the timeline mid-scrub without dropping the
  // gesture. Pointer-capture would also work but window listeners
  // give us the cancel-on-Escape pattern for free.
  useEffect(() => {
    if (!scrubbing) return;
    function onMove(e: PointerEvent) {
      seekToGlobalTime(clientXToGlobalTime(e.clientX));
    }
    function onUp() {
      setScrubbing(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [scrubbing, clientXToGlobalTime, seekToGlobalTime]);

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-subtle px-3 text-xs text-fg-muted">
        {/* Transport — play/pause + timecode. Mirrors CapCut's
         *  bottom-bar transport: a clear primary button plus a
         *  monospace "current / total" readout. */}
        <button
          type="button"
          onClick={() => requestPlayPause(!playbackPlaying)}
          disabled={segments.length === 0}
          title={playbackPlaying ? "Pause (space)" : "Play (space)"}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded transition-colors",
            segments.length === 0
              ? "cursor-not-allowed text-fg-muted/40"
              : playbackPlaying
                ? "bg-accent text-bg hover:bg-accent-hover"
                : "bg-bg-raised text-fg hover:bg-bg-inset",
          )}
        >
          {playbackPlaying ? (
            <Pause size={12} strokeWidth={2.5} fill="currentColor" />
          ) : (
            <Play size={12} strokeWidth={2.5} fill="currentColor" />
          )}
        </button>
        <span
          className="rounded bg-bg-raised px-2 py-0.5 font-mono text-[10px] tabular-nums text-fg"
          title="Current playback time / total timeline duration"
        >
          {fmtTimecode(globalPlayhead)} / {fmtTimecode(totalDuration)}
        </span>
        <span className="text-fg-muted">·</span>
        <span className="font-mono uppercase tracking-wider">Timeline</span>
        <span className="text-fg-muted">·</span>
        <span>
          {segments.length} segment{segments.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px]">
          <DurationBadge />
          <span className="text-fg-muted">·</span>
          <HistoryButton
            label="↶"
            title="Undo (⌘Z)"
            disabled={past === 0}
            onClick={undo}
          />
          <HistoryButton
            label="↷"
            title="Redo (⇧⌘Z)"
            disabled={future === 0}
            onClick={redo}
          />
          <span className="text-fg-muted">·</span>
          <span title="Pixels per second">{pxPerSec.toFixed(0)} px/s</span>
        </span>
      </header>

      <div
        ref={tracksAreaRef}
        className="relative flex flex-1 overflow-x-auto overflow-y-hidden"
        onClick={() => setMenu(null)}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setMenu(null);
          }
        }}
      >
        {segments.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
            Empty timeline. Import a video or record a session to seed segments.
          </div>
        ) : playbackMode === "raw" ? (
          // Raw mode plays the unedited source mp4 — it has nothing to
          // do with the per-segment edit plan, so the segmented tracks
          // would be misleading (they imply "this is how raw is
          // sliced," but raw is precisely the UNSLICED material). We
          // hide the tracks and point the user back to Final mode for
          // the plan view.
          //
          // The playhead-during-raw-playback "highlight my edit"
          // behavior still works through the Preview pane's own
          // timebase mapping — the timeline tracks just aren't the
          // right surface for it. A future enhancement could show a
          // single bar with cut markers; deferred.
          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center text-sm text-fg-muted">
            <span>Raw source playback</span>
            <span className="text-xs text-fg-muted/70">
              The edit-plan tracks are hidden in Raw mode. Switch to{" "}
              <span className="text-accent">Final</span> to see them.
            </span>
          </div>
        ) : (
          <div
            // `min-w-full` ensures the tracks span at LEAST the full
            // visible width — short timelines no longer leave dead
            // space on the right. `minWidth` (a measured pixel value)
            // kicks in when content needs to scroll horizontally past
            // the viewport. Both work together.
            style={{ minWidth: TRACK_LABEL_WIDTH + trackWidth + 24 }}
            className="relative flex min-w-full flex-col gap-1.5 px-2 py-2"
          >
            <TimeRuler
              totalDuration={totalDuration}
              pxPerSec={pxPerSec}
              leftPad={TRACK_LABEL_WIDTH}
              onSeek={(t) => seekToGlobalTime(t)}
              onScrubStart={() => setScrubbing(true)}
            />
            <Track
              label="Video"
              kind="video"
              positioned={positioned}
              pxPerSec={pxPerSec}
              selectedId={selectedId}
              onSelect={(id) => {
                selectSegment(id);
                // Clicking a segment also jumps playback to that
                // segment's start (timeline-seconds). The Preview
                // pane handles the timebase mapping in Raw mode.
                const hit = positioned.find((p) => p.seg.id === id);
                if (hit) requestSeek(hit.start);
              }}
              onDoubleClick={(id) => {
                selectSegment(id);
                setInspectorOpen(true);
              }}
              onContextMenu={(segId, x, y) => setMenu({ segId, x, y })}
            />
            <Track
              label="Audio"
              kind="audio"
              positioned={positioned}
              pxPerSec={pxPerSec}
              selectedId={selectedId}
              onSelect={selectSegment}
              onDoubleClick={(id) => {
                selectSegment(id);
                setInspectorOpen(true);
              }}
              onContextMenu={(segId, x, y) => setMenu({ segId, x, y })}
            />
            <Track
              label="Captions"
              kind="captions"
              positioned={positioned}
              pxPerSec={pxPerSec}
              selectedId={selectedId}
              onSelect={selectSegment}
              onDoubleClick={(id) => {
                selectSegment(id);
                setInspectorOpen(true);
              }}
              onContextMenu={(segId, x, y) => setMenu({ segId, x, y })}
            />
            <Playhead
              left={TRACK_LABEL_WIDTH + playheadLeft}
              playing={playbackPlaying}
              onPointerDown={() => setScrubbing(true)}
            />
          </div>
        )}
      </div>

      {menu && (
        <SegmentContextMenu
          segId={menu.segId}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time ruler — second markers across the top of the tracks
// ---------------------------------------------------------------------------

function TimeRuler({
  totalDuration,
  pxPerSec,
  leftPad,
  onSeek,
  onScrubStart,
}: {
  totalDuration: number;
  pxPerSec: number;
  leftPad: number;
  /** Called when the user clicks/drags on the ruler — receives the
   *  global timeline time (seconds from 0) that the click corresponds
   *  to. Drag-scrub fires this repeatedly via the window pointermove
   *  listener (see `scrubbing` in Timeline). */
  onSeek: (globalTime: number) => void;
  onScrubStart: () => void;
}) {
  // Pick a tick interval that yields a marker every ~80px so the ruler
  // doesn't get crowded at high zoom or sparse at low zoom.
  const targetSpacing = 80;
  const rawSeconds = targetSpacing / Math.max(pxPerSec, 1);
  const tickSeconds = niceTickInterval(rawSeconds);
  const ticks: number[] = [];
  for (let t = 0; t <= totalDuration + 0.001; t += tickSeconds) {
    ticks.push(t);
  }

  // Translate a clientX inside the ruler track to a timeline time.
  // We use a local handler instead of accepting clientX up-stream so
  // the math stays self-contained — the ruler knows its own width.
  function timeFromClientX(rect: DOMRect, clientX: number): number {
    const x = clientX - rect.left;
    return Math.max(0, Math.min(totalDuration, x / pxPerSec));
  }

  return (
    <div
      style={{
        height: RULER_HEIGHT,
        paddingLeft: leftPad,
      }}
      className="relative shrink-0 select-none border-b border-border-subtle"
    >
      <div
        // `flex-1` lets the ruler extend past `totalDuration * pxPerSec`
        // to fill the visible width, matching the lane backgrounds.
        // `minWidth` keeps the ruler at AT LEAST the content width so
        // ticks past the viewport remain clickable when scrolling.
        style={{ minWidth: totalDuration * pxPerSec }}
        className="relative h-full flex-1 cursor-ew-resize"
        onPointerDown={(e) => {
          // Left-click only; ignore right-click + middle-click.
          if (e.button !== 0) return;
          e.preventDefault();
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          onSeek(timeFromClientX(rect, e.clientX));
          onScrubStart();
        }}
      >
        {ticks.map((t) => (
          <div
            key={t}
            style={{ left: t * pxPerSec }}
            className="absolute top-0 flex h-full flex-col items-start"
          >
            <span className="h-2 w-px bg-border-subtle" />
            <span className="ml-0.5 font-mono text-[9px] text-fg-muted">
              {fmtTickLabel(t)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function niceTickInterval(seconds: number): number {
  // Round to a "nice" interval — 1s, 2s, 5s, 10s, 15s, 30s, 60s, etc.
  const nice = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const n of nice) {
    if (seconds <= n) return n;
  }
  return Math.ceil(seconds / 60) * 60;
}

function fmtTickLabel(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}:00` : `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Track — one horizontal lane (Video / Audio / Captions)
// ---------------------------------------------------------------------------

function Track({
  label,
  kind,
  positioned,
  pxPerSec,
  selectedId,
  onSelect,
  onDoubleClick,
  onContextMenu,
}: {
  label: string;
  kind: TrackKind;
  positioned: PositionedSegment[];
  pxPerSec: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDoubleClick?: (id: string) => void;
  onContextMenu: (segId: string, x: number, y: number) => void;
}) {
  const Icon = ICONS_BY_KIND[kind];
  const height = TRACK_HEIGHTS[kind];
  const lane = LANE_TINTS[kind];
  return (
    <div className="flex items-stretch" style={{ height }}>
      {/* Track label with icon — CapCut-style sticky left column.
       *  The lane's accent color shows on the left edge as a 3px
       *  stripe so the eye can pick out "this is the audio lane" at a
       *  glance even when the icon is off-screen via scroll. */}
      <div
        style={{ width: TRACK_LABEL_WIDTH }}
        className={cn(
          "flex shrink-0 items-center gap-2 border-l-[3px] pl-2 pr-3",
          lane.stripe,
        )}
      >
        <Icon size={13} strokeWidth={1.75} className={lane.iconColor} />
        <span className="text-[10px] font-medium uppercase tracking-wider text-fg-muted">
          {label}
        </span>
      </div>
      {/* Lane background — distinct tinted band per track so the row
       *  reads as a "lane" not just a flex row. The lane stretches to
       *  fill remaining horizontal space (flex-1) so the right side
       *  of the timeline doesn't have dead gray space past the last
       *  clip — the lane reads as the actual track, not a fitted box. */}
      <div className={cn("relative h-full flex-1", lane.bg)}>
        {/* Faint vertical dividers every N seconds so the empty
         *  trailing space still feels like a timeline track, not a
         *  void. Aligned with the ruler's tick interval. */}
        {positioned.map(({ seg, start }) => (
          <SegmentBlock
            key={seg.id}
            seg={seg}
            kind={kind}
            start={start}
            pxPerSec={pxPerSec}
            selected={seg.id === selectedId}
            onSelect={() => onSelect(seg.id)}
            onDoubleClick={onDoubleClick ? () => onDoubleClick(seg.id) : undefined}
            onContextMenu={(x, y) => onContextMenu(seg.id, x, y)}
          />
        ))}
      </div>
    </div>
  );
}

/** Per-lane visual tokens. `bg` is the lane *background* (the floor of
 *  the lane); `stripe` is the left-edge accent that runs full-height
 *  through the label column; `iconColor` matches the stripe so the
 *  icon + stripe + clip border all visually tie together. */
const LANE_TINTS: Record<TrackKind, { bg: string; stripe: string; iconColor: string }> = {
  video: {
    bg: "bg-[#0d1115]",
    stripe: "border-l-[#3b82f6]/70 bg-[#0a0d11]",
    iconColor: "text-[#60a5fa]",
  },
  audio: {
    bg: "bg-[#0c0d18]",
    stripe: "border-l-[#a78bfa]/70 bg-[#08091a]",
    iconColor: "text-[#a78bfa]",
  },
  captions: {
    bg: "bg-[#13100b]",
    stripe: "border-l-[#f59e0b]/70 bg-[#0e0a08]",
    iconColor: "text-[#fbbf24]",
  },
};

// ---------------------------------------------------------------------------
// Segment block — one slice on one track
// ---------------------------------------------------------------------------

function SegmentBlock({
  seg,
  kind,
  start,
  pxPerSec,
  selected,
  onSelect,
  onDoubleClick,
  onContextMenu,
}: {
  seg: Segment;
  kind: TrackKind;
  start: number;
  pxPerSec: number;
  selected: boolean;
  onSelect: () => void;
  onDoubleClick?: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const left = start * pxPerSec;
  const width = Math.max(36, seg.target_duration * pxPerSec);
  // Each track gets a distinct tint so the eye can scan one row at a
  // time. The video row is the "primary" block with the segment label;
  // audio + captions are lighter indicators of availability.
  const tint = TRACK_TINTS[kind];
  // Audio + caption rows show whether the asset is actually wired up
  // for that segment — if the corresponding ref is disabled we render
  // a disabled-state pattern so the user can spot gaps at a glance.
  const enabled =
    kind === "video"
      ? true
      : kind === "audio"
        ? seg.voiceover.enabled
        : seg.captions.enabled;
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      style={{
        position: "absolute",
        left,
        top: 3,
        bottom: 3,
        width: Math.max(width - 2, 4),
      }}
      className={cn(
        "group flex flex-col items-stretch justify-center overflow-hidden rounded border px-1.5 text-left transition-colors",
        tint.bg,
        tint.border,
        tint.text,
        selected
          ? "ring-2 ring-accent border-accent z-[5]"
          : "hover:brightness-125",
        !enabled && "opacity-35",
      )}
      title={
        kind === "video"
          ? `${seg.id} · ${seg.label || "(no label)"} · ${seg.target_duration.toFixed(1)}s`
          : kind === "audio"
            ? enabled
              ? `${seg.id} · voiceover · ${seg.target_duration.toFixed(1)}s`
              : `${seg.id} · voiceover disabled`
            : enabled
              ? `${seg.id} · captions · ${seg.target_duration.toFixed(1)}s`
              : `${seg.id} · captions disabled`
      }
    >
      {kind === "video" && (
        <>
          <span className="truncate text-[11px] font-medium leading-tight">
            {seg.label || seg.id}
          </span>
          <span className="flex w-full items-center gap-1 text-[9px] text-fg-muted">
            <span className="font-mono">{seg.target_duration.toFixed(1)}s</span>
            {seg.chapter && (
              <span className="truncate rounded bg-bg-inset px-1 py-px font-mono">
                {seg.chapter}
              </span>
            )}
            <span className="ml-auto font-mono">{seg.id.replace("seg_", "")}</span>
          </span>
        </>
      )}
      {kind === "audio" && (
        // Audio clip: a fake "waveform" — vertical bars of varying
        // height across the clip's width. Cheap CSS-only pattern that
        // reads as audio without needing the actual mp3 waveform. The
        // bars use a stable pseudo-random pattern keyed by the seg id
        // so the same segment always shows the same shape.
        <Waveform segId={seg.id} enabled={enabled} />
      )}
      {kind === "captions" && (
        // Caption peek: show a hint of the script text inside the clip
        // when there's room. Falls back to "cc · seg_NNN" on narrow
        // clips so we don't crash into truncation immediately.
        <span className="truncate font-mono text-[9px] leading-tight">
          {width > 90 && seg.label
            ? `cc · ${seg.label}`
            : `cc · ${seg.id.replace("seg_", "")}`}
        </span>
      )}
    </button>
  );
}

const TRACK_TINTS: Record<TrackKind, { bg: string; border: string; text: string }> = {
  video: {
    // Premiere-style cool gradient feel for the primary video lane.
    bg: "bg-gradient-to-b from-[#1f2937] to-[#111827]",
    border: "border-[#3b82f6]/40",
    text: "text-fg",
  },
  audio: {
    // Purple-tinted — matches the audio lane stripe.
    bg: "bg-gradient-to-b from-[#1a1430] to-[#0f0a20]",
    border: "border-[#a78bfa]/40",
    text: "text-[#ddd6fe]",
  },
  captions: {
    // Amber-tinted — matches the caption lane stripe.
    bg: "bg-gradient-to-b from-[#2a1f10] to-[#1a1308]",
    border: "border-[#f59e0b]/40",
    text: "text-[#fde68a]",
  },
};

/** Stylized waveform bars across an audio clip — a stable pseudo-random
 *  pattern keyed by the segment id so the same clip always renders the
 *  same shape (looks more "real" than re-shuffling on every render).
 *  We don't have the actual mp3 waveform yet — that's a future polish
 *  pass; this gives the audio lane a clear visual identity in the
 *  meantime. */
function Waveform({ segId, enabled }: { segId: string; enabled: boolean }) {
  // Deterministic-ish hash → bar heights. Plain modular arithmetic
  // keeps the result stable across renders without pulling a hashing
  // dep. We render 24 bars; the CSS flex layout stretches them across
  // the clip width.
  const seed = hashSeed(segId);
  const bars: number[] = [];
  for (let i = 0; i < 24; i++) {
    const n = (seed + i * 17) % 100;
    bars.push(20 + (n * 70) / 100); // height percent: 20% .. 90%
  }
  return (
    <div className="flex h-full w-full items-center gap-[1px]">
      {bars.map((h, i) => (
        <div
          key={i}
          style={{ height: `${h}%` }}
          className={cn(
            "flex-1 rounded-[1px]",
            enabled ? "bg-[#a78bfa]" : "bg-fg-muted/30",
          )}
        />
      ))}
    </div>
  );
}

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Playhead — vertical line + grab handle that tracks current playback
// ---------------------------------------------------------------------------
//
// Drawn as an absolute-positioned overlay so it spans every track row
// without participating in the flex layout. The triangular grab handle
// at the top is a CSS-only diamond rotated 45°. Drag the handle to
// scrub — that delegates to the same `scrubbing` flag the ruler uses,
// so the window pointermove listener handles the motion.
//
// We hide the handle when scrubbing so the user's cursor isn't fighting
// a hover state, but keep the line for visual continuity.

function Playhead({
  left,
  playing,
  onPointerDown,
}: {
  left: number;
  playing: boolean;
  onPointerDown: () => void;
}) {
  // We want the diamond handle AND the vertical line to share the
  // same horizontal axis at exactly `left` pixels. The previous
  // implementation wrapped both in a `flex flex-col items-center`
  // container; `items-center` aligns to the cross-axis center
  // (12px = handle width / 2 = 6px), but the handle ALSO had
  // `marginLeft: -6` — which combined produced a 6px offset between
  // the diamond and the line. Both pieces are now absolute-
  // positioned relative to the zero-width container so their centers
  // land on `left` exactly.
  //
  // Handle: 12×12 rotated 45° → its visual center is the center of
  // the box, so positioning `left: -6` puts its center at 0 of the
  // wrapper, which sits at `left` on the timeline.
  //
  // Line: 2px wide → `left: -1` puts its center at 0 of the wrapper.
  return (
    <div
      style={{ left, top: 0, bottom: 0 }}
      className="pointer-events-none absolute z-10"
    >
      <div
        style={{ position: "absolute", top: 0, bottom: 0, left: -1, width: 2 }}
        className={cn(
          playing
            ? "bg-accent shadow-[0_0_8px_rgba(99,179,237,0.7)]"
            : "bg-accent/80",
        )}
      />
      <div
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          onPointerDown();
        }}
        style={{
          position: "absolute",
          top: -3,
          left: -6,
          width: 12,
          height: 12,
        }}
        className="pointer-events-auto rotate-45 cursor-ew-resize rounded-sm border border-accent bg-accent shadow-md"
        title="Drag to scrub"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DurationBadge — per-video target duration override editor
// ---------------------------------------------------------------------------
//
// The badge shows the effective target duration for the current video:
//   - If the video has `target_duration_seconds_override > 0`, that wins.
//   - Else falls back to the project-level recap config target.
//   - Else "—" (we don't have a target).
//
// Click → small numeric input + Save / Clear. "Clear" removes the
// override so the project default takes over again. Saving 0 also
// clears. The badge labels the source ("project default" vs "video
// override") so the user knows what they're editing.
//
// Writes via `saveVideo` — the Rust side accepts the raw Video JSON
// including the new `target_duration_seconds_override` field, persists
// it, and the next agent prompt picks it up.
function DurationBadge() {
  const project = useApp((s) => s.project);
  const setError = useApp((s) => s.setError);
  const loadProject = useApp((s) => s.loadProject);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [projectDefault, setProjectDefault] = useState(0);

  // Pull the project-level target so we can show "project default" as
  // a fallback indicator. This is the SAME value the Settings dialog
  // edits — we don't try to keep it in sync via store; a fresh fetch
  // when the badge opens is enough.
  useEffect(() => {
    if (!project?.project_dir) return;
    getRecapConfig(project.project_dir)
      .then((cfg) => setProjectDefault(cfg.target_duration_seconds))
      .catch(() => setProjectDefault(0));
  }, [project?.project_dir]);

  const video = project?.video ?? null;
  const override = video?.target_duration_seconds_override ?? 0;
  const effective = override > 0 ? override : projectDefault;

  function startEdit() {
    setDraft(String(override > 0 ? override : ""));
    setEditing(true);
  }

  async function commit(rawValue: string) {
    if (!project || !video) return;
    const parsed = parseInt(rawValue || "0", 10) || 0;
    const next = parsed > 0 ? parsed : 0;
    try {
      const nextVideo = { ...video, target_duration_seconds_override: next };
      await saveVideoCmd(project.project_dir, video.video_id, nextVideo);
      // Patch the store so the UI updates without a full re-open.
      loadProject({
        ...project,
        video: nextVideo,
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!project?.video) return null;

  if (editing) {
    return (
      <span className="flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5">
        <span className="text-[9px] uppercase tracking-wider text-fg-muted">target</span>
        <input
          autoFocus
          type="number"
          min={0}
          max={1800}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit(draft);
            else if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => void commit(draft)}
          className="w-12 rounded border border-border-subtle bg-bg-inset px-1 py-0 font-mono text-[10px] text-fg focus:focus-ring"
        />
        <span className="text-[9px] text-fg-muted">s</span>
      </span>
    );
  }

  const label = effective > 0 ? `${effective}s` : "—";
  const source =
    override > 0 ? "override" : projectDefault > 0 ? "project" : "unset";
  return (
    <button
      type="button"
      onClick={startEdit}
      title={
        override > 0
          ? `This video's target duration overrides the project default (${projectDefault || "unset"}s). Click to edit.`
          : `Target duration from project settings (${projectDefault || "unset"}s). Click to override for this video only.`
      }
      className={cn(
        "rounded border px-1.5 py-0.5 transition-colors hover:bg-bg-raised",
        override > 0
          ? "border-accent/40 bg-accent/10 text-fg"
          : "border-border-subtle text-fg-muted",
      )}
    >
      <span className="text-[9px] uppercase tracking-wider opacity-70">target</span>{" "}
      <span className="text-fg">{label}</span>{" "}
      <span className="text-[9px] opacity-60">· {source}</span>
    </button>
  );
}

function HistoryButton(props: {
  label: string;
  title: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      className={cn(
        "rounded px-1.5 py-0.5 text-sm transition-colors",
        props.disabled
          ? "cursor-not-allowed text-fg-muted"
          : "text-fg-subtle hover:bg-bg-raised hover:text-fg",
      )}
    >
      {props.label}
    </button>
  );
}

/** Compute pixels-per-second so the timeline fills the visible
 *  tracks area WITHOUT compressing short segments past readability.
 *
 *  Two competing goals:
 *
 *    - Fit-to-viewport: short timelines should expand to fill the
 *      lane so we don't leave dead space on the right. `fit = usable
 *      / totalSec` gives the density that exactly fills.
 *    - Readability floor: a 3-second segment crushed to 20px wide is
 *      unreadable (label clips to a single character, see the user's
 *      screenshot). For long timelines we want each segment to have
 *      at least MIN_SEG_PX of width — and we'd rather scroll
 *      horizontally than squeeze. Overflow-x is already enabled on
 *      the tracks area, so this is free.
 *
 *  We pick the LARGER of (fit, readability-floor) so short timelines
 *  still fill and long ones scroll. MIN_PX_PER_SEC / MAX_PX_PER_SEC
 *  remain as sanity clamps.
 *
 *  First-paint fallback: when the ResizeObserver hasn't fired yet
 *  (containerWidth = 0) we use a synthetic 1200px viewport so the
 *  initial render is close to the final layout instead of popping. */
function autoDensity(
  segments: Segment[],
  totalSec: number,
  containerWidth: number,
): number {
  if (segments.length === 0 || totalSec === 0) return DEFAULT_PX_PER_SEC;
  const usable =
    containerWidth > TRACK_LABEL_WIDTH + 80
      ? containerWidth - TRACK_LABEL_WIDTH - 24
      : 1200 * 0.85;
  const fit = usable / totalSec;
  // Readability floor: the SHORTEST segment must render at least
  // MIN_SEG_PX wide so its label has somewhere to live. Anything
  // below that and we let the timeline overflow horizontally rather
  // than squeeze every clip into illegibility.
  const MIN_SEG_PX = 64;
  let shortest = Infinity;
  for (const s of segments) {
    if (s.target_duration > 0 && s.target_duration < shortest) {
      shortest = s.target_duration;
    }
  }
  const readabilityFloor =
    Number.isFinite(shortest) ? MIN_SEG_PX / shortest : DEFAULT_PX_PER_SEC;
  const want = Math.max(fit, readabilityFloor);
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, want));
}

/** Format a time as `mm:ss.t` — CapCut/Premiere style timecode for
 *  the transport readout. Tenths-of-a-second precision keeps the
 *  field compact while still being scrub-useful. */
function fmtTimecode(sec: number): string {
  const safe = Math.max(0, sec);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const t = Math.floor((safe * 10) % 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${t}`;
}
