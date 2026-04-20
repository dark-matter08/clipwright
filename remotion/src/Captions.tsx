import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";

type Caption = { text: string; start: number; end: number };

/**
 * Bold overlay captions (re-rendered in Remotion — no PNG dependency).
 * Times are in SECONDS LOCAL to the segment audio. `offsetSeconds` shifts into
 * the segment's audio window (usually 0 or a small `lead`).
 */
export const Captions: React.FC<{
  captions: Caption[];
  offsetSeconds?: number;
}> = ({ captions, offsetSeconds = 0 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps - offsetSeconds;

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
          fontSize: Math.round(width * 0.085),
          fontWeight: 900,
          color: "#ffffff",
          letterSpacing: "-0.02em",
          textShadow:
            "0 0 16px rgba(0,0,0,0.9), 0 4px 12px rgba(0,0,0,0.8)",
          padding: `${Math.round(height * 0.015)}px ${Math.round(width * 0.05)}px`,
          background: "rgba(0, 0, 0, 0.55)",
          borderRadius: Math.round(width * 0.03),
          textTransform: "uppercase",
          lineHeight: 1.1,
          maxWidth: width * 0.85,
          textAlign: "center",
        }}
      >
        {active.text}
      </div>
    </div>
  );
};
