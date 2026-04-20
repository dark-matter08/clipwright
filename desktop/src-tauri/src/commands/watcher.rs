use crate::state::AppState;
use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn start_watcher(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let out_dir = Path::new(&path).join("out");
    if !out_dir.exists() {
        std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    }

    let app_clone = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        move |res: notify_debouncer_mini::DebounceEventResult| {
            if let Ok(events) = res {
                for ev in events {
                    let p = ev.path.to_string_lossy().to_string();
                    let _ = app_clone.emit("artifact:changed", p);
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&out_dir, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    state.watchers.lock().unwrap().insert(path, debouncer);
    Ok(())
}

#[tauri::command]
pub fn stop_watcher(path: String, state: State<'_, AppState>) -> Result<(), String> {
    state.watchers.lock().unwrap().remove(&path);
    Ok(())
}
