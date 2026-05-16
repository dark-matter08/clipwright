//! User-scoped API credentials for paid TTS providers.
//!
//! Lives at `~/.clipwright/credentials.json` (or
//! `$CLIPWRIGHT_HOME/credentials.json` / `$XDG_CONFIG_HOME/clipwright/`
//! when those env vars are set — matching the Python side and the
//! existing user templates dir).
//!
//! Security posture:
//!
//!   - The file is written `chmod 0600` on Unix (best-effort on
//!     Windows). Atomic write via temp + rename so we never leave a
//!     partially-written secret on disk.
//!
//!   - The desktop's `get_credentials` command **never returns the
//!     raw secret values to the frontend** — it returns a
//!     `{has_openai_key, has_elevenlabs_key}` presence map. That way
//!     a stray `console.log` in the rail or settings dialog can't
//!     leak the key into dev tools / crash reports. The frontend's
//!     settings form is write-only: it shows masked input fields,
//!     the user types a new key to overwrite (or clears to wipe).
//!
//!   - `set_credentials` accepts either fresh values or `null` for
//!     each field. `null` ⇒ leave the existing value alone; empty
//!     string ⇒ explicitly wipe. This lets the settings dialog send
//!     "only the field the user changed" without forcing the user to
//!     re-type all keys to update one of them.

use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CredentialsError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("malformed credentials.json: {0}")]
    Parse(#[from] serde_json::Error),
}

impl Serialize for CredentialsError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct StoredCredentials {
    #[serde(default)]
    pub openai_api_key: String,
    #[serde(default)]
    pub elevenlabs_api_key: String,
}

/// Presence-only view returned to the frontend. The raw key strings
/// never cross the Tauri boundary back to JS — see the module
/// header for why.
#[derive(Debug, Serialize)]
pub struct CredentialsStatus {
    /// True when an OpenAI key is set EITHER via the file OR via the
    /// `OPENAI_API_KEY` env var. The dialog uses this to render
    /// "configured" vs "not configured" badges.
    pub has_openai_key: bool,
    pub has_elevenlabs_key: bool,
    /// True when the env var is providing the key (so the user knows
    /// editing the dialog field won't help — they need to unset
    /// the env var first).
    pub openai_key_from_env: bool,
    pub elevenlabs_key_from_env: bool,
    /// On-disk file path, surfaced so the user can locate / delete
    /// the secret store manually.
    pub credentials_path: String,
}

/// One-or-the-other update payload — `None` means "don't touch this
/// field"; `Some("")` means "wipe"; `Some(non-empty)` means "set".
#[derive(Debug, Deserialize)]
pub struct CredentialsUpdate {
    #[serde(default)]
    pub openai_api_key: Option<String>,
    #[serde(default)]
    pub elevenlabs_api_key: Option<String>,
}

fn base_dir() -> PathBuf {
    if let Ok(home) = std::env::var("CLIPWRIGHT_HOME") {
        return PathBuf::from(shellexpand_home(&home));
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(shellexpand_home(&xdg)).join("clipwright");
    }
    home_dir().join(".clipwright")
}

fn shellexpand_home(s: &str) -> String {
    if let Some(stripped) = s.strip_prefix("~") {
        return format!("{}{}", home_dir().display(), stripped);
    }
    s.to_string()
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn credentials_path() -> PathBuf {
    base_dir().join("credentials.json")
}

fn load_stored() -> StoredCredentials {
    let path = credentials_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return StoredCredentials::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_stored(creds: &StoredCredentials) -> Result<(), CredentialsError> {
    let path = credentials_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let serialized = serde_json::to_string_pretty(creds)?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)?;
        f.write_all(serialized.as_bytes())?;
        f.flush()?;
    }
    // chmod 0600 on Unix so other users on the machine can't read
    // the file. Best-effort on Windows (ignored).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[tauri::command]
pub async fn get_credentials_status() -> Result<CredentialsStatus, CredentialsError> {
    let stored = load_stored();
    let openai_env = std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|s| !s.is_empty());
    let eleven_env = std::env::var("ELEVENLABS_API_KEY")
        .ok()
        .filter(|s| !s.is_empty());
    Ok(CredentialsStatus {
        has_openai_key: openai_env.is_some() || !stored.openai_api_key.is_empty(),
        has_elevenlabs_key: eleven_env.is_some() || !stored.elevenlabs_api_key.is_empty(),
        openai_key_from_env: openai_env.is_some(),
        elevenlabs_key_from_env: eleven_env.is_some(),
        credentials_path: credentials_path().display().to_string(),
    })
}

#[tauri::command]
pub async fn set_credentials(
    update: CredentialsUpdate,
) -> Result<CredentialsStatus, CredentialsError> {
    let mut stored = load_stored();
    if let Some(v) = update.openai_api_key {
        stored.openai_api_key = v;
    }
    if let Some(v) = update.elevenlabs_api_key {
        stored.elevenlabs_api_key = v;
    }
    save_stored(&stored)?;
    get_credentials_status().await
}
