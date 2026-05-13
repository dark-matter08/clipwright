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

fn reload(
    app: tauri::AppHandle,
    project_dir: String,
    video_id: String,
) -> impl std::future::Future<Output = Result<ProjectState, SegmentOpError>> {
    async move {
        project::open_project(app, project_dir, Some(video_id))
            .await
            .map_err(Into::into)
    }
}

/// `clipwright tts-segment <seg_id> --video <id> [--force]`
#[tauri::command]
pub async fn tts_segment_cmd(
    app: tauri::AppHandle,
    project_dir: String,
    video_id: String,
    seg_id: String,
    force: bool,
) -> Result<ProjectState, SegmentOpError> {
    validate::seg_id(&seg_id).map_err(SegmentOpError::Bad)?;
    let mut args: Vec<&str> = vec!["tts-segment", &seg_id, "--project", &project_dir, "--video", &video_id];
    if force {
        args.push("--force");
    }
    clipwright::run(&args)?;
    reload(app, project_dir, video_id).await
}

/// `clipwright caption-segment <seg_id> --video <id> [--force]`
#[tauri::command]
pub async fn caption_segment_cmd(
    app: tauri::AppHandle,
    project_dir: String,
    video_id: String,
    seg_id: String,
    force: bool,
) -> Result<ProjectState, SegmentOpError> {
    validate::seg_id(&seg_id).map_err(SegmentOpError::Bad)?;
    let mut args: Vec<&str> = vec!["caption-segment", &seg_id, "--project", &project_dir, "--video", &video_id];
    if force {
        args.push("--force");
    }
    clipwright::run(&args)?;
    reload(app, project_dir, video_id).await
}

/// `clipwright render-segment <seg_id> --video <id> [--force]`
#[tauri::command]
pub async fn render_segment_cmd(
    app: tauri::AppHandle,
    project_dir: String,
    video_id: String,
    seg_id: String,
    force: bool,
) -> Result<ProjectState, SegmentOpError> {
    validate::seg_id(&seg_id).map_err(SegmentOpError::Bad)?;
    let mut args: Vec<&str> = vec!["render-segment", &seg_id, "--project", &project_dir, "--video", &video_id];
    if force {
        args.push("--force");
    }
    clipwright::run(&args)?;
    reload(app, project_dir, video_id).await
}

#[derive(Debug, serde::Serialize)]
pub struct RenderFinalReport {
    pub project: ProjectState,
    pub final_path: String,
}

/// `clipwright render-final --video <id> [--force]`
#[tauri::command]
pub async fn render_final_cmd(
    app: tauri::AppHandle,
    project_dir: String,
    video_id: String,
    force: bool,
) -> Result<RenderFinalReport, SegmentOpError> {
    let mut args: Vec<&str> = vec!["render-final", "--project", &project_dir, "--video", &video_id];
    if force {
        args.push("--force");
    }
    clipwright::run(&args)?;
    let project = reload(app, project_dir.clone(), video_id.clone()).await?;
    let final_path = std::path::PathBuf::from(&project_dir)
        .join("out").join("final").join(format!("{video_id}.mp4"))
        .display()
        .to_string();
    Ok(RenderFinalReport { project, final_path })
}
