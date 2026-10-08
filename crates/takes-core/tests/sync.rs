//! Two "devices" syncing through a folder remote.

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use takes_core::{
    Blocked, Error, FolderStorage, MergeOutcome, RemoteConfig, Repo, Resolution, Storage,
    SyncReport,
};
use tempfile::TempDir;

/// Records writes, and can fail them, to check what sync sends.
struct Spy {
    inner: FolderStorage,
    writes: Mutex<Vec<String>>,
    fail_prefix: Mutex<Option<String>>,
}

impl Spy {
    fn new(path: &Path) -> Self {
        Self {
            inner: FolderStorage::new(path),
            writes: Mutex::default(),
            fail_prefix: Mutex::default(),
        }
    }

    fn take_writes(&self) -> Vec<String> {
        std::mem::take(&mut self.writes.lock().unwrap())
    }

    fn record(&self, path: &str) -> takes_core::Result<()> {
        if let Some(prefix) = &*self.fail_prefix.lock().unwrap()
            && path.starts_with(prefix.as_str())
        {
            return Err(Error::Remote("connection lost".into()));
        }
        self.writes.lock().unwrap().push(path.to_owned());
        Ok(())
    }
}

impl Storage for Spy {
    fn list(&self, dir: &str) -> takes_core::Result<Vec<String>> {
        self.inner.list(dir)
    }
    fn read(&self, path: &str) -> takes_core::Result<Option<Vec<u8>>> {
        self.inner.read(path)
    }
    fn read_range(&self, path: &str, offset: u64, len: u64) -> takes_core::Result<Vec<u8>> {
        self.inner.read_range(path, offset, len)
    }
    fn write(&self, path: &str, data: &[u8]) -> takes_core::Result<()> {
        self.record(path)?;
        self.inner.write(path, data)
    }
    fn write_file(&self, path: &str, local: &Path) -> takes_core::Result<()> {
        self.record(path)?;
        self.inner.write_file(path, local)
    }
    fn delete(&self, path: &str) -> takes_core::Result<()> {
        self.inner.delete(path)
    }
}

struct World {
    dir: TempDir,
    remote: Spy,
    config: RemoteConfig,
}

impl World {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("remote");
        let config = RemoteConfig::Folder {
            path: path.display().to_string(),
        };
        Self {
            remote: Spy::new(&path),
            dir,
            config,
        }
    }

    fn device(&self, name: &str) -> Repo {
        let repo = Repo::init(self.dir.path().join(name)).unwrap();
        repo.set_config("user.name", name).unwrap();
        repo.set_device_name(name).unwrap();
        repo.set_remote(Some(&self.config)).unwrap();
        repo
    }

    fn clone(&self, name: &str) -> Repo {
        let (repo, _) = Repo::clone_from(
            &self.remote,
            &self.config,
            &self.dir.path().join(name),
            &mut |_| {},
        )
        .unwrap();
        repo.set_config("user.name", name).unwrap();
        repo.set_device_name(name).unwrap();
        repo
    }

    fn sync(&self, repo: &mut Repo) -> SyncReport {
        repo.sync(&self.remote, &mut |_| {}).unwrap()
    }
}

fn write(repo: &Repo, path: &str, data: impl AsRef<[u8]>) {
    let abs = repo.root().join(path);
    fs::create_dir_all(abs.parent().unwrap()).unwrap();
    fs::write(abs, data).unwrap();
}

fn read(repo: &Repo, path: &str) -> Vec<u8> {
    fs::read(repo.root().join(path)).unwrap()
}

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
fn push_then_clone_on_another_device() {
    let world = World::new();
    let mut laptop = world.device("laptop");
    let mix = noise(5 * 1024 * 1024, 7);
    write(&laptop, "01 Intro.wav", &mix);
    write(&laptop, "Альбом/lyrics.txt", "la la");
    laptop.commit("first demos", &[]).unwrap();
    write(&laptop, "Альбом/lyrics.txt", "la la la");
    laptop.commit("lyrics", &[]).unwrap();
    laptop.create_tag("demo-v1", "HEAD").unwrap();

    let report = world.sync(&mut laptop);
    assert_eq!(report.sent_versions, 2);
    assert!(report.uploaded_bytes > mix.len() as u64 / 2);

    let studio = world.clone("studio");
    assert_eq!(read(&studio, "01 Intro.wav"), mix);
    assert_eq!(read(&studio, "Альбом/lyrics.txt"), b"la la la");
    assert!(studio.status().unwrap().is_empty());
    assert_eq!(studio.head().unwrap(), laptop.head().unwrap());
    assert_eq!(studio.log(None).unwrap().len(), 2);
    assert_eq!(studio.tags().unwrap()[0].name, "demo-v1");
    assert_eq!(studio.remote().unwrap(), Some(world.config.clone()));
}

#[test]
fn nothing_is_uploaded_twice() {
    let world = World::new();
    let mut laptop = world.device("laptop");
    write(&laptop, "song.wav", noise(3 * 1024 * 1024, 1));
    laptop.commit("v1", &[]).unwrap();
    world.sync(&mut laptop);
    world.remote.take_writes();

    let again = world.sync(&mut laptop);
    assert_eq!(again.sent_versions, 0);
    assert_eq!(world.remote.take_writes(), Vec::<String>::new());

    // A copy of the same audio costs no new pack.
    write(&laptop, "copy.wav", noise(3 * 1024 * 1024, 1));
    laptop.commit("copy", &[]).unwrap();
    world.sync(&mut laptop);
    let writes = world.remote.take_writes();
    assert!(
        !writes.iter().any(|w| w.starts_with("packs/")),
        "{writes:?}"
    );
}

#[test]
fn newer_versions_are_applied_on_sync() {
    let world = World::new();
    let mut laptop = world.device("laptop");
    write(&laptop, "song.wav", "v1");
    laptop.commit("v1", &[]).unwrap();
    world.sync(&mut laptop);
    let mut studio = world.clone("studio");

    write(&laptop, "song.wav", "v2");
    write(&laptop, "new.wav", "new");
    laptop.commit("v2", &[]).unwrap();
    laptop.create_branch("remix", None).unwrap();
    world.sync(&mut laptop);

    let report = world.sync(&mut studio);
    assert_eq!(report.received_versions, 1);
    assert_eq!(report.updated_branches, ["main"]);
    assert_eq!(report.new_branches, ["remix"]);
    assert!(report.diverged.is_empty());
    assert_eq!(read(&studio, "song.wav"), b"v2");
    assert_eq!(read(&studio, "new.wav"), b"new");
    assert!(studio.status().unwrap().is_empty());
    assert_eq!(studio.sync_state().unwrap().unsent_versions, 0);
}

#[test]
fn unsaved_work_is_never_overwritten() {
    let world = World::new();
    let mut laptop = world.device("laptop");
    write(&laptop, "song.wav", "v1");
    laptop.commit("v1", &[]).unwrap();
    world.sync(&mut laptop);
    let mut studio = world.clone("studio");

    write(&laptop, "song.wav", "v2");
    laptop.commit("v2", &[]).unwrap();
    world.sync(&mut laptop);

    write(&studio, "song.wav", "studio edit, not saved");
    let report = world.sync(&mut studio);
    assert_eq!(report.current_blocked, Some(Blocked::Unsaved));
    assert_eq!(read(&studio, "song.wav"), b"studio edit, not saved");
    assert_eq!(studio.sync_state().unwrap().waiting, ["main"]);

    // Throw the edit away and sync again: now it updates.
    studio.restore("song.wav", "HEAD", None, true).unwrap();
    let report = world.sync(&mut studio);
    assert_eq!(report.current_blocked, None);
    assert_eq!(read(&studio, "song.wav"), b"v2");
}

#[test]
fn diverged_branches_are_merged_like_any_branch() {
    let world = World::new();
    let mut laptop = world.device("laptop");
    write(&laptop, "song.wav", "demo");
    laptop.commit("demo", &[]).unwrap();
    world.sync(&mut laptop);
    let mut studio = world.clone("studio");

    write(&laptop, "song.wav", "laptop vocal");
    laptop.commit("laptop vocal", &[]).unwrap();
    world.sync(&mut laptop);
    write(&studio, "song.wav", "studio vocal");
    write(&studio, "drums.wav", "drums");
    studio.commit("studio vocal", &[]).unwrap();

    let report = world.sync(&mut studio);
    assert_eq!(report.diverged.len(), 1);
    let rev = report.diverged[0].rev.clone();
    assert_eq!(rev, "main@laptop");
    assert_eq!(studio.sync_state().unwrap().diverged.len(), 1);

    let outcome = studio.merge(&rev, |_| Some(Resolution::Both)).unwrap();
    assert!(matches!(outcome, MergeOutcome::Merged(_)));
    assert_eq!(read(&studio, "song.wav"), b"studio vocal");
    assert_eq!(read(&studio, "song (main@laptop).wav"), b"laptop vocal");
    assert!(world.sync(&mut studio).diverged.is_empty());

    // The laptop takes the merge as a plain update.
    let report = world.sync(&mut laptop);
    assert_eq!(report.updated_branches, ["main"]);
    assert!(report.diverged.is_empty());
    assert_eq!(laptop.head().unwrap(), studio.head().unwrap());
    assert_eq!(read(&laptop, "drums.wav"), b"drums");
}

#[test]
fn comments_and_resolutions_travel() {
    let world = World::new();
    let mut laptop = world.device("laptop");
    write(&laptop, "mix.wav", "mix");
    laptop.commit("mix", &[]).unwrap();
    laptop
        .add_comment("HEAD", "mix.wav", Some(42_000), "kick too loud")
        .unwrap();
    let first = laptop
        .add_comment("HEAD", "mix.wav", None, "love it")
        .unwrap();
    laptop.resolve_comment(first).unwrap();
    let report = world.sync(&mut laptop);
    assert_eq!(report.comments_sent, 2);

    let mut studio = world.clone("studio");
    let comments = studio.comments(Some("mix.wav"), true).unwrap();
    assert_eq!(comments.len(), 2);
    let kick = comments.iter().find(|c| c.text == "kick too loud").unwrap();
    assert_eq!(kick.timecode_ms, Some(42_000));
    assert!(
        comments
            .iter()
            .find(|c| c.text == "love it")
            .unwrap()
            .resolved
    );

    studio.resolve_comment(kick.id).unwrap();
    studio
        .add_comment("HEAD", "mix.wav", Some(1_000), "fixed in next mix")
        .unwrap();
    assert_eq!(world.sync(&mut studio).comments_sent, 1);

    let report = world.sync(&mut laptop);
    assert_eq!(report.comments_received, 1);
    let comments = laptop.comments(Some("mix.wav"), true).unwrap();
    assert_eq!(comments.len(), 3);
    assert!(
        comments
            .iter()
            .all(|c| c.resolved || c.text == "fixed in next mix")
    );
}

#[test]
fn a_remote_belongs_to_one_project() {
    let world = World::new();
    let mut laptop = world.device("laptop");
    write(&laptop, "a.wav", "a");
    laptop.commit("a", &[]).unwrap();
    world.sync(&mut laptop);

    let mut other = world.device("other");
    write(&other, "b.wav", "b");
    other.commit("b", &[]).unwrap();
    assert!(matches!(
        other.sync(&world.remote, &mut |_| {}),
        Err(Error::RemoteMismatch)
    ));

    // A folder with someone's files is not taken over.
    let foreign = world.dir.path().join("photos");
    fs::create_dir_all(&foreign).unwrap();
    fs::write(foreign.join("cat.jpg"), "meow").unwrap();
    let storage = FolderStorage::new(&foreign);
    assert!(matches!(
        other.sync(&storage, &mut |_| {}),
        Err(Error::RemoteNotEmpty)
    ));
    assert!(matches!(
        Repo::clone_from(
            &storage,
            &world.config,
            &world.dir.path().join("x"),
            &mut |_| {}
        ),
        Err(Error::NotARemote)
    ));
}

#[test]
fn damaged_remote_data_is_rejected_and_clone_cleans_up() {
    let world = World::new();
    let mut laptop = world.device("laptop");
    write(&laptop, "song.wav", noise(1024 * 1024, 3));
    laptop.commit("v1", &[]).unwrap();
    world.sync(&mut laptop);

    let packs = world.dir.path().join("remote/packs");
    let pack = fs::read_dir(&packs)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "pack"))
        .unwrap();
    let mut data = fs::read(&pack).unwrap();
    let middle = data.len() / 2;
    data[middle] ^= 0xff;
    fs::write(&pack, data).unwrap();

    let dest = world.dir.path().join("studio");
    let result = Repo::clone_from(&world.remote, &world.config, &dest, &mut |_| {});
    assert!(
        matches!(result, Err(Error::Corrupt(_))),
        "{:?}",
        result.err()
    );
    assert!(!dest.exists(), "a failed clone leaves nothing behind");
}

#[test]
fn an_interrupted_push_resumes_without_resending() {
    let world = World::new();
    let mut laptop = world.device("laptop");
    write(&laptop, "song.wav", noise(2 * 1024 * 1024, 5));
    laptop.commit("v1", &[]).unwrap();

    *world.remote.fail_prefix.lock().unwrap() = Some("snapshots/".into());
    assert!(matches!(
        laptop.sync(&world.remote, &mut |_| {}),
        Err(Error::Remote(_))
    ));
    assert_eq!(laptop.sync_state().unwrap().unsent_versions, 1);
    let first = world.remote.take_writes();
    assert!(first.iter().any(|w| w.ends_with(".pack")));

    *world.remote.fail_prefix.lock().unwrap() = None;
    let report = world.sync(&mut laptop);
    assert_eq!(report.sent_versions, 1);
    let second = world.remote.take_writes();
    assert!(
        !second.iter().any(|w| w.starts_with("packs/")),
        "{second:?}"
    );

    let studio = world.clone("studio");
    assert_eq!(read(&studio, "song.wav"), read(&laptop, "song.wav"));
}

#[test]
fn deleted_branches_disappear_from_the_remote() {
    let world = World::new();
    let mut laptop = world.device("laptop");
    write(&laptop, "a.wav", "a");
    laptop.commit("a", &[]).unwrap();
    laptop.create_branch("try", None).unwrap();
    world.sync(&mut laptop);
    laptop.delete_branch("try").unwrap();
    world.sync(&mut laptop);

    let studio = world.clone("studio");
    let names: Vec<String> = studio
        .branches()
        .unwrap()
        .into_iter()
        .map(|b| b.name)
        .collect();
    assert_eq!(names, ["main"]);
}

/// Runs only against a real server, e.g. a local wsgidav:
/// `TAKES_WEBDAV_URL=http://127.0.0.1:8090 TAKES_WEBDAV_USER=u TAKES_WEBDAV_PASSWORD=p cargo test webdav`
#[test]
fn webdav_push_and_clone() {
    let Ok(url) = std::env::var("TAKES_WEBDAV_URL") else {
        eprintln!("skipped: TAKES_WEBDAV_URL not set");
        return;
    };
    let user = std::env::var("TAKES_WEBDAV_USER").unwrap_or_default();
    let password = std::env::var("TAKES_WEBDAV_PASSWORD").unwrap_or_default();
    let dir = TempDir::new().unwrap();
    let folder = format!("takes-test/Альбом {}", std::process::id());
    let config = RemoteConfig::WebDav {
        url: url.clone(),
        folder: folder.clone(),
        username: user.clone(),
    };
    let storage = config.open(Some(&password)).unwrap();

    let mut laptop = Repo::init(dir.path().join("laptop")).unwrap();
    laptop.set_device_name("laptop").unwrap();
    laptop.set_remote(Some(&config)).unwrap();
    let mix = noise(3 * 1024 * 1024, 11);
    write(&laptop, "Песня/mix.wav", &mix);
    laptop.commit("mix", &[]).unwrap();
    laptop
        .add_comment("HEAD", "Песня/mix.wav", Some(5_000), "громче вокал")
        .unwrap();
    let report = laptop.sync(storage.as_ref(), &mut |_| {}).unwrap();
    assert_eq!(report.sent_versions, 1);

    let parent = RemoteConfig::WebDav {
        url,
        folder: "takes-test".into(),
        username: user,
    }
    .open(Some(&password))
    .unwrap();
    let found = takes_core::find_remote_projects(parent.as_ref()).unwrap();
    assert!(
        found.iter().any(|f| folder.ends_with(f.as_str())),
        "{found:?}"
    );

    let (studio, _) = Repo::clone_from(
        storage.as_ref(),
        &config,
        &dir.path().join("studio"),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(read(&studio, "Песня/mix.wav"), mix);
    assert_eq!(studio.comments(None, true).unwrap()[0].text, "громче вокал");

    let wrong = RemoteConfig::WebDav {
        url: std::env::var("TAKES_WEBDAV_URL").unwrap(),
        folder,
        username: "nobody".into(),
    }
    .open(Some("wrong"))
    .unwrap();
    if !password.is_empty() {
        assert!(matches!(wrong.list(""), Err(Error::RemoteAuth)));
    }
}
