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
};

export function errorText(e: unknown): string {
  if (isCommandError(e) && e.kind === "fileBusy") {
    const names = e.paths.map((p) => `«${p.split("/").pop()}»`).join(", ");
    return `Файлы открыты в другой программе (например, в DAW) или защищены от записи: ${names}. Закройте их и повторите. Ничего не изменено.`;
  }
  if (isCommandError(e)) return MESSAGES[e.kind] ?? e.message;
  return String(e);
}
