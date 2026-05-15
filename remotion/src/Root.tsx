import React from "react";
import { Composition } from "remotion";
import { ManhwaRecap } from "./ManhwaRecap";
import { ClipwrightVideo } from "./Video";
import { InputsSchema, ManhwaInputsSchema } from "./schema";

import type { Inputs, ManhwaInputs } from "./schema";

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
  // The full Inputs shape requires these — they default in the zod
  // schema at runtime but TS wants them on the literal. Empty/sane
  // values match the schema defaults.
  viewport_w: 540,
  viewport_h: 960,
  annotations: [],
  brand_color: "#1a1a2e",
  brand_description: "",
  brand_hero: null,
  brand_logo: null,
};

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
    </>
  );
};
