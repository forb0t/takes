//! Musicians' notes on file contents: labels ("демо", "сведение", "мастер"),
//! and tempo and key set by hand.
//!
//! Notes belong to a content, not to a version: a mix marked "мастер" stays
//! marked in every later version where it is unchanged. Every change is kept
//! as an event, and the latest one per content and field wins, so devices
//! that sync them agree without coordination.

use std::collections::{BTreeMap, HashMap};

use rusqlite::params;

use super::{Repo, now_ns};
use crate::error::{Error, Result};
use crate::hash::Hash;

const LABEL: &str = "label:";
const BPM: &str = "bpm";
const KEY: &str = "key";

/// Notes on one file content.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FileMeta {
    /// Sorted by name.
    pub labels: Vec<String>,
    /// Tempo set by hand (overrides the estimate).
    pub bpm: Option<f64>,
    /// Key set by hand, e.g. "Am".
    pub key: Option<String>,
}

impl FileMeta {
    pub fn is_empty(&self) -> bool {
        self.labels.is_empty() && self.bpm.is_none() && self.key.is_none()
    }

    fn from_fields(fields: BTreeMap<String, String>) -> Self {
        let mut meta = FileMeta::default();
        for (field, value) in fields {
            if let Some(label) = field.strip_prefix(LABEL) {
                if !value.is_empty() {
                    meta.labels.push(label.to_owned());
                }
            } else if field == BPM {
                meta.bpm = value.parse().ok();
            } else if field == KEY && !value.is_empty() {
                meta.key = Some(value);
            }
        }
        meta
    }
}

/// A change to the notes, as stored and synced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct MetaEvent {
    pub uid: String,
    pub blob: Hash,
    pub field: String,
    pub value: String,
    pub at: i64,
    pub author: String,
}

fn invalid(what: &str) -> Error {
    Error::InvalidMeta(what.to_owned())
}

/// Labels and keys are short, printable and trimmed.
fn check_text(text: &str, max: usize) -> Result<()> {
    if text.is_empty()
        || text.trim() != text
        || text.chars().count() > max
        || text.chars().any(char::is_control)
    {
        return Err(invalid(text));
    }
    Ok(())
}

fn format_bpm(bpm: f64) -> String {
    let rounded = (bpm * 100.0).round() / 100.0;
    format!("{rounded}")
}

impl Repo {
    /// Notes on every content that has any.
    pub fn all_file_meta(&self) -> Result<HashMap<Hash, FileMeta>> {
        let mut stmt = self
            .conn
            .prepare("SELECT blob, field, value FROM meta_events ORDER BY at, uid")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, Hash>(0)?, r.get::<_, String>(1)?, r.get(2)?))
        })?;
        let mut fields: HashMap<Hash, BTreeMap<String, String>> = HashMap::new();
        for row in rows {
            let (blob, field, value) = row?;
            fields.entry(blob).or_default().insert(field, value);
        }
        Ok(fields
            .into_iter()
            .map(|(blob, f)| (blob, FileMeta::from_fields(f)))
            .filter(|(_, meta)| !meta.is_empty())
            .collect())
    }

    /// Notes on one content (empty if none).
    pub fn file_meta(&self, blob: Hash) -> Result<FileMeta> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT field, value FROM meta_events WHERE blob = ?1 ORDER BY at, uid",
        )?;
        let rows = stmt.query_map([blob], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))?;
        let fields = rows.collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
        Ok(FileMeta::from_fields(fields))
    }

    /// Replaces the notes on `path` as saved in `rev`, recording only what
    /// changed.
    pub fn set_file_meta(&self, rev: &str, path: &str, meta: &FileMeta) -> Result<()> {
        for label in &meta.labels {
            check_text(label, 40)?;
        }
        if let Some(key) = &meta.key {
            check_text(key, 12)?;
        }
        if meta.bpm.is_some_and(|b| !(20.0..=400.0).contains(&b)) {
            return Err(invalid("bpm"));
        }
        let blob = self.file_at(rev, path)?.blob;
        let current = self.file_meta(blob)?;
        let mut changes: Vec<(String, String)> = Vec::new();
        for label in meta.labels.iter().filter(|l| !current.labels.contains(l)) {
            changes.push((format!("{LABEL}{label}"), "1".into()));
        }
        for label in current.labels.iter().filter(|l| !meta.labels.contains(l)) {
            changes.push((format!("{LABEL}{label}"), String::new()));
        }
        if meta.bpm.map(format_bpm) != current.bpm.map(format_bpm) {
            changes.push((BPM.into(), meta.bpm.map(format_bpm).unwrap_or_default()));
        }
        if meta.key != current.key {
            changes.push((KEY.into(), meta.key.clone().unwrap_or_default()));
        }
        if changes.is_empty() {
            return Ok(());
        }
        let author = self.author()?;
        // Later than anything recorded here, even within one millisecond.
        let last: i64 =
            self.conn
                .query_row("SELECT COALESCE(MAX(at), 0) FROM meta_events", [], |r| {
                    r.get(0)
                })?;
        let at = (now_ns() / 1_000_000).max(last + 1);
        let tx = self.conn.unchecked_transaction()?;
        for (field, value) in changes {
            tx.execute(
                "INSERT INTO meta_events (uid, blob, field, value, at, author)
                 VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5)",
                params![blob, field, value, at, author],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Changes not sent to the remote yet.
    pub(super) fn unpushed_meta(&self) -> Result<Vec<MetaEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT uid, blob, field, value, at, author FROM meta_events WHERE pushed = 0",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(MetaEvent {
                uid: r.get(0)?,
                blob: r.get(1)?,
                field: r.get(2)?,
                value: r.get(3)?,
                at: r.get(4)?,
                author: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Stores a change from another device; false if it was known.
    pub(super) fn import_meta(&self, event: &MetaEvent) -> Result<bool> {
        let field_ok = event.field == BPM
            || event.field == KEY
            || event
                .field
                .strip_prefix(LABEL)
                .is_some_and(|l| check_text(l, 40).is_ok());
        if !field_ok {
            return Ok(false);
        }
        Ok(self.conn.execute(
            "INSERT OR IGNORE INTO meta_events (uid, blob, field, value, at, author, pushed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
            params![
                event.uid,
                event.blob,
                event.field,
                event.value,
                event.at,
                event.author
            ],
        )? > 0)
    }
}
