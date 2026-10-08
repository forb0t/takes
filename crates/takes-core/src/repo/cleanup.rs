//! Freeing space: versions nothing leads to any more, and the file data of
//! old intermediate versions.

use std::collections::HashSet;
use std::fs;
use std::io;

use rusqlite::Connection;

use super::{BRANCH, Repo, TAG};
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
        let _lock = self.lock_exclusive()?;
        let graph = self.graph()?;
        let (me, _) = self.device()?;

        // Versions that keep everything before them alive.
        let mut heads: HashSet<Hash> = self
            .refs(BRANCH)?
            .into_iter()
            .chain(self.refs(TAG)?)
            .map(|(_, id)| id)
            .collect();
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
            if !self.deletion_covers(&graph, &branch, id)? {
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

        // Versions whose file data stays.
        let full: HashSet<Hash> = match prune_before {
            None => live.clone(),
            Some(before) => live
                .iter()
                .filter(|id| {
                    heads.contains(*id)
                        || open_comments.contains(*id)
                        || graph.time_of(id) >= before
                })
                .copied()
                .collect(),
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
                } else if kept.contains(&blob) && !pruned.contains(&blob) {
                    needed.extend(store::chunks_from_bytes(&chunks)?);
                }
            }
        }
        let to_prune: Vec<Hash> = used
            .iter()
            .filter(|b| !kept.contains(*b) && !pruned.contains(*b))
            .copied()
            .collect();
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

fn ids(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> Result<Vec<Hash>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
