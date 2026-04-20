import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import type { Keyframe } from "./schema";

/**
 * Interpolate zoom + focus at the current frame from a global output-timeline
 * keyframe list. `offsetFrames` shifts the wrapper's local frame into the
 * global output timeline (since each segment is a <Series.Sequence>).
 */
export const CameraWrapper: React.FC<{
  keyframes: Keyframe[];
  offsetFrames: number;
  width: number;
  height: number;
  children: React.ReactNode;
}> = ({ keyframes, offsetFrames, width, height, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = (frame + offsetFrames) / fps;

  const { zoom, fx, fy } = sampleCamera(keyframes, t);

  // Translate so that the normalized focus point stays centered while zooming.
  // tx,ty are CSS transform-origin in px; we scale about that point.
  const tx = fx * width;
  const ty = fy * height;

  return (
    <div
      style={{
        width,
        height,
        overflow: "hidden",
        position: "absolute",
        top: 0,
        left: 0,
      }}
    >
      <div
        style={{
          width,
          height,
          transformOrigin: `${tx}px ${ty}px`,
          transform: `scale(${zoom})`,
          willChange: "transform",
        }}
      >
        {children}
      </div>
    </div>
  );
};

function sampleCamera(kfs: Keyframe[], t: number): { zoom: number; fx: number; fy: number } {
  if (kfs.length === 0) return { zoom: 1, fx: 0.5, fy: 0.5 };
  if (t <= kfs[0].t) return { zoom: kfs[0].zoom, fx: kfs[0].focus[0], fy: kfs[0].focus[1] };
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const zoom = interpolate(t, [a.t, b.t], [a.zoom, b.zoom], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const fx = interpolate(t, [a.t, b.t], [a.focus[0], b.focus[0]], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const fy = interpolate(t, [a.t, b.t], [a.focus[1], b.focus[1]], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      return { zoom, fx, fy };
    }
  }
  const last = kfs[kfs.length - 1];
  return { zoom: last.zoom, fx: last.focus[0], fy: last.focus[1] };
}
