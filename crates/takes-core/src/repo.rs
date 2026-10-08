use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};

use crate::db;
use crate::error::{Error, Result};
use crate::hash::Hash;
use crate::merge::{self, Conflict, MergeKind, MergeOutcome, MergePreview, Resolution, ThreeWay};
use crate::model::{
    Branch, Change, ChangeKind, Comment, Entry, FileVersion, Snapshot, Stats, Tag, Tree, diff_trees,
};
use crate::store::{self, Blob, ObjectStore};
use crate::worktree::{self, META_DIR};

mod sync;
pub use sync::{
    Blocked, Diverged, SyncPhase, SyncProgress, SyncReport, SyncState, find_remote_projects,
    is_remote_project,
};

pub const DEFAULT_BRANCH: &str = "main";

const BRANCH: &str = "branch";
const TAG: &str = "tag";

/// Files modified this recently are re-hashed on every scan: a second quick
/// write may leave size and mtime unchanged (the "racy git" problem, worse on
/// FAT/exFAT drives with 2-second timestamps).
const RACY_WINDOW_NS: i64 = 2_000_000_000;

const UPSERT_REF: &str = "INSERT INTO refs (kind, name, snapshot_id) VALUES (?1, ?2, ?3)
     ON CONFLICT (kind, name) DO UPDATE SET snapshot_id = excluded.snapshot_id";

/// An open project: the working folder plus its `.takes` data.
pub struct Repo {
    root: PathBuf,
    store: ObjectStore,
    conn: Connection,
}

impl Repo {
    /// Turns `path` (created if missing) into an empty project on `main`.
    pub fn init(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        fs::create_dir_all(path)?;
        let root = dunce::canonicalize(path)?;
        let meta = root.join(META_DIR);
        if meta.exists() {
            return Err(Error::AlreadyInitialized(root));
        }
        fs::create_dir(&meta)?;
        fs::create_dir(meta.join("objects"))?;
        let conn = db::open(&meta.join("db.sqlite"))?;
        conn.execute(
            "INSERT INTO head (id, branch) VALUES (1, ?1)",
            [DEFAULT_BRANCH],
        )?;
        Ok(Self {
            store: ObjectStore::new(meta.join("objects")),
            root,
            conn,
        })
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let root = dunce::canonicalize(path)?;
        let meta = root.join(META_DIR);
        if !meta.is_dir() {
            return Err(Error::NotAProject(root));
        }
        let conn = db::open(&meta.join("db.sqlite"))?;
        Ok(Self {
            store: ObjectStore::new(meta.join("objects")),
            root,
            conn,
        })
    }

    /// Opens the project containing `start` (or any of its parents).
    pub fn discover(start: impl AsRef<Path>) -> Result<Self> {
        let start = dunce::canonicalize(start)?;
        match start.ancestors().find(|dir| dir.join(META_DIR).is_dir()) {
            Some(root) => Self::open(root),
            None => Err(Error::NotAProject(start)),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    // ---- settings -------------------------------------------------------

    pub fn config(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM config WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_config(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO config (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    /// `user.name` from the project settings, else the OS user name.
    pub fn author(&self) -> Result<String> {
        if let Some(name) = self.config("user.name")? {
            return Ok(name);
        }
        Ok(std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_else(|_| "unknown".into()))
    }

    // ---- branches and tags ----------------------------------------------

    pub fn current_branch(&self) -> Result<String> {
        Ok(self
            .conn
            .query_row("SELECT branch FROM head WHERE id = 1", [], |r| r.get(0))?)
    }

    /// Latest version on the current branch; `None` before the first save.
    pub fn head(&self) -> Result<Option<Hash>> {
        self.ref_target(BRANCH, &self.current_branch()?)
    }

    fn ref_target(&self, kind: &str, name: &str) -> Result<Option<Hash>> {
        Ok(self
            .conn
            .query_row(
                "SELECT snapshot_id FROM refs WHERE kind = ?1 AND name = ?2",
                [kind, name],
                |r| r.get(0),
            )
            .optional()?)
    }

    fn refs(&self, kind: &str) -> Result<Vec<(String, Hash)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT name, snapshot_id FROM refs WHERE kind = ?1 ORDER BY name")?;
        let rows = stmt.query_map([kind], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn branches(&self) -> Result<Vec<Branch>> {
        let current = self.current_branch()?;
        let mut branches: Vec<Branch> = self
            .refs(BRANCH)?
            .into_iter()
            .map(|(name, id)| Branch {
                current: name == current,
                name,
                head: Some(id),
            })
            .collect();
        if !branches.iter().any(|b| b.current) {
            branches.push(Branch {
                name: current,
                head: None,
                current: true,
            });
            branches.sort_by(|a, b| a.name.cmp(&b.name));
        }
        Ok(branches)
    }

    /// New branch at `from` (default: the current version). Does not switch.
    pub fn create_branch(&mut self, name: &str, from: Option<&str>) -> Result<Hash> {
        validate_name(name)?;
        if self.ref_target(BRANCH, name)?.is_some() || name == self.current_branch()? {
            return Err(Error::BranchExists(name.into()));
        }
        let id = self.resolve(from.unwrap_or("HEAD"))?;
        self.conn.execute(
            "INSERT INTO refs (kind, name, snapshot_id) VALUES (?1, ?2, ?3)",
            params![BRANCH, name, id],
        )?;
        Ok(id)
    }

    pub fn delete_branch(&mut self, name: &str) -> Result<()> {
        if name == self.current_branch()? {
            return Err(Error::CannotDeleteCurrentBranch(name.into()));
        }
        let deleted = self.conn.execute(
            "DELETE FROM refs WHERE kind = ?1 AND name = ?2",
            [BRANCH, name],
        )?;
        if deleted == 0 {
            return Err(Error::NoSuchBranch(name.into()));
        }
        Ok(())
    }

    pub fn tags(&self) -> Result<Vec<Tag>> {
        Ok(self
            .refs(TAG)?
            .into_iter()
            .map(|(name, target)| Tag { name, target })
            .collect())
    }

    /// Marks a version, e.g. "master-v1" for what was sent to the label.
    pub fn create_tag(&mut self, name: &str, rev: &str) -> Result<Hash> {
        validate_name(name)?;
        if self.ref_target(TAG, name)?.is_some() {
            return Err(Error::TagExists(name.into()));
        }
        let id = self.resolve(rev)?;
        self.conn.execute(
            "INSERT INTO refs (kind, name, snapshot_id) VALUES (?1, ?2, ?3)",
            params![TAG, name, id],
        )?;
        Ok(id)
    }

    pub fn delete_tag(&mut self, name: &str) -> Result<()> {
        let deleted = self.conn.execute(
            "DELETE FROM refs WHERE kind = ?1 AND name = ?2",
            [TAG, name],
        )?;
        if deleted == 0 {
            return Err(Error::NoSuchTag(name.into()));
        }
        Ok(())
    }

    // ---- reading history ------------------------------------------------

    /// Accepts `HEAD`, a branch, a tag or an id prefix (4+ hex chars), each
    /// optionally followed by `~N` to go N versions back.
    pub fn resolve(&self, rev: &str) -> Result<Hash> {
        let unknown = || Error::UnknownRevision(rev.into());
        let (base, steps) = match rev.split_once('~') {
            Some((base, "")) => (base, 1),
            Some((base, n)) => (base, n.parse::<usize>().map_err(|_| unknown())?),
            None => (rev, 0),
        };
        let mut id = self.resolve_base(base).map_err(|e| match e {
            Error::UnknownRevision(_) => unknown(),
            e => e,
        })?;
        for _ in 0..steps {
            id = *self.parents(id)?.first().ok_or_else(unknown)?;
        }
        Ok(id)
    }

    fn resolve_base(&self, base: &str) -> Result<Hash> {
        if base == "HEAD" {
            return self.head()?.ok_or_else(|| {
                Error::UnbornBranch(self.current_branch().unwrap_or_else(|_| "HEAD".into()))
            });
        }
        for kind in [BRANCH, TAG] {
            if let Some(id) = self.ref_target(kind, base)? {
                return Ok(id);
            }
        }
        if (4..=64).contains(&base.len()) && base.bytes().all(|b| b.is_ascii_hexdigit()) {
            let mut stmt = self
                .conn
                .prepare("SELECT id FROM snapshots WHERE hex(id) LIKE ?1 LIMIT 2")?;
            let ids = stmt
                .query_map([format!("{}%", base.to_ascii_uppercase())], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<Hash>>>()?;
            match ids.as_slice() {
                [id] => return Ok(*id),
                [_, _] => return Err(Error::AmbiguousRevision(base.into())),
                _ => {}
            }
        }
        if let Some(id) = self.resolve_remote_head(base)? {
            return Ok(id);
        }
        Err(Error::UnknownRevision(base.into()))
    }

    pub fn snapshot(&self, id: Hash) -> Result<Snapshot> {
        let (message, author, created_at) = self
            .conn
            .query_row(
                "SELECT message, author, created_at FROM snapshots WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| Error::UnknownRevision(id.to_hex()))?;
        Ok(Snapshot {
            id,
            parents: self.parents(id)?,
            message,
            author,
            created_at,
        })
    }

    fn parents(&self, id: Hash) -> Result<Vec<Hash>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT parent_id FROM snapshot_parents WHERE snapshot_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map([id], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// All files of a version.
    pub fn tree(&self, id: Hash) -> Result<Tree> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT path, blob_hash, size FROM snapshot_entries WHERE snapshot_id = ?1",
        )?;
        let rows = stmt.query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Entry {
                    blob: r.get(1)?,
                    size: r.get::<_, i64>(2)? as u64,
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn head_tree(&self) -> Result<Tree> {
        match self.head()? {
            Some(id) => self.tree(id),
            None => Ok(Tree::new()),
        }
    }

    fn entry(&self, id: Hash, path: &str) -> Result<Option<Entry>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT blob_hash, size FROM snapshot_entries WHERE snapshot_id = ?1 AND path = ?2",
        )?;
        Ok(stmt
            .query_row(params![id, path], |r| {
                Ok(Entry {
                    blob: r.get(0)?,
                    size: r.get::<_, i64>(1)? as u64,
                })
            })
            .optional()?)
    }

    fn graph(&self) -> Result<Graph> {
        let mut graph = Graph::default();
        let mut stmt = self.conn.prepare("SELECT id, created_at FROM snapshots")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, Hash>(0)?, r.get::<_, i64>(1)?)))? {
            let (id, time) = row?;
            graph.time.insert(id, time);
        }
        let mut stmt = self.conn.prepare(
            "SELECT snapshot_id, parent_id FROM snapshot_parents ORDER BY snapshot_id, position",
        )?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, Hash>(0)?, r.get::<_, Hash>(1)?)))? {
            let (id, parent) = row?;
            graph.parents.entry(id).or_default().push(parent);
        }
        Ok(graph)
    }

    /// Versions reachable from `rev` (default: current branch), newest first.
    pub fn log(&self, rev: Option<&str>) -> Result<Vec<Snapshot>> {
        let head = match rev {
            Some(rev) => self.resolve(rev)?,
            None => match self.head()? {
                Some(id) => id,
                None => return Ok(Vec::new()),
            },
        };
        self.graph()?
            .topo_order(head)
            .into_iter()
            .map(|id| self.snapshot(id))
            .collect()
    }

    /// Versions in which `path` was added, changed or deleted, newest first.
    pub fn file_history(&self, path: &str, rev: Option<&str>) -> Result<Vec<FileVersion>> {
        let mut versions = Vec::new();
        for snapshot in self.log(rev)? {
            let entry = self.entry(snapshot.id, path)?;
            let before = match snapshot.parents.first() {
                Some(parent) => self.entry(*parent, path)?,
                None => None,
            };
            let kind = match (before, entry) {
                (None, Some(_)) => ChangeKind::Added,
                (Some(_), None) => ChangeKind::Deleted,
                (Some(a), Some(b)) if a.blob != b.blob => ChangeKind::Modified,
                _ => continue,
            };
            versions.push(FileVersion {
                snapshot,
                entry,
                kind,
            });
        }
        Ok(versions)
    }

    /// What a version changed compared to its first parent.
    pub fn changes_in(&self, id: Hash) -> Result<Vec<Change>> {
        let before = match self.parents(id)?.first() {
            Some(parent) => self.tree(*parent)?,
            None => Tree::new(),
        };
        Ok(diff_trees(&before, &self.tree(id)?))
    }

    /// A file as stored in a version.
    pub fn file_at(&self, rev: &str, path: &str) -> Result<Entry> {
        self.entry(self.resolve(rev)?, path)?
            .ok_or_else(|| Error::PathNotFound {
                path: path.into(),
                rev: rev.into(),
            })
    }

    /// Streams one file of a version, e.g. into an audio player or a file
    /// outside the project, without touching the working folder.
    pub fn read_file(&self, rev: &str, path: &str, out: &mut impl Write) -> Result<()> {
        let entry = self.file_at(rev, path)?;
        self.store.write_blob(&self.blob(entry.blob)?, out)
    }

    pub fn export(&self, rev: &str, path: &str, dest: &Path) -> Result<()> {
        let mut out = BufWriter::new(File::create(dest)?);
        self.read_file(rev, path, &mut out)?;
        out.flush()?;
        Ok(())
    }

    fn blob(&self, hash: Hash) -> Result<Blob> {
        let (size, chunks): (i64, Vec<u8>) = self
            .conn
            .query_row(
                "SELECT size, chunks FROM blobs WHERE hash = ?1",
                [hash],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| Error::Corrupt(format!("missing content {hash}")))?;
        Ok(Blob {
            hash,
            size: size as u64,
            chunks: store::chunks_from_bytes(&chunks)?,
        })
    }

    // ---- working folder -------------------------------------------------

    /// Where a project path lives in the working folder.
    pub fn abs(&self, path: &str) -> Result<PathBuf> {
        worktree::to_abs(&self.root, path)
    }

    fn scan_worktree(&self) -> Result<Tree> {
        let files = worktree::scan(&self.root)?;
        let mut cache = HashMap::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT path, size, mtime_ns, blob_hash FROM worktree_cache")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (
                        r.get::<_, i64>(1)? as u64,
                        r.get::<_, i64>(2)?,
                        r.get::<_, Hash>(3)?,
                    ),
                ))
            })?;
            for row in rows {
                let (path, cached) = row?;
                cache.insert(path, cached);
            }
        }
        let mut tree = Tree::new();
        for file in files {
            let blob = match cache.get(&file.path) {
                Some(&(size, mtime, hash)) if size == file.size && mtime == file.mtime_ns => hash,
                _ => {
                    let (hash, _) = store::hash_file(&file.abs)?;
                    self.cache_put(&file.path, file.size, file.mtime_ns, hash)?;
                    hash
                }
            };
            tree.insert(
                file.path,
                Entry {
                    blob,
                    size: file.size,
                },
            );
        }
        Ok(tree)
    }

    fn cache_put(&self, path: &str, size: u64, mtime_ns: i64, hash: Hash) -> Result<()> {
        if mtime_ns > now_ns() - RACY_WINDOW_NS {
            self.conn
                .execute("DELETE FROM worktree_cache WHERE path = ?1", [path])?;
            return Ok(());
        }
        self.conn.execute(
            "INSERT INTO worktree_cache (path, size, mtime_ns, blob_hash) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (path) DO UPDATE SET
                 size = excluded.size, mtime_ns = excluded.mtime_ns, blob_hash = excluded.blob_hash",
            params![path, size as i64, mtime_ns, hash],
        )?;
        Ok(())
    }

    /// Differences between the working folder and the current version.
    pub fn status(&self) -> Result<Vec<Change>> {
        Ok(diff_trees(&self.head_tree()?, &self.scan_worktree()?))
    }

    fn ensure_clean(&self) -> Result<()> {
        let changes = self.status()?;
        if changes.is_empty() {
            Ok(())
        } else {
            Err(Error::DirtyWorktree(changes))
        }
    }

    /// Saves a new version of the changed files under `paths` (files or
    /// folders; empty = everything) on the current branch.
    pub fn commit(&mut self, message: &str, paths: &[&str]) -> Result<Hash> {
        let branch = self.current_branch()?;
        let head = self.head()?;
        let mut tree = self.head_tree()?;
        let selected: Vec<Change> = diff_trees(&tree, &self.scan_worktree()?)
            .into_iter()
            .filter(|c| paths.is_empty() || paths.iter().any(|p| path_matches(p, &c.path)))
            .collect();
        if selected.is_empty() {
            return Err(Error::NothingToCommit);
        }
        let mut blobs = Vec::new();
        for change in selected {
            if change.kind == ChangeKind::Deleted {
                tree.remove(&change.path);
                continue;
            }
            let blob = self.store.put_file(&self.abs(&change.path)?)?;
            tree.insert(
                change.path,
                Entry {
                    blob: blob.hash,
                    size: blob.size,
                },
            );
            blobs.push(blob);
        }
        let parents: Vec<Hash> = head.into_iter().collect();
        self.write_snapshot(&branch, &parents, message, &tree, &blobs)
    }

    fn write_snapshot(
        &mut self,
        branch: &str,
        parents: &[Hash],
        message: &str,
        tree: &Tree,
        new_blobs: &[Blob],
    ) -> Result<Hash> {
        let author = self.author()?;
        let created_at = now_secs();
        let id = snapshot_id(parents, &author, message, created_at, tree);
        let tx = self.conn.transaction()?;
        {
            let mut put_blob =
                tx.prepare("INSERT OR IGNORE INTO blobs (hash, size, chunks) VALUES (?1, ?2, ?3)")?;
            for blob in new_blobs {
                put_blob.execute(params![
                    blob.hash,
                    blob.size as i64,
                    store::chunks_to_bytes(&blob.chunks)
                ])?;
            }
            tx.execute(
                "INSERT INTO snapshots (id, message, author, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, message, author, created_at],
            )?;
            let mut put_parent = tx.prepare(
                "INSERT INTO snapshot_parents (snapshot_id, position, parent_id) VALUES (?1, ?2, ?3)",
            )?;
            for (position, parent) in parents.iter().enumerate() {
                put_parent.execute(params![id, position as i64, parent])?;
            }
            let mut put_entry = tx.prepare(
                "INSERT INTO snapshot_entries (snapshot_id, path, blob_hash, size)
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (path, entry) in tree {
                put_entry.execute(params![id, path, entry.blob, entry.size as i64])?;
            }
            tx.execute(UPSERT_REF, params![BRANCH, branch, id])?;
        }
        tx.commit()?;
        Ok(id)
    }

    /// Moves to another branch, replacing the working files with its latest
    /// version. Refuses when there are unsaved changes.
    pub fn switch(&mut self, name: &str) -> Result<()> {
        if name == self.current_branch()? {
            return Ok(());
        }
        let target = self
            .ref_target(BRANCH, name)?
            .ok_or_else(|| Error::NoSuchBranch(name.into()))?;
        self.ensure_clean()?;
        self.apply_tree(&self.head_tree()?, &self.tree(target)?)?;
        self.conn
            .execute("UPDATE head SET branch = ?1 WHERE id = 1", [name])?;
        Ok(())
    }

    /// Brings `path` back as it was in `rev`, at `dest` (default: in place).
    /// The result shows up as an unsaved change. Without `force`, refuses to
    /// replace content that is not saved in the current version.
    pub fn restore(&self, path: &str, rev: &str, dest: Option<&str>, force: bool) -> Result<()> {
        let id = self.resolve(rev)?;
        let entry = self.entry(id, path)?.ok_or_else(|| Error::PathNotFound {
            path: path.into(),
            rev: rev.into(),
        })?;
        let target = dest.unwrap_or(path);
        let abs = self.abs(target)?;
        if !force && abs.exists() {
            let current = if abs.is_file() {
                Some(store::hash_file(&abs)?.0)
            } else {
                None
            };
            let saved = match self.head()? {
                Some(head) => self.entry(head, target)?.map(|e| e.blob),
                None => None,
            };
            let safe = current.is_some() && (current == Some(entry.blob) || current == saved);
            if !safe {
                return Err(Error::WouldOverwrite(vec![target.into()]));
            }
        }
        let busy = self.busy_files([target])?;
        if !busy.is_empty() {
            return Err(Error::FileBusy(busy));
        }
        self.materialize(target, &entry)
    }

    /// Makes the working folder go from `from` to `to`. Assumes it currently
    /// matches `from`; checks first that no unsaved file would be clobbered.
    fn apply_tree(&self, from: &Tree, to: &Tree) -> Result<()> {
        let mut blocked = Vec::new();
        for (path, entry) in to.iter().filter(|(p, _)| !from.contains_key(*p)) {
            let abs = self.abs(path)?;
            if abs.is_dir() || (abs.exists() && store::hash_file(&abs)?.0 != entry.blob) {
                blocked.push(path.clone());
            }
        }
        if !blocked.is_empty() {
            return Err(Error::WouldOverwrite(blocked));
        }
        // Check everything up front so a file held open by a DAW stops the
        // whole operation before anything has changed.
        let touched = from
            .iter()
            .filter(|(p, e)| to.get(*p) != Some(*e))
            .map(|(p, _)| p.as_str());
        let busy = self.busy_files(touched)?;
        if !busy.is_empty() {
            return Err(Error::FileBusy(busy));
        }
        for path in from.keys().filter(|p| !to.contains_key(*p)) {
            self.remove_file(path)?;
        }
        for (path, entry) in to {
            if from.get(path) != Some(entry) {
                self.materialize(path, entry)?;
            }
        }
        Ok(())
    }

    fn remove_file(&self, path: &str) -> Result<()> {
        let abs = self.abs(path)?;
        match fs::remove_file(&abs) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(busy_or_io(e, path)),
            _ => {}
        }
        self.conn
            .execute("DELETE FROM worktree_cache WHERE path = ?1", [path])?;
        // Drop folders the removal left empty, but never the project root.
        let mut dir = abs.parent();
        while let Some(d) = dir {
            if d == self.root || fs::remove_dir(d).is_err() {
                break;
            }
            dir = d.parent();
        }
        Ok(())
    }

    /// Existing files among `paths` that cannot be replaced right now: open in
    /// another program (Windows locks those) or read-only.
    fn busy_files<'a>(&self, paths: impl IntoIterator<Item = &'a str>) -> Result<Vec<String>> {
        let mut busy = Vec::new();
        for path in paths {
            let abs = self.abs(path)?;
            if !abs.is_file() {
                continue;
            }
            // Opening for writing without truncating changes nothing, but
            // fails while another program holds the file without sharing.
            if let Err(e) = OpenOptions::new().write(true).open(&abs) {
                if !is_busy(&e) {
                    return Err(e.into());
                }
                busy.push(path.to_owned());
            }
        }
        Ok(busy)
    }

    /// Writes a stored file into the working folder atomically (temp + rename)
    /// so an open DAW never sees a half-written file.
    fn materialize(&self, path: &str, entry: &Entry) -> Result<()> {
        let abs = self.abs(path)?;
        if abs.is_dir() {
            return Err(Error::WouldOverwrite(vec![path.into()]));
        }
        let parent = abs.parent().expect("project files live inside the root");
        fs::create_dir_all(parent)?;
        let name = abs
            .file_name()
            .expect("validated path has a file name")
            .to_string_lossy();
        let tmp = parent.join(format!(".{name}{}", worktree::TMP_SUFFIX));
        let blob = self.blob(entry.blob)?;
        let written = (|| -> Result<()> {
            let mut out = BufWriter::new(File::create(&tmp)?);
            self.store.write_blob(&blob, &mut out)?;
            out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
            fs::rename(&tmp, &abs).map_err(|e| busy_or_io(e, path))?;
            Ok(())
        })();
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        written?;
        let meta = fs::metadata(&abs)?;
        self.cache_put(path, meta.len(), worktree::mtime_ns(&meta), entry.blob)
    }

    // ---- merging --------------------------------------------------------

    fn plan_merge(&self, rev: &str) -> Result<MergePlan> {
        let ours = self.head()?.ok_or_else(|| {
            Error::UnbornBranch(self.current_branch().unwrap_or_else(|_| "HEAD".into()))
        })?;
        let theirs = self.resolve(rev)?;
        let graph = self.graph()?;
        if graph.is_ancestor(theirs, ours) {
            return Ok(MergePlan::UpToDate);
        }
        let ours_tree = self.tree(ours)?;
        if graph.is_ancestor(ours, theirs) {
            return Ok(MergePlan::FastForward { ours_tree, theirs });
        }
        let base = match graph.merge_base(ours, theirs) {
            Some(base) => self.tree(base)?,
            None => Tree::new(),
        };
        let result = merge::three_way(&base, &ours_tree, &self.tree(theirs)?);
        Ok(MergePlan::Merge {
            ours,
            theirs,
            ours_tree,
            result,
        })
    }

    /// What merging `rev` into the current branch would do.
    pub fn merge_preview(&self, rev: &str) -> Result<MergePreview> {
        Ok(match self.plan_merge(rev)? {
            MergePlan::UpToDate => MergePreview {
                kind: MergeKind::UpToDate,
                changes: Vec::new(),
                conflicts: Vec::new(),
            },
            MergePlan::FastForward { ours_tree, theirs } => MergePreview {
                kind: MergeKind::FastForward,
                changes: diff_trees(&ours_tree, &self.tree(theirs)?),
                conflicts: Vec::new(),
            },
            MergePlan::Merge {
                ours_tree, result, ..
            } => {
                // Conflicting paths are left out of `merged`; don't report
                // them as deletions too.
                let conflicted: HashSet<&str> =
                    result.conflicts.iter().map(|c| c.path.as_str()).collect();
                let changes = diff_trees(&ours_tree, &result.merged)
                    .into_iter()
                    .filter(|c| !conflicted.contains(c.path.as_str()))
                    .collect();
                MergePreview {
                    kind: MergeKind::Merge,
                    changes,
                    conflicts: result.conflicts,
                }
            }
        })
    }

    /// Merges `rev` into the current branch. `choose` settles files changed on
    /// both sides; if it returns `None` for any, nothing is changed and the
    /// open conflicts are returned.
    pub fn merge(
        &mut self,
        rev: &str,
        choose: impl FnMut(&Conflict) -> Option<Resolution>,
    ) -> Result<MergeOutcome> {
        let branch = self.current_branch()?;
        match self.plan_merge(rev)? {
            MergePlan::UpToDate => Ok(MergeOutcome::UpToDate),
            MergePlan::FastForward { ours_tree, theirs } => {
                self.ensure_clean()?;
                self.apply_tree(&ours_tree, &self.tree(theirs)?)?;
                self.conn
                    .execute(UPSERT_REF, params![BRANCH, branch, theirs])?;
                Ok(MergeOutcome::FastForward(theirs))
            }
            MergePlan::Merge {
                ours,
                theirs,
                ours_tree,
                result,
            } => {
                let merged = match merge::resolve(result, choose, rev) {
                    Ok(merged) => merged,
                    Err(open) => return Ok(MergeOutcome::Conflicts(open)),
                };
                self.ensure_clean()?;
                self.apply_tree(&ours_tree, &merged)?;
                let message = format!("Merge '{rev}' into '{branch}'");
                let id = self.write_snapshot(&branch, &[ours, theirs], &message, &merged, &[])?;
                Ok(MergeOutcome::Merged(id))
            }
        }
    }

    // ---- comments -------------------------------------------------------

    /// Comment on a file in a version, optionally at a position in the audio.
    pub fn add_comment(
        &self,
        rev: &str,
        path: &str,
        timecode_ms: Option<u64>,
        text: &str,
    ) -> Result<i64> {
        let id = self.resolve(rev)?;
        if self.entry(id, path)?.is_none() {
            return Err(Error::PathNotFound {
                path: path.into(),
                rev: rev.into(),
            });
        }
        self.conn.execute(
            "INSERT INTO comments (uid, snapshot_id, path, timecode_ms, text, author, created_at)
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                path,
                timecode_ms.map(|t| t as i64),
                text,
                self.author()?,
                now_secs()
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn comments(&self, path: Option<&str>, include_resolved: bool) -> Result<Vec<Comment>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, snapshot_id, path, timecode_ms, text, author, created_at, resolved
             FROM comments
             WHERE (?1 IS NULL OR path = ?1) AND (?2 OR resolved = 0)
             ORDER BY path, timecode_ms, id",
        )?;
        let rows = stmt.query_map(params![path, include_resolved], comment_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Comments on `path` made on any version where it had exactly this
    /// content, so feedback stays visible while the file is unchanged.
    pub fn comments_on_content(
        &self,
        path: &str,
        blob: Hash,
        include_resolved: bool,
    ) -> Result<Vec<Comment>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id, c.snapshot_id, c.path, c.timecode_ms, c.text, c.author, c.created_at,
                    c.resolved
             FROM comments c
             JOIN snapshot_entries e ON e.snapshot_id = c.snapshot_id AND e.path = c.path
             WHERE c.path = ?1 AND e.blob_hash = ?2 AND (?3 OR c.resolved = 0)
             ORDER BY c.timecode_ms, c.id",
        )?;
        let rows = stmt.query_map(params![path, blob, include_resolved], comment_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn resolve_comment(&self, id: i64) -> Result<()> {
        if self
            .conn
            .execute("UPDATE comments SET resolved = 1 WHERE id = ?1", [id])?
            == 0
        {
            return Err(Error::NoSuchComment(id));
        }
        Ok(())
    }

    // ---- storage --------------------------------------------------------

    pub fn stats(&self) -> Result<Stats> {
        let count = |sql: &str| self.conn.query_row(sql, [], |r| r.get::<_, i64>(0));
        let (chunks, stored_bytes) = self.store.usage()?;
        Ok(Stats {
            snapshots: count("SELECT COUNT(*) FROM snapshots")? as u64,
            blobs: count("SELECT COUNT(*) FROM blobs")? as u64,
            content_bytes: count("SELECT COALESCE(SUM(size), 0) FROM blobs")? as u64,
            chunks,
            stored_bytes,
        })
    }
}

enum MergePlan {
    UpToDate,
    FastForward {
        ours_tree: Tree,
        theirs: Hash,
    },
    Merge {
        ours: Hash,
        theirs: Hash,
        ours_tree: Tree,
        result: ThreeWay,
    },
}

/// The version DAG, loaded whole: projects have hundreds of versions, not
/// millions, and graph walks are much simpler in memory.
#[derive(Default)]
struct Graph {
    parents: HashMap<Hash, Vec<Hash>>,
    time: HashMap<Hash, i64>,
}

impl Graph {
    fn parents_of(&self, id: &Hash) -> &[Hash] {
        self.parents.get(id).map_or(&[], Vec::as_slice)
    }

    fn time_of(&self, id: &Hash) -> i64 {
        self.time.get(id).copied().unwrap_or(0)
    }

    /// `id` and everything before it.
    fn ancestors(&self, id: Hash) -> HashSet<Hash> {
        let mut seen = HashSet::new();
        let mut stack = vec![id];
        while let Some(next) = stack.pop() {
            if seen.insert(next) {
                stack.extend_from_slice(self.parents_of(&next));
            }
        }
        seen
    }

    fn is_ancestor(&self, ancestor: Hash, of: Hash) -> bool {
        self.ancestors(of).contains(&ancestor)
    }

    /// Latest common ancestor; the most recent one if there are several.
    fn merge_base(&self, a: Hash, b: Hash) -> Option<Hash> {
        let from_a = self.ancestors(a);
        let common: HashSet<Hash> = self
            .ancestors(b)
            .into_iter()
            .filter(|id| from_a.contains(id))
            .collect();
        let mut best = common.clone();
        for candidate in &common {
            if !best.contains(candidate) {
                continue;
            }
            for older in self.ancestors(*candidate) {
                if older != *candidate {
                    best.remove(&older);
                }
            }
        }
        best.into_iter().max_by_key(|id| (self.time_of(id), *id))
    }

    /// Children before parents, newer before older among the ready ones.
    fn topo_order(&self, head: Hash) -> Vec<Hash> {
        let members = self.ancestors(head);
        let mut waiting_children: HashMap<Hash, usize> = HashMap::new();
        for id in &members {
            for parent in self.parents_of(id) {
                *waiting_children.entry(*parent).or_default() += 1;
            }
        }
        let mut ready = BinaryHeap::from([(self.time_of(&head), head)]);
        let mut order = Vec::with_capacity(members.len());
        while let Some((_, id)) = ready.pop() {
            order.push(id);
            for parent in self.parents_of(&id) {
                let waiting = waiting_children.get_mut(parent).expect("counted above");
                *waiting -= 1;
                if *waiting == 0 {
                    ready.push((self.time_of(parent), *parent));
                }
            }
        }
        order
    }
}

fn comment_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Comment> {
    Ok(Comment {
        id: r.get(0)?,
        snapshot: r.get(1)?,
        path: r.get(2)?,
        timecode_ms: r.get::<_, Option<i64>>(3)?.map(|t| t as u64),
        text: r.get(4)?,
        author: r.get(5)?,
        created_at: r.get(6)?,
        resolved: r.get(7)?,
    })
}

fn is_busy(e: &io::Error) -> bool {
    // ERROR_SHARING_VIOLATION (32) and ERROR_LOCK_VIOLATION (33) on Windows.
    e.kind() == io::ErrorKind::PermissionDenied
        || (cfg!(windows) && matches!(e.raw_os_error(), Some(32 | 33)))
}

fn busy_or_io(e: io::Error, path: &str) -> Error {
    if is_busy(&e) {
        Error::FileBusy(vec![path.to_owned()])
    } else {
        e.into()
    }
}

/// Branch and tag names: anything printable without `~ ^ : ? * [ \`,
/// no `..`, and no leading/trailing spaces or slashes.
pub fn validate_name(name: &str) -> Result<()> {
    let bad = name.is_empty()
        || name == "HEAD"
        || name.trim() != name
        || name.starts_with(['-', '/'])
        || name.ends_with('/')
        || name.contains("..")
        || name.contains("//")
        || name
            .chars()
            .any(|c| c.is_control() || "~^:?*[\\".contains(c));
    if bad {
        Err(Error::InvalidName(name.into()))
    } else {
        Ok(())
    }
}

fn path_matches(filter: &str, path: &str) -> bool {
    filter.is_empty()
        || path == filter
        || path
            .strip_prefix(filter)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn snapshot_id(
    parents: &[Hash],
    author: &str,
    message: &str,
    created_at: i64,
    tree: &Tree,
) -> Hash {
    let mut h = blake3::Hasher::new();
    h.update(b"takes-snapshot-v1\0");
    h.update(&(parents.len() as u64).to_le_bytes());
    for parent in parents {
        h.update(&parent.0);
    }
    for text in [author, message] {
        h.update(&(text.len() as u64).to_le_bytes());
        h.update(text.as_bytes());
    }
    h.update(&created_at.to_le_bytes());
    h.update(&(tree.len() as u64).to_le_bytes());
    for (path, entry) in tree {
        h.update(&(path.len() as u64).to_le_bytes());
        h.update(path.as_bytes());
        h.update(&entry.blob.0);
        h.update(&entry.size.to_le_bytes());
    }
    h.finalize().into()
}

fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as i64)
}

fn now_secs() -> i64 {
    now_ns() / 1_000_000_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        for ok in ["main", "acoustic version", "feat/strings", "демо-2"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "HEAD",
            " x",
            "a..b",
            "-x",
            "a~1",
            "x/",
            "a:b",
            "tab\there",
        ] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn path_filter() {
        assert!(path_matches("", "a/b"));
        assert!(path_matches("a", "a/b"));
        assert!(path_matches("a/b", "a/b"));
        assert!(!path_matches("a", "ab"));
    }
}
