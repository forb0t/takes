use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

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
    /// Moved or renamed with its content unchanged: it keeps its history.
    Renamed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub path: String,
    pub kind: ChangeKind,
    /// The earlier path of a renamed file.
    pub from: Option<String>,
}

impl Change {
    pub fn new(path: impl Into<String>, kind: ChangeKind) -> Self {
        Self {
            path: path.into(),
            kind,
            from: None,
        }
    }
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
    /// What the file was called in this snapshot (it may have been renamed since).
    pub path: String,
    /// For a rename, what it was called before.
    pub from: Option<String>,
}

/// A file earlier versions had and the latest one does not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemovedFile {
    pub path: String,
    /// The latest version that still had it: where to bring it back from.
    pub last: Hash,
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

/// Changes that turn `from` into `to`, sorted by path, renames included.
pub fn diff_trees(from: &Tree, to: &Tree) -> Vec<Change> {
    let mut changes = Vec::new();
    for (path, entry) in to {
        let kind = match from.get(path) {
            None => ChangeKind::Added,
            Some(old) if old.blob != entry.blob => ChangeKind::Modified,
            Some(_) => continue,
        };
        changes.push(Change::new(path.clone(), kind));
    }
    for path in from.keys().filter(|p| !to.contains_key(*p)) {
        changes.push(Change::new(path.clone(), ChangeKind::Deleted));
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    pair_renames(changes, |p| from.get(p).copied(), |p| to.get(p).copied())
}

/// Turns a deletion and an addition of the same content into one rename,
/// so a moved or renamed file keeps its history. `old` and `new` give the
/// deleted and the added files. Empty files stay as they are: they all
/// share one content. Pairs are made in path order.
pub(crate) fn pair_renames(
    changes: Vec<Change>,
    old: impl Fn(&str) -> Option<Entry>,
    new: impl Fn(&str) -> Option<Entry>,
) -> Vec<Change> {
    let mut gone: HashMap<Hash, VecDeque<String>> = HashMap::new();
    for c in changes.iter().filter(|c| c.kind == ChangeKind::Deleted) {
        if let Some(entry) = old(&c.path).filter(|e| e.size > 0) {
            gone.entry(entry.blob)
                .or_default()
                .push_back(c.path.clone());
        }
    }
    if gone.is_empty() {
        return changes;
    }
    let mut moved = HashSet::new();
    let mut out: Vec<Change> = changes
        .into_iter()
        .map(|mut c| {
            if c.kind == ChangeKind::Added
                && let Some(entry) = new(&c.path)
                && let Some(from) = gone.get_mut(&entry.blob).and_then(VecDeque::pop_front)
            {
                moved.insert(from.clone());
                c.kind = ChangeKind::Renamed;
                c.from = Some(from);
            }
            c
        })
        .collect();
    out.retain(|c| !(c.kind == ChangeKind::Deleted && moved.contains(&c.path)));
    out
}
