import { ask, open } from "@tauri-apps/plugin-dialog";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type ChangeKind, type Overview, type RemovedFile } from "../api";
import {
  LANE_PAD,
  NEW_BRANCH_KEY,
  NODE_H,
  PIN_Y,
  SONG_KEY,
  SONG_W,
  addKey,
  branchKey,
  growing,
  laneGroup,
  nodeKey,
  nodeSize,
  placeLanes,
  previousVersion,
  songHue,
  wire,
  type Lane,
  type Layout,
  type PlacedLane,
  type Point,
  type Rect,
  type SongBranch,
  type SongVersion,
  type WorkNode,
} from "../blueprint";
import { CompareButton, PlayButton, usePlayer, type Track } from "../player";
import { Empty, FileLabels, Icon, KindBadge, PromptDialog, useToast, type IconName } from "../ui";
import { baseName, formatDate, plural, previewKind, short, splitPath } from "../util";
import { shortId } from "../blueprint";
import { FileDetail, type Drafts, type ProjectFile } from "./FilesTab";
import { FileMetaDialog } from "./FileMetaDialog";
import { SongBranchDialog } from "./SongBranchDialog";
import { SETTLE_MS, type Songs } from "../songs";
import { useFileActions } from "./useFileActions";

/** Shared by every device of the project: where things lie, the tiles. */
const LAYOUT_KEY = "canvas.layout";
const TILES_KEY = "canvas.tiles";
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.5;
/** A grid cell, in canvas pixels; every eighth line is a dark one. Things snap to it. */
const GRID = 16;

type View = { x: number; y: number; zoom: number };
type Selection = { path: string; key: string | null; draft: boolean; n: number };
type MenuItem = { label: string; icon: IconName; run: () => void; danger?: boolean };
type Menu = { x: number; y: number; items: MenuItem[] };
type Meta = { path: string; rev: string; label: string };
/** A new branch of a song: from the folder's version ("HEAD") or a given one. */
type BranchStart = { lane: Lane; parent: string; start: string; source?: string };

/** Something on the canvas that is not a file: a note, a song to come, a frame grouping things. */
interface Tile {
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

const TILE_NEW: Record<Tile["kind"], Pick<Tile, "w" | "h" | "title" | "color">> = {
  note: { w: 256, h: 160, title: "Заметка", color: 48 },
  song: { w: SONG_W, h: 144, title: "Новая песня", color: 0 },
  frame: { w: 720, h: 400, title: "Группа", color: 210 },
};
const TILE_MIN = { w: 160, h: 80 };
const COLORS: [string, number][] = [
  ["Жёлтый", 48],
  ["Зелёный", 130],
  ["Голубой", 190],
  ["Синий", 225],
  ["Фиолетовый", 275],
  ["Красный", 0],
];

/** What is being dragged, and how far, in canvas pixels. */
type Drag =
  | { kind: "node"; lane: string; key: string; by: Point; branch: string | null }
  | { kind: "lane"; lane: string; by: Point }
  | { kind: "tile"; id: string; by: Point; lanes: string[]; tiles: string[] }
  | { kind: "size"; id: string; by: Point };

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function saveFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // A convenience only.
  }
}

/** What lanes and tiles ask of the diagram, read when it happens so it is always current. */
interface Actions {
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
}

/** While dragging, the pointer passing over text must not select it. */
function noSelecting(on: boolean) {
  document.documentElement.classList.toggle("no-select", on);
  if (on) window.getSelection()?.removeAllRanges();
}

/** The dock's place for a branch not made yet. */
const NEW_BRANCH = "";

const snap = (v: number) => Math.round(v / GRID) * GRID;
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Where the diagram was looked at, per project, so it opens there again. */
function loadView(root: string): View | null {
  try {
    const v = JSON.parse(localStorage.getItem(`takes.bpview:${root}`) ?? "null");
    return v && [v.x, v.y, v.zoom].every(Number.isFinite) ? v : null;
  } catch {
    return null;
  }
}

function saveView(root: string, view: View) {
  try {
    localStorage.setItem(`takes.bpview:${root}`, JSON.stringify(view));
  } catch {
    // A convenience: the diagram fits itself without it.
  }
}

function parseLayout(value: string | null): Layout {
  try {
    const v = JSON.parse(value ?? "null");
    if (v && typeof v === "object") return { lanes: v.lanes ?? {} };
  } catch {
    // Written by a newer version, or broken: lay out anew.
  }
  return { lanes: {} };
}

function parseTiles(value: string | null): Tile[] {
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

const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
const laneRect = (p: PlacedLane): Rect => ({ ...p.frame, x: p.origin.x + p.frame.x, y: p.origin.y + p.frame.y });

const WORK_WORD: Record<ChangeKind, string> = {
  added: "новый файл",
  modified: "изменён",
  deleted: "удалён с диска",
  renamed: "переименован",
};

function laneText(lane: Lane): string {
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

/**
 * The project as a blueprint: a framed lane per song that starts with the
 * song's node and wires its versions from left to right, forks for other
 * branches and the file on disk at the end when it is not saved. Lanes,
 * nodes and tiles (notes, songs to come, frames) go wherever they are
 * dragged, for every device of the project; a version dropped on another
 * branch moves there. Everything a file allows is done right here.
 */
export function BlueprintTab({
  overview,
  songs,
  files,
  removed,
  drafts,
  refreshKey,
  onChanged,
  onLabelsChanged,
  onAddFiles,
  onOpenFile,
  onUploadVersion,
}: {
  overview: Overview;
  songs: Songs;
  files: ProjectFile[] | null;
  removed: RemovedFile[];
  drafts: Drafts;
  refreshKey: number;
  onChanged: () => void;
  onLabelsChanged: () => void;
  onAddFiles: (what: "files" | "folder") => void;
  onOpenFile: (path: string) => void;
  onUploadVersion: (path: string) => void;
}) {
  const root = overview.root;
  const toast = useToast();
  const player = usePlayer();
  const actions = useFileActions(root, onChanged);
  const [layout, setLayout] = useState<Layout>({ lanes: {} });
  /** A version just moved to another branch, shown for a moment. */
  const [flash, setFlash] = useState<string | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  /** A song's branch being renamed. */
  const [renamingBranch, setRenamingBranch] = useState<{ lane: Lane; name: string } | null>(null);
  /** A version going to a new branch of its song, waiting for the name. */
  const [naming, setNaming] = useState<{ lane: Lane; node: SongVersion } | null>(null);
  const [savedView] = useState(() => loadView(root));
  const [view, setView] = useState<View>(savedView ?? { x: 32, y: 32, zoom: 1 });
  const [selected, setSelected] = useState<Selection | null>(null);
  const [selectedTile, setSelectedTile] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [tagging, setTagging] = useState<{ rev: string; label: string } | null>(null);
  const [branching, setBranching] = useState<BranchStart | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  /** The file being renamed. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  /** Songs, branches and notes to find on the canvas. */
  const [query, setQuery] = useState("");
  const [found, setFound] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const [showMap, setShowMap] = useState(() => loadFlag("takes.bpmap", true));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [panning, setPanning] = useState(false);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const fitted = useRef(savedView !== null);
  const pan = useRef<{ x: number; y: number; origin: View; moved: boolean } | null>(null);
  /** A drag just ended: the click that follows is not a click on what was under it. */
  const suppressClick = useRef(false);
  const localEdit = useRef(0);
  const lanes = songs.lanes;

  // Another device may have moved things; a sync reloads the overview.
  useEffect(() => {
    let alive = true;
    Promise.all([api.sharedSetting(root, LAYOUT_KEY), api.sharedSetting(root, TILES_KEY)])
      .then(([layoutValue, tilesValue]) => {
        if (!alive || Date.now() - localEdit.current < SETTLE_MS) return;
        setLayout(parseLayout(layoutValue));
        setTiles(parseTiles(tilesValue));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [root, overview]);
  const visible = useMemo(
    () => lanes?.filter((l) => showRemoved || l.status !== "removed") ?? [],
    [lanes, showRemoved],
  );
  const basePlaced = useMemo(() => placeLanes(visible, layout), [visible, layout]);

  // What is being dragged follows the pointer; the rest keeps its objects, so it is not drawn again.
  const placed = useMemo(() => {
    if (!drag || drag.kind === "size") return basePlaced;
    const moved = drag.kind === "lane" ? [drag.lane] : drag.kind === "tile" ? drag.lanes : [];
    return basePlaced.map((p) => {
      if (moved.includes(p.lane.path)) {
        return { ...p, origin: { x: p.origin.x + drag.by.x, y: p.origin.y + drag.by.y } };
      }
      // A dragged version follows the pointer; its lane stays as it was.
      if (drag.kind === "node" && p.lane.path === drag.lane) {
        const at = new Map(p.at);
        const was = at.get(drag.key)!;
        at.set(drag.key, { x: was.x + drag.by.x, y: was.y + drag.by.y });
        return { ...p, at };
      }
      return p;
    });
  }, [basePlaced, drag]);

  const shownTiles = useMemo(() => {
    if (!drag || (drag.kind !== "tile" && drag.kind !== "size")) return tiles;
    return tiles.map((t) => {
      if (drag.kind === "size" && t.id === drag.id) {
        return { ...t, w: Math.max(TILE_MIN.w, t.w + drag.by.x), h: Math.max(TILE_MIN.h, t.h + drag.by.y) };
      }
      if (drag.kind === "tile" && (t.id === drag.id || drag.tiles.includes(t.id))) {
        return { ...t, x: t.x + drag.by.x, y: t.y + drag.by.y };
      }
      return t;
    });
  }, [tiles, drag]);

  const fileByPath = useMemo(() => new Map((files ?? []).map((f) => [f.path, f])), [files]);

  // What the search finds: songs by any of their names or branches, tiles by their text.
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return null;
    const lanesFound = basePlaced
      .filter((p) => [...p.lane.names, ...p.lane.branches.map((b) => b.name)].some((n) => n.toLowerCase().includes(q)))
      .map((p) => ({ key: p.lane.path, rect: laneRect(p) }));
    const tilesFound = tiles
      .filter((t) => `${t.title} ${t.text}`.toLowerCase().includes(q))
      .map((t) => ({ key: t.id, rect: t as Rect }));
    return [...lanesFound, ...tilesFound].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  }, [q, basePlaced, tiles]);
  const matched = useMemo(() => (matches ? new Set(matches.map((m) => m.key)) : null), [matches]);
  const tagsOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of overview.tags) map.set(t.target, [...(map.get(t.target) ?? []), t.name]);
    return map;
  }, [overview.tags]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => !(e.target as Element | null)?.closest?.(".bp-menu") && setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const select = useCallback((path: string, key: string | null, draft = false) => {
    setSelectedTile(null);
    setSelected((s) => ({ path, key, draft, n: (s?.n ?? 0) + 1 }));
  }, []);

  // ---- view: fit, pan, zoom -----------------------------------------------------

  /** Everything there is, from the lanes and the tiles. */
  const bounds = useCallback((): Rect | null => {
    const rects = [...basePlaced.map(laneRect), ...tiles];
    if (!rects.length) return null;
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    return {
      x,
      y,
      w: Math.max(...rects.map((r) => r.x + r.w)) - x,
      h: Math.max(...rects.map((r) => r.y + r.h)) - y,
    };
  }, [basePlaced, tiles]);

  /** Everything in sight, or its top left when that would be too small to read. */
  const fit = useCallback(() => {
    const b = bounds();
    if (!box || !b) return;
    const { width, height } = box.getBoundingClientRect();
    const m = 32;
    const whole = Math.min(1, (width - m * 2) / b.w, (height - m * 2) / b.h);
    const zoom = whole >= 0.6 ? whole : Math.min(1, Math.max(0.85, (width - m * 2) / b.w));
    setView({
      zoom,
      x: whole >= 0.6 ? (width - b.w * zoom) / 2 - b.x * zoom : m - b.x * zoom,
      y: whole >= 0.6 ? Math.min(m * 2, (height - b.h * zoom) / 2) - b.y * zoom : m - b.y * zoom,
    });
  }, [box, bounds]);

  // The first look: where it was left, unless nothing would be in sight.
  useLayoutEffect(() => {
    const b = bounds();
    if (!box || !b) return;
    if (fitted.current) {
      const { width, height } = box.getBoundingClientRect();
      const left = view.x + b.x * view.zoom;
      const top = view.y + b.y * view.zoom;
      const right = left + b.w * view.zoom;
      const bottom = top + b.h * view.zoom;
      if (right > 40 && bottom > 40 && left < width - 40 && top < height - 40) return;
    }
    fitted.current = true;
    fit();
    // Only once, when there is something to show.
  }, [box, basePlaced.length + tiles.length > 0]);

  useEffect(() => {
    const t = setTimeout(() => saveView(root, view), 400);
    return () => clearTimeout(t);
  }, [root, view]);

  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!box) return;
    const observer = new ResizeObserver(() => setSize({ w: box.clientWidth, h: box.clientHeight }));
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      return { zoom, x: cx - ((cx - v.x) * zoom) / v.zoom, y: cy - ((cy - v.y) * zoom) / v.zoom };
    });
  }, []);
  const zoomBy = useCallback(
    (factor: number) => box && zoomAt(box.clientWidth / 2, box.clientHeight / 2, factor),
    [box, zoomAt],
  );

  /** Brings a place on the canvas into sight: centred, or its start when it is too wide. */
  const focusRect = useCallback(
    (rect: Rect) => {
      if (!box) return;
      const { clientWidth: w, clientHeight: h } = box;
      setView((v) => ({
        ...v,
        x: rect.w * v.zoom > w - 80 ? 40 - rect.x * v.zoom : w / 2 - (rect.x + rect.w / 2) * v.zoom,
        y: rect.h * v.zoom > h - 80 ? 40 - rect.y * v.zoom : h / 2 - (rect.y + rect.h / 2) * v.zoom,
      }));
    },
    [box],
  );

  function findNext(step: 1 | -1) {
    if (!matches?.length) return;
    const next = (found + step + matches.length) % matches.length;
    setFound(next);
    focusRect(matches[next].rect);
  }

  /** A point on the screen, on the canvas. */
  const toCanvas = useCallback(
    (clientX: number, clientY: number): Point => {
      const r = box?.getBoundingClientRect() ?? { left: 0, top: 0 };
      return { x: (clientX - r.left - view.x) / view.zoom, y: (clientY - r.top - view.y) / view.zoom };
    },
    [box, view],
  );

  // The wheel scrolls (with Shift, sideways); Ctrl + wheel or a pinch zooms.
  useEffect(() => {
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      const area = (e.target as HTMLElement).closest("textarea");
      if (area && area.scrollHeight > area.clientHeight && !e.ctrlKey) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.clientHeight : 1;
      if (e.ctrlKey) {
        const r = box.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * 0.002));
      } else {
        const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
        const dy = e.shiftKey ? 0 : e.deltaY * unit;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [box, zoomAt]);

  function onPointerDown(e: React.PointerEvent) {
    suppressClick.current = false;
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, select, a")) return;
    // The middle button pans too, instead of scrolling by itself.
    if (e.button === 1) e.preventDefault();
    pan.current = { x: e.clientX, y: e.clientY, origin: view, moved: false };
  }

  function onPointerMove(e: React.PointerEvent) {
    const p = pan.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved) {
      // Capture only once it is a drag, so clicks still reach what was clicked.
      if (Math.abs(dx) + Math.abs(dy) <= 4) return;
      p.moved = true;
      suppressClick.current = true;
      noSelecting(true);
      setPanning(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setView({ ...p.origin, x: p.origin.x + dx, y: p.origin.y + dy });
  }

  function onPointerUp(e: React.PointerEvent) {
    const p = pan.current;
    pan.current = null;
    if (p?.moved) noSelecting(false);
    setPanning(false);
    // A click on the empty canvas lets go of what was selected.
    if (p && !p.moved && !(e.target as HTMLElement).closest(".bp-node, .bp-lane-title, .bp-group-title")) {
      setSelected(null);
      setSelectedTile(null);
    }
  }

  // ---- saving where things lie --------------------------------------------------

  function saveSetting(key: string, value: unknown) {
    localEdit.current = Date.now();
    api.setSharedSetting(root, key, JSON.stringify(value)).catch((e) => toast(errorText(e), "error"));
  }

  /** The layout and tiles as last changed, also by a change not drawn yet. */
  const layoutNow = useRef(layout);
  layoutNow.current = layout;
  const tilesNow = useRef(tiles);
  tilesNow.current = tiles;

  function putLayout(next: Layout) {
    setLayout(next);
    layoutNow.current = next;
    saveSetting(LAYOUT_KEY, next);
  }

  function putTiles(next: Tile[]) {
    setTiles(next);
    tilesNow.current = next;
    saveSetting(TILES_KEY, next);
  }

  /** What Ctrl+Z takes back, newest last. */
  const undo = useRef<{ at: number; back: () => void }[]>([]);

  /**
   * Remembers how things lie before a change, so Ctrl+Z can bring it back;
   * `also` undoes what else the change does. Changes made together (within
   * a moment) are one step.
   */
  function remember(also?: () => void) {
    const last = undo.current[undo.current.length - 1];
    if (!also && last && Date.now() - last.at < 300) return;
    const layoutBefore = layoutNow.current;
    const tilesBefore = tilesNow.current;
    undo.current.push({
      at: Date.now(),
      back: () => {
        also?.();
        putLayout(layoutBefore);
        putTiles(tilesBefore);
      },
    });
    if (undo.current.length > 50) undo.current.shift();
  }

  function saveLayout(next: Layout) {
    remember();
    putLayout(next);
  }

  function saveTiles(next: Tile[]) {
    remember();
    putTiles(next);
  }

  /** The layout with every lane fixed where it is now: once arranged by hand, songs stay put. */
  function pinAll(move?: { lanes: string[]; by: Point }): Layout {
    const lanes: Layout["lanes"] = {};
    for (const p of basePlaced) {
      const by = move?.lanes.includes(p.lane.path) ? move.by : { x: 0, y: 0 };
      lanes[p.lane.path] = [snap(p.origin.x + by.x), snap(p.origin.y + by.y)];
    }
    // Songs not shown now (removed ones) keep their places.
    for (const [path, at] of Object.entries(layout.lanes)) {
      if (!basePlaced.some((p) => p.lane.names.includes(path))) lanes[path] = at;
    }
    return { lanes };
  }

  /** Back to songs one under another in order of where they are now; tiles stay. */
  async function arrange() {
    const ok = await ask("Разложить песни заново, одну под другой? Заметки, заготовки и рамки останутся на местах.", {
      title: "Упорядочить песни",
      okLabel: "Упорядочить",
      cancelLabel: "Отмена",
    });
    if (!ok) return;
    const sorted = [...basePlaced].sort((a, b) => a.origin.y - b.origin.y || a.origin.x - b.origin.x);
    const paths = sorted.map((p) => p.lane.path);
    songs.setOrder([...paths, ...songs.order.filter((p) => !paths.includes(p))]);
    saveLayout({ lanes: {} });
    fitted.current = false;
    requestAnimationFrame(() => fit());
  }

  const finish = useRef<(d: Drag) => void>(() => {});
  finish.current = (d: Drag) => {
    if (d.kind === "node") {
      const p = basePlaced.find((x) => x.lane.path === d.lane);
      if (!p) return;
      // Dropped on a band: the version goes to that branch; anywhere else it goes back.
      const n = p.lane.nodes.find((x) => nodeKey(x) === d.key);
      if (d.branch === null || n?.kind !== "version") return;
      if (d.branch === NEW_BRANCH) setNaming({ lane: p.lane, node: n });
      else moveToBranch(p.lane, n, d.branch);
    } else if (d.kind === "lane") {
      saveLayout(pinAll({ lanes: [d.lane], by: d.by }));
    } else if (d.kind === "tile") {
      const ids = [d.id, ...d.tiles];
      saveTiles(tiles.map((t) => (ids.includes(t.id) ? { ...t, x: snap(t.x + d.by.x), y: snap(t.y + d.by.y) } : t)));
      if (d.lanes.length) saveLayout(pinAll({ lanes: d.lanes, by: d.by }));
    } else {
      saveTiles(
        tiles.map((t) =>
          t.id === d.id
            ? { ...t, w: Math.max(TILE_MIN.w, snap(t.w + d.by.x)), h: Math.max(TILE_MIN.h, snap(t.h + d.by.y)) }
            : t,
        ),
      );
    }
  };

  /** Drags something on the canvas; a press without moving stays a click. */
  function beginDrag(e: React.PointerEvent, make: (by: Point, ev: PointerEvent) => Drag) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, textarea, select, a")) return;
    e.stopPropagation();
    suppressClick.current = false;
    const start = { x: e.clientX, y: e.clientY };
    const zoom = view.zoom;
    let last: Drag | null = null;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!last && Math.abs(dx) + Math.abs(dy) <= 4) return;
      if (!last) noSelecting(true);
      suppressClick.current = true;
      last = make({ x: dx / zoom, y: dy / zoom }, ev);
      setDrag(last);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      noSelecting(false);
      setDrag(null);
      if (last) finish.current(last);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /** A version is dragged onto a band of its song: another branch, or a new one. */
  function dragNode(e: React.PointerEvent, lane: Lane, key: string) {
    const n = lane.nodes.find((x) => nodeKey(x) === key);
    if (n?.kind !== "version" || n.change === "deleted" || !growing(lane)) return;
    beginDrag(e, (by, ev) => {
      const band = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>(`[data-band][data-lane="${CSS.escape(lane.path)}"]`);
      const branch = band ? (band.dataset.band ?? null) : null;
      return { kind: "node", lane: lane.path, key, by, branch: branch === n.branch ? null : branch };
    });
  }

  function dragLane(e: React.PointerEvent, lane: Lane) {
    beginDrag(e, (by) => ({ kind: "lane", lane: lane.path, by }));
  }

  function dragTile(e: React.PointerEvent, tile: Tile) {
    // A frame takes along what lies inside it.
    const lanesIn = tile.kind === "frame" ? basePlaced.filter((p) => inside(laneRect(p), tile)).map((p) => p.lane.path) : [];
    const tilesIn =
      tile.kind === "frame" ? tiles.filter((t) => t.id !== tile.id && inside(t, tile)).map((t) => t.id) : [];
    setSelectedTile(tile.id);
    beginDrag(e, (by) => ({ kind: "tile", id: tile.id, by, lanes: lanesIn, tiles: tilesIn }));
  }

  function sizeTile(e: React.PointerEvent, tile: Tile) {
    beginDrag(e, (by) => ({ kind: "size", id: tile.id, by }));
  }

  // ---- tiles --------------------------------------------------------------------

  function addTile(kind: Tile["kind"], at: Point) {
    const tile: Tile = { id: newId(), kind, x: snap(at.x), y: snap(at.y), text: "", ...TILE_NEW[kind] };
    // A frame goes under what is there; the rest on top.
    saveTiles(kind === "frame" ? [tile, ...tiles] : [...tiles, tile]);
    setSelectedTile(tile.id);
    setEditing(tile.id);
  }

  function updateTile(id: string, change: Partial<Tile>) {
    saveTiles(tilesNow.current.map((t) => (t.id === id ? { ...t, ...change } : t)));
  }

  async function removeTile(tile: Tile) {
    if (tile.text.trim()) {
      const ok = await ask(`Удалить «${tile.title}» вместе с текстом?`, {
        title: "Удалить с полотна",
        kind: "warning",
        okLabel: "Удалить",
        cancelLabel: "Отмена",
      });
      if (!ok) return;
    }
    saveTiles(tilesNow.current.filter((t) => t.id !== tile.id));
    setSelectedTile(null);
  }

  /** A song to come gets its file: it becomes a song of the project, where the tile was. */
  async function fillTile(tile: Tile, source?: string) {
    const file = source ?? (await open({ multiple: false, title: `Файл для «${tile.title}»` }));
    if (typeof file !== "string") return;
    try {
      const result = await api.importFiles(root, [file], { save: true, message: tile.title.trim() || null });
      const path = result.paths[0];
      if (!path) return;
      const next = pinAll();
      next.lanes[path] = [tile.x, tile.y];
      saveLayout(next);
      // Its notes stay, as a note just above.
      const rest = tilesNow.current.filter((t) => t.id !== tile.id);
      saveTiles(
        tile.text.trim()
          ? [...rest, { ...tile, ...TILE_NEW.note, id: newId(), kind: "note", title: tile.title, y: tile.y - 176 }]
          : rest,
      );
      toast(`«${baseName(path)}» добавлен в проект`, "ok");
      onChanged();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  // Delete removes the selected tile.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" || !selectedTile || editing) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      const tile = tiles.find((t) => t.id === selectedTile);
      if (tile) removeTile(tile);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // F shows everything, + and − zoom, 0 returns to 100%, Ctrl+F finds, Ctrl+Z takes back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ" && !e.shiftKey) {
        if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
        if (document.querySelector(".modal-backdrop")) return;
        const step = undo.current.pop();
        e.preventDefault();
        if (step) {
          step.back();
          toast("Отменено", "info");
        } else {
          toast("Отменять нечего", "info");
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyF" && !document.querySelector(".modal-backdrop")) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || !box) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      if (document.querySelector(".modal-backdrop")) return;
      if (e.code === "KeyF" || e.code === "Home") fit();
      else if (e.key === "+" || e.key === "=") zoomBy(1.2);
      else if (e.key === "-") zoomBy(1 / 1.2);
      else if (e.key === "0") zoomBy(1 / view.zoom);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [box, fit, zoomBy, view.zoom]);

  // ---- actions ------------------------------------------------------------------

  const versionTrack = (n: SongVersion): Track => ({
    root,
    rev: n.version.id,
    path: n.path,
    label: `v${n.number} · ${n.version.message || short(n.version.id)}`,
  });
  const nowTrack = (path: string): Track => ({ root, rev: null, path, label: "Сейчас на диске (не сохранено)" });

  /** A version goes to another branch of its song: only where it is drawn changes. */
  function moveToBranch(lane: Lane, n: SongVersion, to: string) {
    if (n.branch === to) return;
    const before = { ...lane.branchOf };
    remember(() => songs.sortInto(lane, before));
    songs.sortInto(lane, { [shortId(n.version.id)]: to });
    setFlash(n.key);
    setTimeout(() => setFlash((f) => (f === n.key ? null : f)), 1600);
    toast(`Версия ${n.number ?? ""} «${splitPath(lane.path).name}» теперь в ветке «${to}»`, "ok");
  }

  async function quickSave(w: WorkNode) {
    const name = splitPath(w.path).name;
    try {
      const [id] = await api.commit(root, [w.path], { [w.path]: drafts.get(w.path) });
      drafts.set(w.path, "");
      toast(
        w.status === "deleted" ? `Удаление «${name}» сохранено` : `Версия ${short(id)} «${name}» сохранена`,
        "ok",
      );
      onChanged();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  async function rename(from: string, to: string) {
    await api.renameFile(root, from, to);
    const draft = drafts.get(from);
    if (draft) {
      drafts.set(to, draft);
      drafts.set(from, "");
    }
    if (selected?.path === from) select(to, null);
    onChanged();
  }

  function reveal(path: string) {
    api.reveal(`${root}/${path}`).catch((e) => toast(errorText(e), "error"));
  }

  function openMenu(e: React.MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function versionMenu(lane: Lane, n: SongVersion): MenuItem[] {
    const items: MenuItem[] = [];
    const usable = n.change !== "deleted" && !n.pruned;
    const kind = previewKind(n.path);
    const prev = previousVersion(lane, n);
    if (usable && kind) {
      items.push({ label: kind === "audio" ? "Слушать" : "Открыть", icon: "play", run: () => player.open([versionTrack(n)]) });
      if (prev && !prev.pruned) {
        items.push({
          label: `Сравнить с v${prev.number}`,
          icon: "wave",
          run: () => player.open([versionTrack(prev), versionTrack(n)]),
        });
      }
    }
    if (usable) {
      items.push(
        // Under the song's current name, even if it was called otherwise then.
        ...(n.inFolder
          ? []
          : [
              {
                label: `Положить в папку (ветка «${n.branch}»)`,
                icon: "restore" as const,
                run: () => songs.intoFolder(lane, n),
              },
            ]),
        {
          label: "Положить копию рядом",
          icon: "copy",
          run: () => actions.saveCopy(lane.path, n.version.id, `v${n.number}`, n.path),
        },
        {
          label: "Метки, темп, тональность…",
          icon: "label",
          run: () => setMeta({ path: n.path, rev: n.version.id, label: `v${n.number} · ${n.version.message || "без описания"}` }),
        },
      );
    }
    const branch = lane.branches.find((b) => b.name === n.branch);
    if (usable && branch && branch.head === n.key && !branch.active) {
      items.push({
        label: `Новая версия в ветку «${n.branch}»…`,
        icon: "download",
        run: () => songs.addFile(lane, n.branch),
      });
    }
    if (n.change !== "deleted") {
      for (const b of lane.branches.filter((b) => b.name !== n.branch)) {
        items.push({ label: `Перенести в ветку «${b.name}»`, icon: "branch", run: () => moveToBranch(lane, n, b.name) });
      }
      items.push({ label: "Перенести в новую ветку…", icon: "branch", run: () => setNaming({ lane, node: n }) });
    }
    if (usable) {
      items.push({
        label: "Новая ветка от этой версии…",
        icon: "plus",
        run: () => setBranching({ lane, parent: n.version.id, start: `версии ${n.number}` }),
      });
    }
    items.push({
      label: "Отметить версию…",
      icon: "tag",
      run: () => setTagging({ rev: n.version.id, label: `версии ${short(n.version.id)}` }),
    });
    items.push({ label: "Открыть во вкладке «Файлы»", icon: "doc", run: () => onOpenFile(n.path) });
    return items;
  }

  function workMenu(lane: Lane, w: WorkNode): MenuItem[] {
    const prev = previousVersion(lane, w);
    const kind = previewKind(w.path);
    const items: MenuItem[] = [
      { label: "Описать и сохранить…", icon: "check", run: () => select(lane.path, w.key, true) },
    ];
    if (w.status !== "deleted" && kind) {
      items.push({ label: kind === "audio" ? "Слушать" : "Открыть", icon: "play", run: () => player.open([nowTrack(w.path)]) });
      if (w.status === "modified" && prev && !prev.pruned) {
        items.push({
          label: `Сравнить с v${prev.number}`,
          icon: "wave",
          run: () => player.open([versionTrack(prev), nowTrack(w.path)]),
        });
      }
    }
    if (w.status === "modified") items.push({ label: "Отменить изменения", icon: "undo", run: () => actions.discard(w.path) });
    if (w.status === "deleted") items.push({ label: "Вернуть файл", icon: "restore", run: () => actions.restore(w.path, "HEAD") });
    const oldName = fileByPath.get(w.path)?.from;
    if (w.status === "renamed" && oldName) {
      items.push({
        label: "Вернуть старое имя",
        icon: "undo",
        run: () => rename(w.path, oldName).catch((e) => toast(errorText(e), "error")),
      });
    }
    if (w.status !== "deleted") items.push({ label: "Показать в папке", icon: "folder", run: () => reveal(w.path) });
    return items;
  }

  function branchMenu(lane: Lane, b: SongBranch): MenuItem[] {
    const head = lane.nodes.find((n): n is SongVersion => n.kind === "version" && n.key === b.head);
    const usable = head && head.change !== "deleted" && !head.pruned;
    const activeHead = lane.nodes.find(
      (n): n is SongVersion => n.kind === "version" && n.key === lane.branches.find((x) => x.active)?.head,
    );
    const items: MenuItem[] = [];
    if (usable && !b.active && growing(lane)) {
      items.push({ label: "Положить в папку", icon: "restore", run: () => songs.intoFolder(lane, head) });
    }
    if (usable && !b.active && activeHead && previewKind(lane.path)) {
      items.push({
        label: "Сравнить с веткой в папке",
        icon: "wave",
        run: () => player.open([versionTrack(activeHead), versionTrack(head)]),
      });
    }
    if (growing(lane)) {
      items.push({ label: "Новая версия в ветку…", icon: "download", run: () => songs.addFile(lane, b.name) });
    }
    items.push({ label: "Переименовать ветку…", icon: "edit", run: () => setRenamingBranch({ lane, name: b.name }) });
    for (const o of lane.branches.filter((o) => o.name !== b.name)) {
      items.push({
        label: `Перенести все версии в «${o.name}»`,
        icon: "merge",
        run: () => {
          const before = { ...lane.branchOf };
          remember(() => songs.sortInto(lane, before));
          songs.joinBranch(lane, b.name, o.name);
        },
      });
    }
    return items;
  }

  function laneMenu(lane: Lane): MenuItem[] {
    const items: MenuItem[] = [];
    if (lane.status !== "elsewhere") {
      items.push({ label: "Открыть во вкладке «Файлы»", icon: "doc", run: () => onOpenFile(lane.path) });
    }
    if (lane.status === "removed") {
      const gone = removed.find((r) => r.path === lane.path);
      if (gone) items.push({ label: "Вернуть в проект", icon: "restore", run: () => actions.restore(lane.path, gone.last) });
    } else if (lane.status !== "elsewhere") {
      items.push(
        { label: "Загрузить новую версию…", icon: "download", run: () => onUploadVersion(lane.path) },
        {
          label: "Новая ветка из файла…",
          icon: "branch",
          run: () => setBranching({ lane, parent: "HEAD", start: "версии, которая сейчас в папке" }),
        },
      );
    }
    if (lane.status !== "deleted" && lane.status !== "removed" && lane.status !== "elsewhere") {
      items.push(
        { label: "Переименовать…", icon: "edit", run: () => setRenaming(lane.path) },
        { label: "Показать в папке", icon: "folder", run: () => reveal(lane.path) },
      );
    }
    return items;
  }

  function tileMenu(tile: Tile): MenuItem[] {
    const items: MenuItem[] = [];
    if (tile.kind === "song") items.push({ label: "Выбрать файл…", icon: "folder", run: () => fillTile(tile) });
    items.push({ label: "Изменить", icon: "edit", run: () => setEditing(tile.id) });
    for (const [name, hue] of COLORS) {
      if (hue !== tile.color) items.push({ label: `Цвет: ${name.toLowerCase()}`, icon: "label", run: () => updateTile(tile.id, { color: hue }) });
    }
    items.push({ label: "Удалить", icon: "trash", run: () => removeTile(tile), danger: true });
    return items;
  }

  function canvasMenu(at: Point): MenuItem[] {
    const items: MenuItem[] = [
      { label: "Заметка", icon: "comment", run: () => addTile("note", at) },
      { label: "Заготовка песни", icon: "wave", run: () => addTile("song", at) },
      { label: "Рамка для группы", icon: "archive", run: () => addTile("frame", at) },
      { label: "Добавить песни (файлы)…", icon: "plus", run: () => onAddFiles("files") },
      { label: "Добавить папку…", icon: "folder", run: () => onAddFiles("folder") },
    ];
    items.push({ label: "Показать всё", icon: "wave", run: fit });
    if (Object.keys(layout.lanes).length) items.push({ label: "Упорядочить песни…", icon: "grip", run: arrange });
    return items;
  }

  const act = useRef<Actions>(null!);
  act.current = {
    select,
    songMenu: (e, lane) => openMenu(e, laneMenu(lane)),
    versionMenu: (e, lane, n) => openMenu(e, versionMenu(lane, n)),
    workMenu: (e, lane, n) => openMenu(e, workMenu(lane, n)),
    save: quickSave,
    dragLane,
    dragNode,
    dragTile,
    sizeTile,
    selectTile: (id) => {
      setSelected(null);
      setSelectedTile(id);
    },
    tileMenu: (e, tile) => {
      setSelectedTile(tile.id);
      openMenu(e, tileMenu(tile));
    },
    editTile: setEditing,
    updateTile,
    fillTile,
    branchMenu: (e, lane, b) => openMenu(e, branchMenu(lane, b)),
    intoFolder: songs.intoFolder,
    addFile: songs.addFile,
    newBranch: (lane, source) =>
      setBranching({ lane, parent: "HEAD", start: "версии, которая сейчас в папке", source }),
  };

  // ---- drawing ------------------------------------------------------------------

  if (songs.error) return <div className="center error-text">{songs.error}</div>;
  if (!lanes) return <div className="center muted">Строю схему…</div>;

  const songCount = lanes.filter((l) => laneGroup(l) === 0).length;
  const unsaved = lanes.filter((l) => l.nodes.some((n) => n.kind === "work")).length;
  const removedCount = lanes.length - lanes.filter((l) => l.status !== "removed").length;
  const empty = lanes.length === 0 && tiles.length === 0;

  const panelLane = selected ? lanes.find((l) => l.path === selected.path) : undefined;
  const panelNode = panelLane && selected?.key ? panelLane.nodes.find((n) => n.key === selected.key) : undefined;
  const panelVersion = panelNode?.kind === "version" ? panelNode : null;
  const newestVersion = panelLane
    ? [...panelLane.nodes].reverse().find((n): n is SongVersion => n.kind === "version")
    : undefined;

  // Large cells in dark lines, small ones in faint light lines; the small
  // ones go when zoomed out too far to tell them apart.
  const cell = GRID * view.zoom;
  const minor = cell < 6 ? cell * 8 : cell;
  const gridStyle = {
    backgroundSize: `${cell * 8}px ${cell * 8}px, ${cell * 8}px ${cell * 8}px, ${minor}px ${minor}px, ${minor}px ${minor}px`,
    backgroundPosition: `${view.x}px ${view.y}px`,
  };

  return (
    <div className="bp-wrap">
      <div className="bp-main">
        <div className="bp-toolbar">
          <span className="muted">
            {songCount} {plural(songCount, "песня", "песни", "песен")}
            {unsaved > 0 && ` · не сохранено: ${unsaved}`}
          </span>
          {removedCount > 0 && (
            <button
              className={`chip ${showRemoved ? "chip-on" : ""}`}
              onClick={() => setShowRemoved((s) => !s)}
              title="Показать песни, удалённые из проекта"
            >
              удалённые · {removedCount}
            </button>
          )}
          <div className={`bp-search ${q && matches?.length === 0 ? "none" : ""}`}>
            <input
              ref={search}
              value={query}
              placeholder="Найти песню, ветку, заметку"
              title="Ctrl+F · Enter — следующая, Shift+Enter — предыдущая, Esc — сбросить"
              onChange={(e) => {
                setQuery(e.target.value);
                setFound(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") findNext(e.shiftKey ? -1 : 1);
                else if (e.key === "Escape") {
                  setQuery("");
                  e.currentTarget.blur();
                }
              }}
            />
            {q && (
              <span className="muted nowrap">
                {matches?.length ? `${Math.max(found, 0) + 1}/${matches.length}` : "нет"}
              </span>
            )}
          </div>
          <span className="grow" />
          <span className="bp-legend muted">
            <i className="bp-sw sw-song" /> песня
            <i className="bp-sw sw-version" /> версия
            <i className="bp-sw sw-other" /> другая ветка
            <i className="bp-sw sw-work" /> не сохранено
          </span>
          <button
            className="btn btn-small"
            onClick={(e) => {
              const r = box?.getBoundingClientRect();
              const at = r ? toCanvas(r.left + r.width / 2 - 120, r.top + r.height / 2 - 80) : { x: 0, y: 0 };
              openMenu(e, [
                { label: "Заметка", icon: "comment", run: () => addTile("note", at) },
                { label: "Заготовка песни", icon: "wave", run: () => addTile("song", at) },
                { label: "Рамка для группы", icon: "archive", run: () => addTile("frame", at) },
              ]);
            }}
            title="Заметка, заготовка песни или рамка — в середину полотна. Или правой кнопкой там, где нужно"
          >
            <Icon name="plus" size={14} /> Тайл
          </button>
          {Object.keys(layout.lanes).length > 0 && (
            <button className="btn btn-small" onClick={arrange} title="Разложить песни заново, одну под другой">
              Упорядочить
            </button>
          )}
          <button className="btn btn-small" onClick={fit} title="Показать всю схему (F)">
            Показать всё
          </button>
          <button
            className={`chip ${showMap ? "chip-on" : ""}`}
            onClick={() => {
              saveFlag("takes.bpmap", !showMap);
              setShowMap(!showMap);
            }}
            title="Мини-карта полотна"
          >
            карта
          </button>
          <span
            className="bp-help"
            title={
              "Красный заголовок — песня, синий — версия, серый — версия не из папки, оранжевый — файл не сохранён\n" +
              "Тащите полотно мышью (или средней кнопкой)\n" +
              "Колесо — прокрутка, Shift + колесо — вбок\n" +
              "Ctrl + колесо — масштаб, 0 — 100%, F — показать всё, Ctrl+F — найти, Ctrl+Z — отменить\n" +
              "Узлы, заголовки песен, заметки и рамки тащатся куда угодно\n" +
              "Версию можно бросить на другую ветку — она перенесётся туда\n" +
              "Правая кнопка — действия, на пустом месте — новые тайлы"
            }
          >
            ?
          </span>
          <div className="bp-zoom" title="Масштаб: Ctrl + колесо мыши">
            <button className="icon-btn" onClick={() => zoomBy(1 / 1.2)} aria-label="Мельче">
              <Icon name="minus" size={14} />
            </button>
            <button className="bp-zoom-value" onClick={() => zoomBy(1 / view.zoom)} title="Вернуть 100% (0)">
              {Math.round(view.zoom * 100)}%
            </button>
            <button className="icon-btn" onClick={() => zoomBy(1.2)} aria-label="Крупнее">
              <Icon name="plus" size={14} />
            </button>
          </div>
        </div>

        <div
          ref={setBox}
          className={`bp ${panning ? "panning" : ""} ${drag ? "dragging" : ""}`}
          style={gridStyle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            pan.current = null;
            noSelecting(false);
            setPanning(false);
          }}
          onClickCapture={(e) => {
            if (suppressClick.current) {
              suppressClick.current = false;
              e.stopPropagation();
            }
          }}
          onContextMenu={(e) => openMenu(e, canvasMenu(toCanvas(e.clientX, e.clientY)))}
        >
          <div
            className="bp-layer"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
              ["--tscale" as string]: Math.min(3, Math.max(1, 0.55 / view.zoom)),
            }}
          >
            {shownTiles
              .filter((t) => t.kind === "frame")
              .map((t) => (
                <TileView
                  key={t.id}
                  tile={t}
                  selected={selectedTile === t.id}
                  editing={editing === t.id}
                  dim={!!matched && !matched.has(t.id)}
                  act={act}
                />
              ))}
            {placed.map((p) => (
              <LaneView
                key={p.lane.path}
                root={root}
                placed={p}
                file={fileByPath.get(p.lane.path)}
                draft={drafts.get(p.lane.path)}
                tagsOf={tagsOf}
                selectedKey={selected?.path === p.lane.path ? (selected.key ?? "") : null}
                dim={!!matched && !matched.has(p.lane.path)}
                target={drag?.kind === "node" && drag.lane === p.lane.path ? drag.branch : null}
                flash={flash}
                dragging={
                  drag?.kind === "node" && drag.lane === p.lane.path
                    ? drag.key
                    : drag?.kind === "lane" && drag.lane === p.lane.path
                      ? ""
                      : null
                }
                act={act}
              />
            ))}
            {shownTiles
              .filter((t) => t.kind !== "frame")
              .map((t) => (
                <TileView
                  key={t.id}
                  tile={t}
                  selected={selectedTile === t.id}
                  editing={editing === t.id}
                  dim={!!matched && !matched.has(t.id)}
                  act={act}
                />
              ))}
          </div>

          {empty && (
            <div className="bp-empty">
              <Empty icon="wave" title="Здесь появится схема проекта">
                У каждой песни будет своя дорожка: узел песни, от него проводами — её версии, ответвления для других
                веток и то, что сейчас лежит в папке. Правой кнопкой по полотну — заметки, заготовки песен и рамки.
                <div className="empty-actions">
                  <button className="btn btn-primary" onClick={() => onAddFiles("files")}>
                    <Icon name="plus" /> Добавить файлы
                  </button>
                </div>
              </Empty>
            </div>
          )}

          <div className={`bp-watermark ${showMap ? "beside-map" : ""}`}>СХЕМА</div>
          {showMap && !empty && (
            <Minimap
              rects={[
                ...shownTiles.map((t) => ({ ...(t as Rect), hue: t.color, frame: t.kind === "frame" })),
                ...placed.map((p) => ({ ...laneRect(p), hue: songHue(p.lane.path), frame: true })),
              ]}
              view={view}
              size={size}
              onCenter={(x, y) => setView((v) => ({ ...v, x: size.w / 2 - x * v.zoom, y: size.h / 2 - y * v.zoom }))}
            />
          )}
        </div>
      </div>

      {menu && (
        <div
          className="popover bp-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 276),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - menu.items.length * 36 - 20)),
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.items.map((item) => (
            <button
              key={item.label}
              className={`popover-main ${item.danger ? "danger-text" : ""}`}
              onClick={() => {
                setMenu(null);
                item.run();
              }}
            >
              <Icon name={item.icon} size={14} /> {item.label}
            </button>
          ))}
        </div>
      )}

      {panelLane && (
        <aside className="bp-panel scroll">
          <button className="icon-btn bp-panel-close" onClick={() => setSelected(null)} aria-label="Закрыть">
            <Icon name="close" size={14} />
          </button>
          <FileDetail
            key={panelLane.path}
            overview={overview}
            songs={songs}
            path={panelLane.path}
            file={fileByPath.get(panelLane.path) ?? null}
            removed={panelLane.status === "removed" ? (removed.find((r) => r.path === panelLane.path) ?? null) : null}
            elsewhere={panelLane.status === "elsewhere" ? panelLane.branchNames : undefined}
            rev={
              panelVersion && !panelVersion.onCurrent
                ? panelVersion.version.id
                : panelLane.status === "elsewhere"
                  ? (newestVersion?.version.id ?? null)
                  : null
            }
            drafts={drafts}
            highlight={panelVersion?.version.id ?? null}
            focusDraft={selected?.draft ? selected.n : 0}
            refreshKey={refreshKey}
            onChanged={onChanged}
            onLabelsChanged={onLabelsChanged}
            onUploadVersion={() => onUploadVersion(panelLane.path)}
            onRenamed={(to) => select(to, null)}
          />
        </aside>
      )}

      {tagging && (
        <PromptDialog
          title="Отметить версию"
          label="Название метки"
          placeholder="Например: master-v1"
          confirm="Отметить"
          hint={`Метка навсегда привязана к ${tagging.label}.`}
          onSubmit={async (name) => {
            await api.createTag(root, name, tagging.rev);
            onChanged();
          }}
          onClose={() => setTagging(null)}
        />
      )}
      {branching && (
        <SongBranchDialog
          path={branching.lane.path}
          taken={branching.lane.branches.map((b) => b.name)}
          start={branching.start}
          source={branching.source}
          onCreate={(name, source, intoFolder) =>
            songs.createBranch(branching.lane, branching.parent, name, source, intoFolder)
          }
          onClose={() => setBranching(null)}
        />
      )}
      {renamingBranch && (
        <PromptDialog
          title={`Переименовать ветку «${renamingBranch.name}»`}
          label="Новое название"
          initial={renamingBranch.name}
          confirm="Переименовать"
          onSubmit={async (to) => {
            const { lane, name } = renamingBranch;
            if (to !== name && lane.branches.some((b) => b.name.toLowerCase() === to.toLowerCase())) {
              throw new Error(`У трека уже есть ветка «${to}»`);
            }
            const before = { ...lane.branchOf };
            remember(() => songs.sortInto(lane, before));
            songs.renameBranch(lane, name, to);
          }}
          onClose={() => setRenamingBranch(null)}
        />
      )}
      {naming && (
        <PromptDialog
          title={`Новая ветка «${splitPath(naming.lane.path).name}»`}
          label="Название ветки"
          placeholder="Например: акустика, ремикс"
          confirm="Перенести"
          hint={`Версия ${naming.node.number} уйдёт из ветки «${naming.node.branch}» в новую. Файлы не меняются.`}
          onSubmit={async (name) => {
            if (naming.lane.branches.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
              throw new Error(`У трека уже есть ветка «${name}»`);
            }
            moveToBranch(naming.lane, naming.node, name);
          }}
          onClose={() => setNaming(null)}
        />
      )}
      {renaming && (
        <PromptDialog
          title={`Переименовать «${splitPath(renaming).name}»`}
          label="Новое имя (можно с папкой: «Демо/Ночь.wav»)"
          initial={renaming}
          confirm="Переименовать"
          hint="Файл переименуется в папке проекта. Сохраните версию — и история останется с ним под новым именем."
          onSubmit={(to) => rename(renaming, to.replace(/\\/g, "/"))}
          onClose={() => setRenaming(null)}
        />
      )}
      {meta && (
        <FileMetaDialog
          root={root}
          rev={meta.rev}
          path={meta.path}
          versionLabel={meta.label}
          onClose={() => setMeta(null)}
          onSaved={onLabelsChanged}
        />
      )}
    </div>
  );
}

/** An execution pin, filled when a wire is attached. */
function ExecPin({ side, on }: { side: "in" | "out"; on: boolean }) {
  return (
    <svg
      className={`bp-pin bp-pin-${side} ${on ? "on" : ""}`}
      width="13"
      height="15"
      viewBox="0 0 13 15"
      style={{ top: PIN_Y - 7.5 }}
    >
      <path d="M1.5 1.5h5.5l4.5 6-4.5 6h-5.5z" />
    </svg>
  );
}

/**
 * One song: a frame with its title and the song's own node, then a band per
 * branch: the branch's node, its versions wired one after another, the file
 * on disk at the end of the branch in the folder, and a place to add a file;
 * below them, a place to start a branch. Drawn again only when the song
 * changes, not while the canvas moves.
 */
const LaneView = memo(function LaneView({
  root,
  placed,
  file,
  draft,
  tagsOf,
  selectedKey,
  dragging,
  target,
  flash,
  dim,
  act,
}: {
  root: string;
  placed: PlacedLane;
  file: ProjectFile | undefined;
  /** The description written for the file's next version. */
  draft: string;
  tagsOf: Map<string, string[]>;
  /** The selected node in this lane; "" for the song itself, null when the selection is elsewhere. */
  selectedKey: string | null;
  /** The node being dragged; "" for the whole lane. */
  dragging: string | null;
  /** The band a dragged version would go to (NEW_BRANCH: a new branch). */
  target: string | null;
  /** A version just moved, shown for a moment. */
  flash: string | null;
  /** Not what the search is looking for. */
  dim: boolean;
  act: React.RefObject<Actions>;
}) {
  const { lane, origin, at, frame } = placed;
  const el = useRef<HTMLDivElement>(null);
  const { dir, name } = splitPath(lane.path);
  const kind = previewKind(lane.path);
  const icon: IconName = kind === "audio" ? "wave" : kind === "image" ? "image" : "doc";
  const muted = !growing(lane);
  const byKey = new Map(lane.nodes.map((n) => [n.key, n]));
  const headOf = (key: string) => {
    const n = byKey.get(key);
    return n?.kind === "version" ? n : undefined;
  };

  // A file from the file manager dropped on "+ файл" or "+ ветка".
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const onDrop = (e: Event) => {
      const [source] = (e as CustomEvent<string[]>).detail;
      const spot = (e.target as HTMLElement).closest<HTMLElement>("[data-add-to], [data-new-branch]");
      if (!source || !spot) return;
      if (spot.dataset.addTo !== undefined) act.current.addFile(lane, spot.dataset.addTo, source);
      else act.current.newBranch(lane, source);
    };
    node.addEventListener("filedrop", onDrop);
    return () => node.removeEventListener("filedrop", onDrop);
  }, [lane, act]);

  const versionTrack = (n: SongVersion): Track => ({
    root,
    rev: n.version.id,
    path: n.path,
    label: `v${n.number} · ${n.version.message || short(n.version.id)}`,
  });
  const nowTrack: Track = { root, rev: null, path: lane.path, label: "Сейчас на диске (не сохранено)" };

  // Places within the frame.
  const pos = (key: string) => {
    const p = at.get(key)!;
    return { x: p.x - frame.x, y: p.y - frame.y };
  };
  const pinOut = (key: string) => {
    const p = pos(key);
    return { x: p.x + nodeSize(key).w - 6, y: p.y + PIN_Y };
  };
  const pinIn = (key: string) => {
    const p = pos(key);
    return { x: p.x + 6, y: p.y + PIN_Y };
  };
  const box = (key: string) => {
    const p = pos(key);
    return { left: p.x, top: p.y, width: nodeSize(key).w, height: nodeSize(key).h };
  };

  // Wires: the song to each branch, each branch along its versions, the
  // branch in the folder on to the file on disk.
  const wires: { from: string; to: string; cls: string }[] = lane.branches.map((b) => ({
    from: SONG_KEY,
    to: branchKey(b.name),
    cls: b.active ? "" : "elsewhere",
  }));
  for (const n of lane.nodes) {
    const row = lane.branches[n.row];
    const before = n.kind === "version" ? n.links[0] : n.parent && byKey.get(n.parent)?.row === n.row ? n.parent : null;
    wires.push({
      from: before && byKey.has(before) ? nodeKey(byKey.get(before)!) : branchKey(row.name),
      to: nodeKey(n),
      cls: n.kind === "work" ? "work" : row.active ? "" : "elsewhere",
    });
  }
  const fed = new Set(wires.map((w) => w.from));

  return (
    <div
      ref={el}
      className={[
        "bp-lane",
        `lane-${lane.status}`,
        selectedKey !== null ? "selected" : "",
        dragging === "" ? "lifted" : "",
        dragging ? "dragging-in" : "",
        dim ? "dim" : "",
      ].join(" ")}
      style={{
        left: origin.x + frame.x,
        top: origin.y + frame.y,
        width: frame.w,
        height: frame.h,
        ["--hue" as string]: songHue(lane.path),
      }}
    >
      <div
        className="bp-lane-title"
        onPointerDown={(e) => act.current.dragLane(e, lane)}
        onClick={() => act.current.select(lane.path, null)}
        onContextMenu={(e) => act.current.songMenu(e, lane)}
        title={`${lane.path}\nТащите, чтобы передвинуть песню целиком`}
      >
        <span className="bp-lane-name">
          {name}
          <span className="bp-lane-meta">{laneText(lane)}</span>
        </span>
      </div>

      {lane.branches.map((b) => {
        const p = pos(branchKey(b.name));
        return (
          <div
            key={b.name}
            data-band={b.name}
            data-lane={lane.path}
            className={`bp-band ${b.active ? "active" : ""} ${target === b.name ? "target" : ""}`}
            style={{ left: p.x - 10, top: p.y - 9, width: frame.w - p.x - LANE_PAD / 2, height: NODE_H + 18 }}
          >
            {target === b.name && <span className="bp-band-hint">в ветку «{b.name}»</span>}
          </div>
        );
      })}

      <svg className="bp-wires" width={frame.w} height={frame.h}>
        {wires.map((w) => {
          const a = pinOut(w.from);
          const b = pinIn(w.to);
          return <path key={`${w.from}>${w.to}`} d={wire(a.x, a.y, b.x, b.y)} className={`bp-wire ${w.cls}`} />;
        })}
      </svg>

      <div
        className={`bp-node bp-song ${muted ? "muted" : ""} ${selectedKey === "" ? "selected" : ""}`}
        style={box(SONG_KEY)}
        onPointerDown={(e) => act.current.dragLane(e, lane)}
        onClick={() => act.current.select(lane.path, null)}
        onContextMenu={(e) => act.current.songMenu(e, lane)}
      >
        <div className="bp-node-head" title={lane.path}>
          <span className="bp-event" />
          <span className="bp-title">{name}</span>
          <button
            className="bp-head-btn"
            title="Действия с песней"
            onClick={(e) => {
              e.stopPropagation();
              act.current.songMenu(e, lane);
            }}
          >
            <Icon name="more" size={14} />
          </button>
        </div>
        <div className="bp-rows">
          <div className="bp-row">
            {lane.status !== "saved" && !muted && <KindBadge kind={lane.status as ChangeKind} />}
            <span className="bp-text">{laneText(lane)}</span>
          </div>
          <div className="bp-row bp-meta">
            <span className="bp-text">
              {[dir.slice(0, -1), `${lane.branches.length} ${plural(lane.branches.length, "ветка", "ветки", "веток")}`]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          <div className="bp-row">{file && <FileLabels labels={file.labels} />}</div>
        </div>
        <ExecPin side="out" on={lane.branches.length > 0} />
      </div>

      {lane.branches.map((b) => {
        const head = headOf(b.head);
        const usable = head && head.change !== "deleted" && !head.pruned;
        return (
          <div
            key={branchKey(b.name)}
            className={`bp-node bp-branch-node ${b.active ? "active" : ""}`}
            style={box(branchKey(b.name))}
            onClick={() => act.current.select(lane.path, null)}
            onContextMenu={(e) => act.current.branchMenu(e, lane, b)}
            title={`Ветка «${b.name}» трека «${name}»${b.active ? ", она в папке" : ""}`}
          >
            <div className="bp-node-head">
              <Icon name="branch" size={12} />
              <span className="bp-title">{b.name}</span>
              <button
                className="bp-head-btn"
                title="Действия с веткой"
                onClick={(e) => {
                  e.stopPropagation();
                  act.current.branchMenu(e, lane, b);
                }}
              >
                <Icon name="more" size={14} />
              </button>
            </div>
            <ExecPin side="in" on />
            <ExecPin side="out" on={fed.has(branchKey(b.name))} />
            <div className="bp-rows">
              <div className="bp-row">
                <span className="bp-text">
                  {b.versions} {plural(b.versions, "версия", "версии", "версий")}
                  {b.from !== null ? ` · от версии ${b.from}` : ""}
                </span>
              </div>
              <div className="bp-row">
                {b.active ? (
                  <span className="bp-here" title="Файл в папке проекта — из этой ветки; новые сохранения идут сюда">
                    в папке
                  </span>
                ) : (
                  usable &&
                  !muted && (
                    <button
                      className="btn btn-small"
                      title="Положить последнюю версию этой ветки в папку проекта"
                      onClick={(e) => {
                        e.stopPropagation();
                        act.current.intoFolder(lane, head);
                      }}
                    >
                      <Icon name="restore" size={12} /> В папку
                    </button>
                  )
                )}
              </div>
            </div>
          </div>
        );
      })}

      {!muted &&
        lane.branches.map((b) => (
          <button
            key={addKey(b.name)}
            className="bp-add"
            data-file-drop
            data-add-to={b.name}
            style={box(addKey(b.name))}
            onClick={() => act.current.addFile(lane, b.name)}
            title={`Новая версия в ветку «${b.name}»: выберите файл или бросьте его сюда`}
          >
            <Icon name="plus" size={16} />
            <span>файл</span>
          </button>
        ))}

      {!muted && (
        <button
          className={`bp-newbranch ${target === NEW_BRANCH ? "target" : ""}`}
          data-file-drop
          data-new-branch
          data-band={NEW_BRANCH}
          data-lane={lane.path}
          style={box(NEW_BRANCH_KEY)}
          onClick={() => act.current.newBranch(lane)}
          title="Новая ветка трека из файла; можно бросить сюда файл или перетащить версию"
        >
          <Icon name="plus" size={14} /> ветка
        </button>
      )}

      {lane.nodes.map((n) => {
        const key = nodeKey(n);
        const style = box(key);
        const isSelected = selectedKey === n.key;
        const prev = previousVersion(lane, n);
        if (n.kind === "work") {
          return (
            <div
              key={n.key}
              style={style}
              className={`bp-node bp-work status-${n.status} ${isSelected ? "selected" : ""}`}
              onClick={() => act.current.select(lane.path, n.key, true)}
              onContextMenu={(e) => act.current.workMenu(e, lane, n)}
              title="Файл в папке сейчас: щёлкните, чтобы описать и сохранить"
            >
              <div className="bp-node-head">
                <Icon name="edit" size={12} />
                <span className="bp-title">Сейчас в папке</span>
                <span className="bp-state">{WORK_WORD[n.status]}</span>
              </div>
              <ExecPin side="in" on />
              <div className="bp-rows">
                <div className="bp-row bp-msg">
                  <span className="bp-text">
                    {draft.trim() || <i>{n.status === "deleted" ? "файла нет в папке" : "не сохранено"}</i>}
                  </span>
                </div>
                <div className="bp-row bp-meta">
                  <span className="bp-text">{draft.trim() ? "описание готово" : "щёлкните, чтобы описать"}</span>
                </div>
                <div className="bp-row bp-foot">
                  {n.status !== "deleted" && <PlayButton track={nowTrack} />}
                  {n.status === "modified" && prev && !prev.pruned && (
                    <CompareButton a={versionTrack(prev)} b={nowTrack} />
                  )}
                  <span className="grow" />
                  <button
                    className="btn btn-small btn-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      act.current.save(n);
                    }}
                    title={
                      draft.trim()
                        ? "Сохранить с написанным описанием"
                        : "Сохранить с автоматическим описанием; своё — щелчком по узлу"
                    }
                  >
                    Сохранить
                  </button>
                </div>
              </div>
            </div>
          );
        }
        const v = n.version;
        const usable = n.change !== "deleted" && !n.pruned;
        const tags = tagsOf.get(v.id) ?? [];
        const merge = v.parents.length > 1;
        return (
          <div
            key={n.key}
            style={style}
            onPointerDown={(e) => act.current.dragNode(e, lane, key)}
            className={[
              "bp-node bp-version",
              `change-${n.change}`,
              lane.branches[n.row]?.active ? "" : "elsewhere",
              merge ? "merge" : "",
              isSelected ? "selected" : "",
              dragging === key ? "dragging" : "",
              flash === n.key ? "flash" : "",
            ].join(" ")}
            onClick={() => act.current.select(lane.path, n.key)}
            onContextMenu={(e) => act.current.versionMenu(e, lane, n)}
            title={`${v.message || "без описания"}\n${formatDate(v.createdAt)} · ${v.author} · ${short(v.id)}${
              muted ? "" : `\nПеретащите на полосу другой ветки, чтобы перенести`
            }`}
          >
            <div className="bp-node-head">
              <Icon name={merge ? "merge" : n.change === "deleted" ? "trash" : icon} size={12} />
              <span className="bp-title">{n.number ? `Версия ${n.number}` : "Удалён"}</span>
              {n.change === "renamed" && (
                <span className="bp-state" title={`Было: ${n.from ?? ""}`}>
                  переименован
                </span>
              )}
              {n.inFolder && (
                <span className="bp-here" title="Эта версия сейчас лежит в папке проекта">
                  в папке
                </span>
              )}
            </div>
            <ExecPin side="in" on />
            <ExecPin side="out" on={fed.has(n.key)} />
            <div className="bp-rows">
              <div className="bp-row bp-msg">
                <span className="bp-text">{v.message || <i>без описания</i>}</span>
              </div>
              <div className="bp-row bp-meta">
                <span className="bp-text">
                  {formatDate(v.createdAt)} · {v.author}
                </span>
              </div>
              <div className="bp-row bp-foot">
                <FileLabels labels={n.labels} />
                {tags.map((t) => (
                  <span key={t} className="bp-tag">
                    <Icon name="tag" size={10} />
                    {t}
                  </span>
                ))}
                <span className="grow" />
                {n.pruned && (
                  <span className="muted" title="Файл этой версии удалён при очистке места">
                    очищен
                  </span>
                )}
                {usable && <PlayButton track={versionTrack(n)} />}
                {usable && prev && !prev.pruned && n.change !== "renamed" && (
                  <CompareButton a={versionTrack(prev)} b={versionTrack(n)} />
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});

/** A note, a song to come or a frame: dragged around, resized, written in. */
function TileView({
  tile,
  selected,
  editing,
  dim,
  act,
}: {
  tile: Tile;
  selected: boolean;
  editing: boolean;
  dim: boolean;
  act: React.RefObject<Actions>;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(tile.title);
  const [text, setText] = useState(tile.text);

  useEffect(() => {
    if (!editing) {
      setTitle(tile.title);
      setText(tile.text);
    }
  }, [editing, tile.title, tile.text]);

  // A file dropped on a song to come from the file manager becomes that song.
  useEffect(() => {
    const node = el.current;
    if (!node || tile.kind !== "song") return;
    const onDrop = (e: Event) => {
      const [first] = (e as CustomEvent<string[]>).detail;
      if (first) act.current.fillTile(tile, first);
    };
    node.addEventListener("filedrop", onDrop);
    return () => node.removeEventListener("filedrop", onDrop);
  }, [tile, act]);

  function done() {
    if (title.trim() !== tile.title || text !== tile.text) {
      act.current.updateTile(tile.id, { title: title.trim() || tile.title, text });
    }
    act.current.editTile(null);
  }

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setTitle(tile.title);
      setText(tile.text);
      act.current.editTile(null);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (e.target as HTMLElement).tagName === "INPUT")) {
      e.preventDefault();
      done();
    }
  };

  const titleField = editing ? (
    <input
      className="bp-tile-input"
      autoFocus
      value={title}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={keys}
      onBlur={(e) => !el.current?.contains(e.relatedTarget as Node) && done()}
    />
  ) : (
    <span className="bp-title">{tile.title}</span>
  );

  const common = {
    ref: el,
    style: {
      left: tile.x,
      top: tile.y,
      width: tile.w,
      height: tile.h,
      ["--hue" as string]: tile.color,
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      act.current.selectTile(tile.id);
    },
    onDoubleClick: () => act.current.editTile(tile.id),
    onContextMenu: (e: React.MouseEvent) => act.current.tileMenu(e, tile),
  };
  const resize = <span className="bp-resize" onPointerDown={(e) => act.current.sizeTile(e, tile)} />;

  if (tile.kind === "frame") {
    return (
      <div {...common} className={`bp-group ${selected ? "selected" : ""} ${dim ? "dim" : ""}`}>
        <div className="bp-group-title" onPointerDown={(e) => act.current.dragTile(e, tile)}>
          {titleField}
        </div>
        {resize}
      </div>
    );
  }

  const body = editing ? (
    <textarea
      className="bp-tile-text"
      value={text}
      placeholder={tile.kind === "song" ? "Идея, текст, что записать…" : "Текст заметки"}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={keys}
      onBlur={(e) => !el.current?.contains(e.relatedTarget as Node) && done()}
    />
  ) : (
    <div className="bp-tile-body">{tile.text || <i>{tile.kind === "song" ? "заготовка без файла" : "пусто"}</i>}</div>
  );

  if (tile.kind === "song") {
    return (
      <div
        {...common}
        data-file-drop
        className={`bp-node bp-placeholder ${selected ? "selected" : ""} ${dim ? "dim" : ""}`}
        onPointerDown={(e) => act.current.dragTile(e, tile)}
      >
        <div className="bp-node-head">
          <span className="bp-event" />
          {titleField}
          <span className="bp-state">заготовка</span>
        </div>
        {body}
        <div className="bp-tile-foot">
          <button className="btn btn-small" onClick={() => act.current.fillTile(tile)}>
            <Icon name="folder" size={13} /> Выбрать файл…
          </button>
          <span className="muted">или бросьте файл сюда</span>
        </div>
        <ExecPin side="out" on={false} />
        {resize}
      </div>
    );
  }

  return (
    <div
      {...common}
      className={`bp-node bp-note ${selected ? "selected" : ""} ${dim ? "dim" : ""}`}
      onPointerDown={(e) => act.current.dragTile(e, tile)}
    >
      <div className="bp-node-head">
        <Icon name="comment" size={12} />
        {titleField}
      </div>
      {body}
      {resize}
    </div>
  );
}

/**
 * The whole canvas in small, with the part in sight: a click or a drag
 * brings another part into sight.
 */
function Minimap({
  rects,
  view,
  size,
  onCenter,
}: {
  rects: (Rect & { hue: number; frame: boolean })[];
  view: View;
  size: { w: number; h: number };
  onCenter: (x: number, y: number) => void;
}) {
  const W = 200;
  const H = 130;
  const pad = 60;
  const x0 = Math.min(...rects.map((r) => r.x)) - pad;
  const y0 = Math.min(...rects.map((r) => r.y)) - pad;
  const x1 = Math.max(...rects.map((r) => r.x + r.w)) + pad;
  const y1 = Math.max(...rects.map((r) => r.y + r.h)) + pad;
  const scale = Math.min(W / (x1 - x0), H / (y1 - y0));
  const to = (x: number, y: number) => ({ x: (x - x0) * scale, y: (y - y0) * scale });
  const seen = to(-view.x / view.zoom, -view.y / view.zoom);

  function center(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    onCenter(x0 + (e.clientX - r.left) / scale, y0 + (e.clientY - r.top) / scale);
  }

  return (
    <svg
      className="bp-map"
      width={(x1 - x0) * scale}
      height={(y1 - y0) * scale}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        center(e);
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && center(e)}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {rects.map((r, i) => {
        const p = to(r.x, r.y);
        return (
          <rect
            key={i}
            x={p.x}
            y={p.y}
            width={Math.max(2, r.w * scale)}
            height={Math.max(2, r.h * scale)}
            rx={2}
            fill={`hsl(${r.hue} 50% 55% / ${r.frame ? 0.35 : 0.8})`}
          />
        );
      })}
      <rect
        className="bp-map-view"
        x={seen.x}
        y={seen.y}
        width={(size.w / view.zoom) * scale}
        height={(size.h / view.zoom) * scale}
      />
    </svg>
  );
}
