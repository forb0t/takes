use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use crate::error::{Error, Result};

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- The branch the working folder is on.
CREATE TABLE head (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    branch TEXT NOT NULL
);

-- File contents: ordered list of 32-byte chunk hashes, concatenated.
CREATE TABLE blobs (
    hash   BLOB PRIMARY KEY,
    size   INTEGER NOT NULL,
    chunks BLOB NOT NULL
);

CREATE TABLE snapshots (
    id         BLOB PRIMARY KEY,
    message    TEXT NOT NULL,
    author     TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE snapshot_parents (
    snapshot_id BLOB NOT NULL REFERENCES snapshots (id),
    position    INTEGER NOT NULL,
    parent_id   BLOB NOT NULL REFERENCES snapshots (id),
    PRIMARY KEY (snapshot_id, position)
);

CREATE TABLE snapshot_entries (
    snapshot_id BLOB NOT NULL REFERENCES snapshots (id),
    path        TEXT NOT NULL,
    blob_hash   BLOB NOT NULL REFERENCES blobs (hash),
    size        INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, path)
);
CREATE INDEX snapshot_entries_path ON snapshot_entries (path);

CREATE TABLE refs (
    kind        TEXT NOT NULL CHECK (kind IN ('branch', 'tag')),
    name        TEXT NOT NULL,
    snapshot_id BLOB NOT NULL REFERENCES snapshots (id),
    PRIMARY KEY (kind, name)
);

-- Content hash of working files keyed by (size, mtime), so status does not
-- re-read gigabytes of audio every time.
CREATE TABLE worktree_cache (
    path      TEXT PRIMARY KEY,
    size      INTEGER NOT NULL,
    mtime_ns  INTEGER NOT NULL,
    blob_hash BLOB NOT NULL
);

CREATE TABLE comments (
    id          INTEGER PRIMARY KEY,
    snapshot_id BLOB NOT NULL REFERENCES snapshots (id),
    path        TEXT NOT NULL,
    timecode_ms INTEGER,
    text        TEXT NOT NULL,
    author      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    resolved    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX comments_path ON comments (path);
";

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(Error::Corrupt(format!(
            "project was created by a newer version of takes (schema {version})"
        )));
    }
    if version < 1 {
        conn.execute_batch(SCHEMA)?;
    }
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}
