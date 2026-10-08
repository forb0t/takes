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
//! tags/<hex name>              a tag (first writer wins)
//! refs/<device>/b-<hex name>   branch heads of one device, written only by it
//! devices/<device>.json        a device's display name
//! ```
//!
//! Since each device only ever writes its own refs, no locking is needed and
//! nothing is overwritten. Branches that moved on two devices show up as
//! diverged and are merged like any branch, as `<branch>@<device>`.

use std::collections::{BTreeMap, HashMap, HashSet};
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
use crate::remote::{RemoteConfig, Storage};
use crate::store;
use crate::worktree::META_DIR;

const FORMAT: u32 = 1;
const MARKER: &str = "takes-remote.json";
/// Packs are closed at this size: few enough files for cloud drives, small
/// enough that an interrupted upload loses little.
const PACK_TARGET: u64 = 64 * 1024 * 1024;
/// Neighbouring chunks closer than this are downloaded in one request.
const MERGE_GAP: u64 = 256 * 1024;
const MAX_REQUEST: u64 = 32 * 1024 * 1024;

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
    /// Branches moved forward to another device's newer version.
    pub updated_branches: Vec<String>,
    /// Branches that existed only on other devices until now.
    pub new_branches: Vec<String>,
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
    /// Branches with a newer version from another device not applied yet
    /// (the current branch while there are unsaved changes).
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

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(value).map_err(|e| Error::Corrupt(e.to_string()))?;
    Ok(zstd::bulk::compress(&json, 3)?)
}

fn decode<T: DeserializeOwned>(what: &str, data: &[u8]) -> Result<T> {
    let json =
        zstd::decode_all(data).map_err(|_| Error::Corrupt(format!("remote {what} is damaged")))?;
    serde_json::from_slice(&json).map_err(|_| Error::Corrupt(format!("remote {what} is damaged")))
}

fn parse_hash(hex: &str) -> Result<Hash> {
    Hash::from_hex(hex).ok_or_else(|| Error::Corrupt(format!("bad hash on the remote: {hex}")))
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
        return Err(Error::Corrupt(
            "the remote was written by a newer version of takes".into(),
        ));
    }
    Ok(Some(marker))
}

/// Projects in the folders directly under `storage` (for "open from remote").
pub fn find_remote_projects(storage: &dyn Storage) -> Result<Vec<String>> {
    let mut found = Vec::new();
    for name in storage.list("")? {
        if storage.read(&format!("{name}/{MARKER}"))?.is_some() {
            found.push(name);
        }
    }
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
             DELETE FROM remote_refs; DELETE FROM remote_seen;
             UPDATE comments SET pushed = 0, resolution_pushed = 0;
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
    /// forward where possible, then sends ours.
    pub fn sync(
        &mut self,
        storage: &dyn Storage,
        progress: &mut dyn FnMut(SyncProgress),
    ) -> Result<SyncReport> {
        progress(SyncProgress {
            phase: SyncPhase::Connecting,
            done: 0,
            total: 0,
        });
        self.connect_remote(storage)?;
        let mut report = SyncReport::default();
        self.fetch(storage, &mut report, progress)?;
        self.integrate(&mut report)?;
        self.push(storage, &mut report, progress)?;
        self.set_config("sync.last", &now_secs().to_string())?;
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
            repo.integrate(&mut report)?;
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
        Ok(self
            .conn
            .query_row("SELECT 1 FROM snapshots WHERE id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some())
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
            None => Relation::Behind(None),
            Some(ours) if ours == head.id => Relation::Same,
            Some(ours) if graph.is_ancestor(head.id, ours) => Relation::Ahead,
            Some(ours) if graph.is_ancestor(ours, head.id) => Relation::Behind(Some(ours)),
            Some(_) => Relation::Diverged,
        })
    }

    // ---- fetch --------------------------------------------------------------

    /// Learns which packs and versions the remote has.
    fn refresh_remote_index(&mut self, storage: &dyn Storage) -> Result<()> {
        let known: HashSet<String> = {
            let mut stmt = self.conn.prepare("SELECT name FROM remote_packs")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for file in storage.list("packs")? {
            let Some(name) = file.strip_suffix(".idx") else {
                continue;
            };
            if known.contains(name) {
                continue;
            }
            let Some(data) = storage.read(&format!("packs/{file}"))? else {
                continue;
            };
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
                tx.execute("INSERT INTO remote_packs (name) VALUES (?1)", [name])?;
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

        let mut device_names = HashMap::new();
        for file in storage.list("devices")? {
            if let Some(id) = file.strip_suffix(".json")
                && let Some(data) = storage.read(&format!("devices/{file}"))?
                && let Ok(device) = serde_json::from_slice::<DeviceFile>(&data)
            {
                device_names.insert(id.to_owned(), device.name);
            }
        }

        // Branch heads of other devices.
        let mut heads: Vec<(String, String, Hash)> = Vec::new();
        for device in storage.list("refs")? {
            if device == me {
                continue;
            }
            for file in storage.list(&format!("refs/{device}"))? {
                let Some(branch) = file.strip_prefix("b-").and_then(file_to_name) else {
                    continue;
                };
                let Some(data) = storage.read(&format!("refs/{device}/{file}"))? else {
                    continue;
                };
                let reference: RefFile = serde_json::from_slice(&data)
                    .map_err(|_| Error::Corrupt(format!("remote branch {branch} is damaged")))?;
                heads.push((device.clone(), branch, parse_hash(&reference.snapshot)?));
            }
        }

        let mut tags: Vec<(String, Hash)> = Vec::new();
        for file in storage.list("tags")? {
            let Some(name) = file_to_name(&file) else {
                continue;
            };
            if self.ref_target(TAG, &name)?.is_some() {
                continue;
            }
            if let Some(data) = storage.read(&format!("tags/{file}"))? {
                let reference: RefFile = serde_json::from_slice(&data)
                    .map_err(|_| Error::Corrupt(format!("remote tag {name} is damaged")))?;
                tags.push((name, parse_hash(&reference.snapshot)?));
            }
        }

        // Versions we lack, following parents until we reach known ones.
        let mut files: HashMap<Hash, SnapshotFile> = HashMap::new();
        let mut queue: Vec<Hash> = heads
            .iter()
            .map(|h| h.2)
            .chain(tags.iter().map(|t| t.1))
            .collect();
        while let Some(id) = queue.pop() {
            if files.contains_key(&id) || self.has_snapshot(id)? {
                continue;
            }
            let data = storage
                .read(&format!("snapshots/{}.snap", id.to_hex()))?
                .ok_or_else(|| {
                    Error::Corrupt(format!("version {} is missing on the remote", id.short()))
                })?;
            let file: SnapshotFile = decode("version", &data)?;
            verify_snapshot(id, &file)?;
            for parent in &file.parents {
                queue.push(parse_hash(parent)?);
            }
            files.insert(id, file);
        }

        self.download_chunks(storage, &files, report, progress)?;

        // Store versions, parents first.
        let order = parents_first(&files)?;
        let tx = self.conn.transaction()?;
        for id in &order {
            insert_snapshot(&tx, *id, &files[id])?;
        }
        tx.commit()?;
        report.received_versions += order.len() as u64;

        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM remote_refs WHERE device != ?1", [&me])?;
        for (device, branch, id) in &heads {
            let name = device_names
                .get(device)
                .cloned()
                .unwrap_or_else(|| device[..8.min(device.len())].to_owned());
            tx.execute(
                "INSERT OR REPLACE INTO remote_refs (device, device_name, name, snapshot_id) VALUES (?1, ?2, ?3, ?4)",
                params![device, name, branch, id],
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

        self.fetch_comments(storage, report)
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
            for blob in &file.blobs {
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
        for hash in needed {
            let (pack, offset, len): (String, i64, i64) = self
                .conn
                .query_row(
                    "SELECT pack, offset, length FROM remote_chunks WHERE hash = ?1",
                    [hash],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
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

        let mut done = 0;
        progress(SyncProgress {
            phase: SyncPhase::Downloading,
            done,
            total,
        });
        for (pack, mut chunks) in by_pack {
            chunks.sort();
            let path = format!("packs/{pack}.pack");
            let mut i = 0;
            while i < chunks.len() {
                // One request for a run of nearby chunks.
                let start = chunks[i].0;
                let mut j = i + 1;
                while j < chunks.len()
                    && chunks[j].0 <= chunks[j - 1].0 + chunks[j - 1].1 + MERGE_GAP
                    && chunks[j].0 + chunks[j].1 - start <= MAX_REQUEST
                {
                    j += 1;
                }
                let end = chunks[j - 1].0 + chunks[j - 1].1;
                let data = storage.read_range(&path, start, end - start)?;
                for &(offset, len, hash) in &chunks[i..j] {
                    let from = (offset - start) as usize;
                    self.store
                        .put_raw(&hash, &data[from..from + len as usize])?;
                    done += len;
                }
                report.downloaded_bytes += end - start;
                progress(SyncProgress {
                    phase: SyncPhase::Downloading,
                    done,
                    total,
                });
                i = j;
            }
        }
        Ok(())
    }

    fn fetch_comments(&mut self, storage: &dyn Storage, report: &mut SyncReport) -> Result<()> {
        let seen: HashSet<String> = {
            let mut stmt = self.conn.prepare("SELECT path FROM remote_seen")?;
            stmt.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for file in storage.list("comments")? {
            let path = format!("comments/{file}");
            if seen.contains(&path) || !file.ends_with(".json") {
                continue;
            }
            let Some(data) = storage.read(&path)? else {
                continue;
            };
            let Ok(c) = serde_json::from_slice::<CommentFile>(&data) else {
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

    // ---- integrate ------------------------------------------------------------

    /// Moves local branches forward to newer versions from other devices and
    /// reports branches that diverged.
    fn integrate(&mut self, report: &mut SyncReport) -> Result<()> {
        let graph = self.graph()?;
        let current = self.current_branch()?;
        for head in self.remote_heads()? {
            match self.relation(&graph, &head)? {
                Relation::Same | Relation::Ahead => {}
                Relation::Diverged => report.diverged.push(diverged(&head)),
                Relation::Behind(ours) if head.branch == current => {
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
        let mut chunks: Vec<Hash> = Vec::new();
        let mut queued: HashSet<Hash> = HashSet::new();
        let mut blobs_seen: HashSet<Hash> = HashSet::new();
        for id in &order {
            for entry in self.tree(*id)?.values() {
                if !blobs_seen.insert(entry.blob) {
                    continue;
                }
                for chunk in self.blob(entry.blob)?.chunks {
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
        for id in &order {
            let data = encode(&self.snapshot_file(*id)?)?;
            storage.write(&format!("snapshots/{}.snap", id.to_hex()), &data)?;
            report.uploaded_bytes += data.len() as u64;
            self.conn.execute(
                "INSERT OR IGNORE INTO remote_snapshots (id) VALUES (?1)",
                [id],
            )?;
            report.sent_versions += 1;
        }

        self.push_comments(storage, report)?;
        self.push_refs(storage)
    }

    fn remote_has_chunk(&self, chunk: Hash) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM remote_chunks WHERE hash = ?1",
                [chunk],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
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

    fn snapshot_file(&self, id: Hash) -> Result<SnapshotFile> {
        let snapshot = self.snapshot(id)?;
        let tree = self.tree(id)?;
        let mut blobs = Vec::new();
        let mut seen = HashSet::new();
        for entry in tree.values() {
            if seen.insert(entry.blob) {
                let blob = self.blob(entry.blob)?;
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
        for (id, comment) in pending {
            let path = format!("comments/{}.json", comment.uid);
            let json = serde_json::to_vec(&comment).map_err(|e| Error::Corrupt(e.to_string()))?;
            storage.write(&path, &json)?;
            self.conn
                .execute("UPDATE comments SET pushed = 1 WHERE id = ?1", [id])?;
            self.conn.execute(
                "INSERT OR IGNORE INTO remote_seen (path) VALUES (?1)",
                [&path],
            )?;
            report.comments_sent += 1;
        }
        let resolved: Vec<(i64, String)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, uid FROM comments WHERE resolved = 1 AND resolution_pushed = 0 AND pushed = 1",
            )?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (id, uid) in resolved {
            let path = format!("resolved/{uid}");
            storage.write(&path, b"1")?;
            self.conn.execute(
                "UPDATE comments SET resolution_pushed = 1 WHERE id = ?1",
                [id],
            )?;
            self.conn.execute(
                "INSERT OR IGNORE INTO remote_seen (path) VALUES (?1)",
                [&path],
            )?;
        }
        Ok(())
    }

    /// Publishes our branch heads and tags, and our device name.
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
            let json = serde_json::to_vec(&device).map_err(|e| Error::Corrupt(e.to_string()))?;
            storage.write(&device_path, &json)?;
        }

        let remote_tags: HashSet<String> = storage.list("tags")?.into_iter().collect();
        for (name, id) in self.refs(TAG)? {
            let file = name_to_file(&name);
            if !remote_tags.contains(&file) {
                let json = serde_json::to_vec(&RefFile {
                    snapshot: id.to_hex(),
                    updated_at: now_secs(),
                })
                .map_err(|e| Error::Corrupt(e.to_string()))?;
                storage.write(&format!("tags/{file}"), &json)?;
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
                let json = serde_json::to_vec(&RefFile {
                    snapshot: id.to_hex(),
                    updated_at: now_secs(),
                })
                .map_err(|e| Error::Corrupt(e.to_string()))?;
                storage.write(&format!("{dir}/{file}"), &json)?;
                self.conn.execute(
                    "INSERT OR REPLACE INTO remote_refs (device, device_name, name, snapshot_id) VALUES (?1, ?2, ?3, ?4)",
                    params![me, my_name, name, id],
                )?;
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
