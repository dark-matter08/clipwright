import { z } from "zod";

export const MomentSchema = z.object({
  t: z.number(),
  type: z.string(),
  label: z.string().default(""),
});

/**
 * One motion-graphic overlay event on the output timeline.
 * cx/cy/bw/bh are in recording CSS pixels (e.g. 540×960 viewport).
 * Remotion components divide by viewport_w/viewport_h to get normalized
 * coords, then multiply by the canvas size (1080×1920) for final positions.
 */
export const AnnotationEventSchema = z.object({
  t_in: z.number(),
  t_out: z.number(),
  action_type: z.string(),
  cx: z.number(),
  cy: z.number(),
  bw: z.number(),
  bh: z.number(),
  label: z.string().default(""),
  chapter: z.string().default(""),
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
  // Annotation overlays (motion graphics per action moment).
  viewport_w: z.number().default(540),
  viewport_h: z.number().default(960),
  annotations: z.array(AnnotationEventSchema).default([]),
  // Brand assets from `clipwright inspire <url>`.
  brand_color: z.string().default("#1a1a2e"),
  brand_description: z.string().default(""),
  brand_hero: z.string().nullable().default(null),
  brand_logo: z.string().nullable().default(null),
});

export type Inputs = z.infer<typeof InputsSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type Keyframe = z.infer<typeof KeyframeSchema>;
export type AnnotationEvent = z.infer<typeof AnnotationEventSchema>;
