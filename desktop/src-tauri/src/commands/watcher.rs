use crate::state::AppState;
use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ArtifactEvent {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    video_slug: Option<String>,
}

/// Parse a slug out of a path like `<project>/videos/<slug>/...`.
fn slug_from_path(project_root: &Path, changed: &Path) -> Option<String> {
    let rel = changed.strip_prefix(project_root).ok()?;
    let mut comps = rel.components();
    let first = comps.next()?.as_os_str().to_str()?;
    if first != "videos" {
        return None;
    }
    let slug = comps.next()?.as_os_str().to_str()?;
    Some(slug.to_string())
}

#[tauri::command]
pub fn start_watcher(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = PathBuf::from(&path);
    let videos_dir = root.join("videos");
    if !videos_dir.exists() {
        std::fs::create_dir_all(&videos_dir).map_err(|e| e.to_string())?;
    }

    let app_clone = app.clone();
    let root_clone = root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        move |res: notify_debouncer_mini::DebounceEventResult| {
            if let Ok(events) = res {
                for ev in events {
                    let slug = slug_from_path(&root_clone, &ev.path);
                    let _ = app_clone.emit(
                        "artifact:changed",
                        ArtifactEvent {
                            path: ev.path.to_string_lossy().to_string(),
                            video_slug: slug,
                        },
                    );
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&videos_dir, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    state.watchers.lock().unwrap().insert(path, debouncer);
    Ok(())
}

#[tauri::command]
pub fn stop_watcher(path: String, state: State<'_, AppState>) -> Result<(), String> {
    state.watchers.lock().unwrap().remove(&path);
    Ok(())
}
