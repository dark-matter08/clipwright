// PanelSegment — one manhwa-recap segment.
//
// Renders a single still panel with Ken Burns motion, an optional
// voiceover audio track, the chapter chip overlay, and themed captions.
// All times are LOCAL to the segment (0 = segment start) because we sit
// inside a Series.Sequence and `useCurrentFrame` resets at the start of
// each sequence.
//
// Visual model:
//   - Solid theme background fills the 9:16 canvas.
//   - Panel image is `objectFit: cover` so it always fills the frame
//     and the Ken Burns crop is meaningful (no letterboxed dead space).
//   - We zoom AND translate via CSS transform — pan_x/pan_y are
//     normalized [-1..+1] offsets multiplied by the canvas size, so a
//     pan_y of 0.2 nudges the image down by 20% of the canvas height.

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
  durationSeconds: number;
  audioPath: string | null;
  camera: KenBurnsKeyframe[];
  captions: PanelCaption[];
  chapter: string;
  theme: ThemeTokens;
  showChip: boolean;
}

export const PanelSegment: React.FC<PanelSegmentProps> = ({
  source,
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

  // Pan offsets in pixels — applied as translate3d on the inner layer
  // so the zoom and pan compose with one transform stack.
  const offsetX = panX * width;
  const offsetY = panY * height;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.background }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${zoom})`,
            transformOrigin: "center center",
            willChange: "transform",
          }}
        >
          <Img
            src={staticFile(source)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        </div>
      </div>

      {/* Caption band — bottom-third placement so it never sits on a face. */}
      <Captions captions={captions} theme={theme} />

      {/* Chapter chip — top-right overlay. */}
      {showChip && (
        <ChapterChip
          label={chapter}
          durationSeconds={durationSeconds}
          theme={theme}
        />
      )}

      {/* Audio track at segment-local t=0. */}
      {audioPath ? <Audio src={staticFile(audioPath)} /> : null}
    </AbsoluteFill>
  );
};

/** Sample zoom + pan at time `t`. With no keyframes we apply a gentle
 *  default Ken Burns (1.0 → 1.08 over the segment) so even untouched
 *  panels feel alive — static is opt-in via a single keyframe at zoom 1. */
function sampleKenBurns(
  kfs: KenBurnsKeyframe[],
  t: number,
  duration: number,
): { zoom: number; panX: number; panY: number } {
  if (kfs.length === 0) {
    const zoom = interpolate(t, [0, duration], [1.0, 1.08], {
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

/** Theme-aware caption band. Same shape as the recording-mode `Captions`
 *  component but reads colors from theme tokens so it harmonizes with
 *  the chapter chip and BG. */
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
        bottom: height * 0.15,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: Math.round(width * 0.078),
          fontWeight: 800,
          color: theme.captionFg,
          letterSpacing: "-0.015em",
          textShadow:
            "0 0 18px rgba(0,0,0,0.85), 0 4px 12px rgba(0,0,0,0.7)",
          padding: `${Math.round(height * 0.015)}px ${Math.round(width * 0.05)}px`,
          background: theme.captionBg,
          borderRadius: Math.round(width * 0.028),
          textTransform: "uppercase",
          lineHeight: 1.15,
          maxWidth: width * 0.85,
          textAlign: "center",
        }}
      >
        {active.text}
      </div>
    </div>
  );
};
