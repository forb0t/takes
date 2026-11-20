#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod dto;
mod pinch;
mod sync;
mod watcher;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::ProjectList::default())
        .manage(watcher::WatchState::default())
        .manage(sync::Syncing::default())
        .setup(|app| {
            if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                pinch::forward(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::is_project,
            commands::add_project,
            commands::remove_project,
            commands::reveal,
            commands::overview,
            commands::status,
            commands::commit,
            commands::import_files,
            commands::history_graph,
            commands::log,
            commands::snapshot_changes,
            commands::files,
            commands::removed_files,
            commands::shared_setting,
            commands::shared_settings,
            commands::set_shared_setting,
            commands::file_history,
            commands::stats,
            commands::cleanup,
            commands::drop_versions,
            commands::export_zip,
            commands::set_author,
            commands::switch_branch,
            commands::save_take,
            commands::use_take,
            commands::create_tag,
            commands::delete_tag,
            commands::merge_preview,
            commands::merge,
            commands::rename_file,
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
