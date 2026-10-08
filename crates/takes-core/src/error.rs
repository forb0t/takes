use std::path::PathBuf;

use crate::model::Change;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not a takes project: no .takes folder in {0} or its parents")]
    NotAProject(PathBuf),
    #[error("a takes project already exists in {0}")]
    AlreadyInitialized(PathBuf),
    #[error("unknown version '{0}'")]
    UnknownRevision(String),
    #[error("'{0}' matches more than one version, use more characters")]
    AmbiguousRevision(String),
    #[error("invalid name '{0}'")]
    InvalidName(String),
    #[error("invalid path '{0}'")]
    InvalidPath(String),
    #[error("invalid {0}: labels take up to 40 characters, keys up to 12, tempo 20–400 BPM")]
    InvalidMeta(String),
    #[error("branch '{0}' already exists")]
    BranchExists(String),
    #[error("tag '{0}' already exists")]
    TagExists(String),
    #[error("no branch named '{0}'")]
    NoSuchBranch(String),
    #[error("no tag named '{0}'")]
    NoSuchTag(String),
    #[error("branch '{0}' has no saved versions yet")]
    UnbornBranch(String),
    #[error("cannot delete '{0}': it is the current branch")]
    CannotDeleteCurrentBranch(String),
    #[error("nothing to save: no changes")]
    NothingToCommit,
    #[error("there are unsaved changes")]
    DirtyWorktree(Vec<Change>),
    #[error("files that are not saved in the project would be overwritten")]
    WouldOverwrite(Vec<String>),
    #[error("files are open in another program or read-only")]
    FileBusy(Vec<String>),
    #[error("files changed while being saved; another program is still writing them")]
    FileChanging(Vec<String>),
    #[error("the content of '{0}' in this version was removed to free space")]
    ContentPruned(String),
    #[error("another operation on this project is running; try again when it ends")]
    Busy,
    #[error("'{path}' does not exist in version {rev}")]
    PathNotFound { path: String, rev: String },
    #[error("no comment with id {0}")]
    NoSuchComment(i64),
    #[error("folder {0} is not empty")]
    FolderNotEmpty(PathBuf),
    #[error("cannot reach the remote: {0}")]
    Remote(String),
    #[error("the remote rejected the login or password")]
    RemoteAuth,
    #[error("this remote belongs to another project")]
    RemoteMismatch,
    #[error("no remote is set up for this project")]
    RemoteNotConfigured,
    #[error("the remote folder is not empty and does not hold a takes project")]
    RemoteNotEmpty,
    #[error("no takes project found at the remote")]
    NotARemote,
    #[error("{0} was made by a newer version of takes; update takes to open it")]
    TooNew(&'static str),
    #[error("project data is damaged: {0}")]
    Corrupt(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
}
