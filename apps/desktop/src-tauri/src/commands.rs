//! Tauri commands: thin wrappers over `takes_core::Repo`.
//!
//! Each call opens the project afresh (cheap: one SQLite connection) and runs
//! on a blocking thread, since status and saving may hash gigabytes of audio.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use takes_core::Repo;
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

/// A local file the web view can load (via the asset protocol) to play or
/// show a file. `rev: None` means the current, possibly unsaved, file.
/// Stored versions are extracted once into the cache, named by content hash.
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
        let Some(rev) = rev else {
            return Ok(repo.abs(&path)?.display().to_string());
        };
        let entry = repo.file_at(&rev, &path)?;
        let ext = Path::new(&path)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        let target = cache.join(format!("{}{ext}", entry.blob.to_hex()));
        if !target.exists() {
            fs::create_dir_all(&cache)?;
            let tmp = cache.join(format!("{}.partial", entry.blob.to_hex()));
            repo.export(&rev, &path, &tmp)?;
            fs::rename(&tmp, &target)?;
        }
        Ok(target.display().to_string())
    })
    .await
}
