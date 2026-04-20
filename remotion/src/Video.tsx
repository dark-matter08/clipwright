import React from "react";
import { AbsoluteFill, OffthreadVideo, Series, staticFile } from "remotion";
import { SegmentClip } from "./SegmentClip";
import type { Inputs } from "./schema";

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
}) => {
  let offsetFrames = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Series>
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
              />
            </Series.Sequence>
          );
        })}
        {outro && outro_duration > 0 ? (
          <Series.Sequence durationInFrames={Math.round(outro_duration * fps)}>
            <AbsoluteFill>
              <OffthreadVideo src={staticFile(outro)} />
            </AbsoluteFill>
          </Series.Sequence>
        ) : null}
      </Series>
    </AbsoluteFill>
  );
};
