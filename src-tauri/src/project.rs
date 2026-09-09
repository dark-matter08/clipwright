//! Read a v2 project from disk and return its JSON shape to the frontend.
//!
//! v2 introduces multi-video projects: `project.json` is a collection
//! manifest and each editable deliverable lives at `videos/<id>.json`.
//! Auto-migration from v1 is delegated to the Python side — `open_project`
//! shells out to `clipwright video list` after a successful read so the
//! frontend gets a clean post-migration view either way. (The Python
//! `load_project` auto-migrates on first read.)
//!
//! The Rust side stays schema-agnostic: it returns parsed `serde_json::Value`
//! so future schema additions don't require a rebuild for the desktop to
//! surface them.

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
    #[error("video '{video_id}' not found in {dir}")]
    VideoMissing { dir: PathBuf, video_id: String },
    #[error("invalid JSON in {file}: {source}")]
    BadJson {
        file: String,
        source: serde_json::Error,
    },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("clipwright cli: {0}")]
    Cli(#[from] crate::clipwright::ClipwrightCliError),
}

impl serde::Serialize for ProjectError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize)]
pub struct VideoMeta {
    pub video_id: String,
    pub title: String,
    pub n_segments: usize,
    /// Manifest mtime as a unix timestamp. Videos carry no `created_at`
    /// of their own, and adding one wouldn't help the projects that
    /// already exist — the file's own timestamp is the only creation
    /// signal available for a 24-video backlog.
    pub created_at: u64,
    /// Per-video persona override, if any. The project-level persona is
    /// on `project.persona_id`; the sidebar falls back to it when this
    /// is empty.
    pub persona_id: String,
    /// Whether `out/final/<id>.mp4` exists — the cheap half of build
    /// status. A stat() per video, versus running the full doctor.
    pub has_final: bool,
}

#[derive(Debug, Serialize)]
pub struct ProjectState {
    pub project_dir: PathBuf,
    pub project: Value,
    /// Catalogue of every video in the project — populated for the
    /// Videos sidebar without reading every manifest's segments.
    pub videos: Vec<VideoMeta>,
    /// Which video the frontend should load into the editor by default.
    /// First successful video id encountered (`main` if present).
    pub current_video_id: Option<String>,
    /// The currently-loaded video manifest.
    pub video: Option<Value>,
}

/// Read `<project_dir>/project.json`, enumerate `videos/*.json`, and load
/// the requested (or default) video. On a v1 project, auto-migration runs
/// transparently because we delegate the initial read to the Python CLI
/// (`clipwright video list` runs `load_project` which migrates).
#[tauri::command]
pub async fn open_project(
    app: tauri::AppHandle,
    project_dir: String,
    video_id: Option<String>,
) -> Result<ProjectState, ProjectError> {
    let dir = PathBuf::from(&project_dir);
    if !dir.exists() {
        return Err(ProjectError::NotFound(dir));
    }

    let project_path = dir.join("project.json");
    if !project_path.exists() {
        return Err(ProjectError::NoProjectJson(dir));
    }

    // Trigger Python-side auto-migration if needed (idempotent on v2).
    // `video list` is the lightest read that loads + migrates if v1.
    let _ = crate::clipwright::run(&["video", "list", "--project", &project_dir]);

    let project = read_json(&project_path, "project.json")?;
    let videos = enumerate_videos(&dir)?;
    let pick_id = video_id.or_else(|| pick_default_video(&videos));
    let video = match pick_id.as_deref() {
        Some(id) => Some(read_json(
            &dir.join("videos").join(format!("{id}.json")),
            &format!("videos/{id}.json"),
        )?),
        None => None,
    };

    let title = project
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let _ = recents::record_open(&app, &dir, &title);

    Ok(ProjectState {
        project_dir: dir,
        project,
        videos,
        current_video_id: pick_id,
        video,
    })
}

/// Probe whether `<project_dir>/out/final/<video_id>.mp4` is on disk.
///
/// The frontend uses this to decide whether to enable Final-mode UI:
/// the Preview's `final` toggle is always present, but the Timeline
/// hides its tracks (and shows a "render first" placeholder) when
/// final-mode is active without a backing file. Re-run after a
/// successful `render_final_cmd` to flip the flag.
#[tauri::command]
pub async fn final_exists_cmd(
    project_dir: String,
    video_id: String,
) -> Result<bool, ProjectError> {
    let path = PathBuf::from(&project_dir)
        .join("out")
        .join("final")
        .join(format!("{video_id}.mp4"));
    Ok(path.exists())
}

fn pick_default_video(videos: &[VideoMeta]) -> Option<String> {
    videos.iter().find(|v| v.video_id == "main").map(|v| v.video_id.clone())
        .or_else(|| videos.first().map(|v| v.video_id.clone()))
}

fn enumerate_videos(dir: &std::path::Path) -> Result<Vec<VideoMeta>, ProjectError> {
    let vdir = dir.join("videos");
    if !vdir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<VideoMeta> = Vec::new();
    for entry in std::fs::read_dir(&vdir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let payload = match read_json(&path, &format!("videos/{}", path.file_name().unwrap().to_string_lossy())) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let video_id = payload
            .get("video_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string());
        if video_id.is_empty() {
            continue;
        }
        let title = payload
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or(&video_id)
            .to_string();
        let n_segments = payload
            .get("segments")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let created_at = entry
            .metadata()
            .ok()
            .and_then(|m| m.created().or_else(|_| m.modified()).ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let persona_id = payload
            .get("recap_overrides")
            .and_then(|v| v.get("persona_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let has_final = dir
            .join("out")
            .join("final")
            .join(format!("{video_id}.mp4"))
            .exists();
        out.push(VideoMeta {
            video_id,
            title,
            n_segments,
            created_at,
            persona_id,
            has_final,
        });
    }
    // main first, then alphabetical — matches the Python `list_videos` ordering.
    out.sort_by(|a, b| {
        let am = a.video_id == "main";
        let bm = b.video_id == "main";
        match (am, bm) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.video_id.cmp(&b.video_id),
        }
    });
    Ok(out)
}

fn read_json(path: &std::path::Path, file_label: &str) -> Result<Value, ProjectError> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|e| ProjectError::BadJson {
        file: file_label.into(),
        source: e,
    })
}

/// Slim DTO mirroring `RecentProject` in the TS layer.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RecentEntry {
    pub project_dir: PathBuf,
    pub title: String,
    pub last_opened_at: String,
}

/// Write a video manifest atomically. Replaces the old `save_timeline`.
#[tauri::command]
pub async fn save_video(
    project_dir: String,
    video_id: String,
    video: Value,
) -> Result<(), ProjectError> {
    crate::validate::seg_id(&video_id) // reuse the same `[a-z0-9_-]` posture
        .ok(); // video_id has a wider charset than seg_id; we don't enforce here.
    let dir = PathBuf::from(&project_dir);
    if !dir.exists() {
        return Err(ProjectError::NotFound(dir));
    }
    let vdir = dir.join("videos");
    std::fs::create_dir_all(&vdir)?;
    let path = vdir.join(format!("{video_id}.json"));
    let bytes = serde_json::to_vec_pretty(&video).map_err(|e| ProjectError::BadJson {
        file: format!("videos/{video_id}.json"),
        source: e,
    })?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// List the videos in a project without loading any segment data. Cheap
/// — used by the Videos sidebar when switching projects.
#[tauri::command]
pub async fn list_videos_cmd(project_dir: String) -> Result<Vec<VideoMeta>, ProjectError> {
    let dir = PathBuf::from(&project_dir);
    if !dir.exists() {
        return Err(ProjectError::NotFound(dir));
    }
    enumerate_videos(&dir)
}

/// Load a single video manifest. Used when the user switches videos in
/// the Workspace sidebar.
#[tauri::command]
pub async fn load_video_cmd(
    project_dir: String,
    video_id: String,
) -> Result<Value, ProjectError> {
    let dir = PathBuf::from(&project_dir);
    let path = dir.join("videos").join(format!("{video_id}.json"));
    if !path.exists() {
        return Err(ProjectError::VideoMissing { dir, video_id });
    }
    read_json(&path, &format!("videos/{video_id}.json"))
}

/// Create a new empty video in the project. Returns its manifest so the
/// frontend can land on it immediately.
#[tauri::command]
pub async fn create_video_cmd(
    project_dir: String,
    video_id: String,
    title: String,
    // Pre-selected Claude Code skills to invoke by default whenever
    // the user chats in the context of this video. Stored under
    // `recap_overrides.default_skills` so the agent prompt (which
    // already reads `recap_overrides`) can surface them in Claude's
    // system prompt without a schema migration. Empty list / omitted
    // → no skills pre-selected (the user can still type `/<skill>`
    // in the rail at any time).
    default_skills: Option<Vec<String>>,
    // Whether this video uses the project's persona. `None` / `Some(true)`
    // writes NOTHING — absence is what the agent prompt reads as
    // "enabled", so the default stays on and every video created before
    // this flag existed keeps its persona. Only an explicit opt-out is
    // persisted, as `recap_overrides.persona_enabled = false`.
    persona_enabled: Option<bool>,
) -> Result<Value, ProjectError> {
    let dir = PathBuf::from(&project_dir);
    if !dir.exists() {
        return Err(ProjectError::NotFound(dir));
    }
    let vdir = dir.join("videos");
    std::fs::create_dir_all(&vdir)?;
    let path = vdir.join(format!("{video_id}.json"));
    if path.exists() {
        return Err(ProjectError::VideoMissing {
            dir: dir.clone(),
            video_id: format!("{video_id} (already exists — pick another id)"),
        });
    }
    let skills: Vec<String> = default_skills
        .unwrap_or_default()
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect();
    let mut recap_overrides = serde_json::Map::new();
    if !skills.is_empty() {
        recap_overrides.insert("default_skills".into(), serde_json::json!(skills));
    }
    if persona_enabled == Some(false) {
        recap_overrides.insert("persona_enabled".into(), serde_json::json!(false));
    }
    let recap_overrides = Value::Object(recap_overrides);
    let payload = serde_json::json!({
        "schema_version": 2,
        "video_id": video_id,
        "title": if title.is_empty() { video_id.clone() } else { title },
        "chat_session_id": "",
        "segments": [],
        "recap_overrides": recap_overrides,
    });
    let bytes = serde_json::to_vec_pretty(&payload).expect("static JSON");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(payload)
}

/// Delete a video and every per-video artifact tree it owns.
///
/// Shells out to `clipwright video delete <id> --yes` so the Python
/// side handles the artifact-tree walk (TTS audio, captions, rendered
/// segments, chat logs). After it returns we re-open the project and
/// hand back the fresh `ProjectState` so the frontend doesn't have to
/// chase a follow-up `open_project` call. The caller picks the new
/// `current_video_id`: if the deleted video was active we fall back to
/// the first surviving id.
#[tauri::command]
pub async fn delete_video_cmd(
    app: tauri::AppHandle,
    project_dir: String,
    video_id: String,
) -> Result<ProjectState, ProjectError> {
    let dir = PathBuf::from(&project_dir);
    if !dir.exists() {
        return Err(ProjectError::NotFound(dir));
    }
    // Python CLI does the actual deletion + safety check (refuses to
    // drop the last video). Surfaces errors as ProjectError::Cli.
    crate::clipwright::run(&[
        "video", "delete", &video_id,
        "--project", &project_dir,
        "--yes",
    ])?;

    // Refresh state. The deleted id obviously can't be the
    // current_video_id — pick the first survivor so the workspace
    // lands on something.
    let videos = enumerate_videos(&dir)?;
    let pick_id = pick_default_video(&videos);
    let video = match pick_id.as_deref() {
        Some(id) => Some(read_json(
            &dir.join("videos").join(format!("{id}.json")),
            &format!("videos/{id}.json"),
        )?),
        None => None,
    };
    let project = read_json(&dir.join("project.json"), "project.json")?;
    let title = project
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let _ = recents::record_open(&app, &dir, &title);
    Ok(ProjectState {
        project_dir: dir,
        project,
        videos,
        current_video_id: pick_id,
        video,
    })
}
