//! Recents list shown on the Project Hub.
//!
//! Persisted at `~/.clipwright/recents.json` per SRS §5.9 (the only state
//! we keep outside individual project directories). Bounded to the most
//! recent N entries; dedup'd by `project_dir`.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::project::RecentEntry;

const MAX_RECENTS: usize = 30;

#[derive(Debug, thiserror::Error)]
pub enum RecentsError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("could not determine home directory")]
    NoHome,
    #[error("recents file corrupt: {0}")]
    BadJson(#[from] serde_json::Error),
}

impl serde::Serialize for RecentsError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

fn recents_dir() -> Result<PathBuf, RecentsError> {
    let home = directories::UserDirs::new()
        .and_then(|d| Some(d.home_dir().to_path_buf()))
        .ok_or(RecentsError::NoHome)?;
    Ok(home.join(".clipwright"))
}

fn recents_path() -> Result<PathBuf, RecentsError> {
    Ok(recents_dir()?.join("recents.json"))
}

pub fn ensure_recents_file<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = recents_dir()?;
    std::fs::create_dir_all(&dir)?;
    let path = recents_path()?;
    if !path.exists() {
        std::fs::write(&path, b"[]\n")?;
    }
    Ok(())
}

fn read_all() -> Result<Vec<RecentEntry>, RecentsError> {
    let path = recents_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(&path)?;
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    // Tolerate the legacy/garbage shapes by returning empty on parse error
    // instead of poisoning the Hub. The user can delete the file by hand.
    let parsed: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let arr = match parsed.as_array() {
        Some(a) => a.clone(),
        None => return Ok(Vec::new()),
    };
    let mut out = Vec::with_capacity(arr.len());
    for v in arr {
        if let Ok(e) = serde_json::from_value::<RecentEntry>(v) {
            // drop entries whose dir has been deleted on disk
            if e.project_dir.exists() {
                out.push(e);
            }
        }
    }
    Ok(out)
}

fn write_all(entries: &[RecentEntry]) -> Result<(), RecentsError> {
    let path = recents_path()?;
    let bytes = serde_json::to_vec_pretty(entries)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Append (or move to front) and persist.
pub fn record_open<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    project_dir: &Path,
    title: &str,
) -> Result<(), RecentsError> {
    let mut entries = read_all().unwrap_or_default();
    entries.retain(|e| e.project_dir != project_dir);
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    entries.insert(
        0,
        RecentEntry {
            project_dir: project_dir.to_path_buf(),
            title: title.to_string(),
            last_opened_at: now,
        },
    );
    entries.truncate(MAX_RECENTS);
    write_all(&entries)
}

#[tauri::command]
pub async fn list_recents() -> Result<Vec<RecentEntry>, RecentsError> {
    read_all()
}
