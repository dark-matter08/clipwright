import { z } from "zod";

export const MomentSchema = z.object({
  t: z.number(),
  type: z.string(),
  label: z.string().default(""),
});

export const SegmentSchema = z.object({
  source_start: z.number(),
  source_end: z.number(),
  duration: z.number(),
  moments: z.array(MomentSchema).default([]),
  audio_path: z.string().nullable().default(null),
  captions: z
    .array(z.object({ text: z.string(), start: z.number(), end: z.number() }))
    .default([]),
});

export const KeyframeSchema = z.object({
  t: z.number(),
  zoom: z.number(),
  focus: z.tuple([z.number(), z.number()]).default([0.5, 0.5]),
});

export const InputsSchema = z.object({
  fps: z.number().default(60),
  width: z.number().default(1080),
  height: z.number().default(1920),
  source_video: z.string(),
  gradient: z.string().nullable().default(null),
  segments: z.array(SegmentSchema),
  keyframes: z.array(KeyframeSchema),
  outro: z.string().nullable().default(null),
  outro_duration: z.number().default(0),
  brand_title: z.string().default("Clipwright"),
});

export type Inputs = z.infer<typeof InputsSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type Keyframe = z.infer<typeof KeyframeSchema>;
