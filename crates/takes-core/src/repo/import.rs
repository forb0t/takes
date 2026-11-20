//! Bringing files from elsewhere (a bounce in Downloads, a folder of stems)
//! into the project folder.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::{Repo, busy_or_io};
use crate::error::{Error, Result};
use crate::model::ChangeKind;
use crate::worktree;

/// A file [`Repo::import`] put into the project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Imported {
    /// Where it is in the project.
    pub path: String,
    /// It replaced a saved file of that name: a new version of that file.
    pub replaced: bool,
}

impl Repo {
    /// Copies files and folders from outside into the project folder,
    /// under `dest` ("" = the top). A folder comes with everything in it.
    /// A file with the name of a saved file becomes its new version; a file
    /// with unsaved changes, or one the project does not track (ignored),
    /// is never replaced. Nothing is copied unless all
    /// of it can be. The copies show up as changes, ready to be saved.
    pub fn import(&self, sources: &[PathBuf], dest: &str) -> Result<Vec<Imported>> {
        let dest = dest.trim_matches('/');
        let mut plan: Vec<(PathBuf, String)> = Vec::new();
        for source in sources {
            let source = self.outside(source)?;
            let name = source
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| Error::InvalidPath(source.display().to_string()))?;
            let base = if dest.is_empty() {
                name.to_owned()
            } else {
                format!("{dest}/{name}")
            };
            if source.is_dir() {
                for (file, rel) in worktree::files_in(&source)? {
                    plan.push((file, format!("{base}/{rel}")));
                }
            } else {
                plan.push((source, base));
            }
        }
        self.copy_in(plan)
    }

    /// Copies one file from outside to `path` in the project, whatever it is
    /// called outside: e.g. `Night_mix_final_v7.wav` as the new version of
    /// `Ночь/mix.wav`. Same rules as [`Repo::import`].
    pub fn import_as(&self, source: &Path, path: &str) -> Result<Imported> {
        let source = self.outside(source)?;
        if !source.is_file() {
            return Err(Error::InvalidPath(source.display().to_string()));
        }
        let mut imported = self.copy_in(vec![(source, path.trim_matches('/').to_owned())])?;
        Ok(imported.remove(0))
    }

    /// A source path, which must not be inside the project already, nor a
    /// folder holding the project (it would be copied into itself).
    pub(super) fn outside(&self, source: &Path) -> Result<PathBuf> {
        let source = dunce::canonicalize(source)?;
        if source.starts_with(&self.root) || self.root.starts_with(&source) {
            return Err(Error::OverlapsProject(source));
        }
        Ok(source)
    }

    /// Checks and then copies (source, project path) pairs.
    fn copy_in(&self, plan: Vec<(PathBuf, String)>) -> Result<Vec<Imported>> {
        let mut targets = HashSet::new();
        for (_, target) in &plan {
            self.abs(target)?;
            if !targets.insert(target.as_str()) {
                return Err(Error::InvalidPath(format!("{target} is given twice")));
            }
        }
        // Only a saved, unchanged file may be replaced: never unsaved work,
        // nor a file the project does not track (e.g. an ignored one).
        let unsaved: HashSet<String> = self
            .status()?
            .into_iter()
            .filter(|c| c.kind != ChangeKind::Deleted)
            .map(|c| c.path)
            .collect();
        let saved = match self.head()? {
            Some(id) => self.tree(id)?,
            None => Default::default(),
        };
        let targets: HashSet<&str> = plan.iter().map(|(_, t)| t.as_str()).collect();
        let mut blocked = Vec::new();
        for (_, target) in &plan {
            let abs = self.abs(target)?;
            let replaceable = saved.contains_key(target) && !unsaved.contains(target);
            // A file (here or copied in) where the target needs a folder.
            let mut under_file = false;
            for (i, _) in target.match_indices('/') {
                let folder = &target[..i];
                let on_disk = self.abs(folder)?;
                under_file |= targets.contains(folder) || (on_disk.exists() && !on_disk.is_dir());
            }
            if abs.is_dir() || (abs.exists() && !replaceable) || under_file {
                blocked.push(target.clone());
            }
        }
        if !blocked.is_empty() {
            return Err(Error::WouldOverwrite(blocked));
        }
        let busy = self.busy_files(plan.iter().map(|(_, t)| t.as_str()))?;
        if !busy.is_empty() {
            return Err(Error::FileBusy(busy));
        }

        let mut imported = Vec::new();
        for (source, target) in plan {
            copy_into(&source, &self.abs(&target)?, &target)?;
            imported.push(Imported {
                replaced: saved.contains_key(&target),
                path: target,
            });
        }
        Ok(imported)
    }
}

/// Copies `source` to `dest` via a temporary file, so an open DAW never
/// sees half a file.
fn copy_into(source: &Path, dest: &Path, path: &str) -> Result<()> {
    let parent = dest.parent().expect("project files live inside the root");
    fs::create_dir_all(parent)?;
    let name = dest
        .file_name()
        .expect("validated path has a file name")
        .to_string_lossy();
    let tmp = parent.join(format!(".{name}{}", worktree::TMP_SUFFIX));
    let copied = fs::copy(source, &tmp)
        .map_err(Error::from)
        .and_then(|_| fs::rename(&tmp, dest).map_err(|e| busy_or_io(e, path)));
    if copied.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    copied
}
