// PanelSegment — one manhwa-recap segment.
//
// Renders still panels with Ken Burns motion, optional voiceover audio,
// chapter chip overlay, and themed captions.
//
// Visual model (v2 — bokeh + multi-panel):
//   - Blurred "bokeh" background of the primary panel fills the 9:16 canvas.
//   - Sharp panel(s) overlay on top with slight horizontal padding so the
//     bokeh is visible on the left/right edges (horizontal axis).
//   - When `sources` has 2+ entries, panels stack vertically with gaps and
//     rounded corners — comic-strip style.
//   - Ken Burns zoom + pan still applies to the sharp layer.

import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { ChapterChip } from "./components/ChapterChip";
import type { KenBurnsKeyframe, PanelCaption, PanelFrame } from "./schema";
import type { ThemeTokens } from "./themes";

interface PanelSegmentProps {
  source: string;
  sources: string[];
  /** Sequential multi-image cycle. Empty array = single-image mode. */
  panels: PanelFrame[];
  durationSeconds: number;
  audioPath: string | null;
  camera: KenBurnsKeyframe[];
  captions: PanelCaption[];
  chapter: string;
  theme: ThemeTokens;
  showChip: boolean;
}

// Layout constants
//
// **Reference style** is the AKIEL-RUNES TikTok format — panels fill the
// canvas fully on the height axis, and bokeh appears ONLY on the left/
// right edges (horizontal-only bokeh) where the panel's natural width
// doesn't reach 1080px. No vertical bokeh, no top/bottom crop.
//
// The earlier layout reserved 2% top + 10% bottom padding inside a
// `object-fit: cover` container. That had two compounding problems:
//   1. The container was smaller than the canvas (only 88% tall), so
//      ~12% of vertical real estate became bokeh — visible as fat
//      horizontal mat-board on top and bottom.
//   2. `cover` then cropped the source to fill that smaller container,
//      which is data-loss on a typically-taller-than-9:16 source.
//
// Now: single-panel mode uses `height: 100%, width: auto` directly so
// the panel fills the canvas height edge-to-edge and overflows / lets
// bokeh show only where horizontally needed. Multi-panel mode keeps
// its stacked layout (the values below only affect multi).
const SIDE_PAD = 0.02; // multi-panel only — horizontal padding for stacked layout
const MULTI_TOP_PAD = 0.02; // multi-panel only — top padding to avoid the chip
const MULTI_BOTTOM_PAD = 0.10; // multi-panel only — leaves caption-band breathing room
const PANEL_GAP = 0.02; // 2% gap between stacked panels
const PANEL_RADIUS = 12; // px — rounded corners on each panel card (multi only)

export const PanelSegment: React.FC<PanelSegmentProps> = ({
  source,
  sources,
  panels,
  durationSeconds,
  audioPath,
  camera,
  captions,
  chapter,
  theme,
  showChip,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const { zoom, panX, panY } = sampleKenBurns(camera, t, durationSeconds);

  const offsetX = panX * width;
  const offsetY = panY * height;

  // Three layouts, decided in priority order:
  //   1. `panels[]` non-empty → SEQUENTIAL cycle (crossfade between frames).
  //   2. `sources[]` non-empty → STACKED comic-strip (cards visible at once).
  //   3. Single `source` → fit/scroll single-panel via `SinglePanel`.
  const useSequence = panels.length > 0;
  const panelPaths = sources.length > 0 ? sources : [source];
  const isMulti = !useSequence && panelPaths.length > 1;

  // Primary source for the bokeh background. In sequence mode we use
  // the first panel; that means the backdrop stays stable across the
  // crossfade, which is the visual choice the reference style makes
  // (the bokeh isn't trying to also crossfade between every frame —
  // that would be too busy).
  const bgSource = useSequence ? panels[0]!.source : panelPaths[0]!;

  // Multi-panel layout metrics — only used in the multi branch below.
  // Single-panel mode ignores these entirely and uses full-bleed height.
  const multiInnerWidth = width * (1 - SIDE_PAD * 2);
  const totalGap = isMulti ? PANEL_GAP * (panelPaths.length - 1) * height : 0;
  const multiUsableHeight = height * (1 - MULTI_TOP_PAD - MULTI_BOTTOM_PAD);
  const multiPanelHeight = isMulti
    ? (multiUsableHeight - totalGap) / panelPaths.length
    : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.background }}>
      {/* Bokeh background — blurred version of the primary panel. We
       *  inset by -40px so the blur's soft edges don't reveal the
       *  canvas background underneath. */}
      <div
        style={{
          position: "absolute",
          inset: -40,
          overflow: "hidden",
        }}
      >
        <Img
          src={staticFile(bgSource)}
          style={{
            width: "calc(100% + 80px)",
            height: "calc(100% + 80px)",
            objectFit: "cover",
            filter: "blur(30px) saturate(1.3) brightness(0.5)",
          }}
        />
      </div>

      {/* Sharp panel layer. Branches by layout in priority order. */}
      {useSequence ? (
        <PanelSequence
          panels={panels}
          totalDurationSeconds={durationSeconds}
          t={t}
        />
      ) : isMulti ? (
        // Multi-panel: stacked cards with rounded corners and gaps. Kept
        // the legacy layout because comic-strip multi-panel framing
        // genuinely benefits from card edges + drop shadow.
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: `${height * MULTI_TOP_PAD}px ${width * SIDE_PAD}px ${height * MULTI_BOTTOM_PAD}px`,
            gap: PANEL_GAP * height,
          }}
        >
          {panelPaths.map((panelPath, idx) => (
            <div
              key={idx}
              style={{
                width: multiInnerWidth,
                height: multiPanelHeight,
                borderRadius: PANEL_RADIUS,
                overflow: "hidden",
                boxShadow: "0 8px 32px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  transform: `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${zoom})`,
                  transformOrigin: "center center",
                  willChange: "transform",
                }}
              >
                <Img
                  src={staticFile(panelPath)}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        // Single-panel: branches on source aspect ratio. See
        // `SinglePanel` for the full decision tree.
        <SinglePanel
          source={panelPaths[0]!}
          t={t}
          durationSeconds={durationSeconds}
          offsetX={offsetX}
          offsetY={offsetY}
          zoom={zoom}
        />
      )}

      {/* Caption band */}
      <Captions captions={captions} theme={theme} />

      {/* Chapter chip */}
      {showChip && (
        <ChapterChip
          label={chapter}
          durationSeconds={durationSeconds}
          theme={theme}
        />
      )}

      {/* Audio */}
      {audioPath ? <Audio src={staticFile(audioPath)} /> : null}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// SinglePanel — branches on source aspect ratio
// ---------------------------------------------------------------------------
//
// Three cases, decided once the source image's natural dimensions are
// known (via the `delayRender` preloader):
//
//   1. **scroll-mode** — source is materially taller than 9:16 (typical
//      manhwa/webtoon page: 800×3000+, aspect ratio ≤ 0.48). Render
//      the image at `width: canvasWidth` (so it fills horizontally
//      edge-to-edge), height auto-scales to maintain aspect. The image
//      is taller than the canvas — we animate `translateY` from 0 down
//      to `-(renderedHeight - canvasHeight)` linearly over the segment
//      duration. The viewer scrolls through the entire page like
//      reading a webtoon. **This is what manhwa is built for.**
//   2. **fit-mode** — source aspect is close to or wider than 9:16
//      (typical action panels, character close-ups, screenshots).
//      Render at `height: 100%, width: auto` so the image fills the
//      canvas height and bokeh shows on the left/right where the
//      natural width doesn't reach 1080. Ken Burns motion applies.
//   3. **fallback** — preload failed (404, decode error, etc.). Use
//      fit-mode behavior since it's the safer default; the bokeh
//      backdrop covers the empty space.
//
// The scroll threshold (`SCROLL_ASPECT_THRESHOLD = 0.48`) is 15% taller
// than the canvas aspect (9:16 = 0.5625), so normal action panels with
// minor aspect mismatch stay in fit-mode and get the horizontal-only
// bokeh look the user asked for.
//
// In scroll-mode the user-provided Ken Burns keyframes are intentionally
// ignored — the auto-scroll IS the camera. Adding a second pan on top
// would compete with the scroll and feel jittery.

const SCROLL_ASPECT_THRESHOLD = 0.48;

// ---------------------------------------------------------------------------
// PanelSequence — sequential image cycle with crossfade
// ---------------------------------------------------------------------------
//
// Renders a segment's `panels[]` array as a temporal sequence: each
// frame appears for its computed window, with a short crossfade
// between adjacent frames so the cut never feels hard.
//
// Per-frame duration resolution:
//   - Frames with `duration_seconds > 0` keep their explicit value.
//   - The leftover (segment_duration - sum_of_explicit) is split evenly
//     across the implicit frames.
//   - If the leftover is negative (explicit durations overspecified the
//     segment), we clip back to a proportional share. No frame goes
//     below 0.5s — at that point the human eye can't register the
//     content anyway.
//
// Crossfade: 0.4s by default. The next frame fades in over its first
// 0.4s while the prior frame fades out over its last 0.4s, producing
// a clean dissolve without the audio cutting (audio is on the parent
// segment, untouched). All frames render layered absolute-positioned;
// opacity drives the visibility.
//
// Each frame inside the sequence delegates to `SinglePanel` so it
// inherits the fit/scroll aspect logic — a tall webtoon page used as
// one of N sequential frames still scrolls within its own window.

const SEQUENCE_CROSSFADE_SEC = 0.4;
const SEQUENCE_MIN_FRAME_SEC = 0.5;

const PanelSequence: React.FC<{
  panels: PanelFrame[];
  totalDurationSeconds: number;
  t: number;
}> = ({ panels, totalDurationSeconds, t }) => {
  // Resolve final per-frame durations.
  const explicitSum = panels.reduce(
    (sum, p) => sum + (p.duration_seconds > 0 ? p.duration_seconds : 0),
    0,
  );
  const implicitCount = panels.filter((p) => !(p.duration_seconds > 0)).length;
  const leftover = totalDurationSeconds - explicitSum;
  const perImplicit =
    implicitCount > 0 ? Math.max(SEQUENCE_MIN_FRAME_SEC, leftover / implicitCount) : 0;
  // Compute cumulative windows.
  let cursor = 0;
  const windows = panels.map((p) => {
    const dur =
      p.duration_seconds > 0
        ? Math.max(SEQUENCE_MIN_FRAME_SEC, p.duration_seconds)
        : perImplicit;
    const start = cursor;
    const end = cursor + dur;
    cursor = end;
    return { source: p.source, start, end, dur };
  });

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {windows.map((w, i) => {
        // Smooth in/out via interpolate. The fade-in window ends at
        // w.start + crossfade, and the fade-out window starts at
        // w.end - crossfade. We clamp half-crossfade against the
        // segment boundaries on the very first / very last frame so
        // they don't fade from / to black at the segment edges.
        const halfFade = SEQUENCE_CROSSFADE_SEC / 2;
        const isFirst = i === 0;
        const isLast = i === windows.length - 1;
        const fadeInStart = isFirst ? -halfFade : w.start - halfFade;
        const fadeInEnd = w.start + halfFade;
        const fadeOutStart = w.end - halfFade;
        const fadeOutEnd = isLast ? w.end + halfFade : w.end + halfFade;
        const opacity = interpolate(
          t,
          [fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
        if (opacity <= 0) return null;
        // Local time within the frame's window — drives its own
        // scroll-mode animation. `t - w.start` clamped to [0, dur].
        const localT = Math.min(w.dur, Math.max(0, t - w.start));
        return (
          <div
            key={`${w.source}-${i}`}
            style={{ position: "absolute", inset: 0, opacity }}
          >
            <SinglePanel
              source={w.source}
              t={localT}
              durationSeconds={w.dur}
              offsetX={0}
              offsetY={0}
              zoom={1}
            />
          </div>
        );
      })}
    </div>
  );
};

const SinglePanel: React.FC<{
  source: string;
  t: number;
  durationSeconds: number;
  offsetX: number;
  offsetY: number;
  zoom: number;
}> = ({ source, t, durationSeconds, offsetX, offsetY, zoom }) => {
  const { width, height } = useVideoConfig();
  // Preload the image to learn its intrinsic dimensions. `delayRender`
  // pauses the Remotion render until we call `continueRender`, so the
  // first frame the encoder sees already has the correct mode picked.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [handle] = useState(() =>
    delayRender(`PanelSegment.SinglePanel: loading ${source}`),
  );
  useEffect(() => {
    const img = new window.Image();
    img.onload = () => {
      setDims({ w: img.naturalWidth, h: img.naturalHeight });
      continueRender(handle);
    };
    img.onerror = () => {
      // Fall through to fit-mode default — render still proceeds.
      continueRender(handle);
    };
    img.src = staticFile(source);
    return () => {
      // If the effect re-runs (source changes), abandon the prior
      // listener — onload will no-op since we'd be in a stale closure
      // anyway.
      img.onload = null;
      img.onerror = null;
    };
  }, [source, handle]);

  if (!dims) {
    // delayRender keeps this frame off the encoder, but during the
    // dev preview the user sees a brief blank. Bokeh backdrop is
    // already painted by the parent so this isn't jarring.
    return null;
  }

  const sourceAspect = dims.w / dims.h;
  const useScroll = sourceAspect < SCROLL_ASPECT_THRESHOLD;

  if (useScroll) {
    // Width = canvas width, height = scaled to preserve aspect.
    const renderedHeight = width / sourceAspect;
    const maxScroll = Math.max(0, renderedHeight - height);
    // Linear scroll from 0 (top) → -maxScroll (bottom) over the segment.
    // Clamped 0..1 so a frame past the end stays at the bottom rather
    // than flying off — happens when ffmpeg renders a frame at t ==
    // duration (the inclusive boundary).
    const progress = Math.min(1, Math.max(0, t / durationSeconds));
    const translateY = -maxScroll * progress;
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width,
            height: renderedHeight,
            transform: `translate3d(0, ${translateY}px, 0)`,
            willChange: "transform",
            filter:
              "drop-shadow(0 8px 32px rgba(0,0,0,0.55)) drop-shadow(0 2px 8px rgba(0,0,0,0.4))",
          }}
        >
          <Img
            src={staticFile(source)}
            style={{
              width: "100%",
              height: "100%",
              display: "block",
            }}
          />
        </div>
      </div>
    );
  }

  // Fit-mode: full-bleed height, horizontal-only bokeh on sides.
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          height: "100%",
          transform: `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${zoom})`,
          transformOrigin: "center center",
          willChange: "transform",
          filter:
            "drop-shadow(0 8px 32px rgba(0,0,0,0.55)) drop-shadow(0 2px 8px rgba(0,0,0,0.4))",
        }}
      >
        <Img
          src={staticFile(source)}
          style={{
            height: "100%",
            width: "auto",
            display: "block",
          }}
        />
      </div>
    </div>
  );
};


/** Sample zoom + pan at time `t`. With no keyframes we apply a gentle
 *  default Ken Burns (1.0 → 1.05 over the segment). */
function sampleKenBurns(
  kfs: KenBurnsKeyframe[],
  t: number,
  duration: number,
): { zoom: number; panX: number; panY: number } {
  if (kfs.length === 0) {
    const zoom = interpolate(t, [0, duration], [1.0, 1.05], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    return { zoom, panX: 0, panY: 0 };
  }
  if (kfs.length === 1) {
    return { zoom: kfs[0]!.zoom, panX: kfs[0]!.pan_x, panY: kfs[0]!.pan_y };
  }
  if (t <= kfs[0]!.t) {
    return { zoom: kfs[0]!.zoom, panX: kfs[0]!.pan_x, panY: kfs[0]!.pan_y };
  }
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const zoom = interpolate(t, [a.t, b.t], [a.zoom, b.zoom], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const panX = interpolate(t, [a.t, b.t], [a.pan_x, b.pan_x], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const panY = interpolate(t, [a.t, b.t], [a.pan_y, b.pan_y], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      return { zoom, panX, panY };
    }
  }
  const last = kfs[kfs.length - 1]!;
  return { zoom: last.zoom, panX: last.pan_x, panY: last.pan_y };
}

/** Theme-aware caption band. */
const Captions: React.FC<{ captions: PanelCaption[]; theme: ThemeTokens }> = ({
  captions,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const active = captions.find((c) => t >= c.start && t <= c.end);
  if (!active) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        // Sit higher up inside the bottom-pad strip — at 5% the caption
        // hugs the bottom; reference-style TikTok captions sit in the
        // middle third, so place at ~30% from bottom to read naturally.
        bottom: height * 0.30,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontFamily: "Inter, system-ui, sans-serif",
          // Was 7.8% → big 2-word bursts clipped the edges. 6.2% holds
          // 2-word bursts on a single line at 1080-wide without wrap,
          // which is the reference style. If captions ever wrap (longer
          // strings), they'll go to two lines instead of clipping.
          fontSize: Math.round(width * 0.062),
          fontWeight: 800,
          color: theme.captionFg,
          letterSpacing: "-0.015em",
          textShadow:
            "0 0 18px rgba(0,0,0,0.85), 0 4px 12px rgba(0,0,0,0.7)",
          padding: `${Math.round(height * 0.012)}px ${Math.round(width * 0.04)}px`,
          background: theme.captionBg,
          borderRadius: Math.round(width * 0.024),
          textTransform: "uppercase",
          lineHeight: 1.15,
          maxWidth: width * 0.88,
          textAlign: "center",
        }}
      >
        {active.text}
      </div>
    </div>
  );
};
