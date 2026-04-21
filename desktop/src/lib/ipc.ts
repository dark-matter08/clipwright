import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProjectState, Clip, ProgressEvent, ClaudeEvent } from "./types";

export async function pickProject(): Promise<string | null> {
  return (await invoke("pick_project")) as string | null;
}

export async function loadProject(path: string): Promise<ProjectState> {
  return (await invoke("load_project", { path })) as ProjectState;
}

export interface FileEntry {
  name: string;
  rel: string;
  size: number;
  isDir: boolean;
}

export async function listProjectFiles(path: string): Promise<FileEntry[]> {
  const raw = (await invoke("list_project_files", { path })) as Array<{
    name: string;
    rel: string;
    size: number;
    is_dir: boolean;
  }>;
  return raw.map((r) => ({ name: r.name, rel: r.rel, size: r.size, isDir: r.is_dir }));
}

export async function initProject(
  parentDir: string,
  name: string,
  url: string,
  aspect: string,
  description?: string,
): Promise<string> {
  return (await invoke("init_project", {
    parentDir,
    name,
    url,
    aspect,
    description: description ?? "",
  })) as string;
}

export async function readTextFile(path: string): Promise<string> {
  return (await invoke("read_text_file", { path })) as string;
}

export async function saveScriptClip(
  path: string,
  clipId: string,
  text: string,
): Promise<void> {
  await invoke("save_script_clip", { path, clipId, text });
}

export async function runClipwright(
  path: string,
  subcommand: string,
  clipId?: string,
): Promise<number> {
  return (await invoke("run_clipwright", {
    path,
    subcommand,
    clipId: clipId ?? null,
  })) as number;
}

export async function cancelRun(runId: number): Promise<void> {
  await invoke("cancel_run", { runId });
}

export async function startWatcher(path: string): Promise<void> {
  await invoke("start_watcher", { path });
}

export async function stopWatcher(path: string): Promise<void> {
  await invoke("stop_watcher", { path });
}

export async function checkClaudeAuth(): Promise<{ ok: boolean; message: string }> {
  return (await invoke("check_claude_auth")) as { ok: boolean; message: string };
}

export async function sendClaudeMessage(
  projectPath: string,
  text: string,
): Promise<number> {
  return (await invoke("send_claude_message", { projectPath, text })) as number;
}

export async function approveClaudePlan(projectPath: string): Promise<number> {
  return (await invoke("approve_claude_plan", { projectPath })) as number;
}

export interface SessionInfo {
  id: string;
  firstMessage: string;
  lastModified: number;
  messageCount: number;
  active: boolean;
}

export async function listClaudeSessions(projectPath: string): Promise<SessionInfo[]> {
  return (await invoke("list_claude_sessions", { projectPath })) as SessionInfo[];
}

export async function getActiveSession(projectPath: string): Promise<string | null> {
  return (await invoke("get_active_session", { projectPath })) as string | null;
}

export async function setActiveSession(projectPath: string, sessionId: string): Promise<void> {
  await invoke("set_active_session", { projectPath, sessionId });
}

export async function clearActiveSession(projectPath: string): Promise<void> {
  await invoke("clear_active_session", { projectPath });
}

export interface ReplayMessage {
  role: "user" | "assistant" | "plan" | "tool";
  content: string;
  tool: string | null;
}

export async function loadSessionTranscript(
  projectPath: string,
  sessionId: string,
): Promise<ReplayMessage[]> {
  return (await invoke("load_session_transcript", { projectPath, sessionId })) as ReplayMessage[];
}

export function onProgress(
  handler: (ev: ProgressEvent & { runId: number }) => void,
): Promise<UnlistenFn> {
  return listen<ProgressEvent & { runId: number }>("clipwright:progress", (e) =>
    handler(e.payload),
  );
}

export function onLog(
  handler: (ev: { runId: number; stream: "stdout" | "stderr"; line: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ runId: number; stream: "stdout" | "stderr"; line: string }>(
    "clipwright:log",
    (e) => handler(e.payload),
  );
}

export function onRunDone(
  handler: (ev: { runId: number; code: number }) => void,
): Promise<UnlistenFn> {
  return listen<{ runId: number; code: number }>("clipwright:done", (e) =>
    handler(e.payload),
  );
}

export function onArtifactChange(
  handler: (path: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("artifact:changed", (e) => handler(e.payload));
}

export function onClaudeEvent(
  handler: (ev: ClaudeEvent & { runId: number }) => void,
): Promise<UnlistenFn> {
  return listen<ClaudeEvent & { runId: number }>("claude:event", (e) =>
    handler(e.payload),
  );
}

export type { Clip };
