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

import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { ChapterChip } from "./components/ChapterChip";
import type { KenBurnsKeyframe, PanelCaption } from "./schema";
import type { ThemeTokens } from "./themes";

interface PanelSegmentProps {
  source: string;
  sources: string[];
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

  // Resolve which images to show: prefer `sources` if non-empty.
  const panelPaths = sources.length > 0 ? sources : [source];
  const isMulti = panelPaths.length > 1;

  // Primary source for the bokeh background
  const bgSource = panelPaths[0]!;

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

      {/* Sharp panel layer with Ken Burns. */}
      {isMulti ? (
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
        // Single-panel: **full-bleed height, horizontal-only bokeh.**
        // The img sits at `height: 100%, width: auto`, which means its
        // rendered width = naturalWidth × (canvasHeight / naturalHeight).
        // - If that width < canvasWidth → bokeh shows on left & right
        //   (the desired case for taller-than-9:16 manhwa panels).
        // - If that width > canvasWidth → the parent's `overflow:
        //   hidden` crops the sides (correct for unusually-wide sources
        //   — still no top/bottom mat-board).
        // - There is NEVER a top or bottom letterbox. That was the bug
        //   the reference video flagged: vertical real estate was being
        //   stolen by mat-board on top/bottom instead of showing more
        //   panel content.
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
              filter: "drop-shadow(0 8px 32px rgba(0,0,0,0.55)) drop-shadow(0 2px 8px rgba(0,0,0,0.4))",
            }}
          >
            <Img
              src={staticFile(panelPaths[0]!)}
              style={{
                height: "100%",
                width: "auto",
                display: "block",
              }}
            />
          </div>
        </div>
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
