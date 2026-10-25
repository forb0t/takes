//! A song's variants (a remix, an acoustic take) beside the project folder.
//! Which variant a version belongs to is the app's business; here a variant
//! not in the folder is saved off the folder's line, on a ref of its own,
//! and a variant is brought into the folder as the song's next version.

use std::path::Path;

use super::{BRANCH, Repo, now_ns};
use crate::error::{Error, Result};
use crate::hash::Hash;
use crate::model::Entry;

/// Refs that keep versions not in the folder's history.
pub const TAKE_PREFIX: &str = "take/";

/// What a take is made of.
#[derive(Clone, Copy, Debug)]
pub enum TakeFrom<'a> {
    /// A file outside the project, e.g. a bounce from elsewhere.
    Outside(&'a Path),
    /// A file of the project folder as it is on disk now, saved or not.
    Folder(&'a str),
    /// A file (called `path` there) of a saved version, e.g. another song's.
    Version { rev: &'a str, path: &'a str },
}

impl Repo {
    /// Saves `from` as a version of `path` after version `parent`, leaving
    /// the folder and its history as they are.
    pub fn save_take(
        &mut self,
        from: TakeFrom,
        path: &str,
        parent: &str,
        message: &str,
    ) -> Result<Hash> {
        let file = match from {
            TakeFrom::Outside(source) => Some(self.outside(source)?),
            TakeFrom::Folder(source) => Some(self.abs(source)?),
            TakeFrom::Version { .. } => None,
        };
        if let Some(file) = &file
            && !file.is_file()
        {
            return Err(Error::InvalidPath(file.display().to_string()));
        }
        let path = path.trim_matches('/');
        self.abs(path)?;
        let _lock = self.lock_shared()?;
        let parent = self.resolve(parent)?;
        let mut tree = self.tree(parent)?;
        let (entry, blobs) = match (from, file) {
            (TakeFrom::Version { rev, path: source }, _) => {
                let entry = self.file_at(rev, source)?;
                if self.is_pruned(entry.blob)? {
                    return Err(Error::ContentPruned(source.into()));
                }
                (entry, Vec::new())
            }
            (_, Some(file)) => {
                let blob = self.store.put_file(&file)?;
                let entry = Entry {
                    blob: blob.hash,
                    size: blob.size,
                };
                (entry, vec![blob])
            }
            (_, None) => unreachable!("a file outside or in the folder"),
        };
        if tree.get(path) == Some(&entry) {
            return Err(Error::NothingToCommit);
        }
        tree.insert(path.to_owned(), entry);
        // Right after the latest version of a take ref, that ref goes on;
        // otherwise a new one keeps the version.
        let name = self
            .refs(BRANCH)?
            .into_iter()
            .find(|(name, id)| name.starts_with(TAKE_PREFIX) && *id == parent)
            .map_or_else(|| format!("{TAKE_PREFIX}{:x}", now_ns()), |(name, _)| name);
        self.write_snapshot(&name, &[parent], message, &tree, &blobs)
    }

    /// Brings version `rev` of a file (called `from` there) into the folder
    /// as `path` and saves it there. Refuses over unsaved changes to `path`;
    /// none when the folder has that content already.
    pub fn use_take(
        &mut self,
        rev: &str,
        from: &str,
        path: &str,
        message: &str,
    ) -> Result<Option<Hash>> {
        self.restore(from, rev, Some(path), false)?;
        match self.commit_each(&[path], |_| message.to_owned()) {
            Ok(ids) => Ok(ids.last().copied()),
            Err(Error::NothingToCommit) => Ok(None),
            Err(e) => Err(e),
        }
    }
}
