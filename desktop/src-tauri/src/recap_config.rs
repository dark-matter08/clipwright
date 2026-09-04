//! Per-project recap preferences — typed pass-through to the Python side.
//!
//! The config lives at `<project>/.clipwright/recap-config.json` and
//! carries the user's video-length target, narration style, and outro
//! spec. The Python module
//! `src/clipwright/recap_config.py` owns the schema + I/O; here we
//! just read/write the file directly so the desktop doesn't pay a
//! subprocess round-trip on every save.
//!
//! Why direct file I/O instead of shelling to the CLI: the config is
//! plain JSON with a stable shape and no validation that requires the
//! Python runtime. Keeping the parsing local makes the settings
//! dialog feel instant.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RecapConfigError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("malformed recap-config.json: {0}")]
    Parse(#[from] serde_json::Error),
}

impl Serialize for RecapConfigError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OutroSpec {
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_outro_duration")]
    pub duration_seconds: f64,
}

impl Default for OutroSpec {
    fn default() -> Self {
        Self {
            description: String::new(),
            duration_seconds: default_outro_duration(),
        }
    }
}

fn default_outro_duration() -> f64 {
    // Matches `DEFAULT_OUTRO_DURATION` in
    // `src/clipwright/recap_config.py`. If either side changes the
    // default, update both so a fresh project loads the same numbers
    // whether we go through the Python loader or the Rust one.
    3.0
}

fn default_target_duration() -> u64 {
    // Matches `DEFAULT_TARGET_DURATION` in
    // `src/clipwright/recap_config.py`.
    90
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecapConfig {
    /// Defaults to 90s (1:30). Override via the settings dialog when
    /// a project needs longer or shorter videos.
    #[serde(default = "default_target_duration")]
    pub target_duration_seconds: u64,
    #[serde(default)]
    pub narration_style: String,
    #[serde(default)]
    pub additional_notes: String,
    /// Who Claude should BE when writing for this project ("an expert
    /// manhwa scriptwriter who specializes in high-retention hooks…").
    /// Empty = no persona section in the agent prompt. Mirrors
    /// `RecapConfig.persona` in `src/clipwright/recap_config.py`.
    #[serde(default)]
    pub persona: String,
    #[serde(default)]
    pub outro: OutroSpec,
}

impl Default for RecapConfig {
    fn default() -> Self {
        Self {
            target_duration_seconds: default_target_duration(),
            narration_style: String::new(),
            additional_notes: String::new(),
            persona: String::new(),
            outro: OutroSpec::default(),
        }
    }
}

fn config_path(project_dir: &str) -> PathBuf {
    PathBuf::from(project_dir)
        .join(".clipwright")
        .join("recap-config.json")
}

/// Read the per-project recap config. Returns `RecapConfig::default()`
/// when the file is missing or malformed — soft-fail by design so the
/// settings dialog always opens to *something* the user can edit.
#[tauri::command]
pub async fn get_recap_config(project_dir: String) -> Result<RecapConfig, RecapConfigError> {
    let path = config_path(&project_dir);
    if !path.exists() {
        return Ok(RecapConfig::default());
    }
    let raw = std::fs::read_to_string(&path)?;
    // Soft-fail on parse errors too: a corrupted file shouldn't trap
    // the user into a broken dialog. They can re-save and we'll
    // overwrite with a clean copy.
    match serde_json::from_str::<RecapConfig>(&raw) {
        Ok(cfg) => Ok(cfg),
        Err(_) => Ok(RecapConfig::default()),
    }
}

#[tauri::command]
pub async fn set_recap_config(
    project_dir: String,
    config: RecapConfig,
) -> Result<(), RecapConfigError> {
    let path = config_path(&project_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Atomic write via temp + rename so a half-written file doesn't
    // corrupt the on-disk state.
    let tmp = path.with_extension("json.tmp");
    let serialized = serde_json::to_string_pretty(&config)?;
    std::fs::write(&tmp, serialized.as_bytes())?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
