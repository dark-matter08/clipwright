//! Spawn the user's `claude` CLI as a subprocess.
//!
//! Two invocation modes per SRS §9.1:
//!
//!   Mode A — persistent chat session. We use `claude --continue` so each
//!            new turn resumes the most recent conversation in `cwd`. The
//!            history lives in claude's own session store; we also append
//!            to `<project>/chat/sessions/<id>.jsonl` so the UI can show
//!            past turns without re-spawning claude.
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
    pub seg_id: Option<String>, // present → Mode B (per-segment scoped)
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

fn append_chat_log(project_dir: &str, role: &str, text: &str) -> std::io::Result<()> {
    let dir = PathBuf::from(project_dir).join("chat/sessions");
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

/// Mode A — persistent chat for the open project.
///
/// Uses `claude --print --continue` so each turn resumes the running
/// conversation. We append the user message and assistant reply to
/// `<project>/chat/sessions/<date>.jsonl` for the UI history view.
#[tauri::command]
pub async fn claude_chat(
    project_dir: String,
    turn: ChatTurn,
) -> Result<ChatResponse, ClaudeError> {
    let start = std::time::Instant::now();
    append_chat_log(&project_dir, "user", &turn.message)?;

    let reply = if let Some(seg_id) = turn.seg_id.as_deref() {
        // Mode B — scoped
        validate::seg_id(seg_id).map_err(ClaudeError::Bad)?;
        let prompt_out = clipwright::run(&["agent", "prompt", seg_id, "--project", &project_dir])?;
        let system_prompt = String::from_utf8_lossy(&prompt_out.stdout).to_string();
        // `--` separator: user message follows, so claude won't interpret a
        // leading `--flag` in the message as a CLI option.
        run_claude(
            &["--print", "--append-system-prompt", &system_prompt, "--", &turn.message],
            &project_dir,
            None,
        )?
    } else {
        // Mode A — persistent
        let prompt_out = clipwright::run(&["agent", "prompt", "--project", &project_dir])?;
        let system_prompt = String::from_utf8_lossy(&prompt_out.stdout).to_string();
        run_claude(
            &[
                "--print",
                "--continue",
                "--append-system-prompt",
                &system_prompt,
                "--",
                &turn.message,
            ],
            &project_dir,
            None,
        )?
    };

    let trimmed = reply.trim().to_string();
    append_chat_log(&project_dir, "assistant", &trimmed)?;
    let elapsed_ms = start.elapsed().as_millis();
    Ok(ChatResponse {
        reply: trimmed,
        mode: if turn.seg_id.is_some() { "B" } else { "A" },
        elapsed_ms,
    })
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

/// Read the chat log for today (or the most recent file). The UI uses
/// this to repopulate the rail across app restarts.
#[tauri::command]
pub async fn load_chat_history(
    project_dir: String,
) -> Result<Vec<ChatHistoryEntry>, ClaudeError> {
    let dir = PathBuf::from(&project_dir).join("chat/sessions");
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
