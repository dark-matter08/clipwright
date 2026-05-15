//! Clipwright Studio — Tauri 2 backend.
//!
//! Phase 1.1 ships the minimum end-to-end loop: read a project from disk
//! and return it to the frontend. The Rust side only handles pure JSON
//! reads + the recents list. Heavy operations (import, tts, render, etc.)
//! will be spawned as `clipwright <subcommand>` subprocesses in later
//! phases (P1.4+) — never reimplemented here.

mod claude;
mod clipwright;
mod new_project;
mod path_env;
mod project;
mod recents;
mod script;
mod segment_ops;
mod credentials;
mod recap_config;
mod sources;
mod templates;
mod validate;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must run before any subprocess discovery — see path_env.rs for why.
    path_env::enrich();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(claude::ClaudeCancellation::default())
        .invoke_handler(tauri::generate_handler![
            project::open_project,
            project::save_video,
            project::list_videos_cmd,
            project::load_video_cmd,
            project::create_video_cmd,
            project::delete_video_cmd,
            project::final_exists_cmd,
            recents::list_recents,
            new_project::import_video_cmd,
            new_project::record_project_cmd,
            new_project::clipwright_doctor,
            new_project::add_source_cmd,
            sources::list_sources,
            templates::list_templates_cmd,
            templates::show_template_cmd,
            templates::apply_template_cmd,
            templates::apply_templates_cmd,
            script::load_script,
            script::save_script_clip,
            segment_ops::tts_segment_cmd,
            segment_ops::caption_segment_cmd,
            segment_ops::render_segment_cmd,
            segment_ops::render_final_cmd,
            claude::claude_chat,
            claude::cancel_claude_chat,
            claude::claude_doctor,
            claude::get_permission_mode,
            claude::set_permission_mode,
            claude::get_idle_timeout,
            claude::set_idle_timeout,
            claude::get_model,
            claude::set_model,
            recap_config::get_recap_config,
            recap_config::set_recap_config,
            credentials::get_credentials_status,
            credentials::set_credentials,
            claude::load_chat_history,
            claude::clear_claude_session,
            claude::list_slash_commands,
            claude::list_skills,
            claude::run_clipwright_command,
        ])
        .setup(|app| {
            // Make sure the recents file exists with an empty list so
            // the frontend's first call doesn't error before any project
            // has ever been opened.
            recents::ensure_recents_file(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
