//! Shapes sent to the web UI. Hashes travel as hex strings, names in camelCase.

use serde::{Deserialize, Serialize};
use takes_core::{
    Branch, Change, ChangeKind, Conflict, Entry, Error, FileVersion, MergeKind, MergeOutcome,
    MergePreview, Resolution, Snapshot, Stats, Tag,
};

fn kind(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::Added => "added",
        ChangeKind::Modified => "modified",
        ChangeKind::Deleted => "deleted",
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDto {
    pub path: String,
    pub kind: &'static str,
    /// Size of the new content; absent for deletions and plain status.
    pub size: Option<u64>,
}

impl From<&Change> for ChangeDto {
    fn from(c: &Change) -> Self {
        Self {
            path: c.path.clone(),
            kind: kind(c.kind),
            size: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDto {
    pub id: String,
    pub parents: Vec<String>,
    pub message: String,
    pub author: String,
    pub created_at: i64,
}

impl From<&Snapshot> for SnapshotDto {
    fn from(s: &Snapshot) -> Self {
        Self {
            id: s.id.to_hex(),
            parents: s.parents.iter().map(|p| p.to_hex()).collect(),
            message: s.message.clone(),
            author: s.author.clone(),
            created_at: s.created_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDto {
    pub name: String,
    pub head: Option<String>,
    pub current: bool,
}

impl From<Branch> for BranchDto {
    fn from(b: Branch) -> Self {
        Self {
            name: b.name,
            head: b.head.map(|h| h.to_hex()),
            current: b.current,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDto {
    pub name: String,
    pub target: String,
}

impl From<Tag> for TagDto {
    fn from(t: Tag) -> Self {
        Self {
            name: t.name,
            target: t.target.to_hex(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewDto {
    pub root: String,
    pub name: String,
    pub branch: String,
    pub head: Option<String>,
    pub author: String,
    pub branches: Vec<BranchDto>,
    pub tags: Vec<TagDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDto {
    pub path: String,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersionDto {
    pub snapshot: SnapshotDto,
    pub kind: &'static str,
    pub size: Option<u64>,
}

impl From<&FileVersion> for FileVersionDto {
    fn from(v: &FileVersion) -> Self {
        Self {
            snapshot: (&v.snapshot).into(),
            kind: kind(v.kind),
            size: v.entry.map(|e| e.size),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideDto {
    pub blob: String,
    pub size: u64,
}

fn side(entry: Option<Entry>) -> Option<SideDto> {
    entry.map(|e| SideDto {
        blob: e.blob.to_hex(),
        size: e.size,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDto {
    pub path: String,
    pub ours: Option<SideDto>,
    pub theirs: Option<SideDto>,
}

impl From<&Conflict> for ConflictDto {
    fn from(c: &Conflict) -> Self {
        Self {
            path: c.path.clone(),
            ours: side(c.ours),
            theirs: side(c.theirs),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreviewDto {
    pub kind: &'static str,
    pub changes: Vec<ChangeDto>,
    pub conflicts: Vec<ConflictDto>,
}

impl From<&MergePreview> for MergePreviewDto {
    fn from(p: &MergePreview) -> Self {
        Self {
            kind: match p.kind {
                MergeKind::UpToDate => "upToDate",
                MergeKind::FastForward => "fastForward",
                MergeKind::Merge => "merge",
            },
            changes: p.changes.iter().map(Into::into).collect(),
            conflicts: p.conflicts.iter().map(Into::into).collect(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcomeDto {
    pub kind: &'static str,
    pub id: Option<String>,
    pub conflicts: Vec<ConflictDto>,
}

impl From<&MergeOutcome> for MergeOutcomeDto {
    fn from(o: &MergeOutcome) -> Self {
        let (kind, id, conflicts) = match o {
            MergeOutcome::UpToDate => ("upToDate", None, Vec::new()),
            MergeOutcome::FastForward(id) => ("fastForward", Some(id.to_hex()), Vec::new()),
            MergeOutcome::Merged(id) => ("merged", Some(id.to_hex()), Vec::new()),
            MergeOutcome::Conflicts(c) => ("conflicts", None, c.iter().map(Into::into).collect()),
        };
        Self {
            kind,
            id,
            conflicts,
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolutionDto {
    Ours,
    Theirs,
    Both,
}

impl From<ResolutionDto> for Resolution {
    fn from(r: ResolutionDto) -> Self {
        match r {
            ResolutionDto::Ours => Resolution::Ours,
            ResolutionDto::Theirs => Resolution::Theirs,
            ResolutionDto::Both => Resolution::Both,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsDto {
    pub snapshots: u64,
    pub content_bytes: u64,
    pub stored_bytes: u64,
}

impl From<Stats> for StatsDto {
    fn from(s: Stats) -> Self {
        Self {
            snapshots: s.snapshots,
            content_bytes: s.content_bytes,
            stored_bytes: s.stored_bytes,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    pub path: String,
    pub name: String,
    /// False when the folder was moved or deleted since it was added.
    #[serde(default)]
    pub exists: bool,
}

/// Error as the UI sees it: `kind` drives the UI's reaction and wording.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub kind: &'static str,
    pub message: String,
    /// Unsaved changes, for `dirtyWorktree`.
    pub changes: Vec<ChangeDto>,
    /// Files in the way, for `wouldOverwrite`.
    pub paths: Vec<String>,
}

impl CommandError {
    pub fn other(message: impl ToString) -> Self {
        Self {
            kind: "other",
            message: message.to_string(),
            changes: Vec::new(),
            paths: Vec::new(),
        }
    }
}

impl From<Error> for CommandError {
    fn from(e: Error) -> Self {
        let mut out = Self::other(&e);
        out.kind = match &e {
            Error::NotAProject(_) => "notAProject",
            Error::AlreadyInitialized(_) => "alreadyInitialized",
            Error::InvalidName(_) => "invalidName",
            Error::InvalidPath(_) => "invalidPath",
            Error::BranchExists(_) => "branchExists",
            Error::TagExists(_) => "tagExists",
            Error::UnbornBranch(_) => "unbornBranch",
            Error::NothingToCommit => "nothingToCommit",
            Error::CannotDeleteCurrentBranch(_) => "cannotDeleteCurrentBranch",
            Error::PathNotFound { .. } => "pathNotFound",
            Error::Corrupt(_) => "corrupt",
            Error::DirtyWorktree(changes) => {
                out.changes = changes.iter().map(Into::into).collect();
                "dirtyWorktree"
            }
            Error::WouldOverwrite(paths) => {
                out.paths = paths.clone();
                "wouldOverwrite"
            }
            Error::FileBusy(paths) => {
                out.paths = paths.clone();
                "fileBusy"
            }
            _ => "other",
        };
        out
    }
}

impl From<std::io::Error> for CommandError {
    fn from(e: std::io::Error) -> Self {
        Self::other(e)
    }
}

impl From<tauri::Error> for CommandError {
    fn from(e: tauri::Error) -> Self {
        Self::other(e)
    }
}
