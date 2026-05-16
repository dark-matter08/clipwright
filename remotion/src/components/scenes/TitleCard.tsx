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
 * Branded opening title card.
 *
 * Layout (vertical 1080×1920):
 *   - Blurred hero image fills the background (optional — falls back to brand color).
 *   - Dimming overlay for legibility.
 *   - Logo centred in the upper third (optional).
 *   - Title text below logo with kinetic reveal animation.
 *   - Tagline / description text below title (optional).
 *
 * Animation timeline (2s default):
 *   0s   — everything invisible
 *   0.3s — logo fades in
 *   0.5s — title word-by-word reveal starts
 *   1.2s — description fades in
 *   1.9s — everything at full opacity
 */
export const TitleCard: React.FC<{
  title: string;
  description?: string;
  brandColor?: string;
  heroSrc?: string | null;
  logoSrc?: string | null;
  width: number;
  height: number;
}> = ({
  title,
  description = "",
  brandColor = "#1a1a2e",
  heroSrc = null,
  logoSrc = null,
  width,
  height,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  // Logo
  const logoOpacity = interpolate(t, [0.2, 0.5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Title — slide up + fade
  const titleY = interpolate(t, [0.4, 0.8], [40, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleOpacity = interpolate(t, [0.4, 0.85], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Description — delayed fade
  const descOpacity = interpolate(t, [1.0, 1.4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Overlay dims to 0.55 opacity at t=0.6
  const overlayOpacity = interpolate(t, [0, 0.5], [0.85, 0.55], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: brandColor }}>
      {/* Hero background */}
      {heroSrc ? (
        <Img
          src={staticFile(heroSrc)}
          style={{
            position: "absolute",
            width,
            height,
            objectFit: "cover",
            filter: "blur(24px) saturate(1.2)",
            transform: "scale(1.08)", // hide blur edges
          }}
        />
      ) : null}

      {/* Dim overlay */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "rgba(0,0,0," + overlayOpacity + ")",
        }}
      />

      {/* Content column */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 80px",
          gap: 36,
        }}
      >
        {/* Logo */}
        {logoSrc ? (
          <Img
            src={staticFile(logoSrc)}
            style={{
              width: 160,
              height: 160,
              objectFit: "contain",
              opacity: logoOpacity,
              marginBottom: 8,
            }}
          />
        ) : null}

        {/* Title */}
        <div
          style={{
            fontSize: 72,
            fontWeight: 800,
            color: "#ffffff",
            textAlign: "center",
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            transform: `translateY(${titleY}px)`,
            opacity: titleOpacity,
            textShadow: "0 4px 32px rgba(0,0,0,0.6)",
          }}
        >
          {title}
        </div>

        {/* Description / tagline */}
        {description ? (
          <div
            style={{
              fontSize: 36,
              fontWeight: 400,
              color: "rgba(255,255,255,0.8)",
              textAlign: "center",
              lineHeight: 1.4,
              opacity: descOpacity,
              maxWidth: 800,
            }}
          >
            {description}
          </div>
        ) : null}
      </div>

      {/* Colored bottom accent bar */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 8,
          backgroundColor: brandColor,
          opacity: 0.8,
        }}
      />
    </AbsoluteFill>
  );
};
