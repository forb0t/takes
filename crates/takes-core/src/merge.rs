use std::collections::BTreeSet;

use crate::hash::Hash;
use crate::model::{Change, Entry, Tree};

/// How to settle a file that changed differently on both sides.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// Keep the current branch's version.
    Ours,
    /// Take the merged branch's version.
    Theirs,
    /// Keep ours under the original name and theirs as `name (branch).ext`.
    Both,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conflict {
    pub path: String,
    pub base: Option<Entry>,
    /// `None` when that side deleted the file.
    pub ours: Option<Entry>,
    pub theirs: Option<Entry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeKind {
    UpToDate,
    FastForward,
    Merge,
}

/// What a merge would do, without touching anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergePreview {
    pub kind: MergeKind,
    /// Changes applied to the current branch automatically.
    pub changes: Vec<Change>,
    pub conflicts: Vec<Conflict>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MergeOutcome {
    UpToDate,
    FastForward(Hash),
    Merged(Hash),
    /// Nothing was changed; resolve these and merge again.
    Conflicts(Vec<Conflict>),
}

pub struct ThreeWay {
    pub merged: Tree,
    pub conflicts: Vec<Conflict>,
}

/// Per-file three-way merge: a side wins when only it changed the file.
pub fn three_way(base: &Tree, ours: &Tree, theirs: &Tree) -> ThreeWay {
    let paths: BTreeSet<&String> = base
        .keys()
        .chain(ours.keys())
        .chain(theirs.keys())
        .collect();
    let mut merged = Tree::new();
    let mut conflicts = Vec::new();
    for path in paths {
        let (b, o, t) = (base.get(path), ours.get(path), theirs.get(path));
        let pick = if o == t || t == b {
            o
        } else if o == b {
            t
        } else {
            conflicts.push(Conflict {
                path: path.clone(),
                base: b.copied(),
                ours: o.copied(),
                theirs: t.copied(),
            });
            continue;
        };
        if let Some(entry) = pick {
            merged.insert(path.clone(), *entry);
        }
    }
    ThreeWay { merged, conflicts }
}

/// Applies the caller's choices; returns the conflicts it had no choice for.
pub fn resolve(
    three_way: ThreeWay,
    mut choose: impl FnMut(&Conflict) -> Option<Resolution>,
    theirs_label: &str,
) -> Result<Tree, Vec<Conflict>> {
    let ThreeWay {
        mut merged,
        conflicts,
    } = three_way;
    let mut taken: BTreeSet<String> = merged
        .keys()
        .cloned()
        .chain(conflicts.iter().map(|c| c.path.clone()))
        .collect();
    let mut unresolved = Vec::new();
    for conflict in conflicts {
        match (choose(&conflict), conflict.ours, conflict.theirs) {
            (None, ..) => unresolved.push(conflict),
            (Some(Resolution::Ours), Some(o), _) | (Some(Resolution::Both), Some(o), None) => {
                merged.insert(conflict.path, o);
            }
            (Some(Resolution::Theirs), _, Some(t)) | (Some(Resolution::Both), None, Some(t)) => {
                merged.insert(conflict.path, t);
            }
            // The chosen side deleted the file.
            (Some(Resolution::Ours), None, _) | (Some(Resolution::Theirs), _, None) => {}
            (Some(Resolution::Both), Some(o), Some(t)) => {
                let alt = side_path(&conflict.path, theirs_label, &taken);
                taken.insert(alt.clone());
                merged.insert(conflict.path, o);
                merged.insert(alt, t);
            }
            // Deleted on both sides never conflicts.
            (Some(Resolution::Both), None, None) => {}
        }
    }
    if unresolved.is_empty() {
        Ok(merged)
    } else {
        Err(unresolved)
    }
}

/// `dir/song.wav` → `dir/song (acoustic).wav`, numbered if that is taken.
fn side_path(path: &str, label: &str, taken: &BTreeSet<String>) -> String {
    let label = label.replace('/', "-");
    let (dir, name) = match path.rsplit_once('/') {
        Some((dir, name)) => (format!("{dir}/"), name),
        None => (String::new(), path),
    };
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name, String::new()),
    };
    (1..)
        .map(|n| match n {
            1 => format!("{dir}{stem} ({label}){ext}"),
            n => format!("{dir}{stem} ({label} {n}){ext}"),
        })
        .find(|p| !taken.contains(p))
        .expect("an unused name exists")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(byte: u8) -> Entry {
        Entry {
            blob: Hash([byte; 32]),
            size: 1,
        }
    }

    fn tree(items: &[(&str, u8)]) -> Tree {
        items.iter().map(|(p, b)| (p.to_string(), e(*b))).collect()
    }

    #[test]
    fn one_sided_changes_merge_cleanly() {
        let base = tree(&[("a", 1), ("b", 1), ("c", 1)]);
        let ours = tree(&[("a", 2), ("b", 1), ("c", 1), ("new", 7)]);
        let theirs = tree(&[("a", 1), ("b", 3)]);
        let result = three_way(&base, &ours, &theirs);
        assert!(result.conflicts.is_empty());
        assert_eq!(result.merged, tree(&[("a", 2), ("b", 3), ("new", 7)]));
    }

    #[test]
    fn both_sides_changing_a_file_conflicts() {
        let base = tree(&[("song.wav", 1), ("gone", 1)]);
        let ours = tree(&[("song.wav", 2), ("gone", 2)]);
        let theirs = tree(&[("song.wav", 3)]);
        let result = three_way(&base, &ours, &theirs);
        let paths: Vec<_> = result.conflicts.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, ["gone", "song.wav"]);

        let merged = resolve(result, |_| Some(Resolution::Both), "acoustic").unwrap();
        assert_eq!(
            merged,
            tree(&[("gone", 2), ("song (acoustic).wav", 3), ("song.wav", 2)])
        );
    }

    #[test]
    fn identical_changes_do_not_conflict() {
        let result = three_way(&tree(&[("a", 1)]), &tree(&[("a", 2)]), &tree(&[("a", 2)]));
        assert!(result.conflicts.is_empty());
        assert_eq!(result.merged, tree(&[("a", 2)]));
    }

    #[test]
    fn side_path_avoids_collisions() {
        let taken: BTreeSet<String> = ["mix (alt).wav".to_string()].into();
        assert_eq!(side_path("mix.wav", "alt", &taken), "mix (alt 2).wav");
        assert_eq!(
            side_path("dir/README", "feat/x", &BTreeSet::new()),
            "dir/README (feat-x)"
        );
        assert_eq!(side_path(".hidden", "b", &BTreeSet::new()), ".hidden (b)");
    }
}
