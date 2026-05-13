// Thin wrappers around the Tauri command surface. All cross-process calls
// flow through this file so the rest of the frontend imports clean typed
// functions, never `invoke` with magic strings.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Aspect, ProjectState, RecentProject, Video, VideoMeta } from "./types";

export async function openProject(
  projectDir: string,
  videoId?: string | null,
): Promise<ProjectState> {
  return invoke<ProjectState>("open_project", { projectDir, videoId: videoId ?? null });
}

export async function saveVideo(
  projectDir: string,
  videoId: string,
  video: Video,
): Promise<void> {
  await invoke("save_video", { projectDir, videoId, video });
}

export async function listVideos(projectDir: string): Promise<VideoMeta[]> {
  return invoke<VideoMeta[]>("list_videos_cmd", { projectDir });
}

export async function loadVideo(
  projectDir: string,
  videoId: string,
): Promise<Video> {
  return invoke<Video>("load_video_cmd", { projectDir, videoId });
}

export async function createVideo(
  projectDir: string,
  videoId: string,
  title: string,
): Promise<Video> {
  return invoke<Video>("create_video_cmd", { projectDir, videoId, title });
}

export async function listRecents(): Promise<RecentProject[]> {
  return invoke<RecentProject[]>("list_recents");
}

/** Native folder picker. Returns null if the user cancels. */
export async function pickProjectDir(
  title = "Open Clipwright project",
): Promise<string | null> {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title,
  });
  if (selected == null) return null;
  return Array.isArray(selected) ? (selected[0] ?? null) : selected;
}

/** Native video-file picker. */
export async function pickVideoFile(): Promise<string | null> {
  const selected = await openDialog({
    directory: false,
    multiple: false,
    title: "Pick a video to import",
    filters: [{ name: "Video", extensions: ["mp4", "mov", "webm", "m4v"] }],
  });
  if (selected == null) return null;
  return Array.isArray(selected) ? (selected[0] ?? null) : selected;
}

export interface ImportVideoArgs {
  videoPath: string;
  projectDir: string;
  title: string;
  aspect: Aspect;
  autoSegment: boolean;
  sceneDetection: boolean;
}

export async function importVideo(args: ImportVideoArgs): Promise<ProjectState> {
  return invoke<ProjectState>("import_video_cmd", { ...args });
}

export interface RecordProjectArgs {
  projectDir: string;
  title: string;
  aspect: Aspect;
  baseUrl: string;
  mobile: boolean;
  videoId: string;
  videoTitle: string;
  /** True when recording into an existing project (adds/replaces a
   *  video inside it). False for first-time project creation. */
  append: boolean;
}

export async function recordProject(args: RecordProjectArgs): Promise<ProjectState> {
  return invoke<ProjectState>("record_project_cmd", { ...args });
}

export interface AddSourceArgs {
  videoPath: string;
  projectDir: string;
  /** Which video in the project the new segments attach to. Use the
   *  current video to add B-roll; use a new video id (with a hint via
   *  next_video_id from `lib/timeline.ts`) to start a new deliverable. */
  videoId: string;
  videoTitle: string;
  autoSegment: boolean;
  sceneDetection: boolean;
}

/** Append source video to a project, optionally creating a new video. */
export async function addSource(args: AddSourceArgs): Promise<ProjectState> {
  return invoke<ProjectState>("add_source_cmd", { ...args });
}

export interface SourceEntry {
  path: string;       // project-relative, e.g. "sources/main.mp4"
  size_bytes: number;
}

/** Enumerate `<project>/sources/` for the inspector's per-segment picker. */
export async function listSources(projectDir: string): Promise<SourceEntry[]> {
  return invoke<SourceEntry[]>("list_sources", { projectDir });
}

export interface ClipwrightDoctorReport {
  installed: boolean;
  path: string | null;
}

export async function clipwrightDoctor(): Promise<ClipwrightDoctorReport> {
  return invoke<ClipwrightDoctorReport>("clipwright_doctor");
}

// ---------------------------------------------------------------------------
// Per-segment operations — each reloads the project on success.
// ---------------------------------------------------------------------------

export async function ttsSegment(
  projectDir: string,
  videoId: string,
  segId: string,
  force = false,
): Promise<ProjectState> {
  return invoke<ProjectState>("tts_segment_cmd", { projectDir, videoId, segId, force });
}

export async function captionSegment(
  projectDir: string,
  videoId: string,
  segId: string,
  force = false,
): Promise<ProjectState> {
  return invoke<ProjectState>("caption_segment_cmd", { projectDir, videoId, segId, force });
}

export async function renderSegment(
  projectDir: string,
  videoId: string,
  segId: string,
  force = false,
): Promise<ProjectState> {
  return invoke<ProjectState>("render_segment_cmd", { projectDir, videoId, segId, force });
}

export interface RenderFinalReport {
  project: ProjectState;
  final_path: string;
}

export async function renderFinal(
  projectDir: string,
  videoId: string,
  force = false,
): Promise<RenderFinalReport> {
  return invoke<RenderFinalReport>("render_final_cmd", { projectDir, videoId, force });
}

// ---------------------------------------------------------------------------
// voiceover/script.json
// ---------------------------------------------------------------------------

export interface ScriptClip {
  id: string;
  segment_id: string;
  text?: string;
  target_seconds?: number;
  hint?: string;
  voice?: { provider?: string; voice_id?: string };
}

export interface ScriptPayload {
  schema_version: number;
  clips: ScriptClip[];
}

export async function loadScript(
  projectDir: string,
  videoId: string,
): Promise<ScriptPayload> {
  return invoke<ScriptPayload>("load_script", { projectDir, videoId });
}

export async function saveScriptClip(
  projectDir: string,
  videoId: string,
  clipId: string,
  segmentId: string,
  patch: Partial<ScriptClip>,
): Promise<void> {
  await invoke("save_script_clip", {
    projectDir,
    videoId,
    clipId,
    segmentId,
    patch,
  });
}

// ---------------------------------------------------------------------------
// Claude chat (Mode A + Mode B)
// ---------------------------------------------------------------------------

export interface ChatTurn {
  message: string;
  videoId: string;
  segId?: string | null;
}

export interface ChatResponse {
  reply: string;
  mode: "A" | "B";
  elapsed_ms: number;
}

export async function claudeChat(
  projectDir: string,
  turn: ChatTurn,
): Promise<ChatResponse> {
  return invoke<ChatResponse>("claude_chat", {
    projectDir,
    turn: {
      message: turn.message,
      video_id: turn.videoId,
      seg_id: turn.segId ?? null,
    },
  });
}

export interface ChatHistoryEntry {
  ts: string;
  role: "user" | "assistant";
  text: string;
}

export async function loadChatHistory(
  projectDir: string,
  videoId: string,
): Promise<ChatHistoryEntry[]> {
  return invoke<ChatHistoryEntry[]>("load_chat_history", { projectDir, videoId });
}

/** Wipe the persistent Claude session for one video so the next turn
 *  starts a brand-new conversation instead of resuming the prior one.
 *  Today's chat log is archived under `chat/sessions/<video>/<date>.jsonl.archived-<ts>`. */
export async function clearClaudeSession(
  projectDir: string,
  videoId: string,
): Promise<void> {
  await invoke("clear_claude_session", { projectDir, videoId });
}

export interface ClaudeDoctorReport {
  installed: boolean;
  path: string | null;
}

export async function claudeDoctor(): Promise<ClaudeDoctorReport> {
  return invoke<ClaudeDoctorReport>("claude_doctor");
}
