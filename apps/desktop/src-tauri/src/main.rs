#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod dto;
mod watcher;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::ProjectList::default())
        .manage(watcher::WatchState::default())
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
            watcher::watch_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Takes");
}
