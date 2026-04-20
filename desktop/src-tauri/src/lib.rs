mod commands;
mod state;

use commands::{claude, clipwright, project, watcher};
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            project::pick_project,
            project::load_project,
            project::save_script_clip,
            clipwright::run_clipwright,
            clipwright::cancel_run,
            watcher::start_watcher,
            watcher::stop_watcher,
            claude::check_claude_auth,
            claude::send_claude_message,
            claude::approve_claude_plan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
