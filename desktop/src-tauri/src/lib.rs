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
            project::init_project,
            project::list_project_files,
            project::read_text_file,
            project::save_script_clip,
            project::list_known_projects,
            project::forget_project,
            project::list_videos,
            project::load_video,
            project::create_video,
            project::delete_video,
            project::rename_video,
            clipwright::run_clipwright,
            clipwright::cancel_run,
            watcher::start_watcher,
            watcher::stop_watcher,
            claude::check_claude_auth,
            claude::send_claude_message,
            claude::approve_claude_plan,
            claude::list_claude_sessions,
            claude::get_active_session,
            claude::set_active_session,
            claude::clear_active_session,
            claude::load_session_transcript,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
