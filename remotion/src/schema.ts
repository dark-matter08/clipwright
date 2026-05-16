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

// ---------------------------------------------------------------------------
// Manhwa-recap composition — separate inputs shape because the workflow is
// fundamentally different from the recording-based one: each segment is a
// still panel image with its own Ken Burns motion, audio, and chapter chip.
// ---------------------------------------------------------------------------

/** Ken Burns keyframe — `zoom` is a multiplier (1.0 = no zoom). `pan_x` and
 *  `pan_y` are normalized [-1..+1] offsets applied at scale-1 (negative pans
 *  the panel left/up, positive right/down). `t` is seconds within the
 *  segment's local timeline. */
export const KenBurnsKeyframeSchema = z.object({
  t: z.number(),
  zoom: z.number().default(1.0),
  pan_x: z.number().default(0.0),
  pan_y: z.number().default(0.0),
});

/** One caption interval. Times are LOCAL to the segment (0 = segment start). */
export const PanelCaptionSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
});

/** One frame inside a segment's sequential `panels[]` cycle. The
 *  renderer plays these in order with a crossfade between each pair.
 *  When `duration_seconds` is 0, the frame's share of the segment is
 *  computed as `(segment.duration - sum(explicit durations)) / count(implicit)`. */
export const PanelFrameSchema = z.object({
  source: z.string(),
  duration_seconds: z.number().default(0),
});

/** One panel-based segment for the manhwa-recap composition. */
export const PanelSegmentSchema = z.object({
  id: z.string(),
  /** Path to the still panel relative to remotion/public/. Ignored when
   *  `panels[]` is non-empty (sequential mode takes over). */
  source: z.string(),
  /** Stacked comic-strip layout — N panels visible AT ONCE, with cards. */
  sources: z.array(z.string()).default([]),
  /** Sequential multi-image mode — N panels played one after another
   *  with crossfade. Distinct from `sources` (stacked).
   *
   *  Empty array = use single `source`. When non-empty:
   *  - explicit `duration_seconds > 0` pins that frame's window.
   *  - `duration_seconds == 0` splits the remaining segment time
   *    evenly across all such frames.
   *  Each frame is fit/scroll-rendered independently using the same
   *  aspect-ratio logic as a single panel. */
  panels: z.array(PanelFrameSchema).default([]),
  /** Total on-screen duration in seconds. */
  duration: z.number(),
  /** Optional per-segment audio (TTS voiceover). Relative to public/. */
  audio_path: z.string().nullable().default(null),
  /** Optional Ken Burns keyframes. Empty array = static shot. Ignored
   *  in sequential-panels mode (the crossfade is the camera). */
  camera: z.array(KenBurnsKeyframeSchema).default([]),
  /** Optional caption events local to this segment. */
  captions: z.array(PanelCaptionSchema).default([]),
  /** Chapter chip label (e.g. "opening"). Empty = no chip. */
  chapter: z.string().default(""),
  /** Short descriptive label, currently unused in render — for debug. */
  label: z.string().default(""),
});

/** Named theme presets. Drives BG color, accent, chip styling. */
export const ManhwaThemeSchema = z.enum([
  "dark-fantasy",
  "cyberpunk",
  "minimal-dark",
  "romantic",
]);

export const ManhwaInputsSchema = z.object({
  fps: z.number().default(30),
  width: z.number().default(1080),
  height: z.number().default(1920),
  theme: ManhwaThemeSchema.default("dark-fantasy"),
  /** Show chapter chip overlay on each segment whose `chapter` is non-empty. */
  show_chapter_chips: z.boolean().default(true),
  segments: z.array(PanelSegmentSchema),
});

export type KenBurnsKeyframe = z.infer<typeof KenBurnsKeyframeSchema>;
export type PanelFrame = z.infer<typeof PanelFrameSchema>;
export type PanelSegment = z.infer<typeof PanelSegmentSchema>;
export type PanelCaption = z.infer<typeof PanelCaptionSchema>;
export type ManhwaTheme = z.infer<typeof ManhwaThemeSchema>;
export type ManhwaInputs = z.infer<typeof ManhwaInputsSchema>;
