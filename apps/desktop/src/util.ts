import type { Snapshot, Overview } from "./api";

export const short = (id: string) => id.slice(0, 8);

export function formatSize(bytes: number): string {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} Б` : `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

const time = new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" });
const dayYear = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", year: "numeric" });
const full = new Intl.DateTimeFormat("ru", { dateStyle: "long", timeStyle: "short" });

/** "только что", "12 мин назад", "сегодня, 14:03", "вчера, 09:10", "8 окт., 14:03". */
export function formatDate(unix: number): string {
  const date = new Date(unix * 1000);
  const now = new Date();
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) return `сегодня, ${time.format(date)}`;
  if (date.getTime() >= startOfToday - 86400000) return `вчера, ${time.format(date)}`;
  const fmt = date.getFullYear() === now.getFullYear() ? day : dayYear;
  return `${fmt.format(date)}, ${time.format(date)}`;
}

export const formatFullDate = (unix: number) => full.format(new Date(unix * 1000));

/** `/home/me/Music/Album` or `C:\Users\me\Music\Album` → `~/Music/Album`. */
export const prettyPath = (path: string) =>
  path.replace(/^(?:[A-Za-z]:)?[\\/](?:home|Users)[\\/][^\\/]+/, "~");

/** Last component of a native path (`/` or `\` separated). */
export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

const AUDIO = new Set(["wav", "mp3", "flac", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "webm"]);

export function isAudio(path: string): boolean {
  const name = splitPath(path).name;
  const dot = name.lastIndexOf(".");
  return dot > 0 && AUDIO.has(name.slice(dot + 1).toLowerCase());
}

/** `dir/song.wav` → `dir/song (label).wav`. */
export function copyName(path: string, label: string): string {
  const { dir, name } = splitPath(path);
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${dir}${name.slice(0, dot)} (${label})${name.slice(dot)}`
    : `${dir}${name} (${label})`;
}

/** Russian plural: plural(3, "файл", "файла", "файлов") → "файла". */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export interface Label {
  text: string;
  kind: "branch" | "current" | "tag";
}

/** Branch and tag names attached to each version id. */
export function labelsById(overview: Overview): Map<string, Label[]> {
  const labels = new Map<string, Label[]>();
  const add = (id: string, label: Label) => labels.set(id, [...(labels.get(id) ?? []), label]);
  for (const b of overview.branches) {
    if (b.head) add(b.head, { text: b.name, kind: b.current ? "current" : "branch" });
  }
  for (const t of overview.tags) add(t.target, { text: t.name, kind: "tag" });
  return labels;
}

export const isMerge = (s: Snapshot) => s.parents.length > 1;
