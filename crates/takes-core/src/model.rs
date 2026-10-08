use std::collections::BTreeMap;

use crate::hash::Hash;

/// One file inside a snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    pub blob: Hash,
    pub size: u64,
}

/// Full contents of a snapshot: project-relative path (with `/`) → file.
pub type Tree = BTreeMap<String, Entry>;

/// A saved version of the whole project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub id: Hash,
    /// Empty for the first version, two entries for a merge.
    pub parents: Vec<Hash>,
    pub message: String,
    pub author: String,
    /// Unix seconds.
    pub created_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub path: String,
    pub kind: ChangeKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Branch {
    pub name: String,
    /// `None` only for the current branch before its first version.
    pub head: Option<Hash>,
    pub current: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tag {
    pub name: String,
    pub target: Hash,
}

/// A snapshot in which a particular file changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileVersion {
    pub snapshot: Snapshot,
    /// `None` when the file was deleted in this snapshot.
    pub entry: Option<Entry>,
    pub kind: ChangeKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Comment {
    pub id: i64,
    pub snapshot: Hash,
    pub path: String,
    /// Position in an audio/video file the comment refers to.
    pub timecode_ms: Option<u64>,
    pub text: String,
    pub author: String,
    pub created_at: i64,
    pub resolved: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub snapshots: u64,
    /// Distinct file contents ever saved.
    pub blobs: u64,
    /// Sum of the sizes of those contents, i.e. space without deduplication.
    pub content_bytes: u64,
    pub chunks: u64,
    /// Space the object store actually takes on disk.
    pub stored_bytes: u64,
}

/// Changes that turn `from` into `to`, sorted by path.
pub fn diff_trees(from: &Tree, to: &Tree) -> Vec<Change> {
    let mut changes = Vec::new();
    for (path, entry) in to {
        let kind = match from.get(path) {
            None => ChangeKind::Added,
            Some(old) if old.blob != entry.blob => ChangeKind::Modified,
            Some(_) => continue,
        };
        changes.push(Change {
            path: path.clone(),
            kind,
        });
    }
    for path in from.keys().filter(|p| !to.contains_key(*p)) {
        changes.push(Change {
            path: path.clone(),
            kind: ChangeKind::Deleted,
        });
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    changes
}
