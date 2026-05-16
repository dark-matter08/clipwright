// Chapter chip — top-right badge that fades in at segment start, dwells,
// and fades out before the segment ends. Reads theme tokens for color so
// dark-fantasy, cyberpunk, romantic, and minimal-dark all look distinct
// with the same component.

import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { ThemeTokens } from "../themes";

interface ChapterChipProps {
  label: string;
  /** Segment length in seconds — the chip auto-times against this. */
  durationSeconds: number;
  theme: ThemeTokens;
}

/** Fade-in 0.0→0.3s, dwell, fade-out (duration-0.5)→duration. */
export const ChapterChip: React.FC<ChapterChipProps> = ({
  label,
  durationSeconds,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  if (!label) return null;

  const t = frame / fps;
  // Cap dwell window so very short segments still get a visible chip.
  const fadeIn = Math.min(0.3, durationSeconds * 0.15);
  const fadeOutStart = Math.max(0, durationSeconds - 0.5);

  const opacity = interpolate(
    t,
    [0, fadeIn, fadeOutStart, durationSeconds],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  if (opacity <= 0.01) return null;

  // Slight slide-in from above on the fade-in.
  const translateY = interpolate(
    t,
    [0, fadeIn],
    [-12, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <div
      style={{
        position: "absolute",
        top: Math.round(height * 0.06),
        right: Math.round(width * 0.05),
        opacity,
        transform: `translateY(${translateY}px)`,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: Math.round(width * 0.012),
          padding: `${Math.round(height * 0.008)}px ${Math.round(width * 0.025)}px`,
          background: theme.accent,
          color: theme.accentFg,
          border: `1px solid ${theme.chipBorder}`,
          borderRadius: Math.round(width * 0.012),
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: Math.round(width * 0.022),
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          boxShadow: "0 4px 14px rgba(0, 0, 0, 0.35)",
        }}
      >
        <span
          style={{
            opacity: 0.65,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontWeight: 600,
          }}
        >
          ch ·
        </span>
        {label}
      </div>
    </div>
  );
};
