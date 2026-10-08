//! Tells the UI when files in the open project change, so the "Changes" list
//! updates while you work in your DAW.

use std::path::Path;
use std::sync::Mutex;

use notify::event::{AccessKind, AccessMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::dto::CommandError;

pub const EVENT: &str = "worktree-changed";

/// The watcher for the project on screen (one at a time).
#[derive(Default)]
pub struct WatchState(Mutex<Option<(String, RecommendedWatcher)>>);

#[tauri::command]
pub fn watch_project(
    app: AppHandle,
    state: State<WatchState>,
    root: String,
) -> Result<(), CommandError> {
    let mut current = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if current.as_ref().is_some_and(|(r, _)| *r == root) {
        return Ok(());
    }
    *current = None;

    let meta = Path::new(&root).join(takes_core::META_DIR);
    let (emitter, payload) = (app.clone(), root.clone());
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        // Reads (including our own hashing during status) are not changes;
        // a file closed after writing is.
        let relevant = match event.kind {
            EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
            EventKind::Access(_) => false,
            _ => true,
        };
        let outside_meta = event.paths.iter().any(|p| {
            !p.starts_with(&meta)
                && !p
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().ends_with(".takes-tmp"))
        });
        if relevant && outside_meta {
            let _ = emitter.emit(EVENT, &payload);
        }
    })
    .map_err(CommandError::other)?;
    watcher
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(CommandError::other)?;

    // Let the player load unsaved files straight from the project folder.
    app.asset_protocol_scope().allow_directory(&root, true)?;
    *current = Some((root, watcher));
    Ok(())
}
