//! Settings shared by every device of a project, such as the order of songs
//! on the diagram. Like file notes, every change is kept as an event and
//! synced as is; the latest one per key wins, so devices agree without
//! coordination.

use std::collections::BTreeMap;

use rusqlite::{OptionalExtension, params};

use super::{Repo, now_ns};
use crate::error::{Error, Result};

/// Keys are short names; values may be any text (often JSON).
const MAX_KEY: usize = 64;
const MAX_VALUE: usize = 256 * 1024;

/// A change to a shared setting, as stored and synced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SettingEvent {
    pub uid: String,
    pub key: String,
    pub value: String,
    pub at: i64,
    pub author: String,
}

fn valid(key: &str, value: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
        && value.len() <= MAX_VALUE
}

impl Repo {
    /// The current value of a shared setting, if anyone ever set it.
    pub fn shared_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM setting_events WHERE key = ?1 ORDER BY at DESC, uid DESC LIMIT 1",
                [key],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// The current values of the shared settings whose keys start with `prefix`.
    pub fn shared_settings(&self, prefix: &str) -> Result<BTreeMap<String, String>> {
        let mut stmt = self.conn.prepare(
            "SELECT key, value FROM setting_events WHERE substr(key, 1, length(?1)) = ?1
             ORDER BY at, uid",
        )?;
        let rows = stmt.query_map([prefix], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        // Later changes come last and win.
        let mut values = BTreeMap::new();
        for row in rows {
            let (key, value) = row?;
            values.insert(key, value);
        }
        Ok(values)
    }

    /// Changes a shared setting here; other devices take it on their next
    /// sync. Setting the current value again records nothing.
    pub fn set_shared_setting(&self, key: &str, value: &str) -> Result<()> {
        if !valid(key, value) {
            return Err(Error::InvalidName(key.to_owned()));
        }
        if self.shared_setting(key)?.as_deref() == Some(value) {
            return Ok(());
        }
        // Later than anything recorded here, even within one millisecond.
        let last: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(at), 0) FROM setting_events WHERE key = ?1",
            [key],
            |r| r.get(0),
        )?;
        let at = (now_ns() / 1_000_000).max(last + 1);
        self.conn.execute(
            "INSERT INTO setting_events (uid, key, value, at, author)
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4)",
            params![key, value, at, self.author()?],
        )?;
        self.forget_older(key)
    }

    /// Drops changes a later one replaced, sent or not: a setting changed
    /// often (where things lie on the diagram) would pile them up, and only
    /// the latest ever counts.
    fn forget_older(&self, key: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM setting_events WHERE key = ?1
             AND at < (SELECT MAX(at) FROM setting_events WHERE key = ?1)",
            [key],
        )?;
        Ok(())
    }

    /// Changes not sent to the remote yet.
    pub(super) fn unpushed_settings(&self) -> Result<Vec<SettingEvent>> {
        let mut stmt = self
            .conn
            .prepare("SELECT uid, key, value, at, author FROM setting_events WHERE pushed = 0")?;
        let rows = stmt.query_map([], |r| {
            Ok(SettingEvent {
                uid: r.get(0)?,
                key: r.get(1)?,
                value: r.get(2)?,
                at: r.get(3)?,
                author: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Stores a change from another device; false if it was known or invalid.
    pub(super) fn import_setting(&self, event: &SettingEvent) -> Result<bool> {
        if !valid(&event.key, &event.value) {
            return Ok(false);
        }
        let added = self.conn.execute(
            "INSERT OR IGNORE INTO setting_events (uid, key, value, at, author, pushed)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)",
            params![event.uid, event.key, event.value, event.at, event.author],
        )? > 0;
        self.forget_older(&event.key)?;
        Ok(added)
    }
}
