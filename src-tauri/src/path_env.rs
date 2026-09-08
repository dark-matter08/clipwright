//! PATH enrichment for GUI processes.
//!
//! On macOS, GUI apps launched from Finder/Spotlight inherit a minimal
//! system PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), missing the directories
//! the user added in `.zshrc`/`.bashrc`/`.zprofile`. That breaks every
//! subprocess discovery in this app — Python `clipwright`, the `claude`
//! CLI, ffmpeg installed via Homebrew or nvm — even when they work fine
//! in the user's Terminal.
//!
//! Fix at app launch:
//!   1. Spawn the user's login shell and capture its PATH.
//!   2. Glob known package-manager locations (Homebrew, nvm, asdf, bun,
//!      pnpm, npm-global) that login shells often miss.
//!   3. Merge all sources into the process PATH for the lifetime of the
//!      app.
//!
//! After `enrich()` runs once, every `std::env::var("PATH")` and every
//! `Command::new("clipwright")` / `Command::new("claude")` lookup gets
//! the user's actual environment.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;

/// Merge the user's login-shell PATH plus a set of known fallback
/// directories into the process PATH. Safe to call once at startup.
pub fn enrich() {
    let mut seen: HashSet<String> = HashSet::new();
    let mut merged: Vec<String> = Vec::new();

    // Existing process PATH first — preserves system defaults.
    if let Ok(current) = std::env::var("PATH") {
        for p in current.split(':') {
            push_unique(p, &mut seen, &mut merged);
        }
    }

    // Login shell PATH — picks up `.zprofile` / `.bash_profile` and on
    // macOS Terminal's default config also `.zshrc` (sourced from login
    // shells). Times out fast: a misbehaving shell can't hang startup.
    if let Some(shell_path) = login_shell_path() {
        for p in shell_path.split(':') {
            push_unique(p, &mut seen, &mut merged);
        }
    }

    // Known package-manager locations, present or not. Cheap to add to
    // PATH even if they don't exist — std::env::set_var doesn't validate.
    for p in fallback_locations() {
        if let Some(s) = p.to_str() {
            push_unique(s, &mut seen, &mut merged);
        }
    }

    std::env::set_var("PATH", merged.join(":"));
}

fn push_unique(p: &str, seen: &mut HashSet<String>, out: &mut Vec<String>) {
    let trimmed = p.trim();
    if trimmed.is_empty() {
        return;
    }
    if seen.insert(trimmed.to_string()) {
        out.push(trimmed.to_string());
    }
}

/// Spawn the user's login shell and capture its PATH. Returns None on
/// any failure — the caller must not depend on this succeeding.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(&shell)
        .args(["-l", "-c", "echo $PATH"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Directories that commonly host CLI tools but aren't always reachable
/// from a login shell's PATH (especially nvm on macOS, which usually
/// sets up in `.zshrc` rather than `.zprofile`).
fn fallback_locations() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = directories::UserDirs::new() {
        let h = home.home_dir().to_path_buf();
        out.push(h.join(".local/bin"));
        out.push(h.join(".bun/bin"));
        out.push(h.join(".cargo/bin"));
        out.push(h.join(".claude/local"));
        out.push(h.join(".claude/local/bin"));
        // nvm: the active node version isn't fixed, glob for the newest.
        let nvm = h.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm) {
            let mut versions: Vec<(String, PathBuf)> = entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    Some((name, e.path().join("bin")))
                })
                .filter(|(_, p)| p.exists())
                .collect();
            // newest first: "v20.x.x" > "v18.x.x" lexicographically
            versions.sort_by(|a, b| b.0.cmp(&a.0));
            for (_, p) in versions {
                out.push(p);
            }
        }
    }
    out
}
