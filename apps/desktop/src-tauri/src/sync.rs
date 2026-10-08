//! Sync commands. WebDAV passwords live in the OS keychain (Secret Service,
//! macOS Keychain, Windows Credential Manager), never in the project.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use takes_core::{
    Blocked, Diverged, RemoteConfig, Repo, Storage, SyncPhase, SyncProgress, SyncReport,
};
use tauri::{AppHandle, Emitter, State};

use crate::commands::{CmdResult, ProjectList, blocking, remember_project};
use crate::dto::{CommandError, ProjectDto};

const KEYCHAIN_SERVICE: &str = "app.takes.desktop";
pub const PROGRESS_EVENT: &str = "sync-progress";

/// Projects being synced right now, to refuse a second concurrent sync.
#[derive(Default)]
pub struct Syncing(Mutex<HashSet<String>>);

fn keychain_entry(remote: &RemoteConfig) -> Option<keyring::Entry> {
    match remote {
        RemoteConfig::WebDav { url, username, .. } => {
            keyring::Entry::new(KEYCHAIN_SERVICE, &format!("webdav {username} {url}")).ok()
        }
        RemoteConfig::Folder { .. } => None,
    }
}

fn saved_password(remote: &RemoteConfig) -> Option<String> {
    keychain_entry(remote)?.get_password().ok()
}

fn save_password(remote: &RemoteConfig, password: &str) -> CmdResult<()> {
    if let Some(entry) = keychain_entry(remote) {
        entry.set_password(password).map_err(|e| CommandError {
            kind: "keychain",
            ..CommandError::other(e)
        })?;
    }
    Ok(())
}

/// Opens the storage, with the given password or the one in the keychain.
fn open_storage(remote: &RemoteConfig, password: Option<String>) -> CmdResult<Box<dyn Storage>> {
    let password = match password.filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None if remote.needs_password() => {
            Some(saved_password(remote).ok_or_else(|| CommandError {
                kind: "passwordNeeded",
                ..CommandError::other("password needed")
            })?)
        }
        None => None,
    };
    Ok(remote.open(password.as_deref())?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DivergedDto {
    branch: String,
    device: String,
    rev: String,
}

impl From<&Diverged> for DivergedDto {
    fn from(d: &Diverged) -> Self {
        Self {
            branch: d.branch.clone(),
            device: d.device.clone(),
            rev: d.rev.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateDto {
    remote: Option<RemoteConfig>,
    location: Option<String>,
    has_password: bool,
    device_name: String,
    unsent_versions: u64,
    diverged: Vec<DivergedDto>,
    waiting: Vec<String>,
    last_sync: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReportDto {
    uploaded_bytes: u64,
    downloaded_bytes: u64,
    sent_versions: u64,
    received_versions: u64,
    comments_sent: u64,
    comments_received: u64,
    updated_branches: Vec<String>,
    new_branches: Vec<String>,
    diverged: Vec<DivergedDto>,
    /// "unsaved" | "filesBusy" | "wouldOverwrite"
    current_blocked: Option<&'static str>,
    blocked_paths: Vec<String>,
}

impl From<&SyncReport> for SyncReportDto {
    fn from(r: &SyncReport) -> Self {
        let (current_blocked, blocked_paths) = match &r.current_blocked {
            None => (None, Vec::new()),
            Some(Blocked::Unsaved) => (Some("unsaved"), Vec::new()),
            Some(Blocked::FilesBusy(p)) => (Some("filesBusy"), p.clone()),
            Some(Blocked::WouldOverwrite(p)) => (Some("wouldOverwrite"), p.clone()),
        };
        Self {
            uploaded_bytes: r.uploaded_bytes,
            downloaded_bytes: r.downloaded_bytes,
            sent_versions: r.sent_versions,
            received_versions: r.received_versions,
            comments_sent: r.comments_sent,
            comments_received: r.comments_received,
            updated_branches: r.updated_branches.clone(),
            new_branches: r.new_branches.clone(),
            diverged: r.diverged.iter().map(Into::into).collect(),
            current_blocked,
            blocked_paths,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressDto {
    /// Project root, or the destination folder while cloning.
    root: String,
    phase: &'static str,
    done: u64,
    total: u64,
}

fn progress_emitter(app: AppHandle, root: String) -> impl FnMut(SyncProgress) {
    move |p| {
        let phase = match p.phase {
            SyncPhase::Connecting => "connecting",
            SyncPhase::Downloading => "downloading",
            SyncPhase::Uploading => "uploading",
        };
        let _ = app.emit(
            PROGRESS_EVENT,
            ProgressDto {
                root: root.clone(),
                phase,
                done: p.done,
                total: p.total,
            },
        );
    }
}

#[tauri::command]
pub async fn sync_state(root: String) -> CmdResult<SyncStateDto> {
    blocking(move || {
        let repo = Repo::open(&root)?;
        let state = repo.sync_state()?;
        Ok(SyncStateDto {
            location: state.remote.as_ref().map(RemoteConfig::describe),
            has_password: state
                .remote
                .as_ref()
                .is_some_and(|r| !r.needs_password() || saved_password(r).is_some()),
            remote: state.remote,
            device_name: repo.device()?.1,
            unsent_versions: state.unsent_versions,
            diverged: state.diverged.iter().map(Into::into).collect(),
            waiting: state.waiting,
            last_sync: state.last_sync,
        })
    })
    .await
}

/// Connects the project to a remote: checks access and that the place is
/// empty or already this project's, then saves it (and the password).
#[tauri::command]
pub async fn set_remote(
    root: String,
    remote: RemoteConfig,
    password: Option<String>,
) -> CmdResult<()> {
    blocking(move || {
        let repo = Repo::open(&root)?;
        let storage = open_storage(&remote, password.clone())?;
        repo.connect_remote(storage.as_ref())?;
        if let Some(password) = password.filter(|p| !p.is_empty()) {
            save_password(&remote, &password)?;
        }
        repo.set_remote(Some(&remote))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn remove_remote(root: String) -> CmdResult<()> {
    blocking(move || Ok(Repo::open(&root)?.set_remote(None)?)).await
}

#[tauri::command]
pub async fn set_device_name(root: String, name: String) -> CmdResult<()> {
    blocking(move || Ok(Repo::open(&root)?.set_device_name(&name)?)).await
}

#[tauri::command]
pub async fn sync(
    app: AppHandle,
    syncing: State<'_, Syncing>,
    root: String,
    password: Option<String>,
) -> CmdResult<SyncReportDto> {
    if !syncing
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(root.clone())
    {
        return Err(CommandError {
            kind: "alreadySyncing",
            ..CommandError::other("sync in progress")
        });
    }
    let progress = progress_emitter(app.clone(), root.clone());
    let key = root.clone();
    let result = blocking(move || {
        let mut repo = Repo::open(&root)?;
        let remote = repo
            .remote()?
            .ok_or(takes_core::Error::RemoteNotConfigured)?;
        let storage = open_storage(&remote, password.clone())?;
        let mut progress = progress;
        let report = repo.sync(storage.as_ref(), &mut progress)?;
        // Remember a password that just worked.
        if let Some(password) = password.filter(|p| !p.is_empty()) {
            save_password(&remote, &password)?;
        }
        Ok((&report).into())
    })
    .await;
    syncing
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&key);
    result
}

/// Projects in the folders right under `remote` (e.g. WebDAV "Takes").
#[tauri::command]
pub async fn find_remote_projects(
    remote: RemoteConfig,
    password: Option<String>,
) -> CmdResult<Vec<String>> {
    blocking(move || {
        let storage = open_storage(&remote, password)?;
        Ok(takes_core::find_remote_projects(storage.as_ref())?)
    })
    .await
}

#[tauri::command]
pub async fn is_remote_project(remote: RemoteConfig, password: Option<String>) -> CmdResult<bool> {
    blocking(move || {
        let storage = open_storage(&remote, password)?;
        Ok(takes_core::is_remote_project(storage.as_ref())?)
    })
    .await
}

/// Gets a project from a remote into `dest` and adds it to the list.
#[tauri::command]
pub async fn clone_project(
    app: AppHandle,
    list: State<'_, ProjectList>,
    remote: RemoteConfig,
    password: Option<String>,
    dest: String,
) -> CmdResult<ProjectDto> {
    let progress = progress_emitter(app.clone(), dest.clone());
    let root = blocking(move || {
        let storage = open_storage(&remote, password.clone())?;
        let mut progress = progress;
        let (repo, _) = Repo::clone_from(
            storage.as_ref(),
            &remote,
            &PathBuf::from(&dest),
            &mut progress,
        )?;
        if let Some(password) = password.filter(|p| !p.is_empty()) {
            save_password(&remote, &password)?;
        }
        Ok(repo.root().to_path_buf())
    })
    .await?;
    remember_project(&app, &list, &root)
}
