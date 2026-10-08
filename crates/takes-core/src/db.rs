use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use crate::error::{Error, Result};

const SCHEMA_VERSION: i64 = 2;

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

/// Version 2: sync. Comments get a global id; caches of what the remote holds.
const MIGRATION_2: &str = "
ALTER TABLE comments ADD COLUMN uid TEXT;
ALTER TABLE comments ADD COLUMN pushed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN resolution_pushed INTEGER NOT NULL DEFAULT 0;
UPDATE comments SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
CREATE UNIQUE INDEX comments_uid ON comments (uid);

-- Packs whose index we have read, and where each chunk lives in them.
CREATE TABLE remote_packs (name TEXT PRIMARY KEY);
CREATE TABLE remote_chunks (
    hash   BLOB PRIMARY KEY,
    pack   TEXT NOT NULL,
    offset INTEGER NOT NULL,
    length INTEGER NOT NULL
);
CREATE TABLE remote_snapshots (id BLOB PRIMARY KEY);

-- Branch heads of every device, as last seen on the remote (ours included).
CREATE TABLE remote_refs (
    device      TEXT NOT NULL,
    device_name TEXT NOT NULL,
    name        TEXT NOT NULL,
    snapshot_id BLOB NOT NULL,
    PRIMARY KEY (device, name)
);

-- Comment and resolution files already imported from the remote.
CREATE TABLE remote_seen (path TEXT PRIMARY KEY);
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
    if version < 2 {
        conn.execute_batch(&format!("BEGIN; {MIGRATION_2} COMMIT;"))?;
    }
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}
