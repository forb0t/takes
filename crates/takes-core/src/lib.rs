//! Core of takes: version control for arbitrary (mostly large, binary) files.
//!
//! A project is an ordinary folder plus a hidden `.takes` directory holding:
//! - `objects/`: content-defined chunks of file contents, addressed by BLAKE3
//!   hash and compressed with zstd, so unchanged parts of big files are stored
//!   once;
//! - `db.sqlite`: snapshots (versions of the whole project), branches, tags,
//!   comments and a stat cache that keeps `status` fast on large files.
//!
//! The model follows git: a snapshot maps every path to a content hash, a
//! branch points at a snapshot, and merges are three-way. Because binary files
//! cannot be merged line by line, a merge works per file and asks the caller to
//! pick a side (or keep both) when the same file changed on both branches.

mod db;
mod error;
mod hash;
mod merge;
mod model;
mod repo;
mod store;
mod worktree;

pub use error::{Error, Result};
pub use hash::Hash;
pub use merge::{Conflict, MergeKind, MergeOutcome, MergePreview, Resolution};
pub use model::{
    Branch, Change, ChangeKind, Comment, Entry, FileVersion, Snapshot, Stats, Tag, Tree,
};
pub use repo::{DEFAULT_BRANCH, Repo, validate_name};
pub use store::hash_file;
pub use worktree::{IGNORE_FILE, META_DIR};
