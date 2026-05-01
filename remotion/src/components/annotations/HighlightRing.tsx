import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Animated stroke rectangle around an input / focused element.
 * Fades in, holds while the user types, then fades out.
 * useCurrentFrame() = 0 at annotation start (via parent Sequence).
 */
export const HighlightRing: React.FC<{
  /** Bbox center in canvas pixels */
  cx: number;
  cy: number;
  /** Bbox dimensions in canvas pixels */
  bw: number;
  bh: number;
  /** Duration of this annotation in seconds (used to determine hold phase). */
  duration: number;
  color?: string;
}> = ({ cx, cy, bw, bh, duration, color = "rgba(255,255,255,0.9)" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const FADE_IN = 0.18;
  const FADE_OUT = Math.max(FADE_IN, duration - 0.2);
  const PAD = 10; // padding around the element in canvas pixels
  const RADIUS = 7; // rounded corner radius

  const x = cx - bw / 2 - PAD;
  const y = cy - bh / 2 - PAD;
  const w = bw + PAD * 2;
  const h = bh + PAD * 2;

  // Entrance: slight scale-in from 1.08 → 1.0
  const scale = interpolate(t, [0, FADE_IN], [1.08, 1.0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const opacity = interpolate(
    t,
    [0, FADE_IN, FADE_OUT, duration],
    [0, 0.9, 0.9, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Apply scale around the rectangle center.
  const scaledW = w * scale;
  const scaledH = h * scale;
  const scaledX = cx - scaledW / 2;
  const scaledY = cy - scaledH / 2;

  return (
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        overflow: "visible",
        pointerEvents: "none",
      }}
    >
      <rect
        x={scaledX}
        y={scaledY}
        width={scaledW}
        height={scaledH}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        rx={RADIUS}
        ry={RADIUS}
        opacity={opacity}
      />
    </svg>
  );
};
