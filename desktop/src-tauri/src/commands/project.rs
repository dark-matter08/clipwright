use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

fn projects_db_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("clipwright-desktop").join("projects.json")
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_projects_db() -> serde_json::Value {
    let p = projects_db_path();
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_projects_db(v: &serde_json::Value) {
    let p = projects_db_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(pretty) = serde_json::to_string_pretty(v) {
        let _ = std::fs::write(&p, pretty);
    }
}

fn remember_project(path: &str, name: Option<&str>) {
    let mut db = read_projects_db();
    if let Some(obj) = db.as_object_mut() {
        let existing = obj.get(path).cloned();
        let name = name
            .map(String::from)
            .or_else(|| {
                existing
                    .as_ref()
                    .and_then(|e| e.get("name"))
                    .and_then(|x| x.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| {
                Path::new(path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.to_string())
            });
        obj.insert(
            path.to_string(),
            serde_json::json!({ "name": name, "lastOpened": unix_now() }),
        );
    }
    write_projects_db(&db);
}

/// Auto-migrate a legacy project layout to the multi-video layout.
fn auto_migrate(root: &Path) {
    let legacy = root.join(".clipwright.json").exists()
        && !root.join("videos").exists()
        && (root.join("browse-plan.json").exists()
            || root.join("out").exists()
            || root.join("script.json").exists());
    if !legacy {
        return;
    }
    let _ = std::process::Command::new("clipwright")
        .arg("migrate")
        .arg("--project")
        .arg(root)
        .output();
}

fn video_root(project: &Path, slug: &str) -> PathBuf {
    project.join("videos").join(slug)
}

fn derive_phase(vroot: &Path) -> String {
    let out = vroot.join("out");
    if out.join("final.mp4").exists() {
        return "ready".into();
    }
    if let Ok(script) = std::fs::read_to_string(vroot.join("script.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&script) {
            let has_text = v
                .get("clips")
                .and_then(|c| c.as_array())
                .map(|arr| arr.iter().any(|c| c.get("text").and_then(|t| t.as_str()).is_some_and(|s| !s.is_empty())))
                .unwrap_or(false);
            if has_text {
                return "audio → render".into();
            }
        }
        return "script".into();
    }
    if out.join("segments.json").exists() {
        return "segments".into();
    }
    if out.join("video.mp4").exists() {
        return "plan".into();
    }
    "record".into()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoState {
    pub slug: String,
    pub title: String,
    pub phase: String,
    pub has_video: bool,
    pub has_moments: bool,
    pub has_segments: bool,
    pub has_script: bool,
    pub has_final: bool,
    /// Hydrated only when this video is explicitly loaded via `load_video`.
    pub script: Option<serde_json::Value>,
    pub segments: Option<serde_json::Value>,
}

fn scan_video(project: &Path, slug: &str, hydrate: bool) -> VideoState {
    let vroot = video_root(project, slug);
    let out = vroot.join("out");

    let title = std::fs::read_to_string(vroot.join("video.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_else(|| slug.to_string());

    let script_path = vroot.join("script.json");
    let segments_path = out.join("segments.json");

    VideoState {
        slug: slug.to_string(),
        title,
        phase: derive_phase(&vroot),
        has_video: out.join("video.mp4").exists(),
        has_moments: out.join("moments.json").exists(),
        has_segments: segments_path.exists(),
        has_script: script_path.exists(),
        has_final: out.join("final.mp4").exists(),
        script: if hydrate { read_json(&script_path) } else { None },
        segments: if hydrate { read_json(&segments_path) } else { None },
    }
}

fn list_video_slugs(project: &Path) -> Vec<String> {
    let vroot = project.join("videos");
    let Ok(entries) = std::fs::read_dir(&vroot) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        if !p.join("video.json").exists() && !p.join("browse-plan.json").exists() {
            continue;
        }
        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
            out.push(name.to_string());
        }
    }
    out.sort();
    out
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub path: String,
    pub config: serde_json::Value,
    pub videos: Vec<VideoState>,
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

    auto_migrate(root);

    let config: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let name = config
        .get("name")
        .and_then(|x| x.as_str())
        .map(String::from);
    remember_project(&path, name.as_deref());

    let slugs = list_video_slugs(root);
    let videos: Vec<VideoState> = slugs
        .iter()
        .map(|s| scan_video(root, s, false))
        .collect();

    Ok(ProjectState {
        path: path.clone(),
        config,
        videos,
    })
}

#[tauri::command]
pub fn list_videos(path: String) -> Result<Vec<VideoState>, String> {
    let root = Path::new(&path);
    let slugs = list_video_slugs(root);
    Ok(slugs.iter().map(|s| scan_video(root, s, false)).collect())
}

#[tauri::command]
pub fn load_video(path: String, slug: String) -> Result<VideoState, String> {
    let root = Path::new(&path);
    if !video_root(root, &slug).exists() {
        return Err(format!("video {slug} does not exist"));
    }
    Ok(scan_video(root, &slug, true))
}

#[tauri::command]
pub async fn create_video(
    path: String,
    slug: String,
    title: String,
    from_slug: Option<String>,
) -> Result<VideoState, String> {
    let mut cmd = tokio::process::Command::new("clipwright");
    cmd.arg("video")
        .arg("new")
        .arg(&slug)
        .arg("--project")
        .arg(&path)
        .arg("--title")
        .arg(&title);
    if let Some(src) = from_slug.as_deref() {
        cmd.arg("--from").arg(src);
    }
    let out = cmd.output().await.map_err(|e| format!("spawn: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(scan_video(Path::new(&path), &slug, true))
}

#[tauri::command]
pub async fn delete_video(path: String, slug: String, force: bool) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new("clipwright");
    cmd.arg("video")
        .arg("rm")
        .arg(&slug)
        .arg("--project")
        .arg(&path);
    if force {
        cmd.arg("--force");
    }
    let out = cmd.output().await.map_err(|e| format!("spawn: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn rename_video(path: String, old_slug: String, new_slug: String) -> Result<(), String> {
    let out = tokio::process::Command::new("clipwright")
        .arg("video")
        .arg("rename")
        .arg(&old_slug)
        .arg(&new_slug)
        .arg("--project")
        .arg(&path)
        .output()
        .await
        .map_err(|e| format!("spawn: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnownProject {
    pub path: String,
    pub name: String,
    pub last_opened: u64,
    pub exists: bool,
}

#[tauri::command]
pub fn list_known_projects() -> Result<Vec<KnownProject>, String> {
    let db = read_projects_db();
    let Some(obj) = db.as_object() else {
        return Ok(Vec::new());
    };
    let mut out: Vec<KnownProject> = obj
        .iter()
        .map(|(path, v)| KnownProject {
            path: path.clone(),
            name: v
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or(path)
                .to_string(),
            last_opened: v.get("lastOpened").and_then(|x| x.as_u64()).unwrap_or(0),
            exists: Path::new(path).join(".clipwright.json").exists(),
        })
        .collect();
    out.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    Ok(out)
}

#[tauri::command]
pub fn forget_project(path: String) -> Result<(), String> {
    let mut db = read_projects_db();
    if let Some(obj) = db.as_object_mut() {
        obj.remove(&path);
    }
    write_projects_db(&db);
    Ok(())
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
        if depth > 4 {
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
    let head = &bytes[..bytes.len().min(4096)];
    if head.contains(&0u8) {
        return Err("binary file".into());
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_script_clip(
    path: String,
    video_slug: String,
    clip_id: String,
    text: String,
) -> Result<(), String> {
    let script_path = video_root(Path::new(&path), &video_slug).join("script.json");
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
