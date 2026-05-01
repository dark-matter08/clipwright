import React from "react";
import { AbsoluteFill, OffthreadVideo, Series, staticFile } from "remotion";
import { SegmentClip } from "./SegmentClip";
import { BrandedOutro } from "./components/scenes/BrandedOutro";
import { TitleCard } from "./components/scenes/TitleCard";
import type { Inputs } from "./schema";

const TITLE_CARD_DURATION = 2.0; // seconds

export const ClipwrightVideo: React.FC<Inputs> = ({
  fps,
  width,
  height,
  source_video,
  gradient,
  segments,
  keyframes,
  outro,
  outro_duration,
  viewport_w,
  viewport_h,
  annotations,
  brand_title,
  brand_color,
  brand_description,
  brand_hero,
  brand_logo,
}) => {
  // Brand scene injection — only when `clipwright inspire` has run.
  const hasBrand = Boolean(brand_hero || brand_logo);
  const titleCardFrames = hasBrand ? Math.round(TITLE_CARD_DURATION * fps) : 0;

  // The segment offset must account for the title card.
  let offsetFrames = titleCardFrames;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Series>
        {/* ── Title card (only when brand assets exist) ── */}
        {hasBrand ? (
          <Series.Sequence durationInFrames={titleCardFrames}>
            <TitleCard
              title={brand_title}
              description={brand_description}
              brandColor={brand_color}
              heroSrc={brand_hero}
              logoSrc={brand_logo}
              width={width}
              height={height}
            />
          </Series.Sequence>
        ) : null}

        {/* ── Recording segments ── */}
        {segments.map((seg, i) => {
          const segFrames = Math.max(1, Math.round(seg.duration * fps));
          const thisOffset = offsetFrames;
          offsetFrames += segFrames;
          return (
            <Series.Sequence key={i} durationInFrames={segFrames}>
              <SegmentClip
                segment={seg}
                sourceVideo={source_video}
                keyframes={keyframes}
                offsetFrames={thisOffset}
                width={width}
                height={height}
                gradient={gradient}
                annotations={annotations}
                viewportW={viewport_w}
                viewportH={viewport_h}
              />
            </Series.Sequence>
          );
        })}

        {/* ── Outro: prefer BrandedOutro when brand assets exist ── */}
        {outro && outro_duration > 0 ? (
          hasBrand ? (
            <Series.Sequence durationInFrames={Math.round(outro_duration * fps)}>
              <BrandedOutro
                title={brand_title}
                description={brand_description}
                brandColor={brand_color}
                logoSrc={brand_logo}
                width={width}
                height={height}
              />
            </Series.Sequence>
          ) : (
            <Series.Sequence durationInFrames={Math.round(outro_duration * fps)}>
              <AbsoluteFill>
                <OffthreadVideo src={staticFile(outro)} />
              </AbsoluteFill>
            </Series.Sequence>
          )
        ) : null}
      </Series>
    </AbsoluteFill>
  );
};
