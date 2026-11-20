/**
 * What the project diagram is made of besides the songs themselves (see
 * `blueprint.ts`): tiles, wires, the view, menus and the steps to take back,
 * and the small helpers the diagram's parts share.
 */
import type { ChangeKind } from "../../api";
import {
  SONG_KEY,
  SONG_W,
  branchKey,
  nodeKey,
  type Lane,
  type Layout,
  type PlacedLane,
  type Point,
  type Rect,
  type SongBranch,
  type SongLinks,
  type SongVersion,
  type WorkNode,
} from "../../blueprint";
import type { IconName } from "../../ui";
import { plural } from "../../util";

/** Shared by every device of the project: where things lie, the tiles. */
export const LAYOUT_KEY = "canvas.layout";
export const TILES_KEY = "canvas.tiles";
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 1.5;
/** A grid cell, in canvas pixels; every eighth line is a dark one. Things snap to it. */
export const GRID = 16;

export type View = { x: number; y: number; zoom: number };
export type Selection = { path: string; key: string | null; draft: boolean; n: number };
export type MenuItem = { label: string; icon: IconName; run: () => void; danger?: boolean };
export type Menu = { x: number; y: number; items: MenuItem[] };
export type Meta = { path: string; rev: string; label: string };
/** A new branch of a song: from the folder's version ("HEAD") or a given one. */
export type BranchStart = { lane: Lane; parent: string; start: string; source?: string };

/** Something on the canvas that is not a file: a note, a song to come, a frame grouping things. */
export interface Tile {
  id: string;
  kind: "note" | "song" | "frame";
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  text: string;
  /** A hue, 0–360. */
  color: number;
}

export const TILE_NEW: Record<Tile["kind"], Pick<Tile, "w" | "h" | "title" | "color">> = {
  note: { w: 256, h: 160, title: "Заметка", color: 48 },
  song: { w: SONG_W, h: 144, title: "Новая песня", color: 0 },
  frame: { w: 720, h: 400, title: "Группа", color: 210 },
};
export const TILE_MIN = { w: 160, h: 80 };
export const COLORS: [string, number][] = [
  ["Жёлтый", 48],
  ["Зелёный", 130],
  ["Голубой", 190],
  ["Синий", 225],
  ["Фиолетовый", 275],
  ["Красный", 0],
];

/** A wire on the diagram: from a node's output into a node's input. */
export interface Wire {
  from: string;
  to: string;
  /** "chain": into a version, people rewire it; "song" (into a branch) and "work" (into the file on disk) stay. */
  kind: "chain" | "song" | "work";
  cls: string;
}

/** One end of a wire: a node's pin, or "+ файл" / "+ ветка" taking a wire as an output. */
export type WireEnd = { lane: string; key: string; side: "in" | "out" };

/** A wire being pulled: a new one from a pin, or one there is by an end. */
export interface Pull {
  /** The end that stays. */
  fixed: WireEnd;
  /** The wire there is, being moved. */
  moving: Wire | null;
  /** The loose end, on the canvas. */
  at: Point;
  /** The same, in the diagram's box: the hint goes there. */
  screen: Point;
  target: WireEnd | null;
  /** What letting go there does; nothing when not `ok`. */
  hint: string;
  ok: boolean;
}

/** How things lay at a moment, to go back or forth to; `wired`: how one song was wired then. */
export interface Snapshot {
  /** When it was taken; 0 for one that never joins the next change into one step. */
  at: number;
  layout: Layout;
  tiles: Tile[];
  wired?: { lane: Lane; links: SongLinks };
}

/** Something the search found: a lane, a tile, or a version (`key`) in lane `lane`. */
export type Match = { key: string; rect: Rect; lane?: string };

/** Where a menu opens: at the cursor, or up by about its height near the bottom of the window. */
export function menuTop(menu: Menu) {
  return Math.max(8, Math.min(menu.y, window.innerHeight - menu.items.length * 36 - 20));
}

/** What plugging a wire in somewhere does. */
export type Plan = { ok: boolean; hint: string; run?: () => void };

/** What is being dragged, and how far, in canvas pixels. */
export type Drag =
  | { kind: "node"; lane: string; key: string; by: Point }
  | { kind: "lane"; lane: string; by: Point; tiles: string[] }
  | { kind: "tile"; id: string; by: Point; lanes: string[]; tiles: string[] }
  | { kind: "size"; id: string; by: Point };

export function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function saveFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // A convenience only.
  }
}

/** What lanes and tiles ask of the diagram, read when it happens so it is always current. */
export interface Actions {
  select: (path: string, key: string | null, draft?: boolean) => void;
  songMenu: (e: React.MouseEvent, lane: Lane) => void;
  versionMenu: (e: React.MouseEvent, lane: Lane, n: SongVersion) => void;
  workMenu: (e: React.MouseEvent, lane: Lane, n: WorkNode) => void;
  save: (n: WorkNode) => void;
  dragLane: (e: React.PointerEvent, lane: Lane) => void;
  dragNode: (e: React.PointerEvent, lane: Lane, key: string) => void;
  dragTile: (e: React.PointerEvent, tile: Tile) => void;
  sizeTile: (e: React.PointerEvent, tile: Tile) => void;
  selectTile: (id: string) => void;
  tileMenu: (e: React.MouseEvent, tile: Tile) => void;
  editTile: (id: string | null) => void;
  updateTile: (id: string, change: Partial<Tile>) => void;
  fillTile: (tile: Tile, source?: string) => void;
  branchMenu: (e: React.MouseEvent, lane: Lane, branch: SongBranch) => void;
  intoFolder: (lane: Lane, n: SongVersion) => void;
  /** A file (picked, or dropped as `source`) as the next version of a branch. */
  addFile: (lane: Lane, branch: string, source?: string) => void;
  /** A new branch of the song, from a file (picked, or dropped as `source`). */
  newBranch: (lane: Lane, source?: string) => void;
  /** Pulls a new wire from a pin; with Alt, unplugs the pin. */
  pullPin: (e: React.PointerEvent, lane: Lane, key: string, side: "in" | "out") => void;
  /** Pulls a wire there is by its nearer end. */
  grabWire: (e: React.PointerEvent, lane: Lane, w: Wire) => void;
  /** A double click on a wire: it breaks. */
  breakWire: (lane: Lane, w: Wire) => void;
}

/** While dragging, the pointer passing over text must not select it. */
export function noSelecting(on: boolean) {
  document.documentElement.classList.toggle("no-select", on);
  if (on) window.getSelection()?.removeAllRanges();
}

export const snap = (v: number) => Math.round(v / GRID) * GRID;
export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Where the diagram was looked at, per project, so it opens there again. */
export function loadView(root: string): View | null {
  try {
    const v = JSON.parse(localStorage.getItem(`takes.bpview:${root}`) ?? "null");
    return v && [v.x, v.y, v.zoom].every(Number.isFinite) ? v : null;
  } catch {
    return null;
  }
}

export function saveView(root: string, view: View) {
  try {
    localStorage.setItem(`takes.bpview:${root}`, JSON.stringify(view));
  } catch {
    // A convenience: the diagram fits itself without it.
  }
}

export function parseLayout(value: string | null): Layout {
  try {
    const v = JSON.parse(value ?? "null");
    if (v && typeof v === "object") return { lanes: v.lanes ?? {}, free: v.free ?? {} };
  } catch {
    // Written by a newer version, or broken: lay out anew.
  }
  return { lanes: {}, free: {} };
}

export function parseTiles(value: string | null): Tile[] {
  try {
    const list: unknown = JSON.parse(value ?? "[]");
    if (!Array.isArray(list)) return [];
    return list.filter(
      (t): t is Tile =>
        !!t &&
        typeof t.id === "string" &&
        ["note", "song", "frame"].includes(t.kind) &&
        [t.x, t.y, t.w, t.h, t.color].every(Number.isFinite) &&
        typeof t.title === "string" &&
        typeof t.text === "string",
    );
  } catch {
    return [];
  }
}

export const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
export const laneRect = (p: PlacedLane): Rect => ({ ...p.frame, x: p.origin.x + p.frame.x, y: p.origin.y + p.frame.y });

export const WORK_WORD: Record<ChangeKind, string> = {
  added: "новый файл",
  modified: "изменён",
  deleted: "удалён с диска",
  renamed: "переименован",
};

export function laneText(lane: Lane): string {
  const saved = `${lane.versions} ${plural(lane.versions, "версия", "версии", "версий")}`;
  switch (lane.status) {
    case "saved":
      return saved;
    case "modified":
      return `${saved} · изменён`;
    case "added":
      return lane.versions ? `${saved} · снова в папке` : "новый, ещё не сохранён";
    case "deleted":
      return `${saved} · удалён с диска`;
    case "renamed":
      return `${saved} · переименован`;
    case "removed":
      return `${saved} · удалён из проекта`;
    case "elsewhere":
      return `только в ${lane.branchNames.length > 1 ? "ветках" : "ветке"} ${lane.branchNames.map((b) => `«${b}»`).join(", ")}`;
  }
}

/** The lane's wires: the song to each branch, the versions on each wire, the file on disk from its version. */
export function wiresOf(lane: Lane): Wire[] {
  const byKey = new Map(lane.nodes.map((n) => [n.key, n]));
  const wires: Wire[] = lane.branches.map((b) => ({
    from: SONG_KEY,
    to: branchKey(b.name),
    kind: "song",
    cls: b.active ? "" : "elsewhere",
  }));
  for (const n of lane.nodes) {
    const row = lane.branches[n.row];
    if (n.kind === "work") {
      const from = n.parent && byKey.has(n.parent) ? n.parent : row ? branchKey(row.name) : null;
      if (from) wires.push({ from, to: nodeKey(n), kind: "work", cls: "work" });
      continue;
    }
    const from = n.links[0] ?? (n.branch ? branchKey(n.branch) : null);
    if (from)
      wires.push({
        from,
        to: n.key,
        kind: "chain",
        cls: !n.branch ? "loose" : row?.active ? "" : "elsewhere",
      });
  }
  return wires;
}
