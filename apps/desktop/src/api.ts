import { invoke } from "@tauri-apps/api/core";

export type ChangeKind = "added" | "modified" | "deleted";

export interface Change {
  path: string;
  kind: ChangeKind;
  size: number | null;
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
}

export interface FileVersion {
  snapshot: Snapshot;
  kind: ChangeKind;
  size: number | null;
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
  commit: (root: string, message: string, paths: string[]) =>
    invoke<string>("commit", { root, message, paths }),
  log: (root: string, rev: string | null) => invoke<Snapshot[]>("log", { root, rev }),
  snapshotChanges: (root: string, id: string) => invoke<Change[]>("snapshot_changes", { root, id }),
  files: (root: string, rev: string) => invoke<FileInfo[]>("files", { root, rev }),
  fileHistory: (root: string, path: string) => invoke<FileVersion[]>("file_history", { root, path }),
  stats: (root: string) => invoke<Stats>("stats", { root }),
  setAuthor: (root: string, name: string) => invoke<void>("set_author", { root, name }),

  switchBranch: (root: string, name: string) => invoke<void>("switch_branch", { root, name }),
  createBranch: (root: string, name: string, from: string | null, switchTo: boolean) =>
    invoke<void>("create_branch", { root, name, from, switchTo }),
  deleteBranch: (root: string, name: string) => invoke<void>("delete_branch", { root, name }),
  createTag: (root: string, name: string, rev: string) => invoke<void>("create_tag", { root, name, rev }),
  deleteTag: (root: string, name: string) => invoke<void>("delete_tag", { root, name }),
  mergePreview: (root: string, rev: string) => invoke<MergePreview>("merge_preview", { root, rev }),
  merge: (root: string, rev: string, resolutions: Record<string, Resolution>) =>
    invoke<MergeOutcome>("merge", { root, rev, resolutions }),

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

  syncState: (root: string) => invoke<SyncState>("sync_state", { root }),
  setRemote: (root: string, remote: RemoteConfig, password: string | null) =>
    invoke<void>("set_remote", { root, remote, password }),
  removeRemote: (root: string) => invoke<void>("remove_remote", { root }),
  setDeviceName: (root: string, name: string) => invoke<void>("set_device_name", { root, name }),
  sync: (root: string, password: string | null) => invoke<SyncReport>("sync", { root, password }),
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
  branchExists: "Ветка с таким именем уже есть.",
  tagExists: "Метка с таким именем уже есть.",
  unbornBranch: "Сначала сохраните хотя бы одну версию.",
  nothingToCommit: "Нечего сохранять: изменений нет.",
  cannotDeleteCurrentBranch: "Нельзя удалить ветку, на которой вы сейчас находитесь.",
  dirtyWorktree: "Есть несохранённые изменения. Сохраните версию или отмените изменения.",
  wouldOverwrite: "Это перезапишет файлы, которых нет в сохранённой версии.",
  pathNotFound: "Файла нет в этой версии.",
  corrupt: "Данные проекта повреждены.",
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
};

export function errorText(e: unknown): string {
  if (isCommandError(e) && e.kind === "fileBusy") {
    const names = e.paths.map((p) => `«${p.split("/").pop()}»`).join(", ");
    return `Файлы открыты в другой программе (например, в DAW) или защищены от записи: ${names}. Закройте их и повторите. Ничего не изменено.`;
  }
  if (isCommandError(e) && e.kind === "remote") return `Хранилище недоступно: ${e.message}`;
  if (isCommandError(e)) return MESSAGES[e.kind] ?? e.message;
  return String(e);
}
