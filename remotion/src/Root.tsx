import React from "react";
import { Composition } from "remotion";
import { ManhwaRecap } from "./ManhwaRecap";
import { ManhwaInputsSchema } from "./schema";

import type { ManhwaInputs } from "./schema";

const MANHWA_DEFAULT_PROPS: ManhwaInputs = {
  fps: 30,
  width: 1080,
  height: 1920,
  theme: "dark-fantasy",
  show_chapter_chips: true,
  segments: [],
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="ManhwaRecap"
      component={ManhwaRecap}
      durationInFrames={1}
      fps={30}
      width={1080}
      height={1920}
      schema={ManhwaInputsSchema}
      defaultProps={MANHWA_DEFAULT_PROPS}
      calculateMetadata={({ props }) => {
        const total = props.segments.reduce(
          (sum, s) => sum + Math.max(1, Math.round(s.duration * props.fps)),
          0,
        );
        return {
          durationInFrames: Math.max(1, total),
          fps: props.fps,
          width: props.width,
          height: props.height,
        };
      }}
    />
  );
};
