// TypeScript mirrors of the v1 project schema defined in
// `engine/clipwright/schema/v1/`. These shapes flow through the Tauri command
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
  /** **Primary** template binding (mirrors `template_ids[0]`).
   *  Kept for back-compat with older readers. Use `template_ids` for
   *  the full list. */
  template_id?: string;
  /** Templates bound to this project. The FIRST entry is the
   *  primary — it drives `render_preset` selection and default
   *  project settings. Additional entries contribute behavioral
   *  guidance only: their `system_prompt` text is appended to the
   *  agent prompt. Empty / absent = no bindings.
   *
   *  Example: `["manhwa-recap-single", "product-demo"]` on a
   *  manhwa-reader product → recap visuals + product-demo
   *  framing in one video. */
  template_ids?: string[];
  /** Persona from the user-level library. A live reference: editing the
   *  persona changes this project on the next turn. */
  persona_id?: string;
}

/** A template's recommended project settings — subset of `Project`. */
export interface TemplateDefaults {
  aspect?: Aspect;
  fps?: number;
  tts_provider?: Project["tts_provider"];
  voice_id?: string;
}

/** Provenance of a template — shipped with the package vs in the user's
 *  `~/.clipwright/templates/` dir. Drives the "USER" badge in the picker. */
export type TemplateSource = "shipped" | "user";

/** Catalog-card view of a project template — what the picker renders. */
export interface TemplateMeta {
  template_id: string;
  name: string;
  category: string;
  summary: string;
  render_preset: string;
  defaults: TemplateDefaults;
  source: TemplateSource;
}

/** Full template payload, including the behavioral system_prompt. */
export interface TemplateFull extends TemplateMeta {
  system_prompt: string;
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
  /** Optional per-video target duration override (seconds). When 0 /
   *  absent, the agent uses the project-level
   *  `recap_config.target_duration_seconds`. Lets the user push a
   *  specific video longer or shorter than the project default. */
  target_duration_seconds_override?: number;
  /** Free-form override map for the other recap-config fields:
   *  `narration_style`, `additional_notes`, `outro_description`,
   *  `outro_duration_seconds`, `voice_provider`, `voice_id`, `persona`.
   *  Empty / missing = use the project-level default for that field.
   *
   *  Values are heterogeneous by design and the map is intentionally
   *  untyped per-key: adding an override is a prompt-side change with
   *  no schema migration (see `Video.recap_overrides` in
   *  `schema/v2/video.py`). Booleans carry opt-outs
   *  (`persona_enabled`), `string[]` carries `default_skills`. */
  recap_overrides?: Record<string, string | number | boolean | string[]>;
}

export interface VideoMeta {
  video_id: string;
  title: string;
  n_segments: number;
  /** Manifest mtime, unix seconds. Videos have no `created_at` of their
   *  own — the file's timestamp is the only creation signal that exists
   *  for projects that already have a backlog. */
  created_at: number;
  /** Per-video persona override. Empty means "inherit the project's". */
  persona_id: string;
  /** `out/final/<id>.mp4` exists. */
  has_final: boolean;
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
