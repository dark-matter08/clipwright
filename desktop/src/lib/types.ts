export interface ClipwrightConfig {
  name: string;
  aspect: string;
  fps: number;
  voice_id?: string;
  tts_provider?: string;
  outro_preset?: string;
  caption_preset?: string;
}

export interface Clip {
  id: string;
  target_seconds: number;
  chapter: string;
  hint: string;
  text: string;
}

export interface Script {
  clips: Clip[];
}

export interface Moment {
  t: number;
  type: string;
  label: string;
  chapter?: string;
  wait?: number;
}

export interface Segment {
  start: number;
  end: number;
  chapter: string;
  moments: Moment[];
}

export interface ProjectState {
  path: string;
  config: ClipwrightConfig;
  script: Script | null;
  segments: Segment[] | null;
  hasMoments: boolean;
  hasVideo: boolean;
  hasFinal: boolean;
}

export type PipelineStage =
  | "record"
  | "segments"
  | "keyframes"
  | "script-init"
  | "tts"
  | "caption"
  | "outro"
  | "render";

export interface ProgressEvent {
  stage: PipelineStage | string;
  clip?: string;
  pct?: number;
  message?: string;
}

export interface ClaudeEvent {
  type: "system" | "assistant" | "tool_use" | "tool_result" | "result" | "error";
  content?: string;
  tool?: string;
  input?: Record<string, unknown>;
  session_id?: string;
}
