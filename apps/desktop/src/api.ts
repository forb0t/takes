import { invoke } from "@tauri-apps/api/core";

/** "renamed": moved or renamed with the same content; the file keeps its history. */
export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface Change {
  path: string;
  kind: ChangeKind;
  size: number | null;
  /** Cleanup removed this content: it cannot be played or restored. */
  pruned: boolean;
  /** Labels on the content ("мастер", …); only in a version's changes. */
  labels: string[];
  /** The earlier path of a renamed file. */
  from?: string | null;
  /** The new content's hash; only in the project diagram's versions. */
  blob?: string | null;
}

export interface Snapshot {
  id: string;
  parents: string[];
  message: string;
  author: string;
  createdAt: number;
}

export interface Branch {
  name: string;
  head: string | null;
  current: boolean;
}

export interface Tag {
  name: string;
  target: string;
}

export interface Overview {
  root: string;
  name: string;
  branch: string;
  head: string | null;
  author: string;
  branches: Branch[];
  tags: Tag[];
}

export interface FileInfo {
  path: string;
  size: number;
  labels: string[];
}

export interface FileVersion {
  snapshot: Snapshot;
  kind: ChangeKind;
  /** What the file was called in this version (it may have been renamed since). */
  path: string;
  /** For a rename, what it was called before. */
  from: string | null;
  size: number | null;
  pruned: boolean;
  labels: string[];
}

/** A file deleted and saved as deleted; `last` is the version to bring it back from. */
export interface RemovedFile {
  path: string;
  last: string;
}

/** A version with what it changed, for the diagram. */
/** What a take of a song is made of: a file outside the project, one in its folder as it is now, or a saved version of a file. */
export type TakeSource = { outside: string } | { folder: string } | { version: { rev: string; path: string } };

export interface GraphVersion extends Snapshot {
  changes: Change[];
}

export interface ImportResult {
  /** Where the copied files are in the project. */
  paths: string[];
  /** How many replaced a saved file of the same name. */
  replaced: number;
  /** Versions saved for them. */
  saved: number;
}

/** Labels, tempo and key a musician set on a file content. */
export interface FileMeta {
  labels: string[];
  bpm: number | null;
  key: string | null;
}

export interface TextFile {
  text: string;
  /** Only the beginning of a long file. */
  truncated: boolean;
}

export interface Side {
  blob: string;
  size: number;
}

export interface Conflict {
  path: string;
  ours: Side | null;
  theirs: Side | null;
}

export interface MergePreview {
  kind: "upToDate" | "fastForward" | "merge";
  changes: Change[];
  conflicts: Conflict[];
}

export interface MergeOutcome {
  kind: "upToDate" | "fastForward" | "merged" | "conflicts";
  id: string | null;
  conflicts: Conflict[];
}

export type Resolution = "ours" | "theirs" | "both";

export interface Project {
  path: string;
  name: string;
  exists: boolean;
}

export interface Stats {
  snapshots: number;
  contentBytes: number;
  storedBytes: number;
}

/** What cleanup frees (or would free). */
export interface Cleanup {
  /** Versions nothing leads to any more, e.g. of deleted branches. */
  versions: number;
  /** Old file versions whose data goes; they stay in the history. */
  contents: number;
  bytes: number;
}

export interface Analysis {
  /** Content hash of the analyzed version. */
  blob: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  /** Peak amplitude per point, 0–255 for 0.0–1.0. */
  peaks: number[];
  rms: number[];
  /** Integrated loudness, LUFS; null for silence. */
  lufs: number | null;
  /** Estimated tempo; null without a clear pulse. */
  bpm: number | null;
  /** Estimated key, e.g. "Am"; null when unclear. */
  key: string | null;
  /** Set by hand; wins over the estimates. */
  manualBpm: number | null;
  manualKey: string | null;
}

export interface Comment {
  id: number;
  snapshot: string;
  path: string;
  timecodeMs: number | null;
  text: string;
  author: string;
  createdAt: number;
  resolved: boolean;
}

export type RemoteConfig =
  | { kind: "folder"; path: string }
  | { kind: "webDav"; url: string; folder: string; username: string };

export interface DivergedBranch {
  branch: string;
  device: string;
  /** What to merge, e.g. "main@Студия". */
  rev: string;
}

export interface SyncState {
  remote: RemoteConfig | null;
  location: string | null;
  hasPassword: boolean;
  deviceName: string;
  unsentVersions: number;
  diverged: DivergedBranch[];
  waiting: string[];
  lastSync: number | null;
  /** Sync on its own (on open, after saving, every few minutes). */
  auto: boolean;
}

export interface SyncReport {
  uploadedBytes: number;
  downloadedBytes: number;
  sentVersions: number;
  receivedVersions: number;
  commentsSent: number;
  commentsReceived: number;
  updatedBranches: string[];
  newBranches: string[];
  deletedBranches: string[];
  diverged: DivergedBranch[];
  currentBlocked: "unsaved" | "filesBusy" | "wouldOverwrite" | null;
  blockedPaths: string[];
}

export interface SyncProgress {
  root: string;
  phase: "connecting" | "downloading" | "uploading";
  done: number;
  total: number;
}

/** Error shape produced by the Rust commands. */
export interface CommandError {
  kind: string;
  message: string;
  changes: Change[];
  paths: string[];
}

export const api = {
  listProjects: () => invoke<Project[]>("list_projects"),
  isProject: (path: string) => invoke<boolean>("is_project", { path }),
  addProject: (path: string, create: boolean) => invoke<Project>("add_project", { path, create }),
  removeProject: (path: string) => invoke<void>("remove_project", { path }),
  reveal: (path: string) => invoke<void>("reveal", { path }),

  overview: (root: string) => invoke<Overview>("overview", { root }),
  status: (root: string) => invoke<Change[]>("status", { root }),
  /**
   * Saves each changed file under `paths` (all if empty) as a version of its
   * own, described by `messages[path]` or automatically; returns them oldest first.
   */
  commit: (root: string, paths: string[], messages: Record<string, string>) =>
    invoke<string[]>("commit", { root, paths, messages }),
  importFiles: (
    root: string,
    sources: string[],
    options: { dest?: string; asPath?: string | null; message?: string | null; save: boolean },
  ) =>
    invoke<ImportResult>("import_files", {
      root,
      sources,
      dest: options.dest ?? "",
      asPath: options.asPath ?? null,
      message: options.message ?? null,
      save: options.save,
    }),
  historyGraph: (root: string) => invoke<GraphVersion[]>("history_graph", { root }),
  log: (root: string, rev: string | null) => invoke<Snapshot[]>("log", { root, rev }),
  snapshotChanges: (root: string, id: string) => invoke<Change[]>("snapshot_changes", { root, id }),
  files: (root: string, rev: string) => invoke<FileInfo[]>("files", { root, rev }),
  /** Versions of a file along `rev` (default: the current branch), newest first. */
  fileHistory: (root: string, path: string, rev: string | null = null) =>
    invoke<FileVersion[]>("file_history", { root, path, rev }),
  removedFiles: (root: string) => invoke<RemovedFile[]>("removed_files", { root }),
  /** A setting every device of the project shares, e.g. "songs.order". */
  sharedSetting: (root: string, key: string) => invoke<string | null>("shared_setting", { root, key }),
  sharedSettings: (root: string, prefix: string) =>
    invoke<Record<string, string>>("shared_settings", { root, prefix }),
  setSharedSetting: (root: string, key: string, value: string) =>
    invoke<void>("set_shared_setting", { root, key, value }),
  stats: (root: string) => invoke<Stats>("stats", { root }),
  cleanup: (root: string, olderThanDays: number | null, dryRun: boolean, keep: string[]) =>
    invoke<Cleanup>("cleanup", { root, olderThanDays, dryRun, keep }),
  exportZip: (root: string, rev: string, dest: string) => invoke<number>("export_zip", { root, rev, dest }),
  setAuthor: (root: string, name: string) => invoke<void>("set_author", { root, name }),

  switchBranch: (root: string, name: string) => invoke<void>("switch_branch", { root, name }),
  /** Saves a file as a version of `path` after version `parent`, beside the folder. */
  saveTake: (root: string, source: TakeSource, path: string, parent: string, variant: string) =>
    invoke<string>("save_take", { root, source, path, parent, variant }),
  /** Brings a version into the folder as `path`, saved there; null if it is there already. */
  useTake: (root: string, rev: string, from: string, path: string, variant: string) =>
    invoke<string | null>("use_take", { root, rev, from, path, variant }),
  createTag: (root: string, name: string, rev: string) => invoke<void>("create_tag", { root, name, rev }),
  deleteTag: (root: string, name: string) => invoke<void>("delete_tag", { root, name }),
  mergePreview: (root: string, rev: string) => invoke<MergePreview>("merge_preview", { root, rev }),
  merge: (root: string, rev: string, resolutions: Record<string, Resolution>) =>
    invoke<MergeOutcome>("merge", { root, rev, resolutions }),

  /** Renames or moves a file in the folder; saved, it keeps its history. */
  renameFile: (root: string, from: string, to: string) => invoke<void>("rename_file", { root, from, to }),
  restore: (root: string, path: string, rev: string, dest: string | null, force: boolean) =>
    invoke<void>("restore", { root, path, rev, dest, force }),
  previewFile: (root: string, rev: string | null, path: string) =>
    invoke<string>("preview_file", { root, rev, path }),
  watchProject: (root: string) => invoke<void>("watch_project", { root }),

  analyzeAudio: (root: string, rev: string | null, path: string) =>
    invoke<Analysis>("analyze_audio", { root, rev, path }),
  comments: (root: string, rev: string | null, path: string) =>
    invoke<Comment[]>("comments", { root, rev, path }),
  addComment: (root: string, rev: string | null, path: string, timecodeMs: number | null, text: string) =>
    invoke<number>("add_comment", { root, rev, path, timecodeMs, text }),
  resolveComment: (root: string, id: number) => invoke<void>("resolve_comment", { root, id }),
  fileMeta: (root: string, rev: string | null, path: string) => invoke<FileMeta>("file_meta", { root, rev, path }),
  setFileMeta: (root: string, rev: string, path: string, meta: FileMeta) =>
    invoke<void>("set_file_meta", { root, rev, path, meta }),
  textFile: (root: string, rev: string | null, path: string) => invoke<TextFile>("text_file", { root, rev, path }),
  fileBytes: (root: string, rev: string | null, path: string) =>
    invoke<ArrayBuffer>("file_bytes", { root, rev, path }),

  syncState: (root: string) => invoke<SyncState>("sync_state", { root }),
  setRemote: (root: string, remote: RemoteConfig, password: string | null) =>
    invoke<void>("set_remote", { root, remote, password }),
  removeRemote: (root: string) => invoke<void>("remove_remote", { root }),
  setDeviceName: (root: string, name: string) => invoke<void>("set_device_name", { root, name }),
  sync: (root: string, password: string | null, background = false) =>
    invoke<SyncReport>("sync", { root, password, background }),
  updateCurrent: (root: string) => invoke<SyncReport>("update_current", { root }),
  setAutoSync: (root: string, enabled: boolean) => invoke<void>("set_auto_sync", { root, enabled }),
  findRemoteProjects: (remote: RemoteConfig, password: string | null) =>
    invoke<string[]>("find_remote_projects", { remote, password }),
  isRemoteProject: (remote: RemoteConfig, password: string | null) =>
    invoke<boolean>("is_remote_project", { remote, password }),
  cloneProject: (remote: RemoteConfig, password: string | null, dest: string) =>
    invoke<Project>("clone_project", { remote, password, dest }),
};

export function isCommandError(e: unknown): e is CommandError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

const MESSAGES: Record<string, string> = {
  notAProject: "В этой папке нет проекта.",
  invalidName: "Недопустимое имя: нельзя использовать ~ ^ : ? * [ \\ и «..».",
  invalidPath: "Недопустимый путь к файлу.",
  overlapsProject:
    "Это уже папка проекта или папка, в которой лежит сам проект. Файлы проекта добавлять не нужно: Takes их уже видит на вкладке «Файлы».",
  invalidMeta: "Метка — до 40 символов, тональность — до 12, темп — от 20 до 400 BPM.",
  notText: "Это не текстовый файл.",
  tooLarge: "Файл слишком большой, чтобы показать его здесь.",
  branchExists: "Ветка с таким именем уже есть.",
  tagExists: "Метка с таким именем уже есть.",
  unbornBranch: "Сначала сохраните хотя бы одну версию.",
  nothingToCommit: "Нечего сохранять: изменений нет.",
  cannotDeleteCurrentBranch: "Нельзя удалить ветку, на которой вы сейчас находитесь.",
  dirtyWorktree: "Есть несохранённые изменения. Сохраните версию или отмените изменения.",
  wouldOverwrite: "Это перезапишет файлы, которых нет в сохранённой версии.",
  pathNotFound: "Файла нет в этой версии.",
  corrupt: "Данные проекта повреждены.",
  tooNew: "Проект или хранилище созданы более новой версией Takes. Обновите приложение.",
  notAudio: "Не удалось прочитать звук: формат не поддерживается или файл повреждён.",
  remoteAuth: "Хранилище не приняло логин или пароль.",
  remoteMismatch: "В этом хранилище лежит другой проект. Выберите другую папку.",
  remoteNotEmpty: "Папка не пустая и не похожа на хранилище Takes. Выберите пустую или новую папку.",
  remoteNotConfigured: "Хранилище не подключено.",
  notARemote: "Здесь нет проекта Takes.",
  folderNotEmpty: "Папка для проекта должна быть пустой или новой.",
  passwordNeeded: "Нужен пароль от хранилища.",
  keychain: "Не удалось сохранить пароль в системной связке ключей.",
  alreadySyncing: "Синхронизация уже идёт.",
  unsavedFile: "Файл изменён и не сохранён. Сохраните версию, чтобы оставлять к нему комментарии.",
  contentPruned: "Файл этой версии удалён при очистке места: его нельзя прослушать или вернуть.",
  busy: "Сейчас с проектом идёт другая операция (например, синхронизация). Попробуйте, когда она закончится.",
};

export function errorText(e: unknown): string {
  if (isCommandError(e) && e.kind === "fileBusy") {
    const names = e.paths.map((p) => `«${p.split("/").pop()}»`).join(", ");
    return `Файлы открыты в другой программе (например, в DAW) или защищены от записи: ${names}. Закройте их и повторите. Ничего не изменено.`;
  }
  if (isCommandError(e) && e.kind === "fileChanging") {
    const names = e.paths.map((p) => `«${p.split("/").pop()}»`).join(", ");
    return `Файлы ещё записываются другой программой: ${names}. Дождитесь, пока она закончит, и сохраните снова.`;
  }
  if (isCommandError(e) && e.kind === "dirtyWorktree" && e.changes.length > 0 && e.changes.length <= 3) {
    const names = e.changes.map((c) => `«${c.path.split("/").pop()}»`).join(", ");
    return `Не сохранены изменения в ${names}. Сохраните версию или отмените изменения.`;
  }
  if (isCommandError(e) && e.kind === "remote") return `Хранилище недоступно: ${e.message}`;
  if (isCommandError(e)) return MESSAGES[e.kind] ?? e.message;
  return String(e);
}
