//! Per-segment Tauri commands. Each shells out to `clipwright <subcommand>`
//! and reloads the project so the frontend always sees fresh state.

use thiserror::Error;

use crate::clipwright::{self, ClipwrightCliError};
use crate::project::{self, ProjectError, ProjectState};
use crate::validate;

#[derive(Debug, Error)]
pub enum SegmentOpError {
    #[error("clipwright cli: {0}")]
    Cli(#[from] ClipwrightCliError),
    #[error("reloading project failed: {0}")]
    Load(#[from] ProjectError),
    #[error("{0}")]
    Bad(String),
}

impl serde::Serialize for SegmentOpError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

/// `clipwright tts-segment <seg_id> [--force]`
#[tauri::command]
pub async fn tts_segment_cmd(
    app: tauri::AppHandle,
    project_dir: String,
    seg_id: String,
    force: bool,
) -> Result<ProjectState, SegmentOpError> {
    validate::seg_id(&seg_id).map_err(SegmentOpError::Bad)?;
    let mut args: Vec<&str> = vec!["tts-segment", &seg_id, "--project", &project_dir];
    if force {
        args.push("--force");
    }
    clipwright::run(&args)?;
    project::open_project(app, project_dir).await.map_err(Into::into)
}

/// `clipwright caption-segment <seg_id> [--force]`
#[tauri::command]
pub async fn caption_segment_cmd(
    app: tauri::AppHandle,
    project_dir: String,
    seg_id: String,
    force: bool,
) -> Result<ProjectState, SegmentOpError> {
    validate::seg_id(&seg_id).map_err(SegmentOpError::Bad)?;
    let mut args: Vec<&str> = vec!["caption-segment", &seg_id, "--project", &project_dir];
    if force {
        args.push("--force");
    }
    clipwright::run(&args)?;
    project::open_project(app, project_dir).await.map_err(Into::into)
}

/// `clipwright render-segment <seg_id> [--force]`
#[tauri::command]
pub async fn render_segment_cmd(
    app: tauri::AppHandle,
    project_dir: String,
    seg_id: String,
    force: bool,
) -> Result<ProjectState, SegmentOpError> {
    validate::seg_id(&seg_id).map_err(SegmentOpError::Bad)?;
    let mut args: Vec<&str> = vec!["render-segment", &seg_id, "--project", &project_dir];
    if force {
        args.push("--force");
    }
    clipwright::run(&args)?;
    project::open_project(app, project_dir).await.map_err(Into::into)
}

#[derive(Debug, serde::Serialize)]
pub struct RenderFinalReport {
    pub project: ProjectState,
    pub final_path: String,
}

/// `clipwright render-final [--force]`
#[tauri::command]
pub async fn render_final_cmd(
    app: tauri::AppHandle,
    project_dir: String,
    force: bool,
) -> Result<RenderFinalReport, SegmentOpError> {
    let mut args: Vec<&str> = vec!["render-final", "--project", &project_dir];
    if force {
        args.push("--force");
    }
    clipwright::run(&args)?;
    let project = project::open_project(app, project_dir.clone()).await?;
    let final_path = std::path::PathBuf::from(&project_dir)
        .join("out/final.mp4")
        .display()
        .to_string();
    Ok(RenderFinalReport { project, final_path })
}
