//! Read a v1 project from disk and return its JSON shape to the frontend.
//!
//! We deserialize only the fields the UI needs (with serde's
//! `#[serde(flatten)]` to keep unknown fields intact under `extra` where
//! appropriate). Strict schema validation happens on the Python writer
//! side; here we trust the file enough to render it.
//!
//! On a successful read the project is appended to the recents file.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::recents;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("project directory not found: {0}")]
    NotFound(PathBuf),
    #[error("project.json missing in {0}")]
    NoProjectJson(PathBuf),
    #[error("timeline.json missing in {0}")]
    NoTimelineJson(PathBuf),
    #[error("invalid JSON in {file}: {source}")]
    BadJson {
        file: String,
        source: serde_json::Error,
    },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for ProjectError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize)]
pub struct ProjectState {
    pub project_dir: PathBuf,
    pub project: Value,
    pub timeline: Value,
}

/// Read `<project_dir>/project.json` + `<project_dir>/timeline.json`.
///
/// Returns the parsed payloads as untyped `serde_json::Value`. The
/// TypeScript layer (`src/lib/types.ts`) is the source of truth for the
/// UI-facing shape; the Rust side stays schema-agnostic so future schema
/// additions don't require a backend rebuild for the desktop to surface
/// them.
#[tauri::command]
pub async fn open_project(
    app: tauri::AppHandle,
    project_dir: String,
) -> Result<ProjectState, ProjectError> {
    let dir = PathBuf::from(&project_dir);
    if !dir.exists() {
        return Err(ProjectError::NotFound(dir));
    }

    let project_path = dir.join("project.json");
    if !project_path.exists() {
        return Err(ProjectError::NoProjectJson(dir));
    }
    let timeline_path = dir.join("timeline.json");
    if !timeline_path.exists() {
        return Err(ProjectError::NoTimelineJson(dir));
    }

    let project_bytes = std::fs::read(&project_path)?;
    let project: Value = serde_json::from_slice(&project_bytes).map_err(|e| {
        ProjectError::BadJson {
            file: "project.json".into(),
            source: e,
        }
    })?;
    let timeline_bytes = std::fs::read(&timeline_path)?;
    let timeline: Value = serde_json::from_slice(&timeline_bytes).map_err(|e| {
        ProjectError::BadJson {
            file: "timeline.json".into(),
            source: e,
        }
    })?;

    let title = project
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Best-effort: append to recents. Failure here is not fatal.
    let _ = recents::record_open(&app, &dir, &title);

    Ok(ProjectState {
        project_dir: dir,
        project,
        timeline,
    })
}

/// Slim DTO mirroring `RecentProject` in the TS layer.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RecentEntry {
    pub project_dir: PathBuf,
    pub title: String,
    pub last_opened_at: String,
}

/// Write a new `timeline.json` atomically.
///
/// Reuses the tmp + rename invariant from `clipwright.schema.io._write_json_atomic`
/// so a crash mid-write can never leave a partial file (SRS §5.9 / NFR-8).
///
/// We accept the timeline as an untyped `Value` because schema validation
/// already happened on the writer side in TS — and forwards-compat is easier
/// when Rust doesn't pin the shape.
#[tauri::command]
pub async fn save_timeline(
    project_dir: String,
    timeline: Value,
) -> Result<(), ProjectError> {
    let dir = PathBuf::from(&project_dir);
    if !dir.exists() {
        return Err(ProjectError::NotFound(dir));
    }
    let path = dir.join("timeline.json");
    let bytes = serde_json::to_vec_pretty(&timeline).map_err(|e| ProjectError::BadJson {
        file: "timeline.json".into(),
        source: e,
    })?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
