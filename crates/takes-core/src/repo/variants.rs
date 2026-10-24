//! A song's variants (a remix, an acoustic take) beside the project folder.
//! Which variant a version belongs to is the app's business; here a variant
//! not in the folder is saved off the folder's line, on a ref of its own,
//! and a variant is brought into the folder as the song's next version.

use std::collections::HashSet;
use std::path::Path;

use super::{BRANCH, Repo, now_ns};
use crate::error::{Error, Result};
use crate::hash::Hash;
use crate::model::{Change, ChangeKind, Entry, Tree};

/// Refs that keep versions not in the folder's history.
pub const TAKE_PREFIX: &str = "take/";

impl Repo {
    /// Saves the file `source` from outside as a version of `path` after
    /// version `parent`, leaving the folder and its history as they are.
    pub fn save_take(
        &mut self,
        source: &Path,
        path: &str,
        parent: &str,
        message: &str,
    ) -> Result<Hash> {
        let source = self.outside(source)?;
        if !source.is_file() {
            return Err(Error::InvalidPath(source.display().to_string()));
        }
        let path = path.trim_matches('/');
        self.abs(path)?;
        let _lock = self.lock_shared()?;
        let parent = self.resolve(parent)?;
        let mut tree = self.tree(parent)?;
        let blob = self.store.put_file(&source)?;
        let entry = Entry {
            blob: blob.hash,
            size: blob.size,
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
        self.write_snapshot(&name, &[parent], message, &tree, &[blob])
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

    /// Unsaved changes that stop the folder from going from `from` to `to`:
    /// any change to a saved file, and new files where `to` puts one. Other
    /// new files simply stay.
    pub(super) fn unsaved_in_the_way(&self, from: &Tree, to: &Tree) -> Result<Vec<Change>> {
        let touched: HashSet<&str> = from
            .iter()
            .filter(|(p, e)| to.get(*p) != Some(*e))
            .map(|(p, _)| p.as_str())
            .chain(
                to.keys()
                    .filter(|p| !from.contains_key(*p))
                    .map(String::as_str),
            )
            .collect();
        Ok(self
            .status()?
            .into_iter()
            .filter(|c| c.kind != ChangeKind::Added || touched.contains(c.path.as_str()))
            .collect())
    }
}
