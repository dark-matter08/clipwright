//! Read + write `voiceover/script.json`. Editing the script clip text is
//! the highest-volume mutation in the inspector, so we give it its own
//! tiny module with atomic writes.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ScriptError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("voiceover/script.json: invalid JSON: {0}")]
    BadJson(#[from] serde_json::Error),
}

impl Serialize for ScriptError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

fn script_path(project_dir: &str) -> PathBuf {
    PathBuf::from(project_dir).join("voiceover/script.json")
}

/// Read the full `voiceover/script.json` (or an empty skeleton if missing).
#[tauri::command]
pub async fn load_script(project_dir: String) -> Result<Value, ScriptError> {
    let path = script_path(&project_dir);
    if !path.exists() {
        return Ok(json!({ "schema_version": 1, "clips": [] }));
    }
    let bytes = std::fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Upsert a clip by id. If the clip doesn't exist, append it (binding it
/// to `segment_id`). If it does, merge the patch fields onto it.
///
/// The patch shape mirrors `voiceover/script.json#clips[]`:
///   { "text"?: str, "target_seconds"?: float,
///     "voice"?: { "provider"?: str, "voice_id"?: str }, "hint"?: str }
#[tauri::command]
pub async fn save_script_clip(
    project_dir: String,
    clip_id: String,
    segment_id: String,
    patch: Value,
) -> Result<(), ScriptError> {
    let path = script_path(&project_dir);
    let mut payload: Value = if path.exists() {
        serde_json::from_slice(&std::fs::read(&path)?)?
    } else {
        json!({ "schema_version": 1, "clips": [] })
    };

    let clips = payload
        .as_object_mut()
        .and_then(|m| m.entry("clips").or_insert_with(|| json!([])).as_array_mut())
        .expect("clips array");

    if let Some(existing) = clips
        .iter_mut()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(&clip_id))
    {
        merge_in_place(existing, &patch);
    } else {
        let mut clip = json!({
            "id": clip_id,
            "segment_id": segment_id,
        });
        merge_in_place(&mut clip, &patch);
        clips.push(clip);
    }

    let bytes = serde_json::to_vec_pretty(&payload)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn merge_in_place(target: &mut Value, patch: &Value) {
    if let (Some(tm), Some(pm)) = (target.as_object_mut(), patch.as_object()) {
        for (k, v) in pm {
            if v.is_object() {
                if let Some(existing) = tm.get_mut(k) {
                    if existing.is_object() {
                        merge_in_place(existing, v);
                        continue;
                    }
                }
            }
            tm.insert(k.clone(), v.clone());
        }
    }
}
