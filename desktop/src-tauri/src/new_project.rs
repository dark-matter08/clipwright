//! New-project Tauri commands — SRS §6.1 (Upload + Record modes).
//!
//! Both commands:
//!   1. Create the target project directory (if it does not exist).
//!   2. Invoke the appropriate `clipwright` subcommand.
//!   3. Reload the freshly-written `project.json` + `timeline.json` and
//!      return them to the frontend — same shape as `open_project`, so
//!      the UI can land in the Workspace identically for both modes.

use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::clipwright::{self, ClipwrightCliError};
use crate::project::{self, ProjectError, ProjectState};

#[derive(Debug, Error)]
pub enum NewProjectError {
    #[error("target directory is not empty: {0}")]
    NotEmpty(PathBuf),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("clipwright cli: {0}")]
    Cli(#[from] ClipwrightCliError),
    #[error("loading the new project failed: {0}")]
    Load(#[from] ProjectError),
    #[error("{0}")]
    Bad(String),
}

impl serde::Serialize for NewProjectError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

fn require_empty_dir(dir: &Path) -> Result<(), NewProjectError> {
    if dir.exists() {
        let mut it = std::fs::read_dir(dir)?;
        if it.next().is_some() {
            return Err(NewProjectError::NotEmpty(dir.to_path_buf()));
        }
    }
    Ok(())
}

/// Upload mode (F-UPL-1/2): import an existing video into a fresh project.
///
/// Calls `clipwright import <video> --into <project_dir> --title ... --aspect ...`.
/// Auto-segmentation is enabled by default; scene detection can be toggled
/// (it slows long imports and isn't useful for static screen recordings).
#[tauri::command]
pub async fn import_video_cmd(
    app: tauri::AppHandle,
    video_path: String,
    project_dir: String,
    title: String,
    aspect: String,
    auto_segment: bool,
    scene_detection: bool,
) -> Result<ProjectState, NewProjectError> {
    let dir = PathBuf::from(&project_dir);
    require_empty_dir(&dir)?;
    std::fs::create_dir_all(&dir)?;

    let mut args: Vec<&str> = vec!["import", &video_path, "--into", &project_dir];
    if !title.is_empty() {
        args.extend(["--title", &title]);
    }
    args.extend(["--aspect", &aspect]);
    args.push(if auto_segment { "--auto-segment" } else { "--no-auto-segment" });
    args.push(if scene_detection { "--scene-detection" } else { "--no-scene-detection" });

    clipwright::run(&args)?;
    project::open_project(app, project_dir, Some("main".into())).await.map_err(Into::into)
}

/// Record mode (F-REC-1/2/4/5): scaffold a starter `browse-plan.json`,
/// then drive Playwright via `clipwright record-project`.
///
/// The starter plan has one chapter ("intro") with one `navigate` action.
/// Users can extend the plan in the desktop's plan editor (P1.x) or with
/// their text editor; the Claude-authored draft (F-REC-2) lands in P1.9.
#[tauri::command]
pub async fn record_project_cmd(
    app: tauri::AppHandle,
    project_dir: String,
    title: String,
    aspect: String,
    base_url: String,
    mobile: bool,
) -> Result<ProjectState, NewProjectError> {
    if base_url.trim().is_empty() {
        return Err(NewProjectError::Bad("base_url is required for Record mode".into()));
    }
    let dir = PathBuf::from(&project_dir);
    require_empty_dir(&dir)?;
    std::fs::create_dir_all(&dir)?;

    // Write a starter browse-plan.json so `clipwright record-project` has
    // something to drive. Users edit this file (or regenerate it via the
    // Claude-authored draft when P1.9 lands) before re-recording.
    let plan = serde_json::json!({
        "viewport": {
            "width":   if mobile { 540 } else { 1280 },
            "height":  if mobile { 960 } else { 800 },
            "mobile":  mobile
        },
        "base_url": base_url,
        "actions": [{
            "type": "navigate",
            "label": "Open the app",
            "chapter": "intro",
            "fields": { "url": "/" },
            "wait": 3.0
        }]
    });
    std::fs::write(
        dir.join("browse-plan.json"),
        serde_json::to_vec_pretty(&plan).expect("static JSON"),
    )?;

    let mut args: Vec<&str> = vec!["record-project", &project_dir];
    if !title.is_empty() {
        args.extend(["--title", &title]);
    }
    args.extend(["--aspect", &aspect]);
    args.push(if mobile { "--mobile" } else { "--desktop" });

    clipwright::run(&args)?;
    project::open_project(app, project_dir, Some("main".into())).await.map_err(Into::into)
}

/// Check whether the `clipwright` binary is reachable. Used by the New
/// Project dialog to fail-fast with a clear message instead of a vague
/// subprocess error after the user has filled the form.
#[tauri::command]
pub async fn clipwright_doctor() -> ClipwrightDoctorReport {
    let bin = clipwright::find_binary();
    let path = bin.as_ref().map(|p| p.display().to_string());
    let installed = bin.is_some();
    ClipwrightDoctorReport { installed, path }
}

/// Append an additional video to an open project (SRS F-UPL-3 multi-source).
///
/// Wraps `clipwright import <video> --into <project_dir> --add`. New
/// segments are appended to `timeline.json`; project.json is unchanged;
/// the source filename is uniquified from the video stem.
#[tauri::command]
pub async fn add_source_cmd(
    app: tauri::AppHandle,
    video_path: String,
    project_dir: String,
    video_id: String,
    video_title: String,
    auto_segment: bool,
    scene_detection: bool,
) -> Result<ProjectState, NewProjectError> {
    // The project must already exist; the library would accept an empty
    // dir but the UX intent of "Add source" is "to an open project".
    if !PathBuf::from(&project_dir).join("project.json").exists() {
        return Err(NewProjectError::Bad(format!(
            "no project at {project_dir} — open one first",
        )));
    }

    let mut args: Vec<&str> = vec![
        "import", &video_path,
        "--into", &project_dir,
        "--add",
        "--video", &video_id,
    ];
    if !video_title.is_empty() {
        args.extend(["--video-title", &video_title]);
    }
    args.push(if auto_segment { "--auto-segment" } else { "--no-auto-segment" });
    args.push(if scene_detection { "--scene-detection" } else { "--no-scene-detection" });

    clipwright::run(&args)?;
    project::open_project(app, project_dir, Some(video_id)).await.map_err(Into::into)
}

#[derive(Debug, serde::Serialize)]
pub struct ClipwrightDoctorReport {
    pub installed: bool,
    pub path: Option<String>,
}
