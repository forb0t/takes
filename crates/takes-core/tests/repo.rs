use std::fs;

use takes_core::{
    Change, ChangeKind, Error, FileMeta, MergeKind, MergeOutcome, Repo, Resolution, Stats,
    hash_file,
};
use tempfile::TempDir;

fn setup() -> (TempDir, Repo) {
    let dir = TempDir::new().unwrap();
    let repo = Repo::init(dir.path()).unwrap();
    repo.set_config("user.name", "tester").unwrap();
    (dir, repo)
}

fn write(repo: &Repo, path: &str, data: impl AsRef<[u8]>) {
    let abs = repo.root().join(path);
    fs::create_dir_all(abs.parent().unwrap()).unwrap();
    fs::write(abs, data).unwrap();
}

fn read(repo: &Repo, path: &str) -> Vec<u8> {
    fs::read(repo.root().join(path)).unwrap()
}

fn exists(repo: &Repo, path: &str) -> bool {
    repo.root().join(path).exists()
}

fn changes(repo: &Repo) -> Vec<(String, ChangeKind)> {
    repo.status()
        .unwrap()
        .into_iter()
        .map(|Change { path, kind }| (path, kind))
        .collect()
}

fn ch(path: &str, kind: ChangeKind) -> (String, ChangeKind) {
    (path.to_owned(), kind)
}

/// Deterministic incompressible bytes, like rendered audio.
fn noise(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

#[test]
fn init_twice_fails_and_discover_finds_root() {
    let (dir, repo) = setup();
    assert!(matches!(
        Repo::init(dir.path()),
        Err(Error::AlreadyInitialized(_))
    ));
    fs::create_dir_all(dir.path().join("deep/inside")).unwrap();
    let found = Repo::discover(dir.path().join("deep/inside")).unwrap();
    assert_eq!(found.root(), repo.root());
    assert_eq!(repo.current_branch().unwrap(), "main");
    assert_eq!(repo.head().unwrap(), None);
}

#[test]
fn save_versions_and_track_changes() {
    let (_dir, mut repo) = setup();
    write(&repo, "Альбом/01 Вступление.wav", "intro v1");
    write(&repo, "cover.png", "cover");
    assert_eq!(
        changes(&repo),
        [
            ch("cover.png", ChangeKind::Added),
            ch("Альбом/01 Вступление.wav", ChangeKind::Added)
        ]
    );

    let first = repo.commit("first demos", &[]).unwrap();
    assert!(changes(&repo).is_empty());
    assert!(matches!(
        repo.commit("again", &[]),
        Err(Error::NothingToCommit)
    ));

    write(&repo, "Альбом/01 Вступление.wav", "intro v2");
    fs::remove_file(repo.root().join("cover.png")).unwrap();
    write(&repo, "notes.txt", "");
    assert_eq!(
        changes(&repo),
        [
            ch("cover.png", ChangeKind::Deleted),
            ch("notes.txt", ChangeKind::Added),
            ch("Альбом/01 Вступление.wav", ChangeKind::Modified),
        ]
    );

    // Save only the song folder; the rest stays pending.
    let second = repo.commit("new intro", &["Альбом"]).unwrap();
    assert_eq!(
        changes(&repo),
        [
            ch("cover.png", ChangeKind::Deleted),
            ch("notes.txt", ChangeKind::Added)
        ]
    );

    let log = repo.log(None).unwrap();
    assert_eq!(
        log.iter().map(|s| s.id).collect::<Vec<_>>(),
        [second, first]
    );
    assert_eq!(log[0].parents, [first]);
    assert_eq!(log[0].author, "tester");

    let history = repo.file_history("Альбом/01 Вступление.wav", None).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].kind, ChangeKind::Modified);
    assert_eq!(history[1].kind, ChangeKind::Added);

    let in_second: Vec<_> = repo
        .changes_in(second)
        .unwrap()
        .into_iter()
        .map(|c| (c.path, c.kind))
        .collect();
    assert_eq!(
        in_second,
        [ch("Альбом/01 Вступление.wav", ChangeKind::Modified)]
    );
    assert_eq!(repo.changes_in(first).unwrap().len(), 2);
    assert_eq!(
        repo.file_at("HEAD", "Альбом/01 Вступление.wav")
            .unwrap()
            .size,
        8
    );

    let mut old = Vec::new();
    repo.read_file(&first.short(), "Альбом/01 Вступление.wav", &mut old)
        .unwrap();
    assert_eq!(old, b"intro v1");
}

#[test]
fn ignore_rules() {
    let (_dir, repo) = setup();
    write(&repo, ".takesignore", "*.asd\nBackup/\n");
    write(&repo, "song.wav", "a");
    write(&repo, "song.wav.asd", "analysis");
    write(&repo, "Project/Backup/old.als", "x");
    write(&repo, "Project/song.als", "y");
    write(&repo, ".DS_Store", "junk");
    assert_eq!(
        changes(&repo),
        [
            ch(".takesignore", ChangeKind::Added),
            ch("Project/song.als", ChangeKind::Added),
            ch("song.wav", ChangeKind::Added),
        ]
    );
}

#[test]
fn branches_keep_separate_versions() {
    let (_dir, mut repo) = setup();
    write(&repo, "song.wav", "demo");
    let base = repo.commit("demo", &[]).unwrap();

    assert_eq!(repo.create_branch("acoustic", None).unwrap(), base);
    assert!(matches!(
        repo.create_branch("acoustic", None),
        Err(Error::BranchExists(_))
    ));
    repo.switch("acoustic").unwrap();
    write(&repo, "song.wav", "acoustic take");
    write(&repo, "guitar/di.wav", "guitar");
    repo.commit("acoustic arrangement", &[]).unwrap();

    repo.switch("main").unwrap();
    assert_eq!(read(&repo, "song.wav"), b"demo");
    assert!(
        !exists(&repo, "guitar"),
        "file and its empty folder are removed"
    );
    assert!(changes(&repo).is_empty());

    repo.switch("acoustic").unwrap();
    assert_eq!(read(&repo, "song.wav"), b"acoustic take");
    assert_eq!(read(&repo, "guitar/di.wav"), b"guitar");

    let names: Vec<_> = repo
        .branches()
        .unwrap()
        .into_iter()
        .map(|b| (b.name, b.current))
        .collect();
    assert_eq!(names, [("acoustic".into(), true), ("main".into(), false)]);
    assert!(matches!(
        repo.delete_branch("acoustic"),
        Err(Error::CannotDeleteCurrentBranch(_))
    ));
}

#[test]
fn switch_protects_unsaved_work() {
    let (_dir, mut repo) = setup();
    write(&repo, "song.wav", "demo");
    repo.commit("demo", &[]).unwrap();
    repo.create_branch("other", None).unwrap();
    repo.switch("other").unwrap();
    write(&repo, "vocals.wav", "branch vocals");
    repo.commit("vocals", &[]).unwrap();
    repo.switch("main").unwrap();

    write(&repo, "song.wav", "unsaved edit");
    assert!(matches!(repo.switch("other"), Err(Error::DirtyWorktree(_))));
    assert_eq!(read(&repo, "song.wav"), b"unsaved edit");
    write(&repo, "song.wav", "demo");

    // An ignored file is not "unsaved work" for status, but switching must
    // still not overwrite it with the branch's version.
    write(&repo, ".takesignore", "vocals.wav\n");
    repo.commit("ignore", &[]).unwrap();
    write(&repo, "vocals.wav", "my only copy");
    let err = repo.switch("other").unwrap_err();
    assert!(
        matches!(err, Error::WouldOverwrite(ref p) if p == &["vocals.wav"]),
        "{err:?}"
    );
    assert_eq!(read(&repo, "vocals.wav"), b"my only copy");
}

#[test]
fn fast_forward_merge() {
    let (_dir, mut repo) = setup();
    write(&repo, "song.wav", "demo");
    repo.commit("demo", &[]).unwrap();
    repo.create_branch("mix", None).unwrap();
    repo.switch("mix").unwrap();
    write(&repo, "song.wav", "mixed");
    let mixed = repo.commit("mix", &[]).unwrap();
    repo.switch("main").unwrap();

    assert_eq!(
        repo.merge_preview("mix").unwrap().kind,
        MergeKind::FastForward
    );
    assert_eq!(
        repo.merge("mix", |_| None).unwrap(),
        MergeOutcome::FastForward(mixed)
    );
    assert_eq!(read(&repo, "song.wav"), b"mixed");
    assert_eq!(repo.head().unwrap(), Some(mixed));
    assert_eq!(repo.merge("mix", |_| None).unwrap(), MergeOutcome::UpToDate);
}

#[test]
fn merge_combines_different_files() {
    let (_dir, mut repo) = setup();
    write(&repo, "song.wav", "demo");
    repo.commit("demo", &[]).unwrap();
    repo.create_branch("strings", None).unwrap();

    write(&repo, "drums.wav", "drums");
    let ours = repo.commit("drums", &[]).unwrap();
    repo.switch("strings").unwrap();
    write(&repo, "strings.wav", "strings");
    let theirs = repo.commit("strings", &[]).unwrap();
    repo.switch("main").unwrap();

    let MergeOutcome::Merged(id) = repo.merge("strings", |_| None).unwrap() else {
        panic!("expected a merge")
    };
    assert_eq!(repo.snapshot(id).unwrap().parents, [ours, theirs]);
    assert_eq!(read(&repo, "strings.wav"), b"strings");
    assert_eq!(read(&repo, "drums.wav"), b"drums");
    assert!(changes(&repo).is_empty());
}

#[test]
fn merge_conflicts_are_resolved_per_file() {
    for (resolution, expect_song, expect_alt) in [
        (Resolution::Ours, "main vocal", None),
        (Resolution::Theirs, "acoustic vocal", None),
        (Resolution::Both, "main vocal", Some("acoustic vocal")),
    ] {
        let (_dir, mut repo) = setup();
        write(&repo, "song.wav", "demo");
        repo.commit("demo", &[]).unwrap();
        repo.create_branch("acoustic", None).unwrap();
        write(&repo, "song.wav", "main vocal");
        repo.commit("main vocal", &[]).unwrap();
        repo.switch("acoustic").unwrap();
        write(&repo, "song.wav", "acoustic vocal");
        repo.commit("acoustic vocal", &[]).unwrap();
        repo.switch("main").unwrap();

        let preview = repo.merge_preview("acoustic").unwrap();
        assert_eq!(preview.kind, MergeKind::Merge);
        assert_eq!(preview.conflicts.len(), 1);
        assert!(preview.changes.is_empty(), "{:?}", preview.changes);

        // Without a decision nothing changes.
        let head = repo.head().unwrap();
        let MergeOutcome::Conflicts(open) = repo.merge("acoustic", |_| None).unwrap() else {
            panic!("expected conflicts")
        };
        assert_eq!(open[0].path, "song.wav");
        assert_eq!(repo.head().unwrap(), head);
        assert_eq!(read(&repo, "song.wav"), b"main vocal");

        let outcome = repo.merge("acoustic", |_| Some(resolution)).unwrap();
        assert!(matches!(outcome, MergeOutcome::Merged(_)), "{resolution:?}");
        assert_eq!(read(&repo, "song.wav"), expect_song.as_bytes());
        match expect_alt {
            Some(alt) => assert_eq!(read(&repo, "song (acoustic).wav"), alt.as_bytes()),
            None => assert!(!exists(&repo, "song (acoustic).wav")),
        }
        assert!(changes(&repo).is_empty());
    }
}

#[test]
fn revisions_and_tags() {
    let (_dir, mut repo) = setup();
    let mut ids = Vec::new();
    for n in 1..=3 {
        write(&repo, "song.wav", format!("take {n}"));
        ids.push(repo.commit(&format!("take {n}"), &[]).unwrap());
    }
    assert_eq!(repo.resolve("HEAD").unwrap(), ids[2]);
    assert_eq!(repo.resolve("HEAD~").unwrap(), ids[1]);
    assert_eq!(repo.resolve("main~2").unwrap(), ids[0]);
    assert_eq!(repo.resolve(&ids[1].short()).unwrap(), ids[1]);
    assert!(matches!(
        repo.resolve("HEAD~3"),
        Err(Error::UnknownRevision(_))
    ));
    assert!(matches!(
        repo.resolve("nope"),
        Err(Error::UnknownRevision(_))
    ));

    repo.create_tag("master v1", "HEAD~1").unwrap();
    assert_eq!(repo.resolve("master v1").unwrap(), ids[1]);
    assert!(matches!(
        repo.create_tag("master v1", "HEAD"),
        Err(Error::TagExists(_))
    ));
}

#[test]
fn restore_older_version() {
    let (_dir, mut repo) = setup();
    write(&repo, "song.wav", "v1");
    repo.commit("v1", &[]).unwrap();
    write(&repo, "song.wav", "v2");
    repo.commit("v2", &[]).unwrap();

    repo.restore("song.wav", "HEAD~1", None, false).unwrap();
    assert_eq!(read(&repo, "song.wav"), b"v1");
    assert_eq!(changes(&repo), [ch("song.wav", ChangeKind::Modified)]);

    write(&repo, "song.wav", "unsaved v3");
    assert!(matches!(
        repo.restore("song.wav", "HEAD", None, false),
        Err(Error::WouldOverwrite(_))
    ));
    repo.restore("song.wav", "HEAD~1", Some("old/song v1.wav"), false)
        .unwrap();
    assert_eq!(read(&repo, "old/song v1.wav"), b"v1");
    assert_eq!(read(&repo, "song.wav"), b"unsaved v3");

    repo.restore("song.wav", "HEAD", None, true).unwrap();
    assert_eq!(read(&repo, "song.wav"), b"v2");

    for bad in ["../outside.wav", ".takes/db.sqlite"] {
        assert!(matches!(
            repo.restore("song.wav", "HEAD", Some(bad), true),
            Err(Error::InvalidPath(_))
        ));
    }
}

#[test]
fn large_files_are_deduplicated_and_roundtrip() {
    let (dir, mut repo) = setup();
    let original = noise(6 * 1024 * 1024, 42);
    write(&repo, "mix.wav", &original);
    repo.commit("mix 1", &[]).unwrap();
    let before = repo.stats().unwrap();

    let mut edited = original.clone();
    edited[3_000_000..3_000_100].fill(0);
    write(&repo, "mix.wav", &edited);
    write(&repo, "copy of mix.wav", &original);
    repo.commit("mix 2 + copy", &[]).unwrap();
    let after = repo.stats().unwrap();

    // The copy costs nothing, the 100-byte edit costs a chunk or two
    // (chunks average ~1-2 MiB, so a 6 MiB file has only a few).
    let Stats {
        chunks: c0,
        stored_bytes: s0,
        ..
    } = before;
    assert!(after.chunks - c0 <= 2, "{before:?} -> {after:?}");
    assert!(
        after.stored_bytes - s0 < original.len() as u64,
        "{before:?} -> {after:?}"
    );
    assert_eq!(after.content_bytes, 2 * original.len() as u64);

    let out = dir.path().join("exported.wav");
    repo.export("HEAD~1", "mix.wav", &out).unwrap();
    assert_eq!(fs::read(&out).unwrap(), original);
    repo.restore("mix.wav", "HEAD~1", None, false).unwrap();
    assert_eq!(read(&repo, "mix.wav"), original);
}

#[test]
fn empty_and_compressible_files() {
    let (_dir, mut repo) = setup();
    write(&repo, "empty.txt", "");
    write(&repo, "lyrics.txt", "la ".repeat(100_000));
    repo.commit("text", &[]).unwrap();
    assert!(repo.stats().unwrap().stored_bytes < 10_000);

    fs::remove_file(repo.root().join("empty.txt")).unwrap();
    fs::remove_file(repo.root().join("lyrics.txt")).unwrap();
    repo.restore("empty.txt", "HEAD", None, false).unwrap();
    repo.restore("lyrics.txt", "HEAD", None, false).unwrap();
    assert_eq!(read(&repo, "empty.txt"), b"");
    assert_eq!(read(&repo, "lyrics.txt"), "la ".repeat(100_000).as_bytes());
}

#[test]
fn comments_on_versions() {
    let (_dir, mut repo) = setup();
    write(&repo, "song.wav", "demo");
    repo.commit("demo", &[]).unwrap();

    let a = repo
        .add_comment("HEAD", "song.wav", Some(42_000), "bass is muddy here")
        .unwrap();
    repo.add_comment("HEAD", "song.wav", None, "love the vibe")
        .unwrap();
    assert!(matches!(
        repo.add_comment("HEAD", "missing.wav", None, "?"),
        Err(Error::PathNotFound { .. })
    ));

    let all = repo.comments(Some("song.wav"), false).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].timecode_ms, None);
    assert_eq!(all[1].timecode_ms, Some(42_000));

    repo.resolve_comment(a).unwrap();
    assert_eq!(repo.comments(None, false).unwrap().len(), 1);
    assert_eq!(repo.comments(None, true).unwrap().len(), 2);
    assert!(matches!(
        repo.resolve_comment(999),
        Err(Error::NoSuchComment(999))
    ));
}

#[test]
fn data_survives_reopen() {
    let (dir, mut repo) = setup();
    write(&repo, "song.wav", "demo");
    let id = repo.commit("demo", &[]).unwrap();
    repo.create_branch("alt", None).unwrap();
    drop(repo);

    let repo = Repo::open(dir.path()).unwrap();
    assert_eq!(repo.head().unwrap(), Some(id));
    assert_eq!(repo.branches().unwrap().len(), 2);
    assert!(changes(&repo).is_empty());
}

fn set_readonly(repo: &Repo, path: &str, readonly: bool) {
    let abs = repo.root().join(path);
    let mut perms = fs::metadata(&abs).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(readonly);
    fs::set_permissions(abs, perms).unwrap();
}

/// A file that cannot be replaced (on Windows: open in a DAW; here simulated
/// as read-only) stops the operation before any file changes.
#[test]
fn busy_files_stop_switch_and_restore_before_touching_anything() {
    let (_dir, mut repo) = setup();
    write(&repo, "a.wav", "main a");
    write(&repo, "song.wav", "main song");
    repo.commit("main", &[]).unwrap();
    repo.create_branch("other", None).unwrap();
    repo.switch("other").unwrap();
    write(&repo, "a.wav", "other a");
    write(&repo, "song.wav", "other song");
    repo.commit("other", &[]).unwrap();
    repo.switch("main").unwrap();

    set_readonly(&repo, "song.wav", true);
    let err = repo.switch("other").unwrap_err();
    assert!(
        matches!(err, Error::FileBusy(ref p) if p == &["song.wav"]),
        "{err:?}"
    );
    assert_eq!(repo.current_branch().unwrap(), "main");
    assert_eq!(read(&repo, "a.wav"), b"main a", "nothing was replaced");

    let err = repo.restore("song.wav", "other", None, true).unwrap_err();
    assert!(matches!(err, Error::FileBusy(_)), "{err:?}");
    assert_eq!(read(&repo, "song.wav"), b"main song");

    set_readonly(&repo, "song.wav", false);
    repo.switch("other").unwrap();
    assert_eq!(read(&repo, "song.wav"), b"other song");
}

#[test]
fn comments_follow_file_content_across_versions() {
    let (_dir, mut repo) = setup();
    write(&repo, "mix.wav", "mix 1");
    write(&repo, "lyrics.txt", "v1");
    repo.commit("mix 1", &[]).unwrap();
    repo.add_comment("HEAD", "mix.wav", Some(30_000), "vocal too quiet")
        .unwrap();

    // The mix is unchanged in the next version: the comment still applies.
    write(&repo, "lyrics.txt", "v2");
    repo.commit("lyrics", &[]).unwrap();
    let mix1 = repo.file_at("HEAD", "mix.wav").unwrap().blob;
    let on_mix1 = repo.comments_on_content("mix.wav", mix1, false).unwrap();
    assert_eq!(on_mix1.len(), 1);
    assert_eq!(on_mix1[0].text, "vocal too quiet");

    // A new mix starts with a clean slate.
    write(&repo, "mix.wav", "mix 2");
    repo.commit("mix 2", &[]).unwrap();
    let mix2 = repo.file_at("HEAD", "mix.wav").unwrap().blob;
    assert!(
        repo.comments_on_content("mix.wav", mix2, false)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        repo.comments_on_content("mix.wav", mix1, false)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(hash_file(&repo.root().join("mix.wav")).unwrap().0, mix2);
}

#[test]
fn edits_that_keep_the_size_are_noticed() {
    let (_dir, mut repo) = setup();
    write(&repo, "mix.wav", noise(10_000, 1));
    write(&repo, "same.wav", "unchanged");
    repo.commit("one", &[]).unwrap();

    // A re-bounce of the same length: only the content tells.
    write(&repo, "mix.wav", noise(10_000, 2));
    // Touched but identical.
    write(&repo, "same.wav", "unchanged");
    assert_eq!(changes(&repo), [ch("mix.wav", ChangeKind::Modified)]);
    repo.commit("two", &[]).unwrap();
    assert!(changes(&repo).is_empty());
    assert_eq!(read(&repo, "mix.wav"), noise(10_000, 2));
}

#[test]
fn cleanup_drops_deleted_branches() {
    let (_dir, mut repo) = setup();
    write(&repo, "song.wav", noise(300_000, 1));
    repo.commit("main", &[]).unwrap();
    repo.create_branch("try", None).unwrap();
    repo.switch("try").unwrap();
    write(&repo, "idea.wav", noise(2_000_000, 2));
    repo.commit("idea", &[]).unwrap();
    repo.switch("main").unwrap();

    let before = repo.stats().unwrap();
    assert_eq!(repo.cleanup(None, false).unwrap().versions, 0);
    repo.delete_branch("try").unwrap();
    let plan = repo.cleanup(None, true).unwrap();
    assert_eq!(plan.versions, 1);
    assert!(plan.bytes >= 1_900_000, "{plan:?}");
    assert_eq!(repo.stats().unwrap(), before, "a dry run changes nothing");

    assert_eq!(repo.cleanup(None, false).unwrap(), plan);
    let after = repo.stats().unwrap();
    assert_eq!(after.snapshots, 1);
    assert!(after.stored_bytes < before.stored_bytes - 1_900_000);
    assert_eq!(repo.cleanup(None, false).unwrap().bytes, 0);
    // What stays is intact.
    let mut out = Vec::new();
    repo.read_file("HEAD", "song.wav", &mut out).unwrap();
    assert_eq!(out, noise(300_000, 1));
}

#[test]
fn pruning_keeps_history_but_frees_old_takes() {
    let (_dir, mut repo) = setup();
    for take in 1..=3 {
        write(&repo, "vocal.wav", noise(500_000, take * 2 + 1));
        write(&repo, "notes.txt", format!("take {take}"));
        repo.commit(&format!("take {take}"), &[]).unwrap();
    }
    repo.create_tag("demo", "HEAD~2").unwrap();
    let log = repo.log(None).unwrap();

    let freed = repo.cleanup(Some(i64::MAX), false).unwrap();
    assert_eq!(freed.versions, 0);
    // Take 2 alone is neither the latest nor tagged.
    assert_eq!(freed.contents, 2);
    assert!(freed.bytes >= 450_000, "{freed:?}");
    assert_eq!(repo.log(None).unwrap(), log, "history stays");

    let mut out = Vec::new();
    repo.read_file("demo", "vocal.wav", &mut out).unwrap();
    assert_eq!(out, noise(500_000, 3));
    assert!(matches!(
        repo.read_file("HEAD~1", "vocal.wav", &mut Vec::new()),
        Err(Error::ContentPruned(p)) if p == "vocal.wav"
    ));
    assert!(matches!(
        repo.restore("vocal.wav", "HEAD~1", Some("old.wav"), false),
        Err(Error::ContentPruned(_))
    ));
    // A branch from a pruned version cannot be checked out; nothing changes.
    repo.create_branch("back", Some("HEAD~1")).unwrap();
    assert!(matches!(repo.switch("back"), Err(Error::ContentPruned(_))));
    assert_eq!(repo.current_branch().unwrap(), "main");
    assert_eq!(read(&repo, "vocal.wav"), noise(500_000, 7));
    assert!(changes(&repo).is_empty());
}

#[test]
fn versions_export_as_zip() {
    let (dir, mut repo) = setup();
    write(&repo, "01 Intro.wav", noise(200_000, 1));
    write(&repo, "Обложка/cover.png", "png");
    repo.commit("master", &[]).unwrap();
    repo.create_tag("master-v1", "HEAD").unwrap();
    write(&repo, "01 Intro.wav", "changed later");
    repo.commit("later", &[]).unwrap();

    let dest = dir.path().join("Album master-v1.zip");
    assert_eq!(repo.export_zip("master-v1", &dest).unwrap(), 2);
    let mut zip = zip::ZipArchive::new(fs::File::open(&dest).unwrap()).unwrap();
    let mut names: Vec<String> = zip.file_names().map(str::to_owned).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "Album master-v1/01 Intro.wav",
            "Album master-v1/Обложка/cover.png"
        ]
    );
    let mut intro = Vec::new();
    std::io::Read::read_to_end(
        &mut zip.by_name("Album master-v1/01 Intro.wav").unwrap(),
        &mut intro,
    )
    .unwrap();
    assert_eq!(intro, noise(200_000, 1));
}

#[test]
fn labels_follow_the_content() {
    let (_dir, mut repo) = setup();
    write(&repo, "mix.wav", noise(10_000, 1));
    write(&repo, "notes.txt", "a");
    repo.commit("mix", &[]).unwrap();
    let meta = FileMeta {
        labels: vec!["мастер".into(), "демо".into()],
        bpm: Some(128.0),
        key: Some("Am".into()),
    };
    repo.set_file_meta("HEAD", "mix.wav", &meta).unwrap();
    let blob = repo.file_at("HEAD", "mix.wav").unwrap().blob;
    let stored = repo.file_meta(blob).unwrap();
    assert_eq!(stored.labels, ["демо", "мастер"]);
    assert_eq!(
        (stored.bpm, stored.key.as_deref()),
        (Some(128.0), Some("Am"))
    );

    // A later version with the same mix keeps the notes; a new mix has none.
    write(&repo, "notes.txt", "b");
    repo.commit("notes", &[]).unwrap();
    assert_eq!(
        repo.file_meta(repo.file_at("HEAD", "mix.wav").unwrap().blob)
            .unwrap(),
        stored
    );
    write(&repo, "mix.wav", noise(10_000, 3));
    repo.commit("new mix", &[]).unwrap();
    let new_blob = repo.file_at("HEAD", "mix.wav").unwrap().blob;
    assert!(repo.file_meta(new_blob).unwrap().is_empty());

    // Changing notes replaces them; the latest change wins.
    let fewer = FileMeta {
        labels: vec!["мастер".into()],
        bpm: None,
        key: Some("A minor".into()),
    };
    repo.set_file_meta("HEAD~1", "mix.wav", &fewer).unwrap();
    assert_eq!(repo.file_meta(blob).unwrap(), fewer);
    let all = repo.all_file_meta().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[&blob], fewer);

    for bad in [
        FileMeta {
            labels: vec![" пробел".into()],
            ..Default::default()
        },
        FileMeta {
            labels: vec!["x".repeat(41)],
            ..Default::default()
        },
        FileMeta {
            bpm: Some(5.0),
            ..Default::default()
        },
    ] {
        assert!(matches!(
            repo.set_file_meta("HEAD", "mix.wav", &bad),
            Err(Error::InvalidMeta(_))
        ));
    }
}
