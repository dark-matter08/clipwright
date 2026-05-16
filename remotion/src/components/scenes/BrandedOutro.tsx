import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/**
 * Animated branded outro card.
 *
 * Replaces the static PIL-rendered outro when brand assets from
 * `clipwright inspire` are available.
 *
 * Animation (3s default):
 *   0s   — black
 *   0.2s — brand color wipes in from bottom
 *   0.5s — logo zooms in from 0.7× to 1.0×
 *   0.8s — title fades in
 *   1.2s — CTA / description fades in
 *   2.5s — everything holds
 *   3.0s — gentle fade to black at the very end
 */
export const BrandedOutro: React.FC<{
  title: string;
  description?: string;
  brandColor?: string;
  logoSrc?: string | null;
  ctaText?: string;
  width: number;
  height: number;
}> = ({
  title,
  description = "",
  brandColor = "#1a1a2e",
  logoSrc = null,
  ctaText = "",
  width,
  height,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;
  const totalDuration = durationInFrames / fps;

  // Background wipe from bottom — brand color rectangle grows upward.
  const wipeH = interpolate(t, [0.1, 0.5], [0, height], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Logo entrance
  const logoScale = interpolate(t, [0.4, 0.8], [0.7, 1.0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const logoOpacity = interpolate(t, [0.4, 0.85], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Title
  const titleOpacity = interpolate(t, [0.7, 1.1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Description
  const descOpacity = interpolate(t, [1.1, 1.5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Tail fade
  const tailOpacity = interpolate(
    t,
    [totalDuration - 0.4, totalDuration],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", opacity: tailOpacity }}>
      {/* Brand color wipe from bottom */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width,
          height: wipeH,
          backgroundColor: brandColor,
        }}
      />

      {/* Center content (only visible after wipe) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 80px",
          gap: 32,
        }}
      >
        {/* Logo */}
        {logoSrc ? (
          <Img
            src={staticFile(logoSrc)}
            style={{
              width: 180,
              height: 180,
              objectFit: "contain",
              opacity: logoOpacity,
              transform: `scale(${logoScale})`,
            }}
          />
        ) : null}

        {/* Product / brand name */}
        <div
          style={{
            fontSize: 68,
            fontWeight: 800,
            color: "#ffffff",
            textAlign: "center",
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            opacity: titleOpacity,
            textShadow: "0 2px 24px rgba(0,0,0,0.4)",
          }}
        >
          {title}
        </div>

        {/* Tagline / description */}
        {description ? (
          <div
            style={{
              fontSize: 32,
              fontWeight: 400,
              color: "rgba(255,255,255,0.75)",
              textAlign: "center",
              lineHeight: 1.4,
              opacity: descOpacity,
              maxWidth: 800,
            }}
          >
            {description}
          </div>
        ) : null}

        {/* CTA */}
        {ctaText ? (
          <div
            style={{
              marginTop: 16,
              fontSize: 28,
              fontWeight: 600,
              color: "rgba(255,255,255,0.9)",
              textAlign: "center",
              opacity: descOpacity,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {ctaText}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
