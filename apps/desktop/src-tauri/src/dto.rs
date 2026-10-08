//! Shapes sent to the web UI. Hashes travel as hex strings, names in camelCase.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use takes_core::{
    Branch, Change, ChangeKind, Cleanup, Comment, Conflict, Entry, Error, FileMeta, FileVersion,
    Hash, MergeKind, MergeOutcome, MergePreview, Resolution, Snapshot, Stats, Tag,
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
    /// The content was removed by cleanup: it cannot be played or restored.
    pub pruned: bool,
    /// Labels on the new content ("мастер", …).
    pub labels: Vec<String>,
}

impl From<&Change> for ChangeDto {
    fn from(c: &Change) -> Self {
        Self {
            path: c.path.clone(),
            kind: kind(c.kind),
            size: None,
            pruned: false,
            labels: Vec::new(),
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
    pub labels: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersionDto {
    pub snapshot: SnapshotDto,
    pub kind: &'static str,
    pub size: Option<u64>,
    pub pruned: bool,
    pub labels: Vec<String>,
}

impl FileVersionDto {
    pub fn new(v: &FileVersion, pruned: &HashSet<Hash>, meta: &HashMap<Hash, FileMeta>) -> Self {
        Self {
            snapshot: (&v.snapshot).into(),
            kind: kind(v.kind),
            size: v.entry.map(|e| e.size),
            pruned: v.entry.is_some_and(|e| pruned.contains(&e.blob)),
            labels: labels(meta, v.entry.map(|e| e.blob)),
        }
    }
}

/// Labels of a content, if it has any.
pub fn labels(meta: &HashMap<Hash, FileMeta>, blob: Option<Hash>) -> Vec<String> {
    blob.and_then(|b| meta.get(&b))
        .map(|m| m.labels.clone())
        .unwrap_or_default()
}

/// Labels, tempo and key a musician set on a file content.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetaDto {
    pub labels: Vec<String>,
    pub bpm: Option<f64>,
    pub key: Option<String>,
}

impl From<FileMeta> for FileMetaDto {
    fn from(m: FileMeta) -> Self {
        Self {
            labels: m.labels,
            bpm: m.bpm,
            key: m.key,
        }
    }
}

impl From<FileMetaDto> for FileMeta {
    fn from(m: FileMetaDto) -> Self {
        Self {
            labels: m.labels,
            bpm: m.bpm,
            key: m.key,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDto {
    pub text: String,
    /// Only the beginning of a long file is included.
    pub truncated: bool,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDto {
    pub versions: u64,
    pub contents: u64,
    pub bytes: u64,
}

impl From<Cleanup> for CleanupDto {
    fn from(c: Cleanup) -> Self {
        Self {
            versions: c.versions,
            contents: c.contents,
            bytes: c.bytes,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisDto {
    /// Content hash, identifying the version for caching on the UI side.
    pub blob: String,
    #[serde(flatten)]
    pub analysis: takes_audio::Analysis,
    /// Tempo and key set by hand, which win over the estimates.
    pub manual_bpm: Option<f64>,
    pub manual_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentDto {
    pub id: i64,
    pub snapshot: String,
    pub path: String,
    pub timecode_ms: Option<u64>,
    pub text: String,
    pub author: String,
    pub created_at: i64,
    pub resolved: bool,
}

impl From<&Comment> for CommentDto {
    fn from(c: &Comment) -> Self {
        Self {
            id: c.id,
            snapshot: c.snapshot.to_hex(),
            path: c.path.clone(),
            timecode_ms: c.timecode_ms,
            text: c.text.clone(),
            author: c.author.clone(),
            created_at: c.created_at,
            resolved: c.resolved,
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
            Error::InvalidMeta(_) => "invalidMeta",
            Error::BranchExists(_) => "branchExists",
            Error::TagExists(_) => "tagExists",
            Error::UnbornBranch(_) => "unbornBranch",
            Error::NothingToCommit => "nothingToCommit",
            Error::CannotDeleteCurrentBranch(_) => "cannotDeleteCurrentBranch",
            Error::PathNotFound { .. } => "pathNotFound",
            Error::Corrupt(_) => "corrupt",
            Error::TooNew(_) => "tooNew",
            Error::Remote(_) => "remote",
            Error::RemoteAuth => "remoteAuth",
            Error::RemoteMismatch => "remoteMismatch",
            Error::RemoteNotConfigured => "remoteNotConfigured",
            Error::RemoteNotEmpty => "remoteNotEmpty",
            Error::NotARemote => "notARemote",
            Error::FolderNotEmpty(_) => "folderNotEmpty",
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
            Error::FileChanging(paths) => {
                out.paths = paths.clone();
                "fileChanging"
            }
            Error::ContentPruned(path) => {
                out.paths = vec![path.clone()];
                "contentPruned"
            }
            Error::Busy => "busy",
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
