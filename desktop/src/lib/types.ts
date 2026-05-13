// TypeScript mirrors of the v1 project schema defined in
// `src/clipwright/schema/v1/`. These shapes flow through the Tauri command
// channel verbatim, so the field names must match the Python `to_dict()`
// output (snake_case).
//
// We do NOT validate on the TS side — the Python writer validated before
// emitting and the Rust reader trusted the on-disk file. If the disk is
// hand-edited to an invalid shape, the open flow surfaces the error from
// the Rust layer.

export type Aspect = "9:16" | "16:9" | "1:1";

export interface Project {
  schema_version: number;
  title: string;
  aspect: Aspect;
  fps: number;
  render_backend: "remotion" | "ffmpeg";
  tts_provider: "kokoro" | "elevenlabs" | "piper";
  voice_id: string;
  base_url: string;
  created_at: string;
}

export interface SegmentVoiceover {
  enabled: boolean;
  script_clip_id: string;
}

export interface SegmentRef {
  enabled: boolean;
  ref: string;
}

export type SegmentKind = "recording" | "scene" | "generated";

export interface Segment {
  id: string;
  source: string;
  source_start: number;
  source_end: number;
  target_duration: number;
  kind: SegmentKind;
  scene_type: string | null;
  label: string;
  chapter: string;
  voiceover: SegmentVoiceover;
  captions: SegmentRef;
  camera: SegmentRef;
  annotations: SegmentRef;
}

export interface Timeline {
  schema_version: number;
  segments: Segment[];
}

/** Wire shape returned by the Rust `open_project` command. */
export interface ProjectState {
  project_dir: string;
  project: Project;
  timeline: Timeline;
}

/** Entry in the recents list shown on the Hub. */
export interface RecentProject {
  project_dir: string;
  title: string;
  last_opened_at: string; // ISO-8601
}
