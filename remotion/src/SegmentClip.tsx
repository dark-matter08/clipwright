import React from "react";
import { AbsoluteFill, Audio, OffthreadVideo, Img, staticFile, useVideoConfig } from "remotion";
import { CameraWrapper } from "./CameraWrapper";
import { Captions } from "./Captions";
import type { Keyframe, Segment } from "./schema";

/**
 * Renders one segment: gradient background + zoomable video crop + audio + captions.
 * `offsetFrames` is the segment's start on the output timeline, passed so the
 * camera wrapper can interpolate global keyframes correctly.
 */
export const SegmentClip: React.FC<{
  segment: Segment;
  sourceVideo: string;
  keyframes: Keyframe[];
  offsetFrames: number;
  width: number;
  height: number;
  gradient: string | null;
}> = ({ segment, sourceVideo, keyframes, offsetFrames, width, height, gradient }) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {gradient ? (
        <Img
          src={staticFile(gradient)}
          style={{ position: "absolute", width, height, objectFit: "cover" }}
        />
      ) : null}

      <CameraWrapper
        keyframes={keyframes}
        offsetFrames={offsetFrames}
        width={width}
        height={height}
      >
        {/* Fit the source video into vertical canvas — scale to width, center. */}
        <div
          style={{
            width,
            height,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <OffthreadVideo
            src={staticFile(sourceVideo)}
            trimBefore={Math.round(segment.source_start * fps)}
            style={{
              width,
              height: "auto",
              objectFit: "contain",
            }}
          />
        </div>
      </CameraWrapper>

      {segment.audio_path ? <Audio src={staticFile(segment.audio_path)} /> : null}

      <Captions captions={segment.captions} />
    </AbsoluteFill>
  );
};
