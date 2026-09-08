//! Spawn the `clipwright` Python CLI as a subprocess.
//!
//! Per SRS §4.1, Python compute is spawned per operation — we never
//! reimplement clipwright primitives in Rust. This module locates the
//! binary and runs it cleanly.
//!
//! Binary discovery order:
//!   1. `CLIPWRIGHT_BIN` environment variable (explicit override).
//!   2. `clipwright` on PATH.
//!   3. `<exe_parent>/../../.venv/bin/clipwright` (dev mode: running from
//!      `src-tauri/target/debug/clipwright-studio`).
//!   4. `$HOME/.local/bin/clipwright`.
//!
//! All commands run synchronously today. Streaming progress events land
//! when the build orchestrator UI does (later in Phase 1).

use std::path::PathBuf;
use std::process::{Command, Output};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ClipwrightCliError {
    #[error("clipwright binary not found")]
    NotFound,
    #[error("clipwright exited {code}: {stderr_tail}")]
    NonZero { code: i32, stderr_tail: String },
    #[error("could not spawn clipwright: {0}")]
    Spawn(#[from] std::io::Error),
}

impl serde::Serialize for ClipwrightCliError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

/// Locate the `clipwright` binary using the discovery order above.
pub fn find_binary() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("CLIPWRIGHT_BIN") {
        let p = PathBuf::from(&explicit);
        if p.exists() {
            return Some(p);
        }
    }
    if let Some(p) = which_on_path("clipwright") {
        return Some(p);
    }
    // Dev fallback: the project's own .venv when the app is run from `target/`.
    if let Ok(exe) = std::env::current_exe() {
        let candidates = [
            exe.ancestors().nth(4).map(|d| d.join(".venv/bin/clipwright")),
            exe.ancestors().nth(5).map(|d| d.join(".venv/bin/clipwright")),
        ];
        for c in candidates.into_iter().flatten() {
            if c.exists() {
                return Some(c);
            }
        }
    }
    if let Some(home) = directories::UserDirs::new() {
        let p = home.home_dir().join(".local/bin/clipwright");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Run `clipwright <args>` and return its captured output.
///
/// On non-zero exit, returns the last ~1.5 kB of stderr as the error so
/// the user sees the real failure rather than a generic message.
pub fn run(args: &[&str]) -> Result<Output, ClipwrightCliError> {
    let bin = find_binary().ok_or(ClipwrightCliError::NotFound)?;
    let mut cmd = Command::new(&bin);
    cmd.args(args);
    // Force unbuffered output so future streaming use cases work.
    cmd.env("PYTHONUNBUFFERED", "1");
    let out = cmd.output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.chars().rev().take(1500).collect::<String>().chars().rev().collect();
        return Err(ClipwrightCliError::NonZero {
            code: out.status.code().unwrap_or(-1),
            stderr_tail: tail.trim().to_string(),
        });
    }
    Ok(out)
}

/// Like `run`, but does NOT error on non-zero exit and lets the caller
/// supply the cwd. The chat rail's Play-button feature uses this to
/// run user-clicked `clipwright …` commands and surface stdout/stderr
/// inline regardless of the exit code (a failed render still has
/// useful diagnostic output the user wants to see).
pub fn run_with_output(
    args: &[&str],
    cwd: Option<&std::path::Path>,
) -> Result<Output, ClipwrightCliError> {
    let bin = find_binary().ok_or(ClipwrightCliError::NotFound)?;
    let mut cmd = Command::new(&bin);
    cmd.args(args);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    cmd.env("PYTHONUNBUFFERED", "1");
    Ok(cmd.output()?)
}
