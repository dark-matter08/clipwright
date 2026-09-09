//! Persona library + memory, bridged to the desktop.
//!
//! Every command here shells out to `clipwright persona … --json` rather
//! than reading `~/.clipwright/personas/` directly. The Rust side owns
//! no persona logic on purpose: the agent reaches personas through the
//! CLI, so if the app parsed the files itself the two would drift, and
//! the drift would show up as the app and Claude disagreeing about what
//! a persona says.
//!
//! The exception is `save_persona`, which writes JSON directly — the
//! definition is a document the desktop owns the editor for, and
//! round-tripping a whole persona through argv would be worse in every
//! way.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::clipwright;

#[derive(Debug, Error)]
pub enum PersonaError {
    #[error("clipwright CLI: {0}")]
    Cli(#[from] clipwright::ClipwrightCliError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("malformed persona JSON: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

impl Serialize for PersonaError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

/// Mirrors `~/.clipwright` resolution in `engine/clipwright/persona/paths.py`.
/// Duplicated rather than shelled out for because it's three lines and
/// `save_persona` needs it on every keystroke-triggered save.
fn base_dir() -> PathBuf {
    if let Some(v) = std::env::var_os("CLIPWRIGHT_HOME") {
        return PathBuf::from(v);
    }
    if let Some(v) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(v).join("clipwright");
    }
    dirs_home().join(".clipwright")
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn personas_dir() -> PathBuf {
    base_dir().join("personas")
}

fn run_json(args: &[&str]) -> Result<Value, PersonaError> {
    let out = clipwright::run(args)?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    // A backend may log to stdout before the payload; take from the
    // first brace/bracket so a stray line doesn't fail the parse.
    let start = stdout
        .find(['{', '['])
        .ok_or_else(|| PersonaError::Other("no JSON in CLI output".into()))?;
    Ok(serde_json::from_str(&stdout[start..])?)
}

#[tauri::command]
pub async fn list_personas() -> Result<Value, PersonaError> {
    run_json(&["persona", "list", "--json"])
}

#[tauri::command]
pub async fn load_persona(persona_id: String) -> Result<Value, PersonaError> {
    run_json(&["persona", "show", &persona_id, "--json"])
}

/// Write a persona document. The frontend sends the whole object, which
/// is what the editor is holding anyway.
#[tauri::command]
pub async fn save_persona(persona: Value) -> Result<Value, PersonaError> {
    let id = persona
        .get("persona_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return Err(PersonaError::Other("persona_id is required".into()));
    }
    // Same rule as the Python side; enforced here too so a bad id can't
    // create a file the library then refuses to load.
    if !id
        .chars()
        .next()
        .map(|c| c.is_ascii_lowercase())
        .unwrap_or(false)
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(PersonaError::Other(format!(
            "invalid persona id {id:?} — must match [a-z][a-z0-9_-]*"
        )));
    }

    let dir = personas_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{id}.json"));

    let mut doc = persona.clone();
    let now = chrono_now();
    if let Some(obj) = doc.as_object_mut() {
        if obj
            .get("created_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
        {
            obj.insert("created_at".into(), Value::String(now.clone()));
        }
        obj.insert("updated_at".into(), Value::String(now));
    }

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc)? + "\n")?;
    std::fs::rename(&tmp, &path)?;
    Ok(doc)
}

fn chrono_now() -> String {
    // Tauri already pulls in `time` transitively via its own deps, but
    // depending on that is fragile. A plain UTC ISO-8601 second-
    // resolution stamp is all the library needs for sort order.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_iso8601(secs)
}

/// Days-from-civil algorithm (Howard Hinnant's), so we can format a
/// timestamp without adding a date crate for one string.
fn format_iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}+00:00")
}

#[tauri::command]
pub async fn clone_persona(persona_id: String, name: String) -> Result<Value, PersonaError> {
    let mut args: Vec<&str> = vec!["persona", "clone", &persona_id];
    if !name.is_empty() {
        args.push("--name");
        args.push(&name);
    }
    clipwright::run(&args)?;
    // `clone` prints a human line, not JSON, so re-read the library and
    // hand back the newest entry — which is the clone we just made.
    list_personas().await
}

#[tauri::command]
pub async fn delete_persona(persona_id: String) -> Result<(), PersonaError> {
    clipwright::run(&["persona", "delete", &persona_id, "--yes"])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct MemoryAdd {
    pub persona_id: String,
    pub kind: String,
    pub body: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub source: String,
}

#[tauri::command]
pub async fn persona_memory_list(
    persona_id: String,
    kind: Option<String>,
    limit: Option<u32>,
) -> Result<Value, PersonaError> {
    let limit = limit.unwrap_or(200).to_string();
    let kind = kind.unwrap_or_default();
    let mut args: Vec<&str> = vec![
        "persona", "memory", "list", &persona_id, "--limit", &limit, "--json",
    ];
    if !kind.is_empty() {
        args.push("--kind");
        args.push(&kind);
    }
    run_json(&args)
}

#[tauri::command]
pub async fn persona_memory_search(
    persona_id: String,
    query: String,
    limit: Option<u32>,
) -> Result<Value, PersonaError> {
    let limit = limit.unwrap_or(20).to_string();
    run_json(&[
        "persona", "memory", "search", &persona_id, &query, "--limit", &limit, "--json",
    ])
}

#[tauri::command]
pub async fn persona_memory_add(entry: MemoryAdd) -> Result<(), PersonaError> {
    let mut args: Vec<&str> = vec![
        "persona",
        "memory",
        "add",
        &entry.persona_id,
        "--kind",
        &entry.kind,
        "--body",
        &entry.body,
    ];
    if !entry.title.is_empty() {
        args.push("--title");
        args.push(&entry.title);
    }
    if !entry.source.is_empty() {
        args.push("--source");
        args.push(&entry.source);
    }
    clipwright::run(&args)?;
    Ok(())
}

#[tauri::command]
pub async fn persona_memory_forget(entry_id: i64) -> Result<(), PersonaError> {
    let id = entry_id.to_string();
    clipwright::run(&["persona", "memory", "forget", &id])?;
    Ok(())
}

#[tauri::command]
pub async fn persona_graph(persona_id: String) -> Result<Value, PersonaError> {
    run_json(&["persona", "memory", "graph", &persona_id])
}

// ---------------------------------------------------------------------------
// Binding a persona to a project
// ---------------------------------------------------------------------------

/// Set (or clear) `project.json#persona_id`.
///
/// A merge into the existing document rather than a rewrite: the desktop
/// only knows about the fields it renders, and `project.json` carries
/// others (`template_ids`, `extra`, whatever a future version adds).
/// Serializing our own view of the file would silently drop them.
#[tauri::command]
pub async fn set_project_persona(
    project_dir: String,
    persona_id: String,
) -> Result<Value, PersonaError> {
    let path = PathBuf::from(&project_dir).join("project.json");
    let raw = std::fs::read_to_string(&path)?;
    let mut doc: Value = serde_json::from_str(&raw)?;
    let obj = doc
        .as_object_mut()
        .ok_or_else(|| PersonaError::Other("project.json is not an object".into()))?;

    if persona_id.is_empty() {
        obj.remove("persona_id");
    } else {
        obj.insert("persona_id".into(), Value::String(persona_id));
    }

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc)? + "\n")?;
    std::fs::rename(&tmp, &path)?;
    Ok(doc)
}
