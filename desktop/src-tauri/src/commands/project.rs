use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize, Clone)]
pub struct ProjectState {
    pub path: String,
    pub config: serde_json::Value,
    pub script: Option<serde_json::Value>,
    pub segments: Option<serde_json::Value>,
    pub has_moments: bool,
    pub has_video: bool,
    pub has_final: bool,
}

#[tauri::command]
pub async fn pick_project(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let result: Option<PathBuf> = path.and_then(|fp| fp.into_path().ok());
        let _ = tx.send(result);
    });
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn load_project(path: String) -> Result<ProjectState, String> {
    let root = Path::new(&path);
    let cfg_path = root.join(".clipwright.json");
    if !cfg_path.exists() {
        return Err(format!("{} is not a Clipwright project (no .clipwright.json)", path));
    }
    let config: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let script = read_json(&root.join("script.json"));
    let segments = read_json(&root.join("out/segments.json"));

    Ok(ProjectState {
        path: path.clone(),
        config,
        script,
        segments,
        has_moments: root.join("out/moments.json").exists(),
        has_video: root.join("out/video.mp4").exists(),
        has_final: root.join("out/final.mp4").exists(),
    })
}

fn read_json(p: &Path) -> Option<serde_json::Value> {
    if !p.exists() {
        return None;
    }
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

#[tauri::command]
pub fn save_script_clip(path: String, clip_id: String, text: String) -> Result<(), String> {
    let script_path = Path::new(&path).join("script.json");
    let raw = std::fs::read_to_string(&script_path).map_err(|e| e.to_string())?;
    let mut v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if let Some(clips) = v.get_mut("clips").and_then(|c| c.as_array_mut()) {
        for c in clips.iter_mut() {
            if c.get("id").and_then(|x| x.as_str()) == Some(&clip_id) {
                c["text"] = serde_json::Value::String(text);
                break;
            }
        }
    }
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    std::fs::write(&script_path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}
