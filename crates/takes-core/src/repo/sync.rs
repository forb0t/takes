//! Syncing a project's history through a [`Storage`].
//!
//! Remote layout (every file is written once, except a device's own refs):
//!
//! ```text
//! takes-remote.json            format version and project id
//! packs/<hash>.pack            stored chunks, concatenated (~64 MiB per pack)
//! packs/<hash>.idx             where each chunk is in the pack; written after
//!                              the pack, so a pack without index is ignored
//! snapshots/<id>.snap          one version: metadata, files and their chunks
//! comments/<uid>.json          one comment
//! resolved/<uid>               marks that comment resolved
//! meta/<uid>.json              one change to a file's labels, tempo or key
//! tags/<hex name>              a tag (first writer wins)
//! refs/<device>/b-<hex name>   branch heads of one device, written only by it
//! refs/<device>/d-<hex name>   branches that device deleted, at which version
//! devices/<device>.json        a device's display name
//! ```
//!
//! Since each device only ever writes its own refs, no locking is needed and
//! nothing is overwritten. Branches that moved on two devices show up as
//! diverged and are merged like any branch, as `<branch>@<device>`.
//!
//! Requests run several at a time: on WebDAV each one costs a round trip.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, Transaction, params};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::{BRANCH, Graph, Repo, TAG, UPSERT_REF, now_secs, snapshot_id};
use crate::error::{Error, Result};
use crate::hash::Hash;
use crate::model::{Entry, Tree};
use crate::remote::{RemoteConfig, Storage, parallel};
use crate::store;
use crate::worktree::META_DIR;

const FORMAT: u32 = 1;
const MARKER: &str = "takes-remote.json";
/// Packs are closed at this size: few enough files for cloud drives, small
/// enough that an interrupted upload loses little.
const PACK_TARGET: u64 = 64 * 1024 * 1024;
/// Neighbouring chunks closer than this are downloaded in one request.
const MERGE_GAP: u64 = 256 * 1024;
/// Largest download request; several run at once.
const MAX_REQUEST: u64 = 16 * 1024 * 1024;
/// Earlier versions listed in each version file, so a long history can be
/// downloaded many versions at a time instead of parent after parent.
const ANCESTOR_HINTS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncPhase {
    Connecting,
    Downloading,
    Uploading,
}

/// Progress of a sync; byte counts are compressed sizes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncProgress {
    pub phase: SyncPhase,
    pub done: u64,
    pub total: u64,
}

/// A branch that moved differently here and on another device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diverged {
    pub branch: String,
    pub device: String,
    /// What to pass to merge, e.g. `main@Studio`.
    pub rev: String,
}

/// Why the current branch could not take the newer version from the remote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Blocked {
    Unsaved,
    FilesBusy(Vec<String>),
    WouldOverwrite(Vec<String>),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub uploaded_bytes: u64,
    pub downloaded_bytes: u64,
    pub sent_versions: u64,
    pub received_versions: u64,
    pub comments_sent: u64,
    pub comments_received: u64,
    /// Changes to labels, tempo and key of files.
    pub notes_sent: u64,
    pub notes_received: u64,
    /// Branches moved forward to another device's newer version.
    pub updated_branches: Vec<String>,
    /// Branches that existed only on other devices until now.
    pub new_branches: Vec<String>,
    /// Branches another device deleted, removed here too.
    pub deleted_branches: Vec<String>,
    pub diverged: Vec<Diverged>,
    pub current_blocked: Option<Blocked>,
}

/// What sync would do, known without contacting the remote.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncState {
    pub remote: Option<RemoteConfig>,
    /// Versions saved here and not yet sent.
    pub unsent_versions: u64,
    pub diverged: Vec<Diverged>,
    /// Branches with a newer version from another device not applied yet:
    /// the current branch, while it has unsaved changes or after a
    /// background sync (see [`Repo::update_current`]).
    pub waiting: Vec<String>,
    pub last_sync: Option<i64>,
}

// ---- file formats ---------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct Marker {
    format: u32,
    project: String,
}

#[derive(Serialize, Deserialize)]
struct PackIndex {
    /// (chunk hash, offset, length)
    chunks: Vec<(String, u64, u64)>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFile {
    id: String,
    parents: Vec<String>,
    message: String,
    author: String,
    created_at: i64,
    entries: Vec<EntryFile>,
    blobs: Vec<BlobFile>,
    /// Some earlier versions (beyond `parents`); only a download hint.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    ancestors: Vec<String>,
    /// Contents the sender had removed to free space before sending, so
    /// their chunks are not on the remote.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pruned: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct EntryFile {
    path: String,
    blob: String,
    size: u64,
}

#[derive(Serialize, Deserialize)]
struct BlobFile {
    hash: String,
    size: u64,
    chunks: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefFile {
    snapshot: String,
    updated_at: i64,
}

#[derive(Serialize, Deserialize, PartialEq)]
struct DeviceFile {
    name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentFile {
    uid: String,
    snapshot: String,
    path: String,
    timecode_ms: Option<u64>,
    text: String,
    author: String,
    created_at: i64,
}

#[derive(Serialize, Deserialize)]
struct MetaFile {
    uid: String,
    blob: String,
    field: String,
    value: String,
    at: i64,
    author: String,
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(value).map_err(|e| Error::Corrupt(e.to_string()))?;
    Ok(zstd::bulk::compress(&json, 3)?)
}

fn decode<T: DeserializeOwned>(what: &str, data: &[u8]) -> Result<T> {
    let json =
        zstd::decode_all(data).map_err(|_| Error::Corrupt(format!("remote {what} is damaged")))?;
    serde_json::from_slice(&json).map_err(|_| Error::Corrupt(format!("remote {what} is damaged")))
}

fn json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|e| Error::Corrupt(e.to_string()))
}

fn parse_hash(hex: &str) -> Result<Hash> {
    Hash::from_hex(hex).ok_or_else(|| Error::Corrupt(format!("bad hash on the remote: {hex}")))
}

fn ref_file(id: Hash) -> Result<Vec<u8>> {
    json(&RefFile {
        snapshot: id.to_hex(),
        updated_at: now_secs(),
    })
}

/// Branch and tag names as file names: hex of the UTF-8 bytes, so any name
/// works on any file system and server.
fn name_to_file(name: &str) -> String {
    name.bytes().map(|b| format!("{b:02x}")).collect()
}

fn file_to_name(file: &str) -> Option<String> {
    let bytes: Option<Vec<u8>> = (0..file.len())
        .step_by(2)
        .map(|i| {
            file.get(i..i + 2)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        })
        .collect();
    String::from_utf8(bytes?).ok()
}

/// Reads the remote's marker, if it is a takes remote at all.
fn read_marker(storage: &dyn Storage) -> Result<Option<Marker>> {
    let Some(data) = storage.read(MARKER)? else {
        return Ok(None);
    };
    let marker: Marker = serde_json::from_slice(&data).map_err(|_| Error::NotARemote)?;
    if marker.format > FORMAT {
        return Err(Error::TooNew("the remote"));
    }
    Ok(Some(marker))
}

/// Projects in the folders directly under `storage` (for "open from remote").
pub fn find_remote_projects(storage: &dyn Storage) -> Result<Vec<String>> {
    let found = parallel(
        storage.list("")?,
        |name| {
            let marker = storage.read(&format!("{name}/{MARKER}"))?;
            Ok(marker.map(|_| name))
        },
        |_| Ok(()),
    )?;
    let mut found: Vec<String> = found.into_iter().flatten().collect();
    found.sort();
    Ok(found)
}

/// Whether `storage` itself holds a takes project.
pub fn is_remote_project(storage: &dyn Storage) -> Result<bool> {
    Ok(read_marker(storage)?.is_some())
}

/// Collects chunks into a pack file before upload.
struct PackBuilder {
    path: PathBuf,
    out: BufWriter<File>,
    hasher: blake3::Hasher,
    index: Vec<(Hash, u64, u64)>,
    size: u64,
}

impl PackBuilder {
    fn new(dir: &Path, n: usize) -> Result<Self> {
        fs::create_dir_all(dir)?;
        let path = dir.join(format!("upload-{}-{n}.pack", std::process::id()));
        Ok(Self {
            out: BufWriter::new(File::create(&path)?),
            path,
            hasher: blake3::Hasher::new(),
            index: Vec::new(),
            size: 0,
        })
    }

    fn add(&mut self, hash: Hash, raw: &[u8]) -> Result<()> {
        self.out.write_all(raw)?;
        self.hasher.update(raw);
        self.index.push((hash, self.size, raw.len() as u64));
        self.size += raw.len() as u64;
        Ok(())
    }
}

/// Remote branch head of another device, with how it relates to ours.
struct RemoteHead {
    device_name: String,
    branch: String,
    id: Hash,
}

enum Relation {
    Same,
    /// Ours already contains theirs.
    Ahead,
    /// Theirs contains ours (or we don't have the branch): take it.
    Behind(Option<Hash>),
    Diverged,
    /// We don't have the branch because it was deleted after this version.
    Deleted,
}

/// A run of nearby chunks of one pack, downloaded in one request.
struct Range {
    path: String,
    start: u64,
    len: u64,
    /// (offset, length, hash)
    chunks: Vec<(u64, u64, Hash)>,
}

impl Repo {
    // ---- settings ---------------------------------------------------------

    pub fn remote(&self) -> Result<Option<RemoteConfig>> {
        match self.config("remote")? {
            Some(json) => Ok(serde_json::from_str(&json).ok()),
            None => Ok(None),
        }
    }

    /// Sets or removes the remote. Changing it forgets what we knew about the
    /// old one, so the next sync looks at the new one from scratch.
    pub fn set_remote(&self, remote: Option<&RemoteConfig>) -> Result<()> {
        if self.remote()?.as_ref() == remote {
            return Ok(());
        }
        self.conn.execute_batch(
            "BEGIN;
             DELETE FROM remote_packs; DELETE FROM remote_chunks; DELETE FROM remote_snapshots;
             DELETE FROM remote_refs; DELETE FROM remote_seen; DELETE FROM remote_deleted;
             UPDATE comments SET pushed = 0, resolution_pushed = 0;
             UPDATE meta_events SET pushed = 0;
             DELETE FROM config WHERE key = 'sync.last';
             COMMIT;",
        )?;
        match remote {
            Some(remote) => {
                let json =
                    serde_json::to_string(remote).map_err(|e| Error::Corrupt(e.to_string()))?;
                self.set_config("remote", &json)
            }
            None => {
                self.conn
                    .execute("DELETE FROM config WHERE key = 'remote'", [])?;
                Ok(())
            }
        }
    }

    fn generated_config(&self, key: &str, make: impl FnOnce() -> String) -> Result<String> {
        if let Some(value) = self.config(key)? {
            return Ok(value);
        }
        let value = make();
        self.set_config(key, &value)?;
        Ok(value)
    }

    fn random_id(&self) -> Result<String> {
        Ok(self
            .conn
            .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?)
    }

    /// This computer's id and display name in the remote.
    pub fn device(&self) -> Result<(String, String)> {
        let id = self.random_id()?;
        let id = self.generated_config("device.id", || id)?;
        let name = self.generated_config("device.name", default_device_name)?;
        Ok((id, name))
    }

    pub fn set_device_name(&self, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::InvalidName(name.into()));
        }
        self.set_config("device.name", name)
    }

    fn project_id(&self) -> Result<String> {
        let id = self.random_id()?;
        self.generated_config("project.id", || id)
    }

    /// Checks that `storage` is this project's remote, or claims it if empty.
    pub fn connect_remote(&self, storage: &dyn Storage) -> Result<()> {
        let project = self.project_id()?;
        match read_marker(storage)? {
            Some(marker) if marker.project == project => Ok(()),
            Some(_) => Err(Error::RemoteMismatch),
            None if !storage.list("")?.is_empty() => Err(Error::RemoteNotEmpty),
            None => {
                let marker = Marker {
                    format: FORMAT,
                    project,
                };
                let json = serde_json::to_vec_pretty(&marker)
                    .map_err(|e| Error::Corrupt(e.to_string()))?;
                storage.write(MARKER, &json)
            }
        }
    }

    // ---- sync ---------------------------------------------------------------

    /// Gets new versions and comments from other devices, moves branches
    /// forward where possible (the current one too, replacing its files if
    /// nothing is unsaved), then sends ours.
    pub fn sync(
        &mut self,
        storage: &dyn Storage,
        progress: &mut dyn FnMut(SyncProgress),
    ) -> Result<SyncReport> {
        self.sync_with(storage, progress, true)
    }

    /// Like [`Repo::sync`], but never touches the working folder: a newer
    /// version of the current branch waits for [`Repo::update_current`].
    /// Meant for automatic syncing while a DAW may have the files open.
    pub fn sync_background(
        &mut self,
        storage: &dyn Storage,
        progress: &mut dyn FnMut(SyncProgress),
    ) -> Result<SyncReport> {
        self.sync_with(storage, progress, false)
    }

    fn sync_with(
        &mut self,
        storage: &dyn Storage,
        progress: &mut dyn FnMut(SyncProgress),
        update_current: bool,
    ) -> Result<SyncReport> {
        progress(SyncProgress {
            phase: SyncPhase::Connecting,
            done: 0,
            total: 0,
        });
        let _lock = self.lock_shared()?;
        self.connect_remote(storage)?;
        let mut report = SyncReport::default();
        self.fetch(storage, &mut report, progress)?;
        self.integrate(&mut report, update_current)?;
        self.push(storage, &mut report, progress)?;
        self.set_config("sync.last", &now_secs().to_string())?;
        Ok(report)
    }

    /// Applies what the last sync fetched to the current branch and its
    /// files (after [`Repo::sync_background`]). Works offline.
    pub fn update_current(&mut self) -> Result<SyncReport> {
        let _lock = self.lock_shared()?;
        let mut report = SyncReport::default();
        self.integrate(&mut report, true)?;
        Ok(report)
    }

    /// Creates a project in `dest` (missing or empty) from a remote.
    pub fn clone_from(
        storage: &dyn Storage,
        remote: &RemoteConfig,
        dest: &Path,
        progress: &mut dyn FnMut(SyncProgress),
    ) -> Result<(Repo, SyncReport)> {
        progress(SyncProgress {
            phase: SyncPhase::Connecting,
            done: 0,
            total: 0,
        });
        let marker = read_marker(storage)?.ok_or(Error::NotARemote)?;
        let existed = dest.exists();
        if existed && fs::read_dir(dest)?.next().is_some() {
            return Err(Error::FolderNotEmpty(dest.to_path_buf()));
        }
        let result = (|| {
            let mut repo = Repo::init(dest)?;
            repo.set_config("project.id", &marker.project)?;
            repo.set_remote(Some(remote))?;
            let mut report = SyncReport::default();
            repo.fetch(storage, &mut report, progress)?;
            // Start on `main` if another device has it, else on any branch.
            let names: Vec<String> = {
                let mut stmt = repo
                    .conn
                    .prepare("SELECT DISTINCT name FROM remote_refs ORDER BY name")?;
                stmt.query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?
            };
            if !names.iter().any(|n| n == super::DEFAULT_BRANCH)
                && let Some(first) = names.first()
            {
                repo.conn
                    .execute("UPDATE head SET branch = ?1 WHERE id = 1", [first])?;
            }
            repo.integrate(&mut report, true)?;
            repo.set_config("sync.last", &now_secs().to_string())?;
            Ok((repo, report))
        })();
        if result.is_err() {
            // Only undo what we created.
            if existed {
                let _ = fs::remove_dir_all(dest.join(META_DIR));
            } else {
                let _ = fs::remove_dir_all(dest);
            }
        }
        result
    }

    /// Offline summary for the UI badge.
    pub fn sync_state(&self) -> Result<SyncState> {
        let remote = self.remote()?;
        if remote.is_none() {
            return Ok(SyncState::default());
        }
        let graph = self.graph()?;
        let on_remote = self.remote_snapshots()?;
        let unsent = self
            .reachable(&graph)?
            .iter()
            .filter(|id| !on_remote.contains(id))
            .count() as u64;
        let current = self.current_branch()?;
        let mut state = SyncState {
            remote,
            unsent_versions: unsent,
            last_sync: self.config("sync.last")?.and_then(|t| t.parse().ok()),
            ..Default::default()
        };
        for head in self.remote_heads()? {
            match self.relation(&graph, &head)? {
                Relation::Diverged => state.diverged.push(diverged(&head)),
                Relation::Behind(_)
                    if head.branch == current && !state.waiting.contains(&head.branch) =>
                {
                    state.waiting.push(head.branch.clone());
                }
                _ => {}
            }
        }
        Ok(state)
    }

    fn remote_snapshots(&self) -> Result<HashSet<Hash>> {
        let mut stmt = self.conn.prepare("SELECT id FROM remote_snapshots")?;
        let ids = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    }

    /// Every version reachable from a branch or tag.
    fn reachable(&self, graph: &Graph) -> Result<HashSet<Hash>> {
        let mut all = HashSet::new();
        for (_, id) in self.refs(BRANCH)?.into_iter().chain(self.refs(TAG)?) {
            if !all.contains(&id) {
                all.extend(graph.ancestors(id));
            }
        }
        Ok(all)
    }

    fn has_snapshot(&self, id: Hash) -> Result<bool> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT 1 FROM snapshots WHERE id = ?1")?;
        Ok(stmt.exists([id])?)
    }

    /// Heads of other devices we know of (and have locally).
    fn remote_heads(&self) -> Result<Vec<RemoteHead>> {
        let (device, _) = self.device()?;
        let mut stmt = self.conn.prepare(
            "SELECT device_name, name, snapshot_id FROM remote_refs
             WHERE device != ?1 AND snapshot_id IN (SELECT id FROM snapshots)
             ORDER BY name, device_name",
        )?;
        let heads = stmt
            .query_map([device], |r| {
                Ok(RemoteHead {
                    device_name: r.get(0)?,
                    branch: r.get(1)?,
                    id: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(heads)
    }

    fn relation(&self, graph: &Graph, head: &RemoteHead) -> Result<Relation> {
        Ok(match self.ref_target(BRANCH, &head.branch)? {
            None if self.deletion_covers(graph, &head.branch, head.id)? => Relation::Deleted,
            None => Relation::Behind(None),
            Some(ours) if ours == head.id => Relation::Same,
            Some(ours) if graph.is_ancestor(head.id, ours) => Relation::Ahead,
            Some(ours) if graph.is_ancestor(ours, head.id) => Relation::Behind(Some(ours)),
            Some(_) => Relation::Diverged,
        })
    }

    /// Whether `head` of `branch` is gone for good: the branch was deleted,
    /// here or on another device, at a version that already contains it.
    pub(super) fn deletion_covers(&self, graph: &Graph, branch: &str, head: Hash) -> Result<bool> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT snapshot_id FROM deleted_branches WHERE name = ?1
             UNION SELECT snapshot_id FROM remote_deleted WHERE name = ?1",
        )?;
        let deleted_at = stmt
            .query_map([branch], |r| r.get::<_, Hash>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(deleted_at.into_iter().any(|t| graph.is_ancestor(head, t)))
    }

    // ---- fetch --------------------------------------------------------------

    /// Learns which packs and versions the remote has.
    fn refresh_remote_index(&mut self, storage: &dyn Storage) -> Result<()> {
        let known: HashSet<String> = {
            let mut stmt = self.conn.prepare("SELECT name FROM remote_packs")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        let new: Vec<String> = storage
            .list("packs")?
            .into_iter()
            .filter_map(|file| file.strip_suffix(".idx").map(str::to_owned))
            .filter(|name| !known.contains(name))
            .collect();
        let indexes = parallel(
            new,
            |name| {
                let data = storage.read(&format!("packs/{name}.idx"))?;
                Ok((name, data))
            },
            |_| Ok(()),
        )?;
        for (name, data) in indexes {
            let Some(data) = data else { continue };
            let index: PackIndex = decode("pack index", &data)?;
            let tx = self.conn.transaction()?;
            {
                let mut put = tx.prepare(
                    "INSERT OR IGNORE INTO remote_chunks (hash, pack, offset, length) VALUES (?1, ?2, ?3, ?4)",
                )?;
                for (hash, offset, len) in &index.chunks {
                    put.execute(params![
                        parse_hash(hash)?,
                        name,
                        *offset as i64,
                        *len as i64
                    ])?;
                }
                tx.execute("INSERT INTO remote_packs (name) VALUES (?1)", [&name])?;
            }
            tx.commit()?;
        }
        let tx = self.conn.transaction()?;
        {
            let mut put = tx.prepare("INSERT OR IGNORE INTO remote_snapshots (id) VALUES (?1)")?;
            for file in storage.list("snapshots")? {
                if let Some(id) = file.strip_suffix(".snap").and_then(Hash::from_hex) {
                    put.execute([id])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    fn fetch(
        &mut self,
        storage: &dyn Storage,
        report: &mut SyncReport,
        progress: &mut dyn FnMut(SyncProgress),
    ) -> Result<()> {
        self.refresh_remote_index(storage)?;
        let (me, _) = self.device()?;

        let device_files: Vec<String> = storage
            .list("devices")?
            .into_iter()
            .filter(|f| f.ends_with(".json"))
            .collect();
        let device_names: HashMap<String, String> = parallel(
            device_files,
            |file| {
                let name = storage
                    .read(&format!("devices/{file}"))?
                    .and_then(|d| serde_json::from_slice::<DeviceFile>(&d).ok())
                    .map(|d| d.name);
                Ok((file.trim_end_matches(".json").to_owned(), name))
            },
            |_| Ok(()),
        )?
        .into_iter()
        .filter_map(|(id, name)| Some((id, name?)))
        .collect();

        // Branch heads and deletions of other devices.
        let devices: Vec<String> = storage
            .list("refs")?
            .into_iter()
            .filter(|d| *d != me)
            .collect();
        let listed = parallel(
            devices,
            |device| {
                let files = storage.list(&format!("refs/{device}"))?;
                Ok(files.into_iter().map(move |f| (device.clone(), f)))
            },
            |_| Ok(()),
        )?;
        let ref_files = parallel(
            listed.into_iter().flatten().collect(),
            |(device, file)| {
                let data = storage.read(&format!("refs/{device}/{file}"))?;
                Ok((device, file, data))
            },
            |_| Ok(()),
        )?;
        let mut heads: Vec<(String, String, Hash)> = Vec::new();
        let mut deletions: Vec<(String, String, Hash)> = Vec::new();
        for (device, file, data) in ref_files {
            let (list, encoded) = if let Some(name) = file.strip_prefix("b-") {
                (&mut heads, name)
            } else if let Some(name) = file.strip_prefix("d-") {
                (&mut deletions, name)
            } else {
                continue;
            };
            let (Some(data), Some(branch)) = (data, file_to_name(encoded)) else {
                continue;
            };
            let reference: RefFile = serde_json::from_slice(&data)
                .map_err(|_| Error::Corrupt(format!("remote branch {branch} is damaged")))?;
            list.push((device, branch, parse_hash(&reference.snapshot)?));
        }

        let mut new_tags = Vec::new();
        for file in storage.list("tags")? {
            if let Some(name) = file_to_name(&file)
                && self.ref_target(TAG, &name)?.is_none()
            {
                new_tags.push((file, name));
            }
        }
        let mut tags: Vec<(String, Hash)> = Vec::new();
        for (name, data) in parallel(
            new_tags,
            |(file, name)| Ok((name, storage.read(&format!("tags/{file}"))?)),
            |_| Ok(()),
        )? {
            let Some(data) = data else { continue };
            let reference: RefFile = serde_json::from_slice(&data)
                .map_err(|_| Error::Corrupt(format!("remote tag {name} is damaged")))?;
            tags.push((name, parse_hash(&reference.snapshot)?));
        }

        let starts: Vec<Hash> = heads
            .iter()
            .map(|h| h.2)
            .chain(tags.iter().map(|t| t.1))
            .collect();
        let files = self.fetch_snapshots(storage, &starts)?;
        self.download_chunks(storage, &files, report, progress)?;

        // Store versions, parents first.
        let order = parents_first(&files)?;
        let tx = self.conn.transaction()?;
        for id in &order {
            insert_snapshot(&tx, *id, &files[id])?;
        }
        tx.commit()?;
        report.received_versions += order.len() as u64;
        self.update_pruned(&files)?;

        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM remote_refs WHERE device != ?1", [&me])?;
        tx.execute("DELETE FROM remote_deleted", [])?;
        let device_name = |device: &str| {
            device_names
                .get(device)
                .cloned()
                .unwrap_or_else(|| device[..8.min(device.len())].to_owned())
        };
        for (device, branch, id) in &heads {
            tx.execute(
                "INSERT OR REPLACE INTO remote_refs (device, device_name, name, snapshot_id) VALUES (?1, ?2, ?3, ?4)",
                params![device, device_name(device), branch, id],
            )?;
        }
        for (device, branch, id) in &deletions {
            tx.execute(
                "INSERT OR REPLACE INTO remote_deleted (device, name, snapshot_id) VALUES (?1, ?2, ?3)",
                params![device, branch, id],
            )?;
        }
        for (name, id) in &tags {
            tx.execute(
                "INSERT OR IGNORE INTO refs (kind, name, snapshot_id)
                 SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM snapshots WHERE id = ?3)",
                params![TAG, name, id],
            )?;
        }
        tx.commit()?;

        self.fetch_comments(storage, report)?;
        self.fetch_meta(storage, report)
    }

    /// Downloads the versions leading to `starts` that we lack. Each version
    /// names some earlier ones, so a long history comes in parallel rounds.
    fn fetch_snapshots(
        &self,
        storage: &dyn Storage,
        starts: &[Hash],
    ) -> Result<HashMap<Hash, SnapshotFile>> {
        let on_remote = self.remote_snapshots()?;
        let mut files: HashMap<Hash, SnapshotFile> = HashMap::new();
        let mut asked: HashSet<Hash> = HashSet::new();
        let mut wanted: Vec<Hash> = starts.to_vec();
        loop {
            let mut batch = Vec::new();
            for id in wanted.drain(..) {
                if asked.insert(id) && !self.has_snapshot(id)? {
                    batch.push(id);
                }
            }
            if batch.is_empty() {
                break;
            }
            let got = parallel(
                batch,
                |id| {
                    let data = storage
                        .read(&format!("snapshots/{}.snap", id.to_hex()))?
                        .ok_or_else(|| {
                            Error::Corrupt(format!(
                                "version {} is missing on the remote",
                                id.short()
                            ))
                        })?;
                    let file: SnapshotFile = decode("version", &data)?;
                    verify_snapshot(id, &file)?;
                    Ok((id, file))
                },
                |_| Ok(()),
            )?;
            for (id, file) in got {
                for parent in &file.parents {
                    wanted.push(parse_hash(parent)?);
                }
                // Hints are only followed to versions the remote has.
                wanted.extend(
                    file.ancestors
                        .iter()
                        .filter_map(|a| Hash::from_hex(a))
                        .filter(|a| on_remote.contains(a)),
                );
                files.insert(id, file);
            }
        }
        // Keep only what the heads really lead to, whatever the hints said.
        let mut keep = HashSet::new();
        let mut stack = starts.to_vec();
        while let Some(id) = stack.pop() {
            if let Some(file) = files.get(&id)
                && keep.insert(id)
            {
                for parent in &file.parents {
                    stack.push(parse_hash(parent)?);
                }
            }
        }
        files.retain(|id, _| keep.contains(id));
        Ok(files)
    }

    fn download_chunks(
        &self,
        storage: &dyn Storage,
        files: &HashMap<Hash, SnapshotFile>,
        report: &mut SyncReport,
        progress: &mut dyn FnMut(SyncProgress),
    ) -> Result<()> {
        let mut needed: HashSet<Hash> = HashSet::new();
        for file in files.values() {
            let pruned: HashSet<&str> = file.pruned.iter().map(String::as_str).collect();
            for blob in file
                .blobs
                .iter()
                .filter(|b| !pruned.contains(b.hash.as_str()))
            {
                for chunk in &blob.chunks {
                    let hash = parse_hash(chunk)?;
                    if !self.store.has_chunk(&hash) {
                        needed.insert(hash);
                    }
                }
            }
        }
        let mut by_pack: BTreeMap<String, Vec<(u64, u64, Hash)>> = BTreeMap::new();
        let mut total = 0;
        let mut find = self
            .conn
            .prepare_cached("SELECT pack, offset, length FROM remote_chunks WHERE hash = ?1")?;
        for hash in needed {
            let (pack, offset, len): (String, i64, i64) = find
                .query_row([hash], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()?
                .ok_or_else(|| {
                    Error::Corrupt(format!(
                        "part {} of a file is missing on the remote",
                        hash.short()
                    ))
                })?;
            total += len as u64;
            by_pack
                .entry(pack)
                .or_default()
                .push((offset as u64, len as u64, hash));
        }

        let mut ranges = Vec::new();
        for (pack, mut chunks) in by_pack {
            chunks.sort();
            let mut i = 0;
            while i < chunks.len() {
                let start = chunks[i].0;
                let mut j = i + 1;
                while j < chunks.len()
                    && chunks[j].0 <= chunks[j - 1].0 + chunks[j - 1].1 + MERGE_GAP
                    && chunks[j].0 + chunks[j].1 - start <= MAX_REQUEST
                {
                    j += 1;
                }
                ranges.push(Range {
                    path: format!("packs/{pack}.pack"),
                    start,
                    len: chunks[j - 1].0 + chunks[j - 1].1 - start,
                    chunks: chunks[i..j].to_vec(),
                });
                i = j;
            }
        }

        let mut done = 0;
        progress(SyncProgress {
            phase: SyncPhase::Downloading,
            done,
            total,
        });
        let store = &self.store;
        parallel(
            ranges,
            |range| {
                let data = storage.read_range(&range.path, range.start, range.len)?;
                let mut stored = 0;
                for &(offset, len, hash) in &range.chunks {
                    let from = (offset - range.start) as usize;
                    store.put_raw(&hash, &data[from..from + len as usize])?;
                    stored += len;
                }
                Ok((range.len, stored))
            },
            |&(fetched, stored)| {
                done += stored;
                report.downloaded_bytes += fetched;
                progress(SyncProgress {
                    phase: SyncPhase::Downloading,
                    done,
                    total,
                });
                Ok(())
            },
        )?;
        Ok(())
    }

    /// After a download: contents we now have completely are no longer
    /// pruned; contents the sender had removed are pruned here too.
    fn update_pruned(&self, files: &HashMap<Hash, SnapshotFile>) -> Result<()> {
        let mut checked = HashSet::new();
        let tx = self.conn.unchecked_transaction()?;
        for file in files.values() {
            for blob in &file.blobs {
                if !checked.insert(blob.hash.as_str()) {
                    continue;
                }
                let mut complete = true;
                for chunk in &blob.chunks {
                    complete &= self.store.has_chunk(&parse_hash(chunk)?);
                }
                let sql = if complete {
                    "DELETE FROM pruned_blobs WHERE hash = ?1"
                } else {
                    "INSERT OR IGNORE INTO pruned_blobs (hash) VALUES (?1)"
                };
                tx.execute(sql, [parse_hash(&blob.hash)?])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    fn fetch_comments(&mut self, storage: &dyn Storage, report: &mut SyncReport) -> Result<()> {
        let seen: HashSet<String> = {
            let mut stmt = self.conn.prepare("SELECT path FROM remote_seen")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        let unseen: Vec<String> = storage
            .list("comments")?
            .into_iter()
            .map(|file| format!("comments/{file}"))
            .filter(|path| path.ends_with(".json") && !seen.contains(path))
            .collect();
        let read = parallel(
            unseen,
            |path| {
                let data = storage.read(&path)?;
                Ok((path, data))
            },
            |_| Ok(()),
        )?;
        for (path, data) in read {
            let Some(c) = data.and_then(|d| serde_json::from_slice::<CommentFile>(&d).ok()) else {
                continue;
            };
            let snapshot = parse_hash(&c.snapshot)?;
            if !self.has_snapshot(snapshot)? {
                // On a version we don't have (yet); look again next time.
                continue;
            }
            report.comments_received += self.conn.execute(
                "INSERT OR IGNORE INTO comments
                     (uid, snapshot_id, path, timecode_ms, text, author, created_at, pushed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
                params![
                    c.uid,
                    snapshot,
                    c.path,
                    c.timecode_ms.map(|t| t as i64),
                    c.text,
                    c.author,
                    c.created_at
                ],
            )? as u64;
            self.conn.execute(
                "INSERT OR IGNORE INTO remote_seen (path) VALUES (?1)",
                [&path],
            )?;
        }
        for uid in storage.list("resolved")? {
            let path = format!("resolved/{uid}");
            if seen.contains(&path) {
                continue;
            }
            let updated = self.conn.execute(
                "UPDATE comments SET resolved = 1, resolution_pushed = 1 WHERE uid = ?1",
                [&uid],
            )?;
            if updated > 0 {
                self.conn.execute(
                    "INSERT OR IGNORE INTO remote_seen (path) VALUES (?1)",
                    [&path],
                )?;
            }
        }
        Ok(())
    }

    fn fetch_meta(&mut self, storage: &dyn Storage, report: &mut SyncReport) -> Result<()> {
        let seen: HashSet<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT path FROM remote_seen WHERE path LIKE 'meta/%'")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        let unseen: Vec<String> = storage
            .list("meta")?
            .into_iter()
            .map(|file| format!("meta/{file}"))
            .filter(|path| path.ends_with(".json") && !seen.contains(path))
            .collect();
        let conn = &self.conn;
        let mut imported = 0;
        parallel(
            unseen,
            |path| {
                let data = storage.read(&path)?;
                Ok((path, data))
            },
            |(path, data)| {
                let event = data
                    .as_deref()
                    .and_then(|d| serde_json::from_slice::<MetaFile>(d).ok())
                    .and_then(|m| {
                        Some(super::meta::MetaEvent {
                            blob: Hash::from_hex(&m.blob)?,
                            uid: m.uid,
                            field: m.field,
                            value: m.value,
                            at: m.at,
                            author: m.author,
                        })
                    });
                if let Some(event) = event
                    && self.import_meta(&event)?
                {
                    imported += 1;
                }
                conn.execute(
                    "INSERT OR IGNORE INTO remote_seen (path) VALUES (?1)",
                    [path],
                )?;
                Ok(())
            },
        )?;
        report.notes_received += imported;
        Ok(())
    }

    // ---- integrate ------------------------------------------------------------

    /// Moves local branches forward to newer versions from other devices,
    /// drops branches other devices deleted, and reports branches that
    /// diverged. The current branch moves only with `update_current`.
    fn integrate(&mut self, report: &mut SyncReport, update_current: bool) -> Result<()> {
        let graph = self.graph()?;
        let current = self.current_branch()?;

        // Deleted elsewhere, and nothing new was saved on it here since.
        let deletions: Vec<(String, Hash)> = {
            let mut stmt = self
                .conn
                .prepare("SELECT name, snapshot_id FROM remote_deleted")?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (name, deleted_at) in deletions {
            if name != current
                && let Some(ours) = self.ref_target(BRANCH, &name)?
                && graph.is_ancestor(ours, deleted_at)
            {
                self.conn.execute(
                    "DELETE FROM refs WHERE kind = ?1 AND name = ?2",
                    [BRANCH, &name],
                )?;
                push_unique(&mut report.deleted_branches, &name);
            }
        }

        for head in self.remote_heads()? {
            match self.relation(&graph, &head)? {
                Relation::Same | Relation::Ahead | Relation::Diverged | Relation::Deleted => {}
                Relation::Behind(ours) if head.branch == current => {
                    if !update_current {
                        continue;
                    }
                    match self.fast_forward_current(ours, head.id) {
                        Ok(()) => {}
                        Err(Error::DirtyWorktree(_)) => {
                            report.current_blocked = Some(Blocked::Unsaved)
                        }
                        Err(Error::FileBusy(paths)) => {
                            report.current_blocked = Some(Blocked::FilesBusy(paths))
                        }
                        Err(Error::WouldOverwrite(paths)) => {
                            report.current_blocked = Some(Blocked::WouldOverwrite(paths))
                        }
                        Err(e) => return Err(e),
                    }
                    if report.current_blocked.is_none() {
                        push_unique(
                            if ours.is_some() {
                                &mut report.updated_branches
                            } else {
                                &mut report.new_branches
                            },
                            &head.branch,
                        );
                    }
                }
                Relation::Behind(ours) => {
                    self.conn
                        .execute(UPSERT_REF, params![BRANCH, head.branch, head.id])?;
                    if ours.is_none() {
                        // Someone saved new work on a branch deleted here.
                        self.conn.execute(
                            "DELETE FROM deleted_branches WHERE name = ?1",
                            [&head.branch],
                        )?;
                    }
                    push_unique(
                        if ours.is_some() {
                            &mut report.updated_branches
                        } else {
                            &mut report.new_branches
                        },
                        &head.branch,
                    );
                }
            }
        }
        // After taking one device's newer head, another device's head may
        // turn out to be contained in it; report only real divergence.
        let mut still = Vec::new();
        for head in self.remote_heads()? {
            if matches!(self.relation(&graph, &head)?, Relation::Diverged) {
                still.push(diverged(&head));
            }
        }
        report.diverged = still;
        Ok(())
    }

    fn fast_forward_current(&mut self, ours: Option<Hash>, theirs: Hash) -> Result<()> {
        self.ensure_clean()?;
        let from = match ours {
            Some(id) => self.tree(id)?,
            None => Tree::new(),
        };
        self.apply_tree(&from, &self.tree(theirs)?)?;
        let branch = self.current_branch()?;
        self.conn
            .execute(UPSERT_REF, params![BRANCH, branch, theirs])?;
        Ok(())
    }

    // ---- push ---------------------------------------------------------------

    fn push(
        &mut self,
        storage: &dyn Storage,
        report: &mut SyncReport,
        progress: &mut dyn FnMut(SyncProgress),
    ) -> Result<()> {
        let graph = self.graph()?;
        let on_remote = self.remote_snapshots()?;
        let missing: HashSet<Hash> = self
            .reachable(&graph)?
            .into_iter()
            .filter(|id| !on_remote.contains(id))
            .collect();
        let order = parents_first_graph(&graph, &missing);

        // File contents the remote lacks.
        let pruned = self.pruned()?;
        let mut unavailable: HashSet<Hash> = HashSet::new();
        let mut chunks: Vec<Hash> = Vec::new();
        let mut queued: HashSet<Hash> = HashSet::new();
        let mut blobs_seen: HashSet<Hash> = HashSet::new();
        for id in &order {
            for entry in self.tree(*id)?.values() {
                if !blobs_seen.insert(entry.blob) {
                    continue;
                }
                let blob = self.blob(entry.blob)?;
                if pruned.contains(&entry.blob) {
                    // Removed here to free space; fine if the remote has it.
                    let mut on_remote = true;
                    for chunk in &blob.chunks {
                        on_remote &= self.remote_has_chunk(*chunk)?;
                    }
                    if !on_remote {
                        unavailable.insert(entry.blob);
                    }
                    continue;
                }
                for chunk in blob.chunks {
                    if queued.insert(chunk) && !self.remote_has_chunk(chunk)? {
                        chunks.push(chunk);
                    }
                }
            }
        }
        let mut total = 0;
        for chunk in &chunks {
            total += self.store.raw_len(chunk)?;
        }

        let tmp = self.root.join(META_DIR).join("tmp");
        let mut done = 0;
        progress(SyncProgress {
            phase: SyncPhase::Uploading,
            done,
            total,
        });
        let mut pack: Option<PackBuilder> = None;
        let mut packs_made = 0;
        for chunk in chunks {
            let raw = self.store.read_raw(&chunk)?;
            let builder = match &mut pack {
                Some(p) => p,
                None => {
                    packs_made += 1;
                    pack.insert(PackBuilder::new(&tmp, packs_made)?)
                }
            };
            builder.add(chunk, &raw)?;
            if builder.size >= PACK_TARGET {
                let full = pack.take().expect("pack in progress");
                done += full.size;
                report.uploaded_bytes += self.upload_pack(storage, full)?;
                progress(SyncProgress {
                    phase: SyncPhase::Uploading,
                    done,
                    total,
                });
            }
        }
        if let Some(last) = pack {
            done += last.size;
            report.uploaded_bytes += self.upload_pack(storage, last)?;
            progress(SyncProgress {
                phase: SyncPhase::Uploading,
                done,
                total,
            });
        }

        // Versions, after all their contents are on the remote.
        let files = order
            .iter()
            .map(|id| {
                Ok((
                    *id,
                    encode(&self.snapshot_file(&graph, *id, &unavailable)?)?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        let conn = &self.conn;
        parallel(
            files,
            |(id, data)| {
                storage.write(&format!("snapshots/{}.snap", id.to_hex()), &data)?;
                Ok((id, data.len() as u64))
            },
            |&(id, len)| {
                conn.execute(
                    "INSERT OR IGNORE INTO remote_snapshots (id) VALUES (?1)",
                    [id],
                )?;
                report.uploaded_bytes += len;
                report.sent_versions += 1;
                Ok(())
            },
        )?;

        self.push_comments(storage, report)?;
        self.push_meta(storage, report)?;
        self.push_refs(storage)
    }

    fn push_meta(&mut self, storage: &dyn Storage, report: &mut SyncReport) -> Result<()> {
        let conn = &self.conn;
        parallel(
            self.unpushed_meta()?,
            |event| {
                let path = format!("meta/{}.json", event.uid);
                let file = MetaFile {
                    blob: event.blob.to_hex(),
                    uid: event.uid,
                    field: event.field,
                    value: event.value,
                    at: event.at,
                    author: event.author,
                };
                storage.write(&path, &json(&file)?)?;
                Ok((file.uid, path))
            },
            |(uid, path)| {
                conn.execute("UPDATE meta_events SET pushed = 1 WHERE uid = ?1", [uid])?;
                conn.execute(
                    "INSERT OR IGNORE INTO remote_seen (path) VALUES (?1)",
                    [path],
                )?;
                report.notes_sent += 1;
                Ok(())
            },
        )?;
        Ok(())
    }

    fn remote_has_chunk(&self, chunk: Hash) -> Result<bool> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT 1 FROM remote_chunks WHERE hash = ?1")?;
        Ok(stmt.exists([chunk])?)
    }

    /// Uploads a pack, then its index; returns the bytes sent.
    fn upload_pack(&mut self, storage: &dyn Storage, mut pack: PackBuilder) -> Result<u64> {
        pack.out.flush()?;
        drop(pack.out);
        let name = Hash::from(pack.hasher.finalize()).to_hex();
        let index = encode(&PackIndex {
            chunks: pack
                .index
                .iter()
                .map(|(h, o, l)| (h.to_hex(), *o, *l))
                .collect(),
        })?;
        let uploaded = (|| {
            storage.write_file(&format!("packs/{name}.pack"), &pack.path)?;
            storage.write(&format!("packs/{name}.idx"), &index)
        })();
        let _ = fs::remove_file(&pack.path);
        uploaded?;
        let tx = self.conn.transaction()?;
        {
            let mut put = tx.prepare(
                "INSERT OR IGNORE INTO remote_chunks (hash, pack, offset, length) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (hash, offset, len) in &pack.index {
                put.execute(params![hash, name, *offset as i64, *len as i64])?;
            }
            tx.execute(
                "INSERT OR IGNORE INTO remote_packs (name) VALUES (?1)",
                [&name],
            )?;
        }
        tx.commit()?;
        Ok(pack.size + index.len() as u64)
    }

    fn snapshot_file(
        &self,
        graph: &Graph,
        id: Hash,
        unavailable: &HashSet<Hash>,
    ) -> Result<SnapshotFile> {
        let snapshot = self.snapshot(id)?;
        let tree = self.tree(id)?;
        let mut blobs = Vec::new();
        let mut pruned = Vec::new();
        let mut seen = HashSet::new();
        for entry in tree.values() {
            if seen.insert(entry.blob) {
                let blob = self.blob(entry.blob)?;
                if unavailable.contains(&blob.hash) {
                    pruned.push(blob.hash.to_hex());
                }
                blobs.push(BlobFile {
                    hash: blob.hash.to_hex(),
                    size: blob.size,
                    chunks: blob.chunks.iter().map(Hash::to_hex).collect(),
                });
            }
        }
        Ok(SnapshotFile {
            id: id.to_hex(),
            parents: snapshot.parents.iter().map(Hash::to_hex).collect(),
            message: snapshot.message,
            author: snapshot.author,
            created_at: snapshot.created_at,
            entries: tree
                .into_iter()
                .map(|(path, e)| EntryFile {
                    path,
                    blob: e.blob.to_hex(),
                    size: e.size,
                })
                .collect(),
            blobs,
            ancestors: ancestor_hints(graph, id).iter().map(Hash::to_hex).collect(),
            pruned,
        })
    }

    fn push_comments(&mut self, storage: &dyn Storage, report: &mut SyncReport) -> Result<()> {
        let pending: Vec<(i64, CommentFile)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, uid, snapshot_id, path, timecode_ms, text, author, created_at FROM comments
                 WHERE pushed = 0 AND snapshot_id IN (SELECT id FROM remote_snapshots)",
            )?;
            stmt.query_map([], |r| {
                Ok((
                    r.get(0)?,
                    CommentFile {
                        uid: r.get(1)?,
                        snapshot: r.get::<_, Hash>(2)?.to_hex(),
                        path: r.get(3)?,
                        timecode_ms: r.get::<_, Option<i64>>(4)?.map(|t| t as u64),
                        text: r.get(5)?,
                        author: r.get(6)?,
                        created_at: r.get(7)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<_>>()?
        };
        let conn = &self.conn;
        parallel(
            pending,
            |(id, comment)| {
                let path = format!("comments/{}.json", comment.uid);
                storage.write(&path, &json(&comment)?)?;
                Ok((id, path))
            },
            |(id, path)| {
                conn.execute("UPDATE comments SET pushed = 1 WHERE id = ?1", [id])?;
                conn.execute(
                    "INSERT OR IGNORE INTO remote_seen (path) VALUES (?1)",
                    [path],
                )?;
                report.comments_sent += 1;
                Ok(())
            },
        )?;

        let resolved: Vec<(i64, String)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, uid FROM comments WHERE resolved = 1 AND resolution_pushed = 0 AND pushed = 1",
            )?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        parallel(
            resolved,
            |(id, uid)| {
                let path = format!("resolved/{uid}");
                storage.write(&path, b"1")?;
                Ok((id, path))
            },
            |(id, path)| {
                conn.execute(
                    "UPDATE comments SET resolution_pushed = 1 WHERE id = ?1",
                    [id],
                )?;
                conn.execute(
                    "INSERT OR IGNORE INTO remote_seen (path) VALUES (?1)",
                    [path],
                )?;
                Ok(())
            },
        )?;
        Ok(())
    }

    /// Publishes our branch heads, deleted branches, tags and device name.
    fn push_refs(&mut self, storage: &dyn Storage) -> Result<()> {
        let (me, my_name) = self.device()?;
        let device_path = format!("devices/{me}.json");
        let device = DeviceFile {
            name: my_name.clone(),
        };
        let current = storage
            .read(&device_path)?
            .and_then(|d| serde_json::from_slice::<DeviceFile>(&d).ok());
        if current.as_ref() != Some(&device) {
            storage.write(&device_path, &json(&device)?)?;
        }

        let remote_tags: HashSet<String> = storage.list("tags")?.into_iter().collect();
        for (name, id) in self.refs(TAG)? {
            let file = name_to_file(&name);
            if !remote_tags.contains(&file) {
                storage.write(&format!("tags/{file}"), &ref_file(id)?)?;
            }
        }

        let dir = format!("refs/{me}");
        let published: HashSet<String> = storage.list(&dir)?.into_iter().collect();
        let pushed: HashMap<String, Hash> = {
            let mut stmt = self
                .conn
                .prepare("SELECT name, snapshot_id FROM remote_refs WHERE device = ?1")?;
            stmt.query_map([&me], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut keep = HashSet::new();
        for (name, id) in self.refs(BRANCH)? {
            let file = format!("b-{}", name_to_file(&name));
            if pushed.get(&name) != Some(&id) || !published.contains(&file) {
                storage.write(&format!("{dir}/{file}"), &ref_file(id)?)?;
                self.conn.execute(
                    "INSERT OR REPLACE INTO remote_refs (device, device_name, name, snapshot_id) VALUES (?1, ?2, ?3, ?4)",
                    params![me, my_name, name, id],
                )?;
            }
            keep.insert(file);
        }
        let deleted: Vec<(String, Hash)> = {
            let mut stmt = self
                .conn
                .prepare("SELECT name, snapshot_id FROM deleted_branches")?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (name, id) in deleted {
            let file = format!("d-{}", name_to_file(&name));
            if !published.contains(&file) {
                storage.write(&format!("{dir}/{file}"), &ref_file(id)?)?;
            }
            keep.insert(file);
        }
        for file in published.difference(&keep) {
            storage.delete(&format!("{dir}/{file}"))?;
            if let Some(name) = file.strip_prefix("b-").and_then(file_to_name) {
                self.conn.execute(
                    "DELETE FROM remote_refs WHERE device = ?1 AND name = ?2",
                    params![me, name],
                )?;
            }
        }
        Ok(())
    }

    /// Resolves `<branch>@<device name>` to another device's branch head.
    pub(super) fn resolve_remote_head(&self, rev: &str) -> Result<Option<Hash>> {
        let Some((branch, device)) = rev.rsplit_once('@') else {
            return Ok(None);
        };
        Ok(self
            .conn
            .query_row(
                "SELECT snapshot_id FROM remote_refs
                 WHERE name = ?1 AND (device_name = ?2 OR device = ?2)
                   AND snapshot_id IN (SELECT id FROM snapshots)
                 LIMIT 1",
                params![branch, device],
                |r| r.get(0),
            )
            .optional()?)
    }
}

fn diverged(head: &RemoteHead) -> Diverged {
    Diverged {
        branch: head.branch.clone(),
        device: head.device_name.clone(),
        rev: format!("{}@{}", head.branch, head.device_name),
    }
}

fn push_unique(list: &mut Vec<String>, name: &str) {
    if !list.iter().any(|n| n == name) {
        list.push(name.to_owned());
    }
}

/// Up to [`ANCESTOR_HINTS`] versions before the parents of `id`, nearest first.
fn ancestor_hints(graph: &Graph, id: Hash) -> Vec<Hash> {
    let parents = graph.parents_of(&id);
    let mut seen: HashSet<Hash> = parents.iter().copied().chain([id]).collect();
    let mut queue: VecDeque<Hash> = parents.iter().copied().collect();
    let mut hints = Vec::new();
    while let Some(next) = queue.pop_front() {
        for &parent in graph.parents_of(&next) {
            if seen.insert(parent) {
                hints.push(parent);
                if hints.len() == ANCESTOR_HINTS {
                    return hints;
                }
                queue.push_back(parent);
            }
        }
    }
    hints
}

/// Checks a downloaded version against its id, so a damaged or forged file
/// is rejected.
fn verify_snapshot(id: Hash, file: &SnapshotFile) -> Result<()> {
    let mut tree = Tree::new();
    for e in &file.entries {
        crate::worktree::to_abs(Path::new(""), &e.path)?;
        tree.insert(
            e.path.clone(),
            Entry {
                blob: parse_hash(&e.blob)?,
                size: e.size,
            },
        );
    }
    let parents = file
        .parents
        .iter()
        .map(|p| parse_hash(p))
        .collect::<Result<Vec<_>>>()?;
    let described: HashSet<String> = file.blobs.iter().map(|b| b.hash.clone()).collect();
    if snapshot_id(
        &parents,
        &file.author,
        &file.message,
        file.created_at,
        &tree,
    ) != id
        || file.entries.iter().any(|e| !described.contains(&e.blob))
    {
        return Err(Error::Corrupt(format!(
            "version {} on the remote is damaged",
            id.short()
        )));
    }
    Ok(())
}

fn insert_snapshot(tx: &Transaction<'_>, id: Hash, file: &SnapshotFile) -> Result<()> {
    let mut put_blob =
        tx.prepare_cached("INSERT OR IGNORE INTO blobs (hash, size, chunks) VALUES (?1, ?2, ?3)")?;
    for blob in &file.blobs {
        let chunks = blob
            .chunks
            .iter()
            .map(|c| parse_hash(c))
            .collect::<Result<Vec<_>>>()?;
        put_blob.execute(params![
            parse_hash(&blob.hash)?,
            blob.size as i64,
            store::chunks_to_bytes(&chunks)
        ])?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO snapshots (id, message, author, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, file.message, file.author, file.created_at],
    )?;
    for (position, parent) in file.parents.iter().enumerate() {
        tx.execute(
            "INSERT OR IGNORE INTO snapshot_parents (snapshot_id, position, parent_id) VALUES (?1, ?2, ?3)",
            params![id, position as i64, parse_hash(parent)?],
        )?;
    }
    let mut put_entry = tx.prepare_cached(
        "INSERT OR IGNORE INTO snapshot_entries (snapshot_id, path, blob_hash, size) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for e in &file.entries {
        put_entry.execute(params![id, e.path, parse_hash(&e.blob)?, e.size as i64])?;
    }
    Ok(())
}

/// Downloaded versions ordered so parents come before children.
fn parents_first(files: &HashMap<Hash, SnapshotFile>) -> Result<Vec<Hash>> {
    let mut parents = HashMap::new();
    for (id, file) in files {
        let ps = file
            .parents
            .iter()
            .map(|p| parse_hash(p))
            .collect::<Result<Vec<_>>>()?;
        parents.insert(*id, ps);
    }
    let set: HashSet<Hash> = files.keys().copied().collect();
    Ok(postorder(&set, |id| {
        parents.get(id).cloned().unwrap_or_default()
    }))
}

fn parents_first_graph(graph: &Graph, set: &HashSet<Hash>) -> Vec<Hash> {
    postorder(set, |id| graph.parents_of(id).to_vec())
}

/// Depth-first post-order over `set`: every node after its parents.
fn postorder(set: &HashSet<Hash>, parents: impl Fn(&Hash) -> Vec<Hash>) -> Vec<Hash> {
    let mut order = Vec::with_capacity(set.len());
    let mut done = HashSet::new();
    let mut roots: Vec<Hash> = set.iter().copied().collect();
    roots.sort();
    for root in roots {
        let mut stack = vec![(root, false)];
        while let Some((id, expanded)) = stack.pop() {
            if done.contains(&id) || !set.contains(&id) {
                continue;
            }
            if expanded {
                done.insert(id);
                order.push(id);
            } else {
                stack.push((id, true));
                for p in parents(&id) {
                    if !done.contains(&p) {
                        stack.push((p, false));
                    }
                }
            }
        }
    }
    order
}

fn default_device_name() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "device".into())
}
