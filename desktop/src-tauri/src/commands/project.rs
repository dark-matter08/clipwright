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
pub async fn init_project(
    parent_dir: String,
    name: String,
    url: String,
    aspect: String,
    description: String,
) -> Result<String, String> {
    let target = Path::new(&parent_dir).join(&name);
    if target.exists() && target.join(".clipwright.json").exists() {
        return Err(format!("{} already contains a Clipwright project", target.display()));
    }
    let out = tokio::process::Command::new("clipwright")
        .arg("init")
        .arg(&target)
        .arg("--url")
        .arg(&url)
        .arg("--aspect")
        .arg(&aspect)
        .output()
        .await
        .map_err(|e| format!("spawn clipwright init: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }

    let trimmed = description.trim();
    if !trimmed.is_empty() {
        let cfg_path = target.join(".clipwright.json");
        if let Ok(raw) = std::fs::read_to_string(&cfg_path) {
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "description".into(),
                        serde_json::Value::String(trimmed.to_string()),
                    );
                }
                if let Ok(pretty) = serde_json::to_string_pretty(&v) {
                    let _ = std::fs::write(&cfg_path, pretty);
                }
            }
        }
        let _ = std::fs::write(target.join("project.md"), format!("# {name}\n\n{trimmed}\n"));
    }

    Ok(target.to_string_lossy().to_string())
}

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub rel: String,
    pub size: u64,
    pub is_dir: bool,
}

#[tauri::command]
pub fn list_project_files(path: String) -> Result<Vec<FileEntry>, String> {
    let root = Path::new(&path);
    let mut out: Vec<FileEntry> = Vec::new();
    fn walk(dir: &Path, root: &Path, out: &mut Vec<FileEntry>, depth: u32) {
        if depth > 3 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != ".clipwright.json" && name != ".env" {
                continue;
            }
            if name == "node_modules" || name == "target" {
                continue;
            }
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().to_string();
            let is_dir = p.is_dir();
            let size = if is_dir {
                0
            } else {
                std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
            };
            out.push(FileEntry { name, rel, size, is_dir });
            if is_dir {
                walk(&p, root, out, depth + 1);
            }
        }
    }
    walk(root, root, &mut out, 0);
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err(format!("file too large ({} bytes)", meta.len()));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    // Reject binaries by looking for null bytes in the first 4KB.
    let head = &bytes[..bytes.len().min(4096)];
    if head.contains(&0u8) {
        return Err("binary file".into());
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
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
