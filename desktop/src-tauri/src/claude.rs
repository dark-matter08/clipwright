//! Spawn the user's `claude` CLI as a subprocess.
//!
//! Two invocation modes per SRS §9.1:
//!
//!   Mode A — persistent chat session. We use `claude --resume <id>` where
//!            `<id>` is stored per-project in `.clipwright/claude-session`.
//!            This keeps each project's chat history isolated even when
//!            the user switches between projects in the same `cwd`. On
//!            first use the file is empty; we fall back to a fresh
//!            session and capture its id from claude's output for the
//!            next turn.
//!
//!   Mode B — one-shot scoped invocation. We pipe the segment-scoped
//!            prompt produced by `clipwright agent prompt <seg>` into
//!            `claude --print --append-system-prompt`.
//!
//! Both modes are simple subprocess calls in P1 — streaming/JSON output
//! is a P2 polish item once a real conversation feels right.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::io::Write;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::clipwright;
use crate::validate;

#[derive(Debug, Error)]
pub enum ClaudeError {
    #[error("claude CLI not found on PATH")]
    NotFound,
    #[error("claude exited {code}: {stderr_tail}")]
    NonZero { code: i32, stderr_tail: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("clipwright agent prompt failed: {0}")]
    Prompt(#[from] crate::clipwright::ClipwrightCliError),
    #[error("{0}")]
    Bad(String),
}

impl Serialize for ClaudeError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Deserialize)]
pub struct ChatTurn {
    pub message: String,
    pub video_id: String,            // every chat is anchored to a video
    pub seg_id: Option<String>,      // present → Mode B (per-segment scoped)
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub reply: String,
    pub mode: &'static str, // "A" or "B"
    pub elapsed_ms: u128,
}

fn find_claude() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join("claude");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Run `claude` and return its stdout (one-shot, no streaming).
///
/// On non-zero exit returns a stderr tail. The frontend renders the error
/// inline in the chat — failure is conversational.
fn run_claude(args: &[&str], cwd: &str, stdin_payload: Option<&str>) -> Result<String, ClaudeError> {
    let bin = find_claude().ok_or(ClaudeError::NotFound)?;
    let mut cmd = Command::new(&bin);
    cmd.args(args).current_dir(cwd);
    cmd.stdin(if stdin_payload.is_some() { Stdio::piped() } else { Stdio::null() });
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(payload.as_bytes())?;
        }
    }
    let out = child.wait_with_output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.chars().rev().take(1500).collect::<String>().chars().rev().collect();
        return Err(ClaudeError::NonZero {
            code: out.status.code().unwrap_or(-1),
            stderr_tail: tail.trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(test)]
mod parse_tests {
    use super::parse_claude_json_output;

    #[test]
    fn parses_canonical_result_shape() {
        let stdout = r#"{"type":"result","subtype":"success","session_id":"sess-abc","result":"Hello back."}"#;
        let (text, sid) = parse_claude_json_output(stdout).unwrap();
        assert_eq!(text, "Hello back.");
        assert_eq!(sid.as_deref(), Some("sess-abc"));
    }

    #[test]
    fn falls_back_to_text_field() {
        let stdout = r#"{"text":"reply","session_id":"x"}"#;
        let (text, sid) = parse_claude_json_output(stdout).unwrap();
        assert_eq!(text, "reply");
        assert_eq!(sid.as_deref(), Some("x"));
    }

    #[test]
    fn non_json_treated_as_text() {
        let stdout = "plain old text reply";
        let (text, sid) = parse_claude_json_output(stdout).unwrap();
        assert_eq!(text, "plain old text reply");
        assert!(sid.is_none());
    }

    #[test]
    fn empty_output_is_an_error() {
        assert!(parse_claude_json_output("   ").is_err());
    }

    #[test]
    fn missing_session_id_returns_none() {
        let stdout = r#"{"result":"hi"}"#;
        let (text, sid) = parse_claude_json_output(stdout).unwrap();
        assert_eq!(text, "hi");
        assert!(sid.is_none());
    }
}

fn append_chat_log(
    project_dir: &str,
    video_id: &str,
    role: &str,
    text: &str,
) -> std::io::Result<()> {
    let dir = PathBuf::from(project_dir).join("chat/sessions").join(video_id);
    std::fs::create_dir_all(&dir)?;
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let path = dir.join(format!("{today}.jsonl"));
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    let entry = serde_json::json!({
        "ts": Utc::now().to_rfc3339(),
        "role": role,
        "text": text,
    });
    writeln!(f, "{}", entry)?;
    Ok(())
}

/// Mode A — persistent chat for the open project (project-scoped session).
///
/// Reads `.clipwright/claude-session` to resume the project's running
/// conversation. If empty, starts a fresh session and writes the new id
/// back for the next turn. This keeps chats per-project even when the
/// user opens multiple projects from the same shell `cwd`.
///
/// Mode B (scoped) does NOT resume — each Ask-Claude is a one-shot.
#[tauri::command]
pub async fn claude_chat(
    project_dir: String,
    turn: ChatTurn,
) -> Result<ChatResponse, ClaudeError> {
    let start = std::time::Instant::now();
    let video_id = turn.video_id.clone();
    append_chat_log(&project_dir, &video_id, "user", &turn.message)?;

    let (reply, new_session_id) = if let Some(seg_id) = turn.seg_id.as_deref() {
        // Mode B — scoped to a single segment in a video; no session reuse.
        validate::seg_id(seg_id).map_err(ClaudeError::Bad)?;
        let prompt_out = clipwright::run(&[
            "agent", "prompt", seg_id,
            "--project", &project_dir,
            "--video", &video_id,
        ])?;
        let system_prompt = String::from_utf8_lossy(&prompt_out.stdout).to_string();
        let stdout = run_claude(
            &[
                "--print",
                "--output-format", "json",
                "--append-system-prompt", &system_prompt,
                "--", &turn.message,
            ],
            &project_dir,
            None,
        )?;
        let (text, _) = parse_claude_json_output(&stdout)?;
        (text, None)
    } else {
        // Mode A — persistent, per-video session.
        let prior = load_session_id(&project_dir, &video_id);
        let prompt_out = clipwright::run(&[
            "agent", "prompt",
            "--project", &project_dir,
            "--video", &video_id,
        ])?;
        let system_prompt = String::from_utf8_lossy(&prompt_out.stdout).to_string();
        let mut args: Vec<&str> = vec!["--print", "--output-format", "json"];
        if let Some(id) = prior.as_deref() {
            args.push("--resume");
            args.push(id);
        }
        args.extend(["--append-system-prompt", &system_prompt, "--", &turn.message]);
        let stdout = run_claude(&args, &project_dir, None)?;
        let (text, session_id) = parse_claude_json_output(&stdout)?;
        (text, session_id)
    };

    if let Some(id) = new_session_id {
        let _ = save_session_id(&project_dir, &video_id, &id);
    }

    let trimmed = reply.trim().to_string();
    append_chat_log(&project_dir, &video_id, "assistant", &trimmed)?;
    let elapsed_ms = start.elapsed().as_millis();
    Ok(ChatResponse {
        reply: trimmed,
        mode: if turn.seg_id.is_some() { "B" } else { "A" },
        elapsed_ms,
    })
}

/// Parse `claude --output-format json` stdout.
///
/// Shape (current claude CLI):
///   { "type": "result", "subtype": "success", "session_id": "...",
///     "result": "the assistant reply", ... }
///
/// We tolerate variations: extract `result` (fallback to `text` or the raw
/// stdout if neither key is present) and `session_id` (None if absent).
fn parse_claude_json_output(stdout: &str) -> Result<(String, Option<String>), ClaudeError> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err(ClaudeError::Bad("claude returned empty output".into()));
    }
    // Try to parse as JSON. If that fails, treat as text (back-compat for
    // older claude CLI versions that don't honor --output-format json).
    let val: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return Ok((trimmed.to_string(), None)),
    };
    let text = val
        .get("result")
        .and_then(|v| v.as_str())
        .or_else(|| val.get("text").and_then(|v| v.as_str()))
        .unwrap_or(trimmed)
        .to_string();
    let session_id = val
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok((text, session_id))
}

fn session_path(project_dir: &str, video_id: &str) -> PathBuf {
    PathBuf::from(project_dir)
        .join(".clipwright")
        .join("claude-sessions")
        .join(format!("{video_id}.txt"))
}

fn load_session_id(project_dir: &str, video_id: &str) -> Option<String> {
    let path = session_path(project_dir, video_id);
    let s = std::fs::read_to_string(&path).ok()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn save_session_id(project_dir: &str, video_id: &str, id: &str) -> std::io::Result<()> {
    let path = session_path(project_dir, video_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, id.trim().as_bytes())?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct ClaudeDoctorReport {
    pub installed: bool,
    pub path: Option<String>,
}

#[tauri::command]
pub async fn claude_doctor() -> ClaudeDoctorReport {
    let p = find_claude();
    ClaudeDoctorReport {
        installed: p.is_some(),
        path: p.map(|x| x.display().to_string()),
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ChatHistoryEntry {
    pub ts: String,
    pub role: String,
    pub text: String,
}

/// Read every chat log for a given video. The UI uses this to repopulate
/// the rail across app restarts and video switches.
#[tauri::command]
pub async fn load_chat_history(
    project_dir: String,
    video_id: String,
) -> Result<Vec<ChatHistoryEntry>, ClaudeError> {
    let dir = PathBuf::from(&project_dir).join("chat/sessions").join(&video_id);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files: Vec<_> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();
    files.sort_by_key(|e| e.path());
    let mut out: Vec<ChatHistoryEntry> = Vec::new();
    for entry in files {
        let bytes = std::fs::read(entry.path())?;
        for line in bytes.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            if let Ok(e) = serde_json::from_slice::<ChatHistoryEntry>(line) {
                out.push(e);
            }
        }
    }
    Ok(out)
}
