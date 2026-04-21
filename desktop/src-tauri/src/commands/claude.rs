use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
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

fn claude_project_dir(project_path: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let slug: String = project_path
        .chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .collect();
    home.join(".claude").join("projects").join(slug)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub first_message: String,
    pub last_modified: u64,
    pub message_count: usize,
    pub active: bool,
}

#[tauri::command]
pub fn list_claude_sessions(project_path: String) -> Result<Vec<SessionInfo>, String> {
    let dir = claude_project_dir(&project_path);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let active = read_session(&project_path);
    let mut out: Vec<SessionInfo> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let id = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
        let last_modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let (first_message, message_count) = summarize_session(&p);
        out.push(SessionInfo {
            active: active.as_deref() == Some(&id),
            id,
            first_message,
            last_modified,
            message_count,
        });
    }
    out.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(out)
}

fn summarize_session(p: &Path) -> (String, usize) {
    let Ok(raw) = std::fs::read_to_string(p) else {
        return (String::new(), 0);
    };
    let mut first = String::new();
    let mut count: usize = 0;
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if kind == "user" || kind == "assistant" {
            count += 1;
        }
        if first.is_empty() && kind == "user" {
            if let Some(content) = v.get("message").and_then(|m| m.get("content")) {
                if let Some(s) = content.as_str() {
                    first = s.to_string();
                } else if let Some(arr) = content.as_array() {
                    for blk in arr {
                        if let Some(t) = blk.get("text").and_then(|x| x.as_str()) {
                            first = t.to_string();
                            break;
                        }
                    }
                }
            }
        }
    }
    if first.len() > 240 {
        first.truncate(240);
        first.push('…');
    }
    (first, count)
}

#[tauri::command]
pub fn get_active_session(project_path: String) -> Result<Option<String>, String> {
    Ok(read_session(&project_path))
}

#[tauri::command]
pub fn set_active_session(project_path: String, session_id: String) -> Result<(), String> {
    write_session(&project_path, &session_id);
    Ok(())
}

#[tauri::command]
pub fn clear_active_session(project_path: String) -> Result<(), String> {
    let p = sessions_path();
    let Some(raw) = std::fs::read_to_string(&p).ok() else {
        return Ok(());
    };
    let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
    if let Some(obj) = v.as_object_mut() {
        obj.remove(&project_path);
    }
    let _ = std::fs::write(&p, serde_json::to_string_pretty(&v).unwrap());
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReplayMessage {
    pub role: String,
    pub content: String,
    pub tool: Option<String>,
}

#[tauri::command]
pub fn load_session_transcript(
    project_path: String,
    session_id: String,
) -> Result<Vec<ReplayMessage>, String> {
    let path = claude_project_dir(&project_path).join(format!("{session_id}.jsonl"));
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut out: Vec<ReplayMessage> = Vec::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let message = v.get("message");
        match kind {
            "user" => {
                if let Some(content) = message.and_then(|m| m.get("content")) {
                    let text = extract_text(content);
                    if !text.is_empty() {
                        out.push(ReplayMessage {
                            role: "user".into(),
                            content: text,
                            tool: None,
                        });
                    }
                }
            }
            "assistant" => {
                if let Some(arr) = message.and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                    for blk in arr {
                        let btype = blk.get("type").and_then(|x| x.as_str()).unwrap_or("");
                        if btype == "text" {
                            if let Some(t) = blk.get("text").and_then(|x| x.as_str()) {
                                out.push(ReplayMessage {
                                    role: "assistant".into(),
                                    content: t.to_string(),
                                    tool: None,
                                });
                            }
                        } else if btype == "tool_use" {
                            let name = blk.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                            let input = blk.get("input").cloned().unwrap_or(serde_json::json!({}));
                            if name == "ExitPlanMode" {
                                let plan = input.get("plan").and_then(|x| x.as_str()).unwrap_or("").to_string();
                                out.push(ReplayMessage {
                                    role: "plan".into(),
                                    content: plan,
                                    tool: Some(name),
                                });
                            } else {
                                out.push(ReplayMessage {
                                    role: "tool".into(),
                                    content: serde_json::to_string(&input).unwrap_or_default(),
                                    tool: Some(name),
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

fn extract_text(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        for blk in arr {
            if let Some(t) = blk.get("text").and_then(|x| x.as_str()) {
                return t.to_string();
            }
        }
    }
    String::new()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClaudeEventOut {
    run_id: u32,
    #[serde(flatten)]
    event: serde_json::Value,
}

fn build_context_preamble(project_path: &str) -> String {
    use std::path::Path;
    let root = Path::new(project_path);
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!(
        "You are assisting with a Clipwright video project at `{}`. \
         Read `.clipwright.json`, `script.json`, `out/segments.json`, `out/moments.json`, \
         and `browse-plan.json` for state. Keep each clip's copy around 2.5 words/sec of its target_seconds.",
        project_path
    ));
    if let Ok(cfg) = std::fs::read_to_string(root.join(".clipwright.json")) {
        parts.push(format!("Current .clipwright.json:\n```json\n{}\n```", cfg.trim()));
    }
    if let Ok(plan) = std::fs::read_to_string(root.join("browse-plan.json")) {
        let short = if plan.len() > 4000 { &plan[..4000] } else { &plan };
        parts.push(format!("Current browse-plan.json:\n```json\n{}\n```", short.trim()));
    }
    if let Ok(script) = std::fs::read_to_string(root.join("script.json")) {
        parts.push(format!("Current script.json:\n```json\n{}\n```", script.trim()));
    }
    parts.join("\n\n")
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

    let full_message = if prior_session.is_none() {
        format!("{}\n\n---\nUser: {}", build_context_preamble(&project_path), text)
    } else {
        text.clone()
    };

    let mut cmd = Command::new("claude");
    cmd.arg("-p").arg(&full_message);
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
    spawn_claude(project_path, text, "bypassPermissions", app, state).await
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
