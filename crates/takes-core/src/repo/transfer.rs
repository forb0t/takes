//! Saving into any branch without switching to it: a song's other take on a
//! branch of its own, or a version moved from one branch to another. When
//! the branch is the current one, the project folder follows.

use std::collections::HashSet;
use std::path::Path;

use super::{BRANCH, Repo, validate_name};
use crate::error::{Error, Result};
use crate::hash::Hash;
use crate::model::{Change, ChangeKind, Entry, Tree};

/// A version of a file going from one branch to another.
#[derive(Clone, Copy, Debug)]
pub struct Transfer<'a> {
    /// The version: any version that has `path`.
    pub rev: &'a str,
    pub path: &'a str,
    /// The branch it goes to, and its name there.
    pub to: &'a str,
    pub to_path: &'a str,
    /// The branch it leaves, and its name there (none: that branch does not
    /// have it now).
    pub from: &'a str,
    pub from_path: Option<&'a str>,
}

impl Repo {
    /// Starts branch `name` at `from` (default: the current version) with
    /// the file `source` from outside saved in it as `path`: a new file, or
    /// a new version of the file of that name. The current branch and the
    /// project folder stay as they are.
    pub fn branch_with_file(
        &mut self,
        name: &str,
        from: Option<&str>,
        source: &Path,
        path: &str,
        message: &str,
    ) -> Result<Hash> {
        let source = self.outside(source)?;
        if !source.is_file() {
            return Err(Error::InvalidPath(source.display().to_string()));
        }
        let path = path.trim_matches('/');
        self.abs(path)?;
        validate_name(name)?;
        let _lock = self.lock_shared()?;
        if self.ref_target(BRANCH, name)?.is_some() || name == self.current_branch()? {
            return Err(Error::BranchExists(name.into()));
        }
        let start = match from {
            Some(rev) => Some(self.resolve(rev)?),
            None => self.head()?,
        };
        let mut tree = match start {
            Some(id) => self.tree(id)?,
            None => Tree::new(),
        };
        let blob = self.store.put_file(&source)?;
        let entry = Entry {
            blob: blob.hash,
            size: blob.size,
        };
        if tree.get(path) == Some(&entry) {
            return Err(Error::NothingToCommit);
        }
        tree.insert(path.to_owned(), entry);
        let parents: Vec<Hash> = start.into_iter().collect();
        let id = self.write_snapshot(name, &parents, message, &tree, &[blob])?;
        self.conn
            .execute("DELETE FROM deleted_branches WHERE name = ?1", [name])?;
        Ok(id)
    }

    /// Moves a version of a file to another branch: saved there as a new
    /// version, removed from the branch it leaves (saved as a deletion).
    pub fn move_version(
        &mut self,
        transfer: &Transfer,
        put_message: &str,
        remove_message: &str,
    ) -> Result<()> {
        let t = transfer;
        let _lock = self.lock_shared()?;
        let id = self.resolve(t.rev)?;
        let entry = self.entry(id, t.path)?.ok_or_else(|| Error::PathNotFound {
            path: t.path.into(),
            rev: t.rev.into(),
        })?;
        if self.is_pruned(entry.blob)? {
            return Err(Error::ContentPruned(t.path.into()));
        }
        if t.to == t.from {
            return Ok(());
        }
        self.abs(t.to_path)?;
        let put = [(t.to_path.to_owned(), Some(entry))];
        let remove: Vec<_> = t
            .from_path
            .map(|p| (p.to_owned(), None))
            .into_iter()
            .collect();
        // The current branch goes first: its folder may refuse (unsaved
        // work, a busy file), and then nothing has changed anywhere.
        if t.from == self.current_branch()? {
            self.edit_branch(t.from, &remove, remove_message)?;
            self.edit_branch(t.to, &put, put_message)?;
        } else {
            self.edit_branch(t.to, &put, put_message)?;
            self.edit_branch(t.from, &remove, remove_message)?;
        }
        Ok(())
    }

    /// Saves a version of `branch` with files set (`Some`) or removed
    /// (`None`); none if that changes nothing. On the current branch the
    /// folder is changed too, which unsaved work in those files prevents.
    fn edit_branch(
        &mut self,
        branch: &str,
        edits: &[(String, Option<Entry>)],
        message: &str,
    ) -> Result<Option<Hash>> {
        let current = self.current_branch()?;
        let head = self.ref_target(BRANCH, branch)?;
        if head.is_none() && branch != current {
            return Err(Error::NoSuchBranch(branch.into()));
        }
        let before = match head {
            Some(id) => self.tree(id)?,
            None => Tree::new(),
        };
        let mut after = before.clone();
        for (path, entry) in edits {
            match entry {
                Some(entry) => after.insert(path.clone(), *entry),
                None => after.remove(path),
            };
        }
        if after == before {
            return Ok(None);
        }
        if branch == current {
            let dirty = self.unsaved_in(&touched(&before, &after))?;
            if !dirty.is_empty() {
                return Err(Error::DirtyWorktree(dirty));
            }
            self.apply_tree(&before, &after)?;
        }
        let parents: Vec<Hash> = head.into_iter().collect();
        Ok(Some(self.write_snapshot(
            branch,
            &parents,
            message,
            &after,
            &[],
        )?))
    }

    /// Unsaved changes that stop the folder from going from `from` to `to`:
    /// any change to a saved file, and new files where `to` puts one. Other
    /// new files simply stay.
    pub(super) fn unsaved_in_the_way(&self, from: &Tree, to: &Tree) -> Result<Vec<Change>> {
        let touched = touched(from, to);
        Ok(self
            .status()?
            .into_iter()
            .filter(|c| c.kind != ChangeKind::Added || touched.contains(c.path.as_str()))
            .collect())
    }

    /// Unsaved changes in any of `paths`.
    fn unsaved_in(&self, paths: &HashSet<&str>) -> Result<Vec<Change>> {
        Ok(self
            .status()?
            .into_iter()
            .filter(|c| {
                paths.contains(c.path.as_str())
                    || c.from.as_deref().is_some_and(|f| paths.contains(f))
            })
            .collect())
    }
}

/// Paths whose file differs between two trees.
fn touched<'a>(from: &'a Tree, to: &'a Tree) -> HashSet<&'a str> {
    from.iter()
        .filter(|(p, e)| to.get(*p) != Some(*e))
        .map(|(p, _)| p.as_str())
        .chain(
            to.keys()
                .filter(|p| !from.contains_key(*p))
                .map(String::as_str),
        )
        .collect()
}
