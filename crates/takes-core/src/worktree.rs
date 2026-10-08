use std::fs::{self, Metadata};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;

use crate::error::{Error, Result};

pub const META_DIR: &str = ".takes";
/// gitignore-syntax file listing paths the project should not track.
pub const IGNORE_FILE: &str = ".takesignore";
/// Suffix of files being written by a checkout; never tracked.
pub(crate) const TMP_SUFFIX: &str = ".takes-tmp";
const BUILTIN_IGNORES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

pub struct WorkFile {
    pub path: String,
    pub abs: PathBuf,
    pub size: u64,
    pub mtime_ns: i64,
}

/// All tracked-eligible files in the working folder.
///
/// Fails instead of skipping unreadable directories: a silently skipped folder
/// would look like deleted files and could be saved as a deletion.
pub fn scan(root: &Path) -> Result<Vec<WorkFile>> {
    let walker = WalkBuilder::new(root)
        .standard_filters(false)
        .add_custom_ignore_filename(IGNORE_FILE)
        .follow_links(false)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(name == META_DIR || name.ends_with(TMP_SUFFIX) || BUILTIN_IGNORES.contains(&&*name))
        })
        .build();

    let mut files = Vec::new();
    for entry in walker {
        let entry = entry.map_err(|e| io::Error::other(e.to_string()))?;
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let abs = entry.into_path();
        let meta = fs::symlink_metadata(&abs)?;
        files.push(WorkFile {
            path: rel_path(root, &abs)?,
            size: meta.len(),
            mtime_ns: mtime_ns(&meta),
            abs,
        });
    }
    Ok(files)
}

fn rel_path(root: &Path, abs: &Path) -> Result<String> {
    let invalid = || Error::InvalidPath(abs.display().to_string());
    let rel = abs.strip_prefix(root).map_err(|_| invalid())?;
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str().ok_or_else(invalid)?),
            _ => return Err(invalid()),
        }
    }
    Ok(parts.join("/"))
}

/// Absolute location of a project path, rejecting anything that could escape
/// the project folder or touch `.takes` (paths may come from synced data).
pub fn to_abs(root: &Path, path: &str) -> Result<PathBuf> {
    let invalid = || Error::InvalidPath(path.to_owned());
    if path.is_empty() || path.contains('\0') {
        return Err(invalid());
    }
    let mut abs = root.to_path_buf();
    for (i, part) in path.split('/').enumerate() {
        if part.is_empty() || part == "." || part == ".." || (i == 0 && part == META_DIR) {
            return Err(invalid());
        }
        abs.push(part);
    }
    Ok(abs)
}

pub fn mtime_ns(meta: &Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_abs_rejects_escapes() {
        let root = Path::new("/project");
        assert_eq!(
            to_abs(root, "a/b.wav").unwrap(),
            Path::new("/project/a/b.wav")
        );
        for bad in [
            "",
            "../x",
            "a/../../x",
            "/etc/passwd",
            "a//b",
            ".takes/db.sqlite",
            "./a",
        ] {
            assert!(to_abs(root, bad).is_err(), "{bad} should be rejected");
        }
    }
}
