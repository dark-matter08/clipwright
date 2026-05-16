//! Project-template commands for the desktop.
//!
//! Templates ship with the Python package and are surfaced to the
//! frontend via `clipwright templates list --json` and friends. Mirrors
//! the pattern we use for `agent prompt` — we never re-parse template
//! JSON in Rust, we just shell out to the canonical CLI so any future
//! template-loader changes (e.g. per-project overrides) take effect on
//! the desktop automatically.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::clipwright;

#[derive(Debug, Error)]
pub enum TemplateError {
    #[error("clipwright templates {0}")]
    Cli(#[from] crate::clipwright::ClipwrightCliError),
    #[error("could not parse template payload: {0}")]
    Parse(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for TemplateError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TemplateMeta {
    pub template_id: String,
    pub name: String,
    pub category: String,
    pub summary: String,
    #[serde(default)]
    pub render_preset: String,
    /// Subset of `{aspect, fps, tts_provider, voice_id}` the template
    /// recommends. The desktop reads these to seed form defaults at
    /// creation time and to hint "recommended: 16:9" near pickers.
    #[serde(default)]
    pub defaults: serde_json::Value,
    /// "shipped" or "user" — drives the user-template badge in the
    /// picker so a writer iterating on a custom template can spot it
    /// at a glance.
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "shipped".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TemplateFull {
    pub template_id: String,
    pub name: String,
    pub category: String,
    pub summary: String,
    #[serde(default)]
    pub render_preset: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub defaults: serde_json::Value,
}

/// List every template shipped with the local `clipwright` install.
///
/// The desktop's New Project dialog renders this catalog as cards; the
/// TopBar's "Template:" badge uses the same list to switch bindings on
/// an open project.
#[tauri::command]
pub async fn list_templates_cmd() -> Result<Vec<TemplateMeta>, TemplateError> {
    let out = clipwright::run(&["templates", "list", "--json"])?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    serde_json::from_str::<Vec<TemplateMeta>>(stdout.trim())
        .map_err(|e| TemplateError::Parse(e.to_string()))
}

/// Return one template's full payload (including system_prompt).
///
/// The desktop uses this to preview the behavioral prompt in the picker
/// before the user commits. Reading the full payload over JSON keeps the
/// Rust side ignorant of the template-file format.
#[tauri::command]
pub async fn show_template_cmd(template_id: String) -> Result<TemplateFull, TemplateError> {
    let out = clipwright::run(&["templates", "show", &template_id, "--json"])?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    serde_json::from_str::<TemplateFull>(stdout.trim())
        .map_err(|e| TemplateError::Parse(e.to_string()))
}

/// Bind / unbind a template on an existing project.
///
/// Pass `template_id = ""` (empty) to clear. The next Claude turn picks
/// up the change automatically — no restart needed because the system
/// prompt is rebuilt per-turn.
#[tauri::command]
pub async fn apply_template_cmd(
    project_dir: String,
    template_id: String,
    overwrite_defaults: Option<bool>,
) -> Result<(), TemplateError> {
    // Back-compat single-template binding. Routes through the
    // multi-template path so we have one implementation. Callers
    // should prefer `apply_templates_cmd` below — kept here so
    // existing dialogs / commands don't need to update at once.
    let ids = if template_id.is_empty() {
        vec![]
    } else {
        vec![template_id]
    };
    apply_templates_cmd(project_dir, ids, overwrite_defaults).await
}

/// Bind a list of templates to an existing project. The FIRST entry
/// is the primary — it drives `render_preset` selection + default
/// settings. Additional entries only contribute behavioral
/// guidance, concatenated into the agent's system prompt.
///
/// Pass an empty Vec to clear all bindings (equivalent to the
/// `-` sentinel in the CLI).
#[tauri::command]
pub async fn apply_templates_cmd(
    project_dir: String,
    template_ids: Vec<String>,
    overwrite_defaults: Option<bool>,
) -> Result<(), TemplateError> {
    let _ = PathBuf::from(&project_dir);
    let mut args: Vec<String> = vec![
        "templates".into(),
        "apply".into(),
    ];
    if template_ids.is_empty() {
        // CLI's "clear all" sentinel.
        args.push("-".into());
    } else {
        args.extend(template_ids.into_iter());
    }
    args.push("--project".into());
    args.push(project_dir);
    if overwrite_defaults.unwrap_or(false) {
        args.push("--overwrite-defaults".into());
    }
    // Borrow into &str for the existing `clipwright::run` signature.
    let borrowed: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    clipwright::run(&borrowed)?;
    Ok(())
}
