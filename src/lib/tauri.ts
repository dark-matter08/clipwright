// Thin wrappers around the Tauri command surface. All cross-process calls
// flow through this file so the rest of the frontend imports clean typed
// functions, never `invoke` with magic strings.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  Aspect,
  ProjectState,
  RecentProject,
  TemplateFull,
  TemplateMeta,
  Video,
  VideoMeta,
} from "./types";

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
  /** Optional list of Claude Code skill names to pre-select as
   *  defaults for this video. Persisted into the video manifest's
   *  `recap_overrides.default_skills` so the agent prompt can
   *  surface them as auto-invoke recommendations. */
  defaultSkills?: string[],
  /** `false` writes `recap_overrides.persona_enabled = false` so this
   *  one video opts out of the project persona. Omitted / `true`
   *  writes nothing — absence means enabled, so the default stays on
   *  and existing videos are untouched. */
  personaEnabled?: boolean,
): Promise<Video> {
  return invoke<Video>("create_video_cmd", {
    projectDir,
    videoId,
    personaEnabled,
    title,
    defaultSkills: defaultSkills ?? [],
  });
}

/** Delete a video and every per-video artifact it owns. Returns the
 *  refreshed project state so the caller can land on a surviving video.
 *  Errors if `videoId` is the project's only video. */
export async function deleteVideo(
  projectDir: string,
  videoId: string,
): Promise<ProjectState> {
  return invoke<ProjectState>("delete_video_cmd", { projectDir, videoId });
}

/** Probe `<project_dir>/out/final/<video_id>.mp4` for existence. The
 *  Timeline + Preview use this to decide whether Final-mode UI should
 *  be active or show a "render first" placeholder. */
export async function finalExists(
  projectDir: string,
  videoId: string,
): Promise<boolean> {
  return invoke<boolean>("final_exists_cmd", { projectDir, videoId });
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
  /** Optional video id for the first deliverable inside the project.
   *  Defaults to `"main"` on the Rust side when empty / omitted, so
   *  back-compat with older callers is preserved. */
  videoId?: string;
  /** Cosmetic title shown in the Videos sidebar. Doesn't affect
   *  on-disk paths — the video_id is what scopes audio/captions/
   *  segments/etc. */
  videoTitle?: string;
  /** Project-level TTS provider default (kokoro | openai | elevenlabs
   *  | piper). Written into `project.json#tts_provider`. Per-video
   *  overrides in `videos/<id>.json#recap_overrides` win at TTS time. */
  ttsProvider?: string;
  /** Project-level voice id default. Empty = let the provider's own
   *  default kick in. Written into `project.json#voice_id`. */
  voiceId?: string;
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
  /** Project-level TTS defaults — see `ImportVideoArgs`. Only honored
   *  on first-creation (append=false); re-records preserve the
   *  existing project.json values. */
  ttsProvider?: string;
  voiceId?: string;
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

// ---------------------------------------------------------------------------
// Voice sampling
// ---------------------------------------------------------------------------

export interface VoiceSample {
  /** Absolute path to the sample mp3. Run it through `convertFileSrc`
   *  before handing it to an `<audio>` element — the asset protocol
   *  scope in `tauri.conf.json` allows this directory specifically. */
  path: string;
}

/** Synthesize a short line in one voice so it can be auditioned before
 *  being committed to a project. Cached on the Python side per
 *  (provider, voice, text), so re-auditioning is a file read and does
 *  not re-bill a paid API. Pass `force` to re-synthesize anyway. */
export async function ttsSample(
  provider: string,
  voice: string,
  tone: { speed?: number; pitch?: number; instructions?: string } = {},
  force = false,
): Promise<VoiceSample> {
  return invoke<VoiceSample>("tts_sample", {
    provider,
    voice,
    speed: tone.speed ?? 1,
    pitch: tone.pitch ?? 0,
    instructions: tone.instructions ?? "",
    force,
  });
}

export interface ClipwrightDoctorReport {
  installed: boolean;
  path: string | null;
}

export async function clipwrightDoctor(): Promise<ClipwrightDoctorReport> {
  return invoke<ClipwrightDoctorReport>("clipwright_doctor");
}

// ---------------------------------------------------------------------------
// Project templates
// ---------------------------------------------------------------------------

/** List every project template shipped with the local clipwright install. */
export async function listTemplates(): Promise<TemplateMeta[]> {
  return invoke<TemplateMeta[]>("list_templates_cmd");
}

/** Read one template's full payload (system prompt included). */
export async function showTemplate(templateId: string): Promise<TemplateFull> {
  return invoke<TemplateFull>("show_template_cmd", { templateId });
}

/** Bind a SINGLE template to an existing project (back-compat).
 *  Prefer `applyTemplates` for new code — it accepts a list and is
 *  the way to bind multiple templates simultaneously (e.g. a manhwa
 *  recap + product demo for a manhwa-reader product). Pass an empty
 *  string to clear all bindings.
 *
 *  `overwriteDefaults` true forces the (primary) template's
 *  aspect/fps/tts_provider/voice_id to replace existing values;
 *  default (false) only fills blanks. */
export async function applyTemplate(
  projectDir: string,
  templateId: string,
  overwriteDefaults = false,
): Promise<void> {
  await invoke("apply_template_cmd", {
    projectDir,
    templateId,
    overwriteDefaults,
  });
}

/** Bind a LIST of templates to an existing project. The FIRST entry
 *  is the primary — it drives `render_preset` selection + default
 *  settings. Additional entries contribute behavioral guidance only.
 *  Pass `[]` to clear all bindings. */
export async function applyTemplates(
  projectDir: string,
  templateIds: string[],
  overwriteDefaults = false,
): Promise<void> {
  await invoke("apply_templates_cmd", {
    projectDir,
    templateIds,
    overwriteDefaults,
  });
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

/** A single chat-log entry as persisted in
 *  `<project>/chat/sessions/<video_id>/<YYYY-MM-DD>.jsonl`. The legacy
 *  shape was `{ts, role: user|assistant, text}`; we now also persist
 *  intermediate tool calls so the rail can replay them on reload (and
 *  so resuming a half-finished turn doesn't lose context).
 *
 *  All `tool_*` fields are optional — older entries on disk don't
 *  carry them. The renderer keys off `role`: tool_use / tool_result
 *  show as ToolChip-style boxes; user / assistant remain bubbles. */
export interface ChatHistoryEntry {
  ts: string;
  role: "user" | "assistant" | "tool_use" | "tool_result";
  text: string;
  /** Stable id linking a tool_use to its matching tool_result. */
  tool_id?: string;
  /** The tool's name (e.g. `Bash`, `Read`). Set on tool_use entries. */
  tool_name?: string;
  /** The `input` object verbatim from the stream. Set on tool_use. */
  tool_input?: unknown;
  /** The tool's reply. Often a string, sometimes a content-block
   *  array. Set on tool_result. */
  tool_output?: unknown;
  /** True when the CLI flagged the tool result as an error. */
  tool_error?: boolean;
}

export async function loadChatHistory(
  projectDir: string,
  videoId: string,
): Promise<ChatHistoryEntry[]> {
  return invoke<ChatHistoryEntry[]>("load_chat_history", { projectDir, videoId });
}

/** A custom slash command discovered under `~/.claude/commands/` or
 *  `<project>/.claude/commands/`. The CLI itself loads + expands the
 *  command when the user actually sends `/<name>`; this metadata
 *  drives the rail's autocomplete popover only. */
export interface SlashCommand {
  /** Fully-qualified command name without the leading slash, e.g.
   *  `qa:test`. Subdirectories become `:`-separated namespaces. */
  name: string;
  /** `"user"` (~/.claude/commands) or `"project"` (<project>/.claude). */
  source: "user" | "project";
  /** One-line summary from frontmatter `description:`. May be empty. */
  description: string;
  /** Placeholder for the argument (e.g. `<file>`). Empty when none. */
  argument_hint: string;
}

export async function listSlashCommands(
  projectDir: string,
): Promise<SlashCommand[]> {
  return invoke<SlashCommand[]>("list_slash_commands", { projectDir });
}

/** A Claude Code skill discovered under `~/.claude/skills/<name>/SKILL.md`
 *  or `<project>/.claude/skills/<name>/SKILL.md`. Skills are broad
 *  capabilities the agent can invoke; we surface them in the rail's
 *  slash-command popover (so `/<name>` triggers them) and in the
 *  "+ New video" pre-select picker (so a video can have a default
 *  skill set). */
export interface Skill {
  name: string;
  description: string;
  source: "user" | "project";
}

export async function listSkills(projectDir: string): Promise<Skill[]> {
  return invoke<Skill[]>("list_skills", { projectDir });
}

/** Result of a Play-button click on a `clipwright …` command code
 *  block in a chat bubble. The Rust runner never throws on a non-zero
 *  exit — a failed render still has useful diagnostics — so the UI
 *  inspects `exit_code` to decide ok/error styling. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

/** Execute a `clipwright …` command from a chat code block. The Rust
 *  side parses + tokenizes the command (no shell), validates the
 *  prefix is on the allow-list, and rejects pipes / redirects / etc.
 *  with a clear error. After resolution, the caller is expected to
 *  refresh project state — the command likely mutated disk. */
export async function runClipwrightCommand(
  projectDir: string,
  command: string,
): Promise<CommandResult> {
  return invoke<CommandResult>("run_clipwright_command", { projectDir, command });
}

/** Permission posture passed to `claude --print --permission-mode`.
 *  `default` honors the CLI's normal allow/deny rules (but the
 *  interactive dialog can't render in --print mode, so this often
 *  blocks); `acceptEdits` auto-approves writes inside the project dir;
 *  `plan` is read-only; `bypassPermissions` is full-yolo. */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export async function getPermissionMode(projectDir: string): Promise<PermissionMode> {
  return invoke<PermissionMode>("get_permission_mode", { projectDir });
}

export async function setPermissionMode(
  projectDir: string,
  mode: PermissionMode,
): Promise<void> {
  await invoke("set_permission_mode", { projectDir, mode });
}

/** Per-project idle-timeout override for the Claude rail's watchdog.
 *
 *  Wire encoding (kept as raw seconds so the Rust side stays the
 *  source-of-truth for clamps and validation):
 *
 *    *  `0`         — unset; the backend uses its default (120s).
 *    *  `-1`        — watchdog disabled; only the wall timeout fires.
 *    *  positive    — seconds; backend clamps to [30, 3600].
 *
 *  The UI exposes a small set of presets (2m / 5m / 15m / 30m / off);
 *  any unfamiliar number coming back from disk falls through to the
 *  "default" preset display so a hand-edited config file doesn't
 *  surprise the user. */
export async function getIdleTimeoutSeconds(projectDir: string): Promise<number> {
  return invoke<number>("get_idle_timeout", { projectDir });
}

export async function setIdleTimeoutSeconds(
  projectDir: string,
  seconds: number,
): Promise<void> {
  await invoke("set_idle_timeout", { projectDir, seconds });
}

/** Read the per-project Claude model preference. Empty string = CLI
 *  default (whatever the user's `claude` config picks). */
export async function getModel(projectDir: string): Promise<string> {
  return invoke<string>("get_model", { projectDir });
}

/** Pass-through to `claude --model <name>` on every chat turn for the
 *  project. Accepts "sonnet"/"opus"/"haiku" aliases or full IDs.
 *  Empty string clears the preference. */
export async function setModel(projectDir: string, model: string): Promise<void> {
  await invoke("set_model", { projectDir, model });
}

// ---------------------------------------------------------------------------
// Per-project recap preferences (target duration, narration, outro spec).
// Read by `agent prompt` so changes here flow into Claude's next turn.
// ---------------------------------------------------------------------------

export interface OutroSpec {
  description: string;
  duration_seconds: number;
}

export interface RecapConfig {
  /** 0 = unset; the agent prompt only injects an explicit duration
   *  override when this is > 0. */
  target_duration_seconds: number;
  narration_style: string;
  additional_notes: string;
  /** Who Claude should BE when writing for this project — "an expert
   *  manhwa scriptwriter who specializes in high-retention hooks and
   *  dramatic pacing". Distinct from `narration_style`, which
   *  describes the voice actor rather than the writer. Empty string =
   *  no persona section in the agent prompt. */
  persona: string;
  /** Builder state behind `persona` — the four fields the persona
   *  builder composed the prose from. UI-only: the agent prompt reads
   *  `persona`, never this. Persisted so reopening settings resumes
   *  the build instead of stranding you in free-text mode. */
  persona_draft: PersonaDraft;
  outro: OutroSpec;
}

export interface PersonaDraft {
  /** Identity + expertise. Completes "You are…". */
  role: string;
  /** Tone and register — how the prose sounds. */
  voice: string;
  /** Structural rules: what they do to a script, in order. */
  moves: string;
  /** Words to prefer and words to ban. The cheapest block to get right
   *  and the most visible in the output — models drift to
   *  "furthermore" and "in a world where" unless told not to. */
  vocabulary: string;
  /** Sentence length, and how to spend runtime across a long input.
   *  Without it, long inputs get flattened evenly. */
  pacing: string;
  /** The failure mode to forbid outright. */
  avoid: string;
}

/** New-project defaults — must mirror the Python side
 *  (`clipwright.recap_config.RecapConfig` field defaults). 1:30
 *  target duration + 3s outro is what fresh projects start at; the
 *  outro description is empty so the agent applies its cyberpunk-
 *  title fallback unless the user types something here. */
export const DEFAULT_RECAP_CONFIG: RecapConfig = {
  target_duration_seconds: 90,
  narration_style: "",
  additional_notes: "",
  persona: "",
  persona_draft: {
    role: "",
    voice: "",
    moves: "",
    vocabulary: "",
    pacing: "",
    avoid: "",
  },
  outro: { description: "", duration_seconds: 3.0 },
};

export async function getRecapConfig(projectDir: string): Promise<RecapConfig> {
  return invoke<RecapConfig>("get_recap_config", { projectDir });
}

export async function setRecapConfig(
  projectDir: string,
  config: RecapConfig,
): Promise<void> {
  await invoke("set_recap_config", { projectDir, config });
}

// ---------------------------------------------------------------------------
// API credentials for paid TTS providers (OpenAI, ElevenLabs).
//
// Lives at ~/.clipwright/credentials.json (USER-scoped, not per-
// project). The Rust side returns PRESENCE ONLY for `get` — actual
// secrets never round-trip back to JS so a stray console.log can't
// leak them. The settings dialog uses write-only password inputs.
// ---------------------------------------------------------------------------

export interface CredentialsStatus {
  has_openai_key: boolean;
  has_elevenlabs_key: boolean;
  openai_key_from_env: boolean;
  elevenlabs_key_from_env: boolean;
  credentials_path: string;
}

export interface CredentialsUpdate {
  /** `null`/`undefined` = leave alone. Empty string = wipe. Any
   *  other value = set. */
  openai_api_key?: string | null;
  elevenlabs_api_key?: string | null;
}

export async function getCredentialsStatus(): Promise<CredentialsStatus> {
  return invoke<CredentialsStatus>("get_credentials_status");
}

export async function setCredentials(
  update: CredentialsUpdate,
): Promise<CredentialsStatus> {
  return invoke<CredentialsStatus>("set_credentials", { update });
}

/** Kill any in-flight `claude` subprocess for this video. Safe to call
 *  even when nothing is running. */
export async function cancelClaudeChat(videoId: string): Promise<void> {
  await invoke("cancel_claude_chat", { videoId });
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

// ---------------------------------------------------------------------------
// Personas — the user-level library, their voices, and their memory
// ---------------------------------------------------------------------------
//
// Personas live outside any project (`~/.clipwright/personas/`) and are
// referenced by id, so editing one changes every project using it. The
// commands below are thin pass-throughs to `clipwright persona …`, so
// the app and the agent read the same library.

export interface PersonaVoice {
  provider: string;
  voice_id: string;
  /** 1.0 = the provider's natural rate. */
  speed: number;
  /** Semitones. No provider supports pitch, so this is applied after
   *  synthesis by resampling in ffmpeg. Past ±2 it starts to sound
   *  processed rather than like a different voice. */
  pitch_semitones: number;
  /** OpenAI only — free-text delivery steering. */
  instructions: string;
  /** ElevenLabs only. */
  stability: number;
  similarity_boost: number;
  style: number;
}

export interface PersonaDoc {
  persona_id: string;
  name: string;
  draft: PersonaDraft;
  prose: string;
  voice: PersonaVoice;
  created_at: string;
  updated_at: string;
  /** Set when this persona was cloned from another. Provenance only —
   *  the clone is fully independent. */
  cloned_from: string;
}

export type MemoryKind = "note" | "edit" | "reference" | "video";

export interface MemoryEntry {
  id: number;
  persona_id: string;
  kind: MemoryKind;
  title: string;
  body: string;
  source: string;
  /** Trust, not relevance: a note you wrote outranks a render log. */
  weight: number;
  created_at: string;
}

export interface PersonaGraphNode {
  id: string;
  kind: string;
  label: string;
  body?: string;
  source?: string;
  weight?: number;
  created_at?: string;
}

export interface PersonaGraphEdge {
  source: string;
  target: string;
  relation: string;
  label?: string;
}

export interface PersonaGraph {
  persona_id: string;
  nodes: PersonaGraphNode[];
  edges: PersonaGraphEdge[];
}

export const EMPTY_PERSONA_VOICE: PersonaVoice = {
  provider: "kokoro",
  voice_id: "",
  speed: 1.0,
  pitch_semitones: 0,
  instructions: "",
  stability: 0.45,
  similarity_boost: 0.75,
  style: 0,
};

export async function listPersonas(): Promise<PersonaDoc[]> {
  return invoke<PersonaDoc[]>("list_personas");
}

/** Returns the persona plus a `memory` overview block. */
export async function loadPersona(personaId: string): Promise<PersonaDoc> {
  return invoke<PersonaDoc>("load_persona", { personaId });
}

export async function savePersona(persona: PersonaDoc): Promise<PersonaDoc> {
  return invoke<PersonaDoc>("save_persona", { persona });
}

/** Copies definition + voice under a new id. Memory is NOT copied — a
 *  clone hasn't done the original's work. Returns the refreshed list. */
export async function clonePersona(
  personaId: string,
  name = "",
): Promise<PersonaDoc[]> {
  return invoke<PersonaDoc[]>("clone_persona", { personaId, name });
}

export async function deletePersona(personaId: string): Promise<void> {
  await invoke("delete_persona", { personaId });
}

export async function personaMemoryList(
  personaId: string,
  kind?: MemoryKind,
  limit = 200,
): Promise<MemoryEntry[]> {
  return invoke<MemoryEntry[]>("persona_memory_list", { personaId, kind, limit });
}

export async function personaMemorySearch(
  personaId: string,
  query: string,
  limit = 20,
): Promise<MemoryEntry[]> {
  return invoke<MemoryEntry[]>("persona_memory_search", { personaId, query, limit });
}

export async function personaMemoryAdd(entry: {
  persona_id: string;
  kind: MemoryKind;
  body: string;
  title?: string;
  source?: string;
}): Promise<void> {
  await invoke("persona_memory_add", {
    entry: { title: "", source: "", ...entry },
  });
}

export async function personaMemoryForget(entryId: number): Promise<void> {
  await invoke("persona_memory_forget", { entryId });
}

export async function personaGraph(personaId: string): Promise<PersonaGraph> {
  return invoke<PersonaGraph>("persona_graph", { personaId });
}

/** Bind a persona to a project (or pass "" to unbind). Stores only the
 *  id — a live reference, so editing the persona later reaches this
 *  project without re-attaching. Merges into `project.json` rather than
 *  rewriting it, so fields the desktop doesn't model survive. */
export async function setProjectPersona(
  projectDir: string,
  personaId: string,
): Promise<void> {
  await invoke("set_project_persona", { projectDir, personaId });
}
