import React from "react";
import { Composition } from "remotion";
import { ClipwrightVideo } from "./Video";
import { InputsSchema } from "./schema";

import type { Inputs } from "./schema";

const DEFAULT_PROPS: Inputs = {
  fps: 60,
  width: 1080,
  height: 1920,
  source_video: "",
  gradient: null,
  segments: [],
  keyframes: [],
  outro: null,
  outro_duration: 0,
  brand_title: "Clipwright",
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ClipwrightVideo"
        component={ClipwrightVideo}
        durationInFrames={1}
        fps={60}
        width={1080}
        height={1920}
        schema={InputsSchema}
        defaultProps={DEFAULT_PROPS}
        calculateMetadata={({ props }) => {
          const segFrames = props.segments.reduce(
            (sum, s) => sum + Math.max(1, Math.round(s.duration * props.fps)),
            0
          );
          const outroFrames = props.outro && props.outro_duration > 0
            ? Math.round(props.outro_duration * props.fps)
            : 0;
          const total = Math.max(1, segFrames + outroFrames);
          return {
            durationInFrames: total,
            fps: props.fps,
            width: props.width,
            height: props.height,
          };
        }}
      />
    </>
  );
};
