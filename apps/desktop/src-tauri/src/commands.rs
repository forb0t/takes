//! Tauri commands: thin wrappers over `takes_core::Repo`.
//!
//! Each call opens the project afresh (cheap: one SQLite connection) and runs
//! on a blocking thread, since status and saving may hash gigabytes of audio.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use takes_core::{Hash, Repo};
use tauri::{AppHandle, Manager, State};

use crate::dto::*;

pub type CmdResult<T> = Result<T, CommandError>;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(CommandError::other)?
}

fn open(root: &str) -> CmdResult<Repo> {
    Ok(Repo::open(root)?)
}

// ---- recent projects --------------------------------------------------------

/// Serializes reads and writes of the project list file.
#[derive(Default)]
pub struct ProjectList(Mutex<()>);

fn projects_file(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_config_dir()?.join("projects.json"))
}

fn load_projects(app: &AppHandle) -> CmdResult<Vec<ProjectDto>> {
    let file = projects_file(app)?;
    let mut projects: Vec<ProjectDto> = match fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    for p in &mut projects {
        p.exists = Path::new(&p.path).join(takes_core::META_DIR).is_dir();
    }
    Ok(projects)
}

fn save_projects(app: &AppHandle, projects: &[ProjectDto]) -> CmdResult<()> {
    let file = projects_file(app)?;
    fs::create_dir_all(file.parent().expect("config file has a parent"))?;
    let json = serde_json::to_vec_pretty(projects).map_err(CommandError::other)?;
    fs::write(file, json)?;
    Ok(())
}

fn folder_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

#[tauri::command]
pub fn list_projects(app: AppHandle, list: State<ProjectList>) -> CmdResult<Vec<ProjectDto>> {
    let _guard = list.0.lock().unwrap_or_else(|e| e.into_inner());
    load_projects(&app)
}

#[tauri::command]
pub fn is_project(path: String) -> bool {
    Path::new(&path).join(takes_core::META_DIR).is_dir()
}

/// Opens an existing project or, with `create`, turns the folder into one,
/// and puts it at the top of the list.
#[tauri::command]
pub fn add_project(
    app: AppHandle,
    list: State<ProjectList>,
    path: String,
    create: bool,
) -> CmdResult<ProjectDto> {
    let repo = match Repo::open(&path) {
        Err(takes_core::Error::NotAProject(_)) if create => Repo::init(&path)?,
        other => other?,
    };
    let root = repo.root().to_path_buf();
    let project = ProjectDto {
        path: root.display().to_string(),
        name: folder_name(&root),
        exists: true,
    };
    let _guard = list.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut projects = load_projects(&app)?;
    projects.retain(|p| p.path != project.path);
    projects.insert(0, project.clone());
    save_projects(&app, &projects)?;
    Ok(project)
}

/// Forgets a project; its folder and history stay on disk.
#[tauri::command]
pub fn remove_project(app: AppHandle, list: State<ProjectList>, path: String) -> CmdResult<()> {
    let _guard = list.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut projects = load_projects(&app)?;
    projects.retain(|p| p.path != path);
    save_projects(&app, &projects)
}

#[tauri::command]
pub fn reveal(path: String) -> CmdResult<()> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(CommandError::other)
}

// ---- project state ----------------------------------------------------------

#[tauri::command]
pub async fn overview(root: String) -> CmdResult<OverviewDto> {
    blocking(move || {
        let repo = open(&root)?;
        Ok(OverviewDto {
            root: repo.root().display().to_string(),
            name: folder_name(repo.root()),
            branch: repo.current_branch()?,
            head: repo.head()?.map(|h| h.to_hex()),
            author: repo.author()?,
            branches: repo.branches()?.into_iter().map(Into::into).collect(),
            tags: repo.tags()?.into_iter().map(Into::into).collect(),
        })
    })
    .await
}

#[tauri::command]
pub async fn status(root: String) -> CmdResult<Vec<ChangeDto>> {
    blocking(move || Ok(open(&root)?.status()?.iter().map(Into::into).collect())).await
}

#[tauri::command]
pub async fn commit(root: String, message: String, paths: Vec<String>) -> CmdResult<String> {
    blocking(move || {
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        Ok(open(&root)?.commit(&message, &paths)?.to_hex())
    })
    .await
}

#[tauri::command]
pub async fn log(root: String, rev: Option<String>) -> CmdResult<Vec<SnapshotDto>> {
    blocking(move || {
        Ok(open(&root)?
            .log(rev.as_deref())?
            .iter()
            .map(Into::into)
            .collect())
    })
    .await
}

/// Files a version changed, with their new sizes.
#[tauri::command]
pub async fn snapshot_changes(root: String, id: String) -> CmdResult<Vec<ChangeDto>> {
    blocking(move || {
        let repo = open(&root)?;
        let id = repo.resolve(&id)?;
        let tree = repo.tree(id)?;
        Ok(repo
            .changes_in(id)?
            .iter()
            .map(|c| ChangeDto {
                size: tree.get(&c.path).map(|e| e.size),
                ..c.into()
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn files(root: String, rev: String) -> CmdResult<Vec<FileDto>> {
    blocking(move || {
        let repo = open(&root)?;
        let tree = repo.tree(repo.resolve(&rev)?)?;
        Ok(tree
            .into_iter()
            .map(|(path, e)| FileDto { path, size: e.size })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn file_history(root: String, path: String) -> CmdResult<Vec<FileVersionDto>> {
    blocking(move || {
        Ok(open(&root)?
            .file_history(&path, None)?
            .iter()
            .map(Into::into)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn stats(root: String) -> CmdResult<StatsDto> {
    blocking(move || Ok(open(&root)?.stats()?.into())).await
}

#[tauri::command]
pub async fn set_author(root: String, name: String) -> CmdResult<()> {
    blocking(move || Ok(open(&root)?.set_config("user.name", name.trim())?)).await
}

// ---- branches, tags, merging ------------------------------------------------

#[tauri::command]
pub async fn switch_branch(root: String, name: String) -> CmdResult<()> {
    blocking(move || Ok(open(&root)?.switch(&name)?)).await
}

#[tauri::command]
pub async fn create_branch(
    root: String,
    name: String,
    from: Option<String>,
    switch_to: bool,
) -> CmdResult<()> {
    blocking(move || {
        let mut repo = open(&root)?;
        repo.create_branch(name.trim(), from.as_deref())?;
        if switch_to {
            repo.switch(name.trim())?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_branch(root: String, name: String) -> CmdResult<()> {
    blocking(move || Ok(open(&root)?.delete_branch(&name)?)).await
}

#[tauri::command]
pub async fn create_tag(root: String, name: String, rev: String) -> CmdResult<()> {
    blocking(move || {
        open(&root)?.create_tag(name.trim(), &rev)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_tag(root: String, name: String) -> CmdResult<()> {
    blocking(move || Ok(open(&root)?.delete_tag(&name)?)).await
}

#[tauri::command]
pub async fn merge_preview(root: String, rev: String) -> CmdResult<MergePreviewDto> {
    blocking(move || Ok((&open(&root)?.merge_preview(&rev)?).into())).await
}

#[tauri::command]
pub async fn merge(
    root: String,
    rev: String,
    resolutions: HashMap<String, ResolutionDto>,
) -> CmdResult<MergeOutcomeDto> {
    blocking(move || {
        let outcome =
            open(&root)?.merge(&rev, |c| resolutions.get(&c.path).map(|r| (*r).into()))?;
        Ok((&outcome).into())
    })
    .await
}

// ---- files --------------------------------------------------------------------

/// Puts a file back as it was in `rev`, in place or as a copy at `dest`.
#[tauri::command]
pub async fn restore(
    root: String,
    path: String,
    rev: String,
    dest: Option<String>,
    force: bool,
) -> CmdResult<()> {
    blocking(move || Ok(open(&root)?.restore(&path, &rev, dest.as_deref(), force)?)).await
}

/// Copies a stored file version into the app cache (named by content hash,
/// so each version is extracted once) and returns that copy and the hash.
fn extract_version(repo: &Repo, cache: &Path, rev: &str, path: &str) -> CmdResult<(PathBuf, Hash)> {
    static NEXT_TMP: AtomicU64 = AtomicU64::new(0);
    let entry = repo.file_at(rev, path)?;
    let ext = Path::new(path)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let target = cache.join(format!("{}{ext}", entry.blob.to_hex()));
    if !target.exists() {
        fs::create_dir_all(cache)?;
        // Unique temp name: playback and analysis may extract the same
        // version at the same time.
        let n = NEXT_TMP.fetch_add(1, Ordering::Relaxed);
        let tmp = cache.join(format!(
            "{}.{}.{n}.partial",
            entry.blob.to_hex(),
            std::process::id()
        ));
        repo.export(rev, path, &tmp)?;
        fs::rename(&tmp, &target)?;
    }
    Ok((target, entry.blob))
}

/// The local file holding a version (`rev: None` = the file on disk now).
fn local_file(
    repo: &Repo,
    cache: &Path,
    rev: Option<&str>,
    path: &str,
) -> CmdResult<(PathBuf, Hash)> {
    match rev {
        Some(rev) => extract_version(repo, cache, rev, path),
        None => {
            let abs = repo.abs(path)?;
            let (hash, _) = takes_core::hash_file(&abs)?;
            Ok((abs, hash))
        }
    }
}

/// A local file the web view can load (via the asset protocol) to play or
/// show a file. `rev: None` means the current, possibly unsaved, file.
#[tauri::command]
pub async fn preview_file(
    app: AppHandle,
    root: String,
    rev: Option<String>,
    path: String,
) -> CmdResult<String> {
    let cache = app.path().app_cache_dir()?.join("previews");
    blocking(move || {
        let repo = open(&root)?;
        let file = match rev {
            None => repo.abs(&path)?,
            Some(rev) => extract_version(&repo, &cache, &rev, &path)?.0,
        };
        Ok(file.display().to_string())
    })
    .await
}

// ---- audio ------------------------------------------------------------------

/// Waveform and loudness of a file version, cached by content hash.
#[tauri::command]
pub async fn analyze_audio(
    app: AppHandle,
    root: String,
    rev: Option<String>,
    path: String,
) -> CmdResult<AnalysisDto> {
    let cache = app.path().app_cache_dir()?;
    blocking(move || {
        let repo = open(&root)?;
        let (file, hash) = local_file(&repo, &cache.join("previews"), rev.as_deref(), &path)?;
        let dir = cache.join("analysis");
        let cached = dir.join(format!("v1-{}.json", hash.to_hex()));
        if let Ok(analysis) = fs::read(&cached)
            .map_err(CommandError::from)
            .and_then(|b| serde_json::from_slice(&b).map_err(CommandError::other))
        {
            return Ok(AnalysisDto {
                blob: hash.to_hex(),
                analysis,
            });
        }
        let analysis = takes_audio::analyze(&file).map_err(|e| CommandError {
            kind: "notAudio",
            ..CommandError::other(e)
        })?;
        fs::create_dir_all(&dir)?;
        let tmp = dir.join(format!("{}.{}.partial", hash.to_hex(), std::process::id()));
        fs::write(
            &tmp,
            serde_json::to_vec(&analysis).map_err(CommandError::other)?,
        )?;
        fs::rename(&tmp, &cached)?;
        Ok(AnalysisDto {
            blob: hash.to_hex(),
            analysis,
        })
    })
    .await
}

/// Comments on this exact content of the file (resolved ones included).
#[tauri::command]
pub async fn comments(
    root: String,
    rev: Option<String>,
    path: String,
) -> CmdResult<Vec<CommentDto>> {
    blocking(move || {
        let repo = open(&root)?;
        let blob = match rev {
            Some(rev) => repo.file_at(&rev, &path)?.blob,
            None => takes_core::hash_file(&repo.abs(&path)?)?.0,
        };
        Ok(repo
            .comments_on_content(&path, blob, true)?
            .iter()
            .map(Into::into)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn add_comment(
    root: String,
    rev: Option<String>,
    path: String,
    timecode_ms: Option<u64>,
    text: String,
) -> CmdResult<i64> {
    blocking(move || {
        let repo = open(&root)?;
        let rev = match rev {
            Some(rev) => rev,
            // The file on disk can be commented only if it is saved as is.
            None => {
                let current = takes_core::hash_file(&repo.abs(&path)?)?.0;
                match repo.file_at("HEAD", &path) {
                    Ok(saved) if saved.blob == current => "HEAD".to_owned(),
                    _ => {
                        return Err(CommandError {
                            kind: "unsavedFile",
                            ..CommandError::other("save a version to comment on this file")
                        });
                    }
                }
            }
        };
        Ok(repo.add_comment(&rev, &path, timecode_ms, text.trim())?)
    })
    .await
}

#[tauri::command]
pub async fn resolve_comment(root: String, id: i64) -> CmdResult<()> {
    blocking(move || Ok(open(&root)?.resolve_comment(id)?)).await
}
