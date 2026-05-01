import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Radial wave ripple centred on a click/hover action.
 * useCurrentFrame() = 0 at the moment the annotation starts (via parent Sequence).
 * Three rings staggered in time create a water-drop-like pulse.
 */
export const ClickRipple: React.FC<{
  /** Center in canvas pixels */
  cx: number;
  cy: number;
  color?: string;
}> = ({ cx, cy, color = "rgba(255,255,255,0.85)" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const MAX_RADIUS = 64;
  const RING_DURATION = 0.55; // seconds per ring
  const DELAYS = [0, 0.12, 0.24]; // stagger between rings

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
      {/* Center dot — fades quickly */}
      <circle
        cx={cx}
        cy={cy}
        r={9}
        fill={color}
        opacity={interpolate(t, [0, 0.18], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })}
      />

      {/* Expanding rings */}
      {DELAYS.map((delay, i) => {
        const progress = Math.max(0, t - delay);
        const radius = interpolate(progress, [0, RING_DURATION], [12, MAX_RADIUS], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const opacity = interpolate(progress, [0, RING_DURATION * 0.3, RING_DURATION], [0.7, 0.5, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            opacity={opacity}
          />
        );
      })}
    </svg>
  );
};
