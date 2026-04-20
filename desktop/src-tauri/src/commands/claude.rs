use crate::state::AppState;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Serialize, Clone)]
pub struct AuthCheck {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn check_claude_auth() -> Result<AuthCheck, String> {
    let out = Command::new("claude").arg("--version").output().await;
    match out {
        Ok(o) if o.status.success() => Ok(AuthCheck {
            ok: true,
            message: String::from_utf8_lossy(&o.stdout).trim().to_string(),
        }),
        Ok(o) => Ok(AuthCheck {
            ok: false,
            message: String::from_utf8_lossy(&o.stderr).to_string(),
        }),
        Err(e) => Ok(AuthCheck {
            ok: false,
            message: format!("`claude` CLI not found: {e}. Install Claude Code and run `claude login`."),
        }),
    }
}

fn sessions_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("clipwright-desktop").join("sessions.json")
}

fn read_session(project: &str) -> Option<String> {
    let p = sessions_path();
    let raw = std::fs::read_to_string(&p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get(project)
        .and_then(|x| x.get("conversationId"))
        .and_then(|x| x.as_str())
        .map(String::from)
}

fn write_session(project: &str, conversation_id: &str) {
    let p = sessions_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut v: serde_json::Value = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    v[project] = serde_json::json!({
        "conversationId": conversation_id,
        "lastUsed": chrono_now(),
    });
    let _ = std::fs::write(&p, serde_json::to_string_pretty(&v).unwrap());
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let s = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    format!("{s}")
}

#[derive(Serialize, Clone)]
struct ClaudeEventOut {
    run_id: u32,
    #[serde(flatten)]
    event: serde_json::Value,
}

async fn spawn_claude(
    project_path: String,
    text: String,
    permission_mode: &str,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    let run_id = state.next_id();
    let prior_session = read_session(&project_path);

    let mut cmd = Command::new("claude");
    cmd.arg("-p").arg(&text);
    cmd.arg("--output-format").arg("stream-json");
    cmd.arg("--verbose");
    cmd.arg("--add-dir").arg(&project_path);
    cmd.arg("--permission-mode").arg(permission_mode);
    if let Some(id) = &prior_session {
        cmd.arg("--resume").arg(id);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("spawn claude: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let project_path_out = project_path.clone();
    let app_out = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) {
                if ev.get("type").and_then(|x| x.as_str()) == Some("system") {
                    if let Some(sid) = ev.get("session_id").and_then(|x| x.as_str()) {
                        write_session(&project_path_out, sid);
                    }
                }
                let _ = app_out.emit(
                    "claude:event",
                    ClaudeEventOut { run_id, event: ev },
                );
            }
        }
    });

    let app_err = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_err.emit(
                "claude:event",
                ClaudeEventOut {
                    run_id,
                    event: serde_json::json!({"type":"error","content":line}),
                },
            );
        }
    });

    let app_done = app.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        let _ = app_done.emit(
            "claude:event",
            ClaudeEventOut {
                run_id,
                event: serde_json::json!({"type":"result"}),
            },
        );
    });

    Ok(run_id)
}

#[tauri::command]
pub async fn send_claude_message(
    project_path: String,
    text: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    spawn_claude(project_path, text, "plan", app, state).await
}

#[tauri::command]
pub async fn approve_claude_plan(
    project_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    spawn_claude(
        project_path,
        "approved, proceed with the plan".to_string(),
        "acceptEdits",
        app,
        state,
    )
    .await
}
