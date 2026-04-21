use crate::state::AppState;
use serde::Serialize;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    run_id: u32,
    stream: &'static str,
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    run_id: u32,
    code: i32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    run_id: u32,
    stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    clip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

const PROGRESS_STAGES: &[&str] = &["tts", "caption", "render"];

#[tauri::command]
pub async fn run_clipwright(
    path: String,
    subcommand: String,
    clip_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    let run_id = state.next_id();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    state.runs.lock().unwrap().insert(run_id, cancel_tx);

    let mut args: Vec<String> = subcommand.split_whitespace().map(String::from).collect();
    let root_cmd = args.first().cloned().unwrap_or_default();
    args.push("--project".into());
    args.push(path.clone());
    if let Some(cid) = clip_id {
        args.push("--clip-id".into());
        args.push(cid);
    }
    if PROGRESS_STAGES.contains(&root_cmd.as_str()) {
        args.push("--progress-json".into());
    }

    let mut cmd = Command::new("clipwright");
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("spawn clipwright: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let app_out = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line.starts_with('{') {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if v.get("stage").is_some() {
                        let _ = app_out.emit(
                            "clipwright:progress",
                            ProgressEvent {
                                run_id,
                                stage: v.get("stage").and_then(|x| x.as_str()).unwrap_or("").into(),
                                clip: v.get("clip").and_then(|x| x.as_str()).map(String::from),
                                pct: v.get("pct").and_then(|x| x.as_f64()),
                                message: v.get("message").and_then(|x| x.as_str()).map(String::from),
                            },
                        );
                        continue;
                    }
                }
            }
            let _ = app_out.emit(
                "clipwright:log",
                LogEvent { run_id, stream: "stdout", line },
            );
        }
    });

    let app_err = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_err.emit(
                "clipwright:log",
                LogEvent { run_id, stream: "stderr", line },
            );
        }
    });

    let app_done = app.clone();
    tokio::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1),
            _ = cancel_rx => {
                let _ = child.start_kill();
                -2
            }
        };
        let _ = app_done.emit("clipwright:done", DoneEvent { run_id, code });
    });

    Ok(run_id)
}

#[tauri::command]
pub fn cancel_run(run_id: u32, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(tx) = state.runs.lock().unwrap().remove(&run_id) {
        let _ = tx.send(());
    }
    Ok(())
}
