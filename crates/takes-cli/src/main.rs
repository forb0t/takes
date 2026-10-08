use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use chrono::{Local, TimeZone};
use clap::{Parser, Subcommand, ValueEnum};
use takes_core::{
    Blocked, Change, ChangeKind, Conflict, Entry, Error, MergeKind, MergeOutcome, RemoteConfig,
    Repo, Resolution, Storage, SyncPhase, SyncProgress, SyncReport,
};

#[derive(Parser)]
#[command(
    name = "takes",
    version,
    about = "Version control for any files: projects, versions, branches"
)]
struct Cli {
    /// Run as if started in this folder
    #[arg(short = 'C', global = true, value_name = "DIR")]
    dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create a project in a folder (default: the current one)
    Init { path: Option<PathBuf> },
    /// Show what changed since the last saved version
    Status,
    /// Save a new version of the changed files
    #[command(alias = "save")]
    Commit {
        #[arg(short, long)]
        message: String,
        /// Only save these files or folders
        paths: Vec<PathBuf>,
    },
    /// Version history of the project, or of one file
    Log {
        /// Branch, tag or version to start from
        rev: Option<String>,
        #[arg(short, long)]
        file: Option<PathBuf>,
        #[arg(short = 'n', long)]
        limit: Option<usize>,
    },
    /// List the files of a version
    Ls { rev: Option<String> },
    /// List branches, or create one
    Branch {
        name: Option<String>,
        /// Start the branch at this version instead of the current one
        #[arg(long)]
        from: Option<String>,
        #[arg(short, long, requires = "name")]
        delete: bool,
    },
    /// Switch to another branch
    Switch {
        name: String,
        /// Create the branch first
        #[arg(short, long)]
        create: bool,
    },
    /// Merge a branch (or any version) into the current branch
    Merge {
        rev: String,
        /// How to settle every file changed on both branches
        #[arg(long, value_enum)]
        strategy: Option<Strategy>,
        /// How to settle one file, e.g. --resolve "song.wav=both"
        #[arg(long = "resolve", value_name = "PATH=ours|theirs|both")]
        resolve: Vec<String>,
        /// Only show what would happen
        #[arg(long)]
        dry_run: bool,
    },
    /// List tags, or mark a version (e.g. a release)
    Tag {
        name: Option<String>,
        rev: Option<String>,
        #[arg(short, long, requires = "name")]
        delete: bool,
    },
    /// Bring back a file as it was in an older version
    Restore {
        path: PathBuf,
        #[arg(long, default_value = "HEAD")]
        from: String,
        /// Put it next to the current file under this name instead
        #[arg(long = "as", value_name = "PATH")]
        as_path: Option<PathBuf>,
        /// Overwrite even unsaved changes
        #[arg(short, long)]
        force: bool,
    },
    /// Copy a file version anywhere, without touching the project
    Export {
        rev: String,
        path: PathBuf,
        dest: PathBuf,
    },
    /// Comments on file versions
    Comment {
        #[command(subcommand)]
        command: CommentCommand,
    },
    /// Read or change a setting (e.g. user.name)
    Config { key: String, value: Option<String> },
    /// How much space the history takes
    Stats,
    /// Show or set where the project syncs to
    Remote {
        #[command(subcommand)]
        command: Option<RemoteCommand>,
    },
    /// Get new versions from other devices and send yours
    Sync,
    /// Get a project from a remote into a new folder
    Clone {
        /// Folder for the project (must be missing or empty)
        into: PathBuf,
        #[command(subcommand)]
        from: RemoteCommand,
    },
    /// Show or set this computer's name, as other devices see it
    Device { name: Option<String> },
}

#[derive(Subcommand)]
enum RemoteCommand {
    /// A folder: on a NAS or USB drive, or inside Google Drive / Dropbox /
    /// Yandex Disk synced by their app
    Folder { path: PathBuf },
    /// A WebDAV server, e.g. Yandex Disk: https://webdav.yandex.ru
    /// (password from TAKES_PASSWORD or asked for)
    Webdav {
        url: String,
        /// Project folder on the server, e.g. "Takes/My album"
        folder: String,
        #[arg(long)]
        user: String,
    },
    /// Stop syncing (the remote itself is left untouched)
    Remove,
}

#[derive(Subcommand)]
enum CommentCommand {
    Add {
        path: PathBuf,
        text: String,
        /// Position in the track: 83, 1:23 or 1:02:03.5
        #[arg(long)]
        at: Option<String>,
        #[arg(long, default_value = "HEAD")]
        rev: String,
    },
    List {
        path: Option<PathBuf>,
        /// Include resolved comments
        #[arg(short, long)]
        all: bool,
    },
    Resolve {
        id: i64,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum Strategy {
    Ours,
    Theirs,
    Both,
}

impl From<Strategy> for Resolution {
    fn from(s: Strategy) -> Self {
        match s {
            Strategy::Ours => Resolution::Ours,
            Strategy::Theirs => Resolution::Theirs,
            Strategy::Both => Resolution::Both,
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    if let Some(dir) = &cli.dir
        && let Err(e) = std::env::set_current_dir(dir)
    {
        eprintln!("error: cannot open {}: {e}", dir.display());
        return ExitCode::FAILURE;
    }
    match run(cli.command) {
        Ok(code) => code,
        Err(err) => {
            report(&err);
            ExitCode::FAILURE
        }
    }
}

fn report(err: &anyhow::Error) {
    eprintln!("error: {err:#}");
    match err.downcast_ref::<Error>() {
        Some(Error::DirtyWorktree(changes)) => {
            for change in changes {
                eprintln!("  {}", format_change(change));
            }
            eprintln!(
                "save them first (takes commit -m \"...\") or bring back the saved files (takes restore)"
            );
        }
        Some(Error::WouldOverwrite(paths)) => {
            for path in paths {
                eprintln!("  {path}");
            }
            eprintln!("move these files somewhere else first");
        }
        Some(Error::FileBusy(paths)) => {
            for path in paths {
                eprintln!("  {path}");
            }
            eprintln!(
                "close them in other programs (e.g. your DAW) and try again; nothing was changed"
            );
        }
        _ => {}
    }
}

fn open() -> Result<Repo> {
    Ok(Repo::discover(".")?)
}

fn run(command: Command) -> Result<ExitCode> {
    match command {
        Command::Init { path } => {
            let repo = Repo::init(path.unwrap_or_else(|| ".".into()))?;
            println!("Created an empty project in {}", repo.root().display());
            println!("Put your files there and run: takes commit -m \"first version\"");
        }

        Command::Status => {
            let repo = open()?;
            println!("On branch {}", repo.current_branch()?);
            if repo.head()?.is_none() {
                println!("No saved versions yet.");
            }
            let changes = repo.status()?;
            if changes.is_empty() {
                println!("Nothing changed.");
            } else {
                println!("Unsaved changes:");
                for change in &changes {
                    println!("  {}", format_change(change));
                }
            }
        }

        Command::Commit { message, paths } => {
            let mut repo = open()?;
            let paths = paths
                .iter()
                .map(|p| project_path(&repo, p))
                .collect::<Result<Vec<_>>>()?;
            let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
            let id = repo.commit(&message, &paths)?;
            println!("[{} {}] {message}", repo.current_branch()?, id.short());
        }

        Command::Log { rev, file, limit } => {
            let repo = open()?;
            let labels = labels(&repo)?;
            let limit = limit.unwrap_or(usize::MAX);
            match file {
                Some(file) => {
                    let path = project_path(&repo, &file)?;
                    for version in repo
                        .file_history(&path, rev.as_deref())?
                        .into_iter()
                        .take(limit)
                    {
                        let s = &version.snapshot;
                        let what = match (version.kind, version.entry) {
                            (ChangeKind::Deleted, _) | (_, None) => "deleted".to_owned(),
                            (kind, Some(e)) => {
                                format!("{} {}", kind_word(kind), human_size(e.size))
                            }
                        };
                        println!(
                            "{}  {}  {:<16} {}",
                            s.id.short(),
                            date(s.created_at),
                            what,
                            s.message
                        );
                    }
                }
                None => {
                    for s in repo.log(rev.as_deref())?.into_iter().take(limit) {
                        let decoration = labels.get(&s.id).map(|l| format!(" ({})", l.join(", ")));
                        println!("{}{}", s.id.short(), decoration.unwrap_or_default());
                        println!("  {}  {}", date(s.created_at), s.author);
                        println!("  {}\n", s.message);
                    }
                }
            }
        }

        Command::Ls { rev } => {
            let repo = open()?;
            let id = repo.resolve(rev.as_deref().unwrap_or("HEAD"))?;
            for (path, entry) in repo.tree(id)? {
                println!("{:>10}  {path}", human_size(entry.size));
            }
        }

        Command::Branch { name: None, .. } => {
            let repo = open()?;
            for branch in repo.branches()? {
                let marker = if branch.current { "*" } else { " " };
                let head = branch
                    .head
                    .map_or_else(|| "(no versions)".into(), |h| h.short());
                println!("{marker} {:<24} {head}", branch.name);
            }
        }
        Command::Branch {
            name: Some(name),
            delete: true,
            ..
        } => {
            open()?.delete_branch(&name)?;
            println!("Deleted branch {name}");
        }
        Command::Branch {
            name: Some(name),
            from,
            ..
        } => {
            let id = open()?.create_branch(&name, from.as_deref())?;
            println!("Created branch {name} at {}", id.short());
        }

        Command::Switch { name, create } => {
            let mut repo = open()?;
            if create {
                repo.create_branch(&name, None)?;
            }
            repo.switch(&name)?;
            println!("Now on branch {name}");
        }

        Command::Merge {
            rev,
            strategy,
            resolve,
            dry_run,
        } => {
            let mut repo = open()?;
            let branch = repo.current_branch()?;
            if dry_run {
                let preview = repo.merge_preview(&rev)?;
                match preview.kind {
                    MergeKind::UpToDate => println!("Already up to date."),
                    MergeKind::FastForward => println!("Would fast-forward {branch} to '{rev}':"),
                    MergeKind::Merge => println!("Would merge '{rev}' into {branch}:"),
                }
                for change in &preview.changes {
                    println!("  {}", format_change(change));
                }
                print_conflicts(&preview.conflicts);
                return Ok(ExitCode::SUCCESS);
            }

            let mut rules = HashMap::new();
            for rule in &resolve {
                let (path, how) = rule
                    .rsplit_once('=')
                    .context("--resolve expects PATH=ours|theirs|both")?;
                let how = Strategy::from_str(how, true).map_err(|_| {
                    anyhow::anyhow!("unknown resolution '{how}' (ours, theirs, both)")
                })?;
                rules.insert(project_path(&repo, Path::new(path))?, Resolution::from(how));
            }
            let outcome = repo.merge(&rev, |c| {
                rules
                    .get(&c.path)
                    .copied()
                    .or(strategy.map(Resolution::from))
            })?;
            match outcome {
                MergeOutcome::UpToDate => println!("Already up to date."),
                MergeOutcome::FastForward(id) => {
                    println!("Fast-forwarded {branch} to {}", id.short())
                }
                MergeOutcome::Merged(id) => {
                    println!("Merged '{rev}' into {branch}: {}", id.short())
                }
                MergeOutcome::Conflicts(conflicts) => {
                    println!("Nothing merged yet.");
                    print_conflicts(&conflicts);
                    println!(
                        "\nChoose per file:  --resolve \"PATH=ours|theirs|both\"\n\
                         or for all files: --strategy ours|theirs|both\n\
                         (both keeps theirs next to yours as \"name ({rev}).ext\")"
                    );
                    return Ok(ExitCode::FAILURE);
                }
            }
        }

        Command::Tag { name: None, .. } => {
            let repo = open()?;
            for tag in repo.tags()? {
                let s = repo.snapshot(tag.target)?;
                println!("{:<24} {}  {}", tag.name, tag.target.short(), s.message);
            }
        }
        Command::Tag {
            name: Some(name),
            delete: true,
            ..
        } => {
            open()?.delete_tag(&name)?;
            println!("Deleted tag {name}");
        }
        Command::Tag {
            name: Some(name),
            rev,
            ..
        } => {
            let id = open()?.create_tag(&name, rev.as_deref().unwrap_or("HEAD"))?;
            println!("Tagged {} as {name}", id.short());
        }

        Command::Restore {
            path,
            from,
            as_path,
            force,
        } => {
            let repo = open()?;
            let path = project_path(&repo, &path)?;
            let dest = as_path.map(|p| project_path(&repo, &p)).transpose()?;
            repo.restore(&path, &from, dest.as_deref(), force)?;
            println!("Restored {} from {from}", dest.as_deref().unwrap_or(&path));
        }

        Command::Export { rev, path, dest } => {
            let repo = open()?;
            repo.export(&rev, &project_path(&repo, &path)?, &dest)?;
            println!("Wrote {}", dest.display());
        }

        Command::Comment { command } => {
            let repo = open()?;
            match command {
                CommentCommand::Add {
                    path,
                    text,
                    at,
                    rev,
                } => {
                    let at = at.as_deref().map(parse_timecode).transpose()?;
                    let id = repo.add_comment(&rev, &project_path(&repo, &path)?, at, &text)?;
                    println!("Added comment #{id}");
                }
                CommentCommand::List { path, all } => {
                    let path = path.map(|p| project_path(&repo, &p)).transpose()?;
                    for c in repo.comments(path.as_deref(), all)? {
                        let at = c.timecode_ms.map(|t| format!(" @{}", format_timecode(t)));
                        let done = if c.resolved { " [resolved]" } else { "" };
                        println!(
                            "#{} {}{} ({}, {})  {}: {}{done}",
                            c.id,
                            c.path,
                            at.unwrap_or_default(),
                            c.snapshot.short(),
                            date(c.created_at),
                            c.author,
                            c.text
                        );
                    }
                }
                CommentCommand::Resolve { id } => {
                    repo.resolve_comment(id)?;
                    println!("Resolved comment #{id}");
                }
            }
        }

        Command::Config { key, value } => {
            let repo = open()?;
            match value {
                Some(value) => repo.set_config(&key, &value)?,
                None => match repo.config(&key)? {
                    Some(value) => println!("{value}"),
                    None => return Ok(ExitCode::FAILURE),
                },
            }
        }

        Command::Remote { command: None } => {
            let repo = open()?;
            let state = repo.sync_state()?;
            match &state.remote {
                None => println!(
                    "No remote. Set one with `takes remote folder <path>` or `takes remote webdav ...`."
                ),
                Some(remote) => {
                    println!("Remote:  {}", remote.describe());
                    println!("Device:  {}", repo.device()?.1);
                    match state.last_sync {
                        Some(t) => println!("Synced:  {}", date(t)),
                        None => println!("Synced:  never"),
                    }
                    println!("Unsent:  {} version(s)", state.unsent_versions);
                    for d in &state.diverged {
                        println!(
                            "Diverged: {} — merge with `takes merge \"{}\"`",
                            d.branch, d.rev
                        );
                    }
                }
            }
        }
        Command::Remote {
            command: Some(RemoteCommand::Remove),
        } => {
            open()?.set_remote(None)?;
            println!("Remote removed. Nothing was deleted from it.");
        }
        Command::Remote {
            command: Some(command),
        } => {
            let repo = open()?;
            let remote = remote_config(command)?;
            let storage = connect(&remote)?;
            repo.connect_remote(storage.as_ref())?;
            repo.set_remote(Some(&remote))?;
            println!(
                "Remote set: {}. Run `takes sync` to send your versions.",
                remote.describe()
            );
        }
        Command::Sync => {
            let mut repo = open()?;
            let remote = repo
                .sync_state()?
                .remote
                .ok_or(Error::RemoteNotConfigured)?;
            let storage = connect(&remote)?;
            let report = repo.sync(storage.as_ref(), &mut print_progress)?;
            eprintln!();
            print_report(&report);
        }
        Command::Clone { from, into } => {
            let remote = remote_config(from)?;
            let storage = connect(&remote)?;
            let (repo, report) =
                Repo::clone_from(storage.as_ref(), &remote, &into, &mut print_progress)?;
            eprintln!();
            println!(
                "Got {} version(s) into {} (branch {}).",
                report.received_versions,
                repo.root().display(),
                repo.current_branch()?
            );
        }
        Command::Device { name } => {
            let repo = open()?;
            match name {
                Some(name) => repo.set_device_name(&name)?,
                None => println!("{}", repo.device()?.1),
            }
        }

        Command::Stats => {
            let s = open()?.stats()?;
            println!("Versions:           {}", s.snapshots);
            println!(
                "File contents:      {} ({})",
                s.blobs,
                human_size(s.content_bytes)
            );
            println!(
                "Stored on disk:     {} in {} chunks",
                human_size(s.stored_bytes),
                s.chunks
            );
            if s.content_bytes > s.stored_bytes {
                let saved = 100 * (s.content_bytes - s.stored_bytes) / s.content_bytes;
                println!("Saved by dedup/compression: {saved}%");
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn remote_config(command: RemoteCommand) -> Result<RemoteConfig> {
    Ok(match command {
        RemoteCommand::Folder { path } => {
            let path = std::path::absolute(&path)?;
            RemoteConfig::Folder {
                path: path.display().to_string(),
            }
        }
        RemoteCommand::Webdav { url, folder, user } => RemoteConfig::WebDav {
            url,
            folder,
            username: user,
        },
        RemoteCommand::Remove => bail!("nothing to connect to"),
    })
}

fn connect(remote: &RemoteConfig) -> Result<Box<dyn Storage>> {
    let password = if remote.needs_password() {
        Some(match std::env::var("TAKES_PASSWORD") {
            Ok(p) => p,
            Err(_) => rpassword::prompt_password(format!("Password for {}: ", remote.describe()))?,
        })
    } else {
        None
    };
    Ok(remote.open(password.as_deref())?)
}

fn print_progress(p: SyncProgress) {
    let what = match p.phase {
        SyncPhase::Connecting => "Connecting",
        SyncPhase::Downloading => "Downloading",
        SyncPhase::Uploading => "Uploading",
    };
    if p.total > 0 {
        eprint!(
            "\r{what}: {} / {}      ",
            human_size(p.done),
            human_size(p.total)
        );
    } else {
        eprint!("\r{what}…                ");
    }
}

fn print_report(r: &SyncReport) {
    println!(
        "Received {} version(s), {} comment(s); sent {} version(s), {} comment(s) ({} down, {} up).",
        r.received_versions,
        r.comments_received,
        r.sent_versions,
        r.comments_sent,
        human_size(r.downloaded_bytes),
        human_size(r.uploaded_bytes)
    );
    for b in &r.updated_branches {
        println!("Updated branch {b}");
    }
    for b in &r.new_branches {
        println!("New branch {b}");
    }
    match &r.current_blocked {
        Some(Blocked::Unsaved) => {
            println!(
                "The current branch has a newer version, but you have unsaved changes: save or discard them and sync again."
            )
        }
        Some(Blocked::FilesBusy(p)) => println!(
            "Close these files to get the newer version: {}",
            p.join(", ")
        ),
        Some(Blocked::WouldOverwrite(p)) => println!(
            "Move these files away to get the newer version: {}",
            p.join(", ")
        ),
        None => {}
    }
    for d in &r.diverged {
        println!(
            "Branch {} also changed on {}: merge with `takes merge \"{}\"`",
            d.branch, d.device, d.rev
        );
    }
}

/// Branch and tag names per version, for log decorations.
fn labels(repo: &Repo) -> Result<HashMap<takes_core::Hash, Vec<String>>> {
    let mut labels: HashMap<_, Vec<String>> = HashMap::new();
    for branch in repo.branches()? {
        if let Some(head) = branch.head {
            let name = if branch.current {
                format!("* {}", branch.name)
            } else {
                branch.name
            };
            labels.entry(head).or_default().push(name);
        }
    }
    for tag in repo.tags()? {
        labels
            .entry(tag.target)
            .or_default()
            .push(format!("tag: {}", tag.name));
    }
    Ok(labels)
}

fn print_conflicts(conflicts: &[Conflict]) {
    if conflicts.is_empty() {
        return;
    }
    println!("Changed on both branches:");
    for c in conflicts {
        println!(
            "  {}: ours {}, theirs {}",
            c.path,
            side(c.ours),
            side(c.theirs)
        );
    }
}

fn side(entry: Option<Entry>) -> String {
    entry.map_or_else(
        || "deleted".into(),
        |e| format!("{} ({})", e.blob.short(), human_size(e.size)),
    )
}

/// A command-line path (relative to the current folder) as a project path.
fn project_path(repo: &Repo, path: &Path) -> Result<String> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in abs.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other),
        }
    }
    let Ok(rel) = normalized.strip_prefix(repo.root()) else {
        bail!(
            "{} is outside the project {}",
            path.display(),
            repo.root().display()
        );
    };
    let parts = rel
        .components()
        .map(|c| {
            c.as_os_str()
                .to_str()
                .context("file name is not valid UTF-8")
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(parts.join("/"))
}

fn format_change(change: &Change) -> String {
    format!(
        "{:<9} {}",
        format!("{}:", kind_word(change.kind)),
        change.path
    )
}

fn kind_word(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::Added => "added",
        ChangeKind::Modified => "modified",
        ChangeKind::Deleted => "deleted",
    }
}

fn date(unix: i64) -> String {
    Local.timestamp_opt(unix, 0).single().map_or_else(
        || unix.to_string(),
        |d| d.format("%Y-%m-%d %H:%M").to_string(),
    )
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

/// `83`, `1:23`, `1:02:03.5` → milliseconds.
fn parse_timecode(s: &str) -> Result<u64> {
    let invalid = || anyhow::anyhow!("invalid time '{s}', use e.g. 83, 1:23 or 1:02:03.5");
    let mut parts: Vec<&str> = s.split(':').collect();
    if parts.len() > 3 {
        return Err(invalid());
    }
    let seconds: f64 = parts.pop().unwrap().parse().map_err(|_| invalid())?;
    if seconds < 0.0 || (!parts.is_empty() && seconds >= 60.0) {
        return Err(invalid());
    }
    let mut total = 0u64;
    for part in parts {
        total = total * 60 + part.parse::<u64>().map_err(|_| invalid())?;
    }
    Ok(total * 60_000 + (seconds * 1000.0).round() as u64)
}

fn format_timecode(ms: u64) -> String {
    let secs = ms / 1000;
    match secs / 3600 {
        0 => format!("{}:{:02}", secs / 60, secs % 60),
        h => format!("{h}:{:02}:{:02}", secs / 60 % 60, secs % 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timecodes() {
        assert_eq!(parse_timecode("83").unwrap(), 83_000);
        assert_eq!(parse_timecode("1:23").unwrap(), 83_000);
        assert_eq!(parse_timecode("1:02:03.5").unwrap(), 3_723_500);
        assert!(parse_timecode("1:75").is_err());
        assert!(parse_timecode("x").is_err());
        assert_eq!(format_timecode(83_000), "1:23");
        assert_eq!(format_timecode(3_723_500), "1:02:03");
    }

    #[test]
    fn sizes() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(human_size(50 * 1024 * 1024), "50.0 MB");
    }
}
