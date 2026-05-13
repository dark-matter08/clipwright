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

export interface Video {
  schema_version: number;
  video_id: string;
  title: string;
  chat_session_id: string;
  segments: Segment[];
}

export interface VideoMeta {
  video_id: string;
  title: string;
  n_segments: number;
}

/** Wire shape returned by the Rust `open_project` command. */
export interface ProjectState {
  project_dir: string;
  project: Project;
  /** Every video in the project, surfaced for the sidebar. */
  videos: VideoMeta[];
  /** The currently-loaded video id (the one in `video`). */
  current_video_id: string | null;
  /** The fully-loaded current video manifest. Null when project has 0 videos. */
  video: Video | null;
}

/** Entry in the recents list shown on the Hub. */
export interface RecentProject {
  project_dir: string;
  title: string;
  last_opened_at: string; // ISO-8601
}
