import React from "react";
import { Sequence, useVideoConfig } from "remotion";
import type { AnnotationEvent } from "../schema";
import { ClickRipple } from "./annotations/ClickRipple";
import { HighlightRing } from "./annotations/HighlightRing";

/**
 * Renders motion-graphic overlays for all annotation events that fall within
 * this segment's playback window.
 *
 * Each annotation is wrapped in a <Sequence> so the inner components receive
 * `useCurrentFrame() === 0` at the moment the annotation starts. The Sequence
 * automatically hides the component outside its window.
 *
 * Coordinate system:
 *   - annotation.cx/cy/bw/bh are in recording CSS pixels (e.g. 540×960).
 *   - We convert to canvas pixels by multiplying by (canvasW / viewportW).
 */
export const AnnotationOverlay: React.FC<{
  annotations: AnnotationEvent[];
  /** Global output-timeline frame offset of this segment's start. */
  offsetFrames: number;
  /** Recording viewport dimensions (source of cx/cy/bw/bh). */
  viewportW: number;
  viewportH: number;
  /** Final canvas dimensions. */
  canvasW: number;
  canvasH: number;
}> = ({ annotations, offsetFrames, viewportW, viewportH, canvasW, canvasH }) => {
  const { fps } = useVideoConfig();

  if (!annotations.length) return null;

  const scaleX = canvasW / viewportW;
  const scaleY = canvasH / viewportH;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {annotations.map((ann, i) => {
        // Convert global output-timeline seconds → local segment frame number.
        const fromFrame = Math.round(ann.t_in * fps) - offsetFrames;
        const durationFrames = Math.max(1, Math.round((ann.t_out - ann.t_in) * fps));

        // Skip annotations that fall entirely outside this segment's timeline.
        // (The parent Video component only supplies the segment slice anyway,
        //  but this guard avoids negative `from` values on Sequence.)
        if (fromFrame + durationFrames <= 0) return null;

        const cx = ann.cx * scaleX;
        const cy = ann.cy * scaleY;
        const bw = ann.bw * scaleX;
        const bh = ann.bh * scaleY;
        const annDuration = ann.t_out - ann.t_in;

        let overlay: React.ReactNode = null;
        if (ann.action_type === "click" || ann.action_type === "hover") {
          overlay = <ClickRipple cx={cx} cy={cy} />;
        } else if (ann.action_type === "type") {
          overlay = <HighlightRing cx={cx} cy={cy} bw={bw} bh={bh} duration={annDuration} />;
        }

        if (!overlay) return null;

        return (
          <Sequence
            key={i}
            from={fromFrame}
            durationInFrames={durationFrames}
            layout="none"
          >
            {overlay}
          </Sequence>
        );
      })}
    </div>
  );
};
