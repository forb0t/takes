//! Freeing space: versions nothing leads to any more, and the file data of
//! old intermediate versions.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;

use rusqlite::{Connection, OptionalExtension};

use super::{BRANCH, Repo, TAG, TAKE_PREFIX};
use crate::error::Result;
use crate::hash::Hash;
use crate::store;
use crate::worktree::META_DIR;

/// What cleanup removed, or would remove.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cleanup {
    /// Versions no branch, tag or comment leads to (e.g. of deleted branches).
    pub versions: u64,
    /// File contents whose data was removed; their versions stay in history.
    pub contents: u64,
    pub chunks: u64,
    /// Disk space freed.
    pub bytes: u64,
}

impl Repo {
    /// Frees space. Always drops versions that no branch, tag, comment or
    /// other device's branch leads to, e.g. those of deleted branches.
    ///
    /// With `prune_before` (unix seconds) it also removes the file data of
    /// versions saved before then, keeping the latest version of every
    /// branch, tagged versions and versions with open comments. Pruned
    /// versions stay in the history, but their files can no longer be
    /// played or restored here. With `dry_run` nothing changes.
    pub fn cleanup(&mut self, prune_before: Option<i64>, dry_run: bool) -> Result<Cleanup> {
        self.cleanup_keeping(prune_before, dry_run, &HashSet::new())
    }

    /// Like [`Repo::cleanup`], also keeping the file data of `keep`: versions
    /// the app holds dear, such as the latest take of every song's branch.
    pub fn cleanup_keeping(
        &mut self,
        prune_before: Option<i64>,
        dry_run: bool,
        keep: &HashSet<Hash>,
    ) -> Result<Cleanup> {
        self.sweep(prune_before, dry_run, keep, None, &HashMap::new())
    }

    /// Deletes versions of one song (`paths`: every name it had), as the app
    /// does with a song's branch. Takes kept beside the folder that are left
    /// with nothing but those versions go, and so do the versions; the song's
    /// file data in all of them is freed wherever nothing else needs it.
    /// Versions in the folder's history stay there, without that file.
    /// Tagged versions and ones with open comments keep it. Cleanup's usual
    /// work (versions nothing leads to) is done too. With `dry_run` nothing
    /// changes.
    pub fn drop_versions(
        &mut self,
        versions: &HashSet<Hash>,
        paths: &[String],
        dry_run: bool,
    ) -> Result<Cleanup> {
        let gone = self.takes_only_of(versions)?;
        if !dry_run {
            for name in gone.keys() {
                self.delete_branch(name)?;
            }
        }
        let dropping = Dropping { versions, paths };
        self.sweep(None, dry_run, &HashSet::new(), Some(&dropping), &gone)
    }

    /// Takes (refs beside the folder) whose own versions, the ones no other
    /// branch or tag leads to, are all in `versions`: name → head.
    fn takes_only_of(&self, versions: &HashSet<Hash>) -> Result<HashMap<String, Hash>> {
        let graph = self.graph()?;
        let heads: Vec<(String, Hash)> = self
            .refs(BRANCH)?
            .into_iter()
            .chain(
                self.refs(TAG)?
                    .into_iter()
                    .map(|(name, id)| (format!("tag:{name}"), id)),
            )
            .collect();
        let before: Vec<HashSet<Hash>> = heads.iter().map(|(_, id)| graph.ancestors(*id)).collect();
        let mut gone = HashMap::new();
        for (i, (name, head)) in heads.iter().enumerate() {
            if !name.starts_with(TAKE_PREFIX) {
                continue;
            }
            let own: HashSet<Hash> = before[i]
                .iter()
                .filter(|id| {
                    !before
                        .iter()
                        .enumerate()
                        .any(|(j, b)| j != i && b.contains(*id))
                })
                .copied()
                .collect();
            if !own.is_empty() && own.is_subset(versions) {
                gone.insert(name.clone(), *head);
            }
        }
        Ok(gone)
    }

    /// Cleanup proper. `dropping`: versions of a song being deleted (see
    /// [`Repo::drop_versions`]); `gone`: take refs deleted for it (name →
    /// head), deleted already or, in a dry run, as if they were.
    fn sweep(
        &mut self,
        prune_before: Option<i64>,
        dry_run: bool,
        keep: &HashSet<Hash>,
        dropping: Option<&Dropping>,
        gone: &HashMap<String, Hash>,
    ) -> Result<Cleanup> {
        let _lock = self.lock_exclusive()?;
        let graph = self.graph()?;
        let (me, _) = self.device()?;

        // Versions that keep everything before them alive.
        let mut heads: HashSet<Hash> = self
            .refs(BRANCH)?
            .into_iter()
            .filter(|(name, _)| !gone.contains_key(name))
            .chain(self.refs(TAG)?)
            .map(|(_, id)| id)
            .collect();
        let tagged: HashSet<Hash> = self.refs(TAG)?.into_iter().map(|(_, id)| id).collect();
        let folder = self.head()?;
        // Other devices' heads, unless that branch was deleted at or after
        // them: those versions are on the remote anyway, should the other
        // device build on them after all.
        let remote_heads: Vec<(String, Hash)> = {
            let mut stmt = self.conn.prepare(
                "SELECT name, snapshot_id FROM remote_refs
                 WHERE device != ?1 AND snapshot_id IN (SELECT id FROM snapshots)",
            )?;
            stmt.query_map([&me], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (branch, id) in remote_heads {
            let dropped_here = gone
                .get(&branch)
                .is_some_and(|head| graph.is_ancestor(id, *head));
            if !dropped_here && !self.deletion_covers(&graph, &branch, id)? {
                heads.insert(id);
            }
        }
        let commented = ids(&self.conn, "SELECT DISTINCT snapshot_id FROM comments", [])?;
        let open_comments: HashSet<Hash> = ids(
            &self.conn,
            "SELECT DISTINCT snapshot_id FROM comments WHERE resolved = 0",
            [],
        )?
        .into_iter()
        .collect();
        let mut live = HashSet::new();
        for id in heads.iter().chain(&commented) {
            if !live.contains(id) {
                live.extend(graph.ancestors(*id));
            }
        }
        let dead: Vec<Hash> = graph
            .time
            .keys()
            .filter(|id| !live.contains(*id))
            .copied()
            .collect();

        // Versions whose file data stays. A version being deleted keeps it
        // only when tagged, commented on or in the folder.
        let dropped = |id: &Hash| dropping.is_some_and(|d| d.versions.contains(id));
        let full: HashSet<Hash> = live
            .iter()
            .filter(|id| {
                if dropped(id) {
                    return tagged.contains(*id)
                        || open_comments.contains(*id)
                        || folder == Some(**id);
                }
                prune_before.is_none_or(|before| {
                    heads.contains(*id)
                        || keep.contains(*id)
                        || open_comments.contains(*id)
                        || graph.time_of(id) >= before
                })
            })
            .copied()
            .collect();
        // Deleting a song's versions frees only that song's file data.
        let candidates: Option<HashSet<Hash>> = match dropping {
            None => None,
            Some(d) => {
                let mut stmt = self.conn.prepare_cached(
                    "SELECT blob_hash FROM snapshot_entries WHERE snapshot_id = ?1 AND path = ?2",
                )?;
                let mut blobs = HashSet::new();
                for id in d.versions {
                    for path in d.paths {
                        if let Some(blob) = stmt
                            .query_row(rusqlite::params![id, path], |r| r.get::<_, Hash>(0))
                            .optional()?
                        {
                            blobs.insert(blob);
                        }
                    }
                }
                Some(blobs)
            }
        };

        // Contents by what still uses them.
        let mut used = HashSet::new();
        let mut kept = HashSet::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT snapshot_id, blob_hash FROM snapshot_entries")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, Hash>(0)?, r.get::<_, Hash>(1)?)))?;
            for row in rows {
                let (snapshot, blob) = row?;
                if live.contains(&snapshot) {
                    used.insert(blob);
                    if full.contains(&snapshot) {
                        kept.insert(blob);
                    }
                }
            }
        }
        let pruned = self.pruned()?;
        let to_prune: HashSet<Hash> = used
            .iter()
            .filter(|b| {
                !kept.contains(*b)
                    && !pruned.contains(*b)
                    && candidates.as_ref().is_none_or(|c| c.contains(*b))
            })
            .copied()
            .collect();
        let mut unused = Vec::new();
        let mut needed = HashSet::new();
        {
            let mut stmt = self.conn.prepare("SELECT hash, chunks FROM blobs")?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, Hash>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
            for row in rows {
                let (blob, chunks) = row?;
                if !used.contains(&blob) {
                    unused.push(blob);
                } else if !to_prune.contains(&blob) && !pruned.contains(&blob) {
                    needed.extend(store::chunks_from_bytes(&chunks)?);
                }
            }
        }
        let garbage = self.store.unreferenced(&needed)?;
        let report = Cleanup {
            versions: dead.len() as u64,
            contents: to_prune.len() as u64,
            chunks: garbage.len() as u64,
            bytes: garbage.iter().map(|(_, len)| len).sum(),
        };
        if dry_run {
            return Ok(report);
        }

        let tx = self.conn.transaction()?;
        {
            let mut entries = tx.prepare("DELETE FROM snapshot_entries WHERE snapshot_id = ?1")?;
            let mut parents = tx.prepare("DELETE FROM snapshot_parents WHERE snapshot_id = ?1")?;
            for id in &dead {
                entries.execute([id])?;
                parents.execute([id])?;
            }
            let mut snapshot = tx.prepare("DELETE FROM snapshots WHERE id = ?1")?;
            for id in &dead {
                snapshot.execute([id])?;
            }
            let mut blob = tx.prepare("DELETE FROM blobs WHERE hash = ?1")?;
            let mut unprune = tx.prepare("DELETE FROM pruned_blobs WHERE hash = ?1")?;
            for hash in &unused {
                blob.execute([hash])?;
                unprune.execute([hash])?;
            }
            let mut prune = tx.prepare("INSERT OR IGNORE INTO pruned_blobs (hash) VALUES (?1)")?;
            for hash in &to_prune {
                prune.execute([hash])?;
            }
        }
        tx.commit()?;
        // Data goes only once the database no longer points to it.
        for (path, _) in &garbage {
            match fs::remove_file(path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
        }
        // Leftovers of interrupted uploads.
        match fs::remove_dir_all(self.root.join(META_DIR).join("tmp")) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        Ok(report)
    }
}

/// Versions of a song being deleted, and every name the song had.
struct Dropping<'a> {
    versions: &'a HashSet<Hash>,
    paths: &'a [String],
}

fn ids(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> Result<Vec<Hash>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
