#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod dto;
mod sync;
mod watcher;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::ProjectList::default())
        .manage(watcher::WatchState::default())
        .manage(sync::Syncing::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::is_project,
            commands::add_project,
            commands::remove_project,
            commands::reveal,
            commands::overview,
            commands::status,
            commands::commit,
            commands::log,
            commands::snapshot_changes,
            commands::files,
            commands::file_history,
            commands::stats,
            commands::cleanup,
            commands::export_zip,
            commands::set_author,
            commands::switch_branch,
            commands::create_branch,
            commands::delete_branch,
            commands::create_tag,
            commands::delete_tag,
            commands::merge_preview,
            commands::merge,
            commands::restore,
            commands::preview_file,
            commands::analyze_audio,
            commands::comments,
            commands::add_comment,
            commands::resolve_comment,
            commands::file_meta,
            commands::set_file_meta,
            commands::text_file,
            commands::file_bytes,
            watcher::watch_project,
            sync::sync_state,
            sync::set_remote,
            sync::remove_remote,
            sync::set_device_name,
            sync::sync,
            sync::update_current,
            sync::set_auto_sync,
            sync::find_remote_projects,
            sync::is_remote_project,
            sync::clone_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Takes");
}
