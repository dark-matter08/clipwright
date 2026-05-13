//! Source-file enumeration for the inspector's per-segment source picker.
//!
//! Returns the contents of `<project>/sources/` so the UI can offer the
//! user a dropdown of every video they've imported / recorded into the
//! project. The picker writes the chosen source path back to the segment
//! via the existing `save_timeline` Tauri command — this module is purely
//! a read API.

use std::path::PathBuf;

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SourcesError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for SourcesError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize)]
pub struct SourceEntry {
    /// Project-relative path, e.g. "sources/main.mp4". Matches the shape
    /// stored in `timeline.json#segments[].source`.
    pub path: String,
    /// On-disk byte size — surfaced in the UI as a tiebreaker when several
    /// sources have similar names.
    pub size_bytes: u64,
}

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "webm", "m4v"];

/// List every video file in `<project_dir>/sources/` (non-recursive).
/// Sorted alphabetically with `main.<ext>` first so the canonical first
/// import lands at the top of the picker.
#[tauri::command]
pub async fn list_sources(project_dir: String) -> Result<Vec<SourceEntry>, SourcesError> {
    let dir = PathBuf::from(&project_dir).join("sources");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<SourceEntry> = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !VIDEO_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if filename.is_empty() {
            continue;
        }
        out.push(SourceEntry {
            path: format!("sources/{filename}"),
            size_bytes,
        });
    }
    // Sort: `main.<ext>` first, then alphabetical.
    out.sort_by(|a, b| {
        let a_is_main = a.path.starts_with("sources/main.");
        let b_is_main = b.path.starts_with("sources/main.");
        match (a_is_main, b_is_main) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.path.cmp(&b.path),
        }
    });
    Ok(out)
}
