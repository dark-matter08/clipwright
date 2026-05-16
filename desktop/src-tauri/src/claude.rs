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

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use thiserror::Error;

use crate::clipwright;
use crate::validate;

/// Permission modes accepted by `claude --print --permission-mode <mode>`.
///
/// `claude --print` runs without a TTY so its interactive Allow/Deny
/// dialog can't render — turns that need write access just hang or
/// silently noop. We pick the mode up-front instead. Default is
/// `acceptEdits`: writes inside the project dir auto-approve, which is
/// the right posture for an editor where Claude is meant to act on the
/// project's own files. The user can dial up to `bypassPermissions` or
/// down to `default`/`plan` via the rail header.
const PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "plan", "bypassPermissions"];
const DEFAULT_PERMISSION_MODE: &str = "acceptEdits";

/// Tools we always allow when the mode is `acceptEdits`.
///
/// `acceptEdits` only auto-approves file Edit/Write tools. Everything
/// else — Bash, WebFetch, WebSearch, Read/Glob/Grep in some configs —
/// still triggers the interactive allow dialog, which **silently
/// blocks** in `--print` mode (no TTY → no dialog → CLI just waits).
/// The frontend never sees an event because the CLI emits no
/// stream-json for the denial; the user sees only our 120s idle
/// timeout: "no output (likely stuck on a permission prompt)".
///
/// To stop that failure mode, this list covers every tool a manhwa-
/// recap / product-demo turn typically needs:
///
///   - **Read-only inspection**: `Read`, `Glob`, `Grep`, `LS`.
///   - **WebFetch / WebSearch** for chapter URLs and reference lookups.
///   - **Clipwright CLI** for driving the pipeline.
///   - **Common file-ops shell** for downloads, copies, ffmpeg
///     analysis — but NOT a blanket Bash, so destructive commands
///     (`rm -rf`, `curl | bash`) still need yolo mode.
///   - **Task** (subagent) so plan-mode kickoffs don't deadlock.
///
/// Pattern syntax is Claude Code's prefix-matching: `Bash(clipwright:*)`
/// matches any bash invocation whose command starts with `clipwright `.
/// Tool names without parens (`WebFetch`) allow that tool fully.
const ALLOWED_TOOLS_FOR_ACCEPT_EDITS: &[&str] = &[
    // Read-only file inspection.
    "Read",
    "Glob",
    "Grep",
    "LS",
    // Network reads.
    "WebFetch",
    "WebSearch",
    // Subagent dispatch.
    "Task",
    // Clipwright CLI — the canonical pipeline driver.
    "Bash(clipwright:*)",
    "Bash(uv run clipwright:*)",
    "Bash(uvx clipwright:*)",
    "Bash(python -m clipwright:*)",
    "Bash(python3 -m clipwright:*)",
    // Common downloads + media inspection.
    "Bash(curl:*)",
    "Bash(wget:*)",
    "Bash(ffprobe:*)",
    "Bash(ffmpeg:*)",
    // Basic filesystem ops scoped to a project — destructive `rm` and
    // shell-pipe patterns intentionally NOT here; bump to yolo.
    "Bash(mkdir:*)",
    "Bash(cp:*)",
    "Bash(mv:*)",
    "Bash(ls:*)",
    "Bash(find:*)",
    "Bash(cat:*)",
    "Bash(head:*)",
    "Bash(tail:*)",
    "Bash(jq:*)",
];

fn permission_path(project_dir: &str) -> PathBuf {
    PathBuf::from(project_dir).join(".clipwright").join("claude-permissions.json")
}

/// Claude model presets the rail's model picker offers.
///
/// We pass the chosen value through to `claude --model <name>`. The
/// Claude CLI accepts model aliases (`sonnet`, `opus`, `haiku`) plus
/// exact model IDs. Empty string = CLI default (whatever the user's
/// claude config picks).
const VALID_MODELS: &[&str] = &[
    "",          // CLI default
    "sonnet",
    "opus",
    "haiku",
];

fn model_path(project_dir: &str) -> PathBuf {
    PathBuf::from(project_dir).join(".clipwright").join("claude-model.json")
}

fn load_model(project_dir: &str) -> String {
    let path = model_path(project_dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let model = parsed.get("model").and_then(|v| v.as_str()).unwrap_or("");
    if VALID_MODELS.contains(&model) {
        model.to_string()
    } else {
        // Accept exact model IDs (e.g. claude-sonnet-4-20250514) the
        // user typed by hand. We don't try to validate them — claude
        // will reject unknown IDs at invocation time with a clear msg.
        model.to_string()
    }
}

fn save_model(project_dir: &str, model: &str) -> std::io::Result<()> {
    let path = model_path(project_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let payload = serde_json::json!({ "model": model });
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&payload).unwrap().as_bytes())?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[tauri::command]
pub async fn get_model(project_dir: String) -> Result<String, ClaudeError> {
    Ok(load_model(&project_dir))
}

#[tauri::command]
pub async fn set_model(project_dir: String, model: String) -> Result<(), ClaudeError> {
    save_model(&project_dir, &model)?;
    Ok(())
}

fn load_permission_mode(project_dir: &str) -> String {
    let path = permission_path(project_dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return DEFAULT_PERMISSION_MODE.to_string(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return DEFAULT_PERMISSION_MODE.to_string(),
    };
    let mode = parsed.get("mode").and_then(|v| v.as_str()).unwrap_or(DEFAULT_PERMISSION_MODE);
    if PERMISSION_MODES.contains(&mode) {
        mode.to_string()
    } else {
        DEFAULT_PERMISSION_MODE.to_string()
    }
}

fn save_permission_mode(project_dir: &str, mode: &str) -> std::io::Result<()> {
    let path = permission_path(project_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let payload = serde_json::json!({ "mode": mode });
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&payload).unwrap().as_bytes())?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[tauri::command]
pub async fn get_permission_mode(project_dir: String) -> Result<String, ClaudeError> {
    Ok(load_permission_mode(&project_dir))
}

#[tauri::command]
pub async fn set_permission_mode(project_dir: String, mode: String) -> Result<(), ClaudeError> {
    if !PERMISSION_MODES.contains(&mode.as_str()) {
        return Err(ClaudeError::Bad(format!(
            "invalid permission mode: {:?}; expected one of {:?}",
            mode, PERMISSION_MODES
        )));
    }
    save_permission_mode(&project_dir, &mode)?;
    Ok(())
}

/// Wall-clock ceiling for a single `claude` turn.
///
/// Real manhwa-recap turns can run a long time: Claude downloads
/// 30–80 panel images, reads several of them, writes a 12–18 segment
/// manifest, runs `tts-segment` + `caption-segment` + `render-segment`
/// for each, and finally `render-final` through Remotion. Multi-
/// chapter arcs stack the same workload several times. Earlier caps
/// (10 min, then 30 min) kept killing actively-working turns mid-
/// render. The default is now **2 hours** — that's the user's
/// chosen ceiling: enough headroom for nearly any single recap
/// workflow while still cutting off a runaway turn before it goes
/// overnight. The idle timeout below (120s of silence) is still the
/// real "stuck process" backstop.
///
/// Overridable per-project via `<project>/.clipwright/claude-timeout.json`:
/// `{"wall_seconds": <int>}`. Clamped to `[60, 14400]` (1 min – 4
/// hours) so a typo can't disable the cap entirely.
const CLAUDE_WALL_TIMEOUT_DEFAULT: Duration = Duration::from_secs(7200);

/// Idle timeout — kill if no stream-json line arrives for this long.
///
/// Stream-json mode emits a line per assistant message, per tool use,
/// per tool result. A healthy turn produces output every few seconds.
/// 120s of complete silence USED to mean "the CLI is stuck" — but
/// long autonomous turns (deep tool chains, heavy thinking, big
/// bashes in yolo mode) can legitimately go silent for several
/// minutes between messages.
///
/// The watchdog is now configurable via the same per-project file
/// that holds `wall_seconds` (`<project>/.clipwright/claude-timeout.json`),
/// new field `idle_seconds`:
///
///   * absent / 0   → use this default (120s — preserves old behavior)
///   * -1           → watchdog DISABLED; only the wall timeout kills
///   * positive int → clamped to [CLAUDE_IDLE_MIN, CLAUDE_IDLE_MAX]
///
/// See `load_idle_timeout()` for the resolution logic. The UI surfaces
/// presets (2m / 5m / 15m / 30m / off) next to the permission picker
/// in the Claude rail header.
const CLAUDE_IDLE_TIMEOUT_DEFAULT: Duration = Duration::from_secs(120);
const CLAUDE_IDLE_MIN: u64 = 30;
const CLAUDE_IDLE_MAX: u64 = 3600;

fn timeout_path(project_dir: &str) -> PathBuf {
    PathBuf::from(project_dir).join(".clipwright").join("claude-timeout.json")
}

/// Load the per-project wall-clock timeout override, or fall back to
/// `CLAUDE_WALL_TIMEOUT_DEFAULT`. Power users tune this when they're
/// running unusually long workflows (e.g. multi-chapter recaps).
fn load_wall_timeout(project_dir: &str) -> Duration {
    let path = timeout_path(project_dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return CLAUDE_WALL_TIMEOUT_DEFAULT,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return CLAUDE_WALL_TIMEOUT_DEFAULT,
    };
    let secs = parsed.get("wall_seconds").and_then(|v| v.as_u64()).unwrap_or(0);
    if secs == 0 {
        return CLAUDE_WALL_TIMEOUT_DEFAULT;
    }
    // Lower bound prevents accidental hair-trigger; upper bound is a
    // sanity check so a typo (`360000` instead of `3600`) doesn't
    // disable the cap entirely.
    let clamped = secs.clamp(60, 14400); // 1 min .. 4 hours
    Duration::from_secs(clamped)
}

/// Resolved idle-timeout policy for a project.
///
/// Returns:
///   * `Some(default 120s)` when the file is missing, invalid, or
///     `idle_seconds` is unset/0 (preserves the historical behavior
///     for projects that never opted in).
///   * `None` when `idle_seconds == -1` — the watchdog is disabled
///     and only the wall-clock timeout will kill an idle process.
///   * `Some(clamped)` when `idle_seconds` is a positive integer.
///     Out-of-range values snap into `[CLAUDE_IDLE_MIN,
///     CLAUDE_IDLE_MAX]` so a typo can't either hair-trigger the
///     kill or accidentally remove the cap.
fn load_idle_timeout(project_dir: &str) -> Option<Duration> {
    let path = timeout_path(project_dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Some(CLAUDE_IDLE_TIMEOUT_DEFAULT),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Some(CLAUDE_IDLE_TIMEOUT_DEFAULT),
    };
    let signed = parsed.get("idle_seconds").and_then(|v| v.as_i64()).unwrap_or(0);
    if signed == -1 {
        return None; // explicit "off"
    }
    if signed <= 0 {
        return Some(CLAUDE_IDLE_TIMEOUT_DEFAULT);
    }
    let clamped = (signed as u64).clamp(CLAUDE_IDLE_MIN, CLAUDE_IDLE_MAX);
    Some(Duration::from_secs(clamped))
}

/// Read the raw `idle_seconds` field from `claude-timeout.json` so the
/// frontend can render the matching preset. Returns `0` when unset
/// (UI shows the default-2m preset). `-1` means "off". Positive
/// values are returned UNCLAMPED — the UI is responsible for falling
/// back to its default-preset display if it doesn't recognize the
/// number; the clamp is enforced at enforcement time inside
/// `load_idle_timeout()`.
fn load_idle_seconds_raw(project_dir: &str) -> i64 {
    let path = timeout_path(project_dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    parsed.get("idle_seconds").and_then(|v| v.as_i64()).unwrap_or(0)
}

/// Persist the idle-timeout choice WITHOUT touching `wall_seconds`.
/// Both fields share a single file, so we read-merge-write. Caller is
/// expected to have already validated `seconds` is one of: -1, 0, or
/// positive (the Tauri command does this).
fn save_idle_seconds(project_dir: &str, seconds: i64) -> std::io::Result<()> {
    let path = timeout_path(project_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Read existing config so we preserve `wall_seconds` and any
    // future siblings. If the file is missing or corrupt we start
    // from an empty object — there's nothing to preserve.
    let mut config: serde_json::Map<String, serde_json::Value> =
        match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(serde_json::Value::Object(m)) => m,
                _ => serde_json::Map::new(),
            },
            Err(_) => serde_json::Map::new(),
        };
    if seconds == 0 {
        // Treat 0 as "clear the override" — drop the key so the
        // file stays tidy and the next read falls through to the
        // hardcoded default. If `wall_seconds` is also absent we
        // delete the file outright; saves an empty `{}` on disk.
        config.remove("idle_seconds");
        if config.is_empty() {
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }
    } else {
        config.insert("idle_seconds".to_string(), serde_json::Value::from(seconds));
    }
    let payload = serde_json::Value::Object(config);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&payload).unwrap().as_bytes())?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[tauri::command]
pub async fn get_idle_timeout(project_dir: String) -> Result<i64, ClaudeError> {
    Ok(load_idle_seconds_raw(&project_dir))
}

#[tauri::command]
pub async fn set_idle_timeout(project_dir: String, seconds: i64) -> Result<(), ClaudeError> {
    // Accept: -1 ("off"), 0 (clear/default), or a positive integer
    // within the clamp range. Out-of-band values are rejected up-
    // front so the user sees a clear error rather than silent
    // snapping at enforcement time.
    if seconds < -1 || (seconds > 0 && ((seconds as u64) < CLAUDE_IDLE_MIN || (seconds as u64) > CLAUDE_IDLE_MAX)) {
        return Err(ClaudeError::Bad(format!(
            "invalid idle_seconds: {seconds}; expected -1 (off), 0 (default), or [{}..{}]",
            CLAUDE_IDLE_MIN, CLAUDE_IDLE_MAX
        )));
    }
    save_idle_seconds(&project_dir, seconds)?;
    Ok(())
}

/// Shared cancellation state — `cancel_claude_chat(video_id)` inserts an
/// entry; the in-flight `run_claude` poll-loop drains it and kills its
/// child. Keyed by video_id so canceling one video's chat doesn't kill
/// another. Wrapped in Tauri `State` from `lib.rs`.
#[derive(Default)]
pub struct ClaudeCancellation {
    pub requested: Mutex<HashSet<String>>,
}

#[derive(Debug, Error)]
pub enum ClaudeError {
    #[error("claude CLI not found on PATH")]
    NotFound,
    #[error("claude exited {code}: {stderr_tail}")]
    NonZero { code: i32, stderr_tail: String },
    #[error("claude timed out after {seconds}s — killed ({reason})")]
    Timeout { seconds: u64, reason: String },
    #[error("cancelled")]
    Cancelled,
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

/// One streamed event from `claude --output-format stream-json`.
///
/// We re-emit each parsed line to the frontend as a Tauri event so the
/// rail can render thinking / tool calls / partial assistant text live
/// instead of waiting for the final result. The shape is the raw line
/// from the CLI plus our `video_id` so the rail can route by video.
#[derive(Debug, Serialize, Clone)]
struct ClaudeStreamEvent {
    video_id: String,
    /// Raw JSON object the CLI emitted. The frontend pattern-matches on
    /// `type` ("assistant", "user", "result", "system", ...) to render.
    payload: serde_json::Value,
}

/// Streaming runner for `claude --output-format stream-json`.
///
/// The CLI emits one JSON object per line as the conversation
/// progresses. We:
///   1. Spawn the child with stdout piped.
///   2. Move stdout into a dedicated reader thread that forwards each
///      line over an mpsc channel — `read_line()` blocks, so we can't
///      poll cancel/timeout on the same thread.
///   3. Main loop: pull lines with `recv_timeout(short)`, emit each as
///      a Tauri event, reset the idle clock, check cancel + walltime.
///   4. On exit, drain stderr for diagnostic context and parse the
///      final `result` object for the (text, session_id) tuple.
fn run_claude_streaming(
    args: &[&str],
    cwd: &str,
    video_id: &str,
    cancel: &ClaudeCancellation,
    app: &tauri::AppHandle,
) -> Result<(String, Option<String>), ClaudeError> {
    let wall_timeout = load_wall_timeout(cwd);
    // `None` here = the user picked "off" in the rail's idle-timeout
    // selector. We capture once at start so the loop below doesn't
    // re-read the file every iteration (and so a config edit
    // mid-turn doesn't change the policy half-way through).
    let idle_timeout = load_idle_timeout(cwd);
    let bin = find_claude().ok_or(ClaudeError::NotFound)?;
    let mut cmd = Command::new(&bin);
    cmd.args(args).current_dir(cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Drain any stale cancel for this video_id before we start.
    {
        let mut set = cancel.requested.lock().unwrap();
        set.remove(video_id);
    }
    let mut child = cmd.spawn()?;

    // Hand stdout to a reader thread that pushes lines through a
    // channel. We never need to manually close `stdout_handle` — when
    // the child exits the EOF naturally drops out of `lines()` and the
    // thread ends, closing the sender.
    let stdout_handle = child.stdout.take().expect("stdout piped");
    let (tx, rx) = mpsc::channel::<std::io::Result<String>>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout_handle);
        for line in reader.lines() {
            if tx.send(line).is_err() {
                // Receiver dropped — main thread killed the child or
                // returned early. Just stop reading.
                break;
            }
        }
    });

    let start = Instant::now();
    let mut last_activity = Instant::now();
    let mut final_text: Option<String> = None;
    let mut final_session_id: Option<String> = None;

    loop {
        // Wait briefly for the next line; tight enough that cancel /
        // timeout checks happen ~10× per second, loose enough not to
        // burn CPU when claude is thinking.
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(line)) => {
                last_activity = Instant::now();
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // Try to parse — if it isn't JSON, still forward the raw
                // text to the UI so the user sees something. Future-
                // proof: an unrecognized event shape doesn't break us.
                let payload: serde_json::Value =
                    serde_json::from_str(trimmed).unwrap_or_else(|_| {
                        serde_json::json!({ "type": "raw", "text": trimmed })
                    });
                // The final "result" line carries text + session_id.
                // Capture before forwarding so the main return value
                // is always populated.
                if payload.get("type").and_then(|v| v.as_str()) == Some("result") {
                    if let Some(s) = payload.get("result").and_then(|v| v.as_str()) {
                        final_text = Some(s.to_string());
                    } else if let Some(s) = payload.get("text").and_then(|v| v.as_str()) {
                        final_text = Some(s.to_string());
                    }
                    if let Some(s) = payload.get("session_id").and_then(|v| v.as_str()) {
                        final_session_id = Some(s.to_string());
                    }
                }
                // Persist tool_use / tool_result blocks BEFORE we hand
                // the payload off to the emit — `app.emit` takes a
                // reference, but we want to avoid holding the payload
                // by reference across both calls. Borrowing here keeps
                // the lifetime simple.
                capture_tool_payload(cwd, video_id, &payload);
                // Emit even the "result" line so the frontend can mark
                // the turn complete and stop the "thinking…" spinner.
                let event = ClaudeStreamEvent {
                    video_id: video_id.to_string(),
                    payload,
                };
                let _ = app.emit("claude:turn", &event);
            }
            Ok(Err(e)) => return Err(ClaudeError::Io(e)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // No line this tick — fall through to the watchdogs.
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Reader thread closed (child exited or pipe broke).
                // Break out and grab the exit status below.
                break;
            }
        }

        // Cancel requested?
        {
            let mut set = cancel.requested.lock().unwrap();
            if set.remove(video_id) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ClaudeError::Cancelled);
            }
        }
        // Wall-clock timeout (per-project, with a sane default).
        if start.elapsed() >= wall_timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ClaudeError::Timeout {
                seconds: wall_timeout.as_secs(),
                reason:
                    "wall-clock cap. Hit Cancel to stop a long turn at any time, or \
                     raise this cap by writing `{\"wall_seconds\": <int>}` to \
                     <project>/.clipwright/claude-timeout.json (default 7200s = 2h, max 14400s = 4h)."
                    .to_string(),
            });
        }
        // Idle timeout — no output for too long. Skipped entirely
        // when the user picked "off" in the rail's idle-timeout
        // selector (idle_timeout = None). The wall-clock check above
        // remains the only kill switch in that mode.
        if let Some(idle_cap) = idle_timeout {
            if last_activity.elapsed() >= idle_cap {
                let _ = child.kill();
                let _ = child.wait();
                // Two common causes for a stalled stream:
                //   1) The CLI silently denied a tool not in our
                //      allow list (no dialog in --print mode), so
                //      Claude is waiting on something that will
                //      never resolve. The user wants permission
                //      changes ("auto-edits" → "yolo") here.
                //   2) Claude is legitimately working — deep tool
                //      chains, big bashes, heavy thinking. The user
                //      wants to raise the idle timeout (or set Off)
                //      here, NOT change permissions.
                // The message names both so neither audience is
                // misdirected by the historical "switch to yolo"
                // advice (which is useless for case 2).
                let idle_secs = idle_cap.as_secs();
                let reason = format!(
                    "no output for {idle_secs}s. Two common causes: (1) the CLI silently denied \
                     a tool (Bash patterns not in the auto-edits allow list) — try the rail's \
                     permission picker (auto-edits or yolo); (2) the turn legitimately needs \
                     longer (long thinking or tool chains) — raise the idle timeout in the rail \
                     header, or set it to Off so only the wall-clock cap fires."
                );
                return Err(ClaudeError::Timeout {
                    seconds: idle_secs,
                    reason,
                });
            }
        }
    }

    // Reader thread closed — wait on the child to grab the exit status
    // and drain stderr for the error path.
    let status = match child.wait() {
        Ok(s) => s,
        Err(e) => return Err(ClaudeError::Io(e)),
    };
    let mut stderr = String::new();
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_string(&mut stderr);
    }
    if !status.success() {
        let tail: String = stderr.chars().rev().take(1500).collect::<String>().chars().rev().collect();
        return Err(ClaudeError::NonZero {
            code: status.code().unwrap_or(-1),
            stderr_tail: tail.trim().to_string(),
        });
    }
    let text = final_text.ok_or_else(|| {
        ClaudeError::Bad("claude exited without a result line".into())
    })?;
    Ok((text, final_session_id))
}

fn append_chat_log(
    project_dir: &str,
    video_id: &str,
    role: &str,
    text: &str,
) -> std::io::Result<()> {
    append_chat_entry(
        project_dir,
        video_id,
        &serde_json::json!({
            "ts": Utc::now().to_rfc3339(),
            "role": role,
            "text": text,
        }),
    )
}

/// Lower-level append — caller supplies the full JSON object. Used by
/// the tool-use / tool-result capture path in `run_claude_streaming`
/// to write entries with extension fields beyond `{ts, role, text}`.
/// The legacy `append_chat_log` is now a thin wrapper around this.
fn append_chat_entry(
    project_dir: &str,
    video_id: &str,
    entry: &serde_json::Value,
) -> std::io::Result<()> {
    let dir = PathBuf::from(project_dir).join("chat/sessions").join(video_id);
    std::fs::create_dir_all(&dir)?;
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let path = dir.join(format!("{today}.jsonl"));
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    writeln!(f, "{}", entry)?;
    Ok(())
}

/// Walk a stream-json payload and persist any tool_use / tool_result
/// blocks it carries to the per-video chat log.
///
/// The CLI emits two relevant event shapes:
///
///   * `type:"assistant"` with `message.content[]` — each part may be
///     `{type:"text", text}` (the bubble copy — captured separately
///     via the final `result` event) or `{type:"tool_use", id, name,
///     input}` (a tool call we want in the log so it survives a
///     refresh / mid-turn stop).
///
///   * `type:"user"` with `message.content[]` — each part is
///     `{type:"tool_result", tool_use_id, content, is_error}`.
///
/// Persistence is best-effort: an IO failure on the log doesn't
/// abort the turn. The user still saw the event in the live bubble
/// (the stream-event emit happens upstream); the only thing they
/// lose is durability for that one entry.
fn capture_tool_payload(
    project_dir: &str,
    video_id: &str,
    payload: &serde_json::Value,
) {
    let event_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let parts = payload
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array());
    let parts = match parts {
        Some(p) => p,
        None => return,
    };
    let ts = Utc::now().to_rfc3339();
    for part in parts {
        let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if event_type == "assistant" && part_type == "tool_use" {
            let entry = serde_json::json!({
                "ts": ts,
                "role": "tool_use",
                // Legacy-reader-friendly: the bare `text` field shows
                // the tool name so older builds at least see "ran
                // <tool>" rather than an empty bubble.
                "text": part.get("name").and_then(|v| v.as_str()).unwrap_or("tool"),
                "tool_id": part.get("id").and_then(|v| v.as_str()),
                "tool_name": part.get("name").and_then(|v| v.as_str()),
                "tool_input": part.get("input").cloned().unwrap_or(serde_json::Value::Null),
            });
            let _ = append_chat_entry(project_dir, video_id, &entry);
        } else if event_type == "user" && part_type == "tool_result" {
            let entry = serde_json::json!({
                "ts": ts,
                "role": "tool_result",
                "text": "", // legacy `text` is empty; readers should use tool_output.
                "tool_id": part.get("tool_use_id").and_then(|v| v.as_str()),
                "tool_output": part.get("content").cloned().unwrap_or(serde_json::Value::Null),
                "tool_error": part.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false),
            });
            let _ = append_chat_entry(project_dir, video_id, &entry);
        }
    }
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
    app: tauri::AppHandle,
    project_dir: String,
    turn: ChatTurn,
    cancel: tauri::State<'_, ClaudeCancellation>,
) -> Result<ChatResponse, ClaudeError> {
    let start = std::time::Instant::now();
    let video_id = turn.video_id.clone();
    append_chat_log(&project_dir, &video_id, "user", &turn.message)?;

    // Resolve permission mode once up-front so both Mode A and Mode B
    // pass the same flag. The CLI's interactive permission dialog can't
    // render in `--print` (no TTY); the flag picks the policy instead.
    let permission_mode = load_permission_mode(&project_dir);
    // Model selection — empty string means "use the CLI default". The
    // rail's model picker writes this; both modes inherit it so the
    // user's model choice applies to scoped one-shots too.
    let model = load_model(&project_dir);
    // In `acceptEdits` mode, also whitelist clipwright shell commands so
    // Claude can actually drive the CLI without an Allow dialog it can't
    // render. Other modes don't need this: `plan` is read-only, `default`
    // expects manual approval, `bypassPermissions` allows everything.
    let allowed_tools_joined: Option<String> = if permission_mode == "acceptEdits" {
        Some(ALLOWED_TOOLS_FOR_ACCEPT_EDITS.join(","))
    } else {
        None
    };

    // Stream-json mode requires `--verbose`; without it the CLI bails
    // out at startup. The frontend pattern-matches on `payload.type` to
    // render each event (assistant text, tool use, tool result, …).
    let (reply, new_session_id) = if let Some(seg_id) = turn.seg_id.as_deref() {
        // Mode B — scoped to a single segment in a video; no session reuse.
        validate::seg_id(seg_id).map_err(ClaudeError::Bad)?;
        let prompt_out = clipwright::run(&[
            "agent", "prompt", seg_id,
            "--project", &project_dir,
            "--video", &video_id,
        ])?;
        let system_prompt = String::from_utf8_lossy(&prompt_out.stdout).to_string();
        let mut b_args: Vec<&str> = vec![
            "--print",
            "--verbose",
            "--output-format", "stream-json",
            "--permission-mode", &permission_mode,
        ];
        if !model.is_empty() {
            b_args.push("--model");
            b_args.push(&model);
        }
        if let Some(at) = allowed_tools_joined.as_deref() {
            b_args.push("--allowedTools");
            b_args.push(at);
        }
        b_args.extend(["--append-system-prompt", &system_prompt, "--", &turn.message]);
        let (text, _) = run_claude_streaming(
            &b_args,
            &project_dir,
            &video_id,
            cancel.inner(),
            &app,
        )?;
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
        let mut args: Vec<&str> = vec![
            "--print",
            "--verbose",
            "--output-format", "stream-json",
            "--permission-mode", &permission_mode,
        ];
        if !model.is_empty() {
            args.push("--model");
            args.push(&model);
        }
        if let Some(at) = allowed_tools_joined.as_deref() {
            args.push("--allowedTools");
            args.push(at);
        }
        if let Some(id) = prior.as_deref() {
            args.push("--resume");
            args.push(id);
        }
        args.extend(["--append-system-prompt", &system_prompt, "--", &turn.message]);
        let (text, session_id) = run_claude_streaming(
            &args,
            &project_dir,
            &video_id,
            cancel.inner(),
            &app,
        )?;
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

/// Ask any in-flight `claude_chat` for `video_id` to kill its subprocess.
///
/// The runner polls the shared cancel set every ~150ms, so the kill lands
/// well within a second. No-op if nothing is in flight for that video —
/// safe to call eagerly from the UI.
#[tauri::command]
pub async fn cancel_claude_chat(
    video_id: String,
    cancel: tauri::State<'_, ClaudeCancellation>,
) -> Result<(), ClaudeError> {
    let mut set = cancel.requested.lock().unwrap();
    set.insert(video_id);
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

/// Reset the persistent chat state for one video.
///
/// Deletes the stored session id (so the next `claude_chat` turn starts a
/// fresh `claude` session instead of `--resume <id>`-ing the prior one)
/// and archives today's chat log alongside it. The archived file keeps
/// the same path with a `.archived-<ts>` suffix so the user can recover
/// the transcript by hand if they need it later. Tomorrow's logs land in
/// a fresh `<date>.jsonl` either way.
#[tauri::command]
pub async fn clear_claude_session(
    project_dir: String,
    video_id: String,
) -> Result<(), ClaudeError> {
    validate::seg_id(&video_id).ok(); // soft sanity — same posture as save_video.

    let session_file = session_path(&project_dir, &video_id);
    if session_file.exists() {
        let _ = std::fs::remove_file(&session_file);
    }

    let today = Utc::now().format("%Y-%m-%d").to_string();
    let log_file = PathBuf::from(&project_dir)
        .join("chat/sessions")
        .join(&video_id)
        .join(format!("{today}.jsonl"));
    if log_file.exists() {
        let stamp = Utc::now().format("%Y%m%dT%H%M%S").to_string();
        let archived = log_file.with_file_name(format!("{today}.jsonl.archived-{stamp}"));
        let _ = std::fs::rename(&log_file, &archived);
    }
    Ok(())
}

/// One line of the per-video JSONL chat log.
///
/// Roles in use:
///   * `"user"`         — message the user submitted via the rail.
///   * `"assistant"`    — the final assistant text emitted as a `result`
///                        line at the end of a turn.
///   * `"tool_use"`     — a tool call Claude made mid-turn. Populates
///                        `tool_id`, `tool_name`, `tool_input`.
///                        `text` repeats the tool name for older
///                        readers that only know the legacy 3-field
///                        schema.
///   * `"tool_result"`  — the reply for a `tool_use`. Populates
///                        `tool_id`, `tool_output`, and `tool_error`
///                        (`Some(true)` when the CLI flagged the
///                        result as an error).
///
/// All four extension fields are `Option` + `skip_serializing_if`-gated
/// so existing user-role / assistant-role lines on disk continue to
/// deserialize unchanged, and so we don't bloat their JSON with
/// trailing `null`s. The frontend treats unknown fields as opt-in
/// extras — older builds opening newer logs just skip the tool
/// entries (they have a recognized role but no `text` worth showing
/// on their own).
#[derive(Debug, Deserialize, Serialize)]
pub struct ChatHistoryEntry {
    pub ts: String,
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_output: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_error: Option<bool>,
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

// ---------------------------------------------------------------------------
// Slash-command discovery
// ---------------------------------------------------------------------------
//
// Claude Code's custom slash commands are markdown files under:
//   * `~/.claude/commands/**/*.md`         — user-level (every project)
//   * `<project>/.claude/commands/**/*.md` — project-level (overrides
//     user-level on name collision)
//
// File path → command name:
//   * `commands/foo.md`        → `/foo`
//   * `commands/qa/test.md`    → `/qa:test`   (subdir = namespace)
//   * `commands/a/b/c.md`      → `/a:b:c`     (nested namespaces)
//
// Markdown frontmatter (between `---` fences) may declare:
//   * `description:`    one-line summary shown in the popover
//   * `argument-hint:`  placeholder for the arg the user should fill in
//
// We only need the metadata for autocomplete — the CLI itself loads and
// executes the file when the user actually sends `/<name>`, so we don't
// have to re-implement template expansion here.

#[derive(Debug, Clone, Serialize)]
pub struct SlashCommand {
    /// The fully-qualified command name without the leading slash, e.g.
    /// `qa:test`. The frontend prepends `/` for display + transmission.
    pub name: String,
    /// `"user"` for `~/.claude/commands/`, `"project"` for the
    /// project-local copy. Used to disambiguate in the popover and to
    /// honor the project-overrides-user rule.
    pub source: String,
    /// One-line description parsed from the markdown frontmatter, or
    /// empty if absent.
    pub description: String,
    /// Frontmatter `argument-hint:` value — a placeholder shown after
    /// the command name in the popover (e.g. "<file>"). Empty when
    /// the command takes no arguments.
    pub argument_hint: String,
}

/// Walk a `commands/` directory tree (recursively) and yield one
/// `SlashCommand` per `.md` file. The `tag` is passed through as
/// `SlashCommand::source` so we can label user vs project entries.
fn collect_slash_commands(root: &std::path::Path, tag: &str, out: &mut Vec<SlashCommand>) {
    if !root.exists() {
        return;
    }
    walk_commands_dir(root, root, tag, out);
}

fn walk_commands_dir(
    base: &std::path::Path,
    dir: &std::path::Path,
    tag: &str,
    out: &mut Vec<SlashCommand>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_commands_dir(base, &path, tag, out);
            continue;
        }
        if path.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        // Derive the command name from the path relative to the
        // `commands/` root: `qa/test.md` → `qa:test`, `foo.md` → `foo`.
        let rel = match path.strip_prefix(base) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut parts: Vec<String> = Vec::new();
        for component in rel.with_extension("").components() {
            if let std::path::Component::Normal(p) = component {
                if let Some(s) = p.to_str() {
                    parts.push(s.to_string());
                }
            }
        }
        if parts.is_empty() {
            continue;
        }
        let name = parts.join(":");
        let (description, argument_hint) = parse_command_frontmatter(&path);
        out.push(SlashCommand {
            name,
            source: tag.to_string(),
            description,
            argument_hint,
        });
    }
}

/// Pull `description:` and `argument-hint:` out of YAML-ish frontmatter
/// at the top of a slash-command markdown file. We do NOT depend on a
/// YAML parser — slash-command frontmatter in the wild is one-line-
/// per-field with simple string values, and a partial parse is fine.
/// Lines outside the `---` fence pair are ignored; if the file has no
/// frontmatter we return empty strings.
fn parse_command_frontmatter(path: &std::path::Path) -> (String, String) {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return (String::new(), String::new()),
    };
    let mut lines = raw.lines();
    let first = lines.next().unwrap_or("").trim();
    if first != "---" {
        return (String::new(), String::new());
    }
    let mut description = String::new();
    let mut argument_hint = String::new();
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("description:") {
            description = strip_yaml_value(rest);
        } else if let Some(rest) = trimmed.strip_prefix("argument-hint:") {
            argument_hint = strip_yaml_value(rest);
        }
    }
    (description, argument_hint)
}

/// Trim surrounding whitespace and matching quote pairs from a
/// frontmatter value. Doesn't handle escapes — slash-command
/// descriptions are short prose, not JSON.
fn strip_yaml_value(raw: &str) -> String {
    let t = raw.trim();
    if (t.starts_with('"') && t.ends_with('"') && t.len() >= 2)
        || (t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2)
    {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// Enumerate every custom slash command available to a project — user-
/// level files first, then project-level files. Project-level entries
/// win on name collision (matching the upstream Claude Code precedence).
#[tauri::command]
pub async fn list_slash_commands(
    project_dir: String,
) -> Result<Vec<SlashCommand>, ClaudeError> {
    let mut user: Vec<SlashCommand> = Vec::new();
    let mut project: Vec<SlashCommand> = Vec::new();
    // Match the home-dir resolution style used elsewhere in this crate
    // (`credentials.rs`): read `$HOME` directly. The `directories`
    // crate would also work but it's overkill for a one-shot path
    // and adds a different code path to maintain.
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        collect_slash_commands(&home.join(".claude").join("commands"), "user", &mut user);
    }
    let proj_root = PathBuf::from(&project_dir).join(".claude").join("commands");
    collect_slash_commands(&proj_root, "project", &mut project);
    // Project entries override user entries on collision.
    let project_names: std::collections::HashSet<String> =
        project.iter().map(|c| c.name.clone()).collect();
    let mut out: Vec<SlashCommand> = user
        .into_iter()
        .filter(|c| !project_names.contains(&c.name))
        .collect();
    out.extend(project);
    // Stable alphabetical order so the popover stays predictable.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------
//
// Claude Code Skills are organized capabilities the agent can invoke
// via slash commands. Each skill lives as a directory containing a
// `SKILL.md` file with YAML frontmatter declaring `name:` and
// `description:`.
//
// Discovery paths (same precedence convention as slash commands):
//   * `~/.claude/skills/<name>/SKILL.md`         — user-level
//   * `<project>/.claude/skills/<name>/SKILL.md` — project-level
//
// The slash-command popover surfaces skills as a separate kind so the
// user can see at a glance which entries are "skill" (broad
// capabilities) vs custom commands (single prompt templates).

#[derive(Debug, Clone, Serialize)]
pub struct Skill {
    /// The skill name — matches the slash-command form (`/<name>`).
    pub name: String,
    /// Frontmatter `description:` — usually a one-paragraph blurb
    /// explaining what the skill does and when to invoke it. Trimmed
    /// to fit a popover row by the frontend; we don't truncate here
    /// so the full text is available on hover.
    pub description: String,
    /// `"user"` (~/.claude/skills) or `"project"` (<project>/.claude).
    pub source: String,
}

fn collect_skills(root: &std::path::Path, tag: &str, out: &mut Vec<Skill>) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        // Skill name = the directory name. The SKILL.md frontmatter
        // also has a `name:` field but we treat the directory name as
        // authoritative because that's what the CLI uses to resolve
        // `/skill-name` → file path. Mismatch in the frontmatter
        // would silently break invocation otherwise.
        let dir_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let (description, _) = parse_command_frontmatter(&skill_md);
        out.push(Skill {
            name: dir_name,
            description,
            source: tag.to_string(),
        });
    }
}

/// Enumerate every skill available to a project — user-level first,
/// then project-level. Project-level entries override user-level on
/// name collision.
#[tauri::command]
pub async fn list_skills(project_dir: String) -> Result<Vec<Skill>, ClaudeError> {
    let mut user: Vec<Skill> = Vec::new();
    let mut project: Vec<Skill> = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        collect_skills(&home.join(".claude").join("skills"), "user", &mut user);
    }
    let proj_root = PathBuf::from(&project_dir).join(".claude").join("skills");
    collect_skills(&proj_root, "project", &mut project);
    let project_names: std::collections::HashSet<String> =
        project.iter().map(|s| s.name.clone()).collect();
    let mut out: Vec<Skill> = user
        .into_iter()
        .filter(|s| !project_names.contains(&s.name))
        .collect();
    out.extend(project);
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Run-clipwright-command (Play button in the chat rail)
// ---------------------------------------------------------------------------
//
// When Claude returns a code block like:
//
//   ```bash
//   clipwright render-segment seg_004 --video my-video
//   ```
//
// the chat bubble renders a small Play button. Clicking it invokes
// this command. We do NOT pipe through a shell — the command string is
// parsed, the allow-list prefix is stripped, and the remaining tokens
// are passed directly to `clipwright::run_with_output` via
// `Command::new(...).args(...)`. That structurally prevents injection
// via `;`, `&&`, backticks, redirections, etc. — they'd just become
// literal argv tokens, the CLI doesn't recognize them, and the worst
// case is a usage error.

#[derive(Debug, Serialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub duration_ms: u64,
}

/// Recognized invocation prefixes for `clipwright …` commands.
/// Mirrors the shell allow-list documented in `_section_skill()` /
/// the agent prompt's "Tools you can use without asking" — anything
/// the agent prompt promises is auto-approved must also be runnable
/// from the Play button, or the user will see an inconsistent UX.
const CLIPWRIGHT_RUN_PREFIXES: &[&str] = &[
    "clipwright",
    "uv run clipwright",
    "uvx clipwright",
    "python -m clipwright",
    "python3 -m clipwright",
];

#[tauri::command]
pub async fn run_clipwright_command(
    project_dir: String,
    command: String,
) -> Result<CommandResult, ClaudeError> {
    let trimmed = command.trim();
    // Strip the prefix and capture the tail. We match longest-first
    // (multi-word prefixes before bare `clipwright`) so `uv run
    // clipwright` doesn't get partially-matched as `clipwright`
    // alone, which would then choke on the `run` token.
    let mut sorted = CLIPWRIGHT_RUN_PREFIXES.to_vec();
    sorted.sort_by_key(|p| std::cmp::Reverse(p.len()));
    let tail: Option<&str> = sorted.iter().find_map(|p| {
        if trimmed == *p {
            Some("")
        } else if let Some(rest) = trimmed.strip_prefix(p) {
            if rest.starts_with(' ') {
                Some(rest.trim_start())
            } else {
                None
            }
        } else {
            None
        }
    });
    let tail = tail.ok_or_else(|| {
        ClaudeError::Bad(format!(
            "command not in clipwright allow-list: {trimmed:?} \
             (must start with one of: {CLIPWRIGHT_RUN_PREFIXES:?})"
        ))
    })?;
    // Reject lines containing shell metacharacters even AFTER prefix
    // strip — they can't actually do harm because we don't invoke a
    // shell, but they signal the user meant something the Play
    // button can't honor (pipes, redirects). Surfacing this as an
    // error is clearer than silently treating them as literal argv.
    for bad in [';', '&', '|', '`', '$', '<', '>'] {
        if tail.contains(bad) {
            return Err(ClaudeError::Bad(format!(
                "command contains unsupported shell metacharacter {bad:?}; \
                 copy-paste this one into a terminal yourself"
            )));
        }
    }
    let args: Vec<&str> = tail.split_whitespace().collect();
    let start = Instant::now();
    let out = crate::clipwright::run_with_output(
        &args,
        Some(std::path::Path::new(&project_dir)),
    )
    .map_err(|e| ClaudeError::Bad(e.to_string()))?;
    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        exit_code: out.status.code().unwrap_or(-1),
        duration_ms: start.elapsed().as_millis() as u64,
    })
}
