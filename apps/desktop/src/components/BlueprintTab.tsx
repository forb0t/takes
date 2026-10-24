import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type ChangeKind, type GraphVersion, type Overview, type RemovedFile } from "../api";
import {
  LANE_GAP,
  LANE_PAD,
  NODE_H,
  NODE_W,
  PIN_Y,
  SONG_W,
  buildLanes,
  laneGroup,
  laneHeight,
  laneWidth,
  nodeX,
  nodeY,
  previousVersion,
  songHue,
  wire,
  type Lane,
  type LaneNode,
  type SongVersion,
  type WorkNode,
} from "../blueprint";
import { CompareButton, PlayButton, usePlayer, type Track } from "../player";
import { Empty, FileLabels, Icon, KindBadge, PromptDialog, useToast, type IconName } from "../ui";
import { formatDate, plural, previewKind, short, splitPath } from "../util";
import { FileDetail, type Drafts, type ProjectFile } from "./FilesTab";
import { FileMetaDialog } from "./FileMetaDialog";
import { useFileActions } from "./useFileActions";

/** The song order, shared by every device of the project. */
const ORDER_KEY = "songs.order";
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.5;
/** A grid cell, in canvas pixels; every eighth line is a dark one. */
const GRID = 16;

type View = { x: number; y: number; zoom: number };
type Placed = { lane: Lane; y: number; w: number; h: number };
type Reorder = { path: string; to: number; dy: number };
type Selection = { path: string; key: string | null; draft: boolean; n: number };
type MenuItem = { label: string; icon: IconName; run: () => void };
type Menu = { x: number; y: number; items: MenuItem[] };
type Prompt = { kind: "branch" | "tag"; rev: string; label: string };
type Meta = { path: string; rev: string; label: string };

const WORK_WORD: Record<ChangeKind, string> = {
  added: "новый файл",
  modified: "изменён",
  deleted: "удалён с диска",
  renamed: "переименован",
};

/** What the lanes ask of the diagram, read when it happens so it is always current. */
interface LaneActions {
  select: (path: string, key: string | null, draft?: boolean) => void;
  songMenu: (e: React.MouseEvent, lane: Lane) => void;
  versionMenu: (e: React.MouseEvent, lane: Lane, n: SongVersion) => void;
  workMenu: (e: React.MouseEvent, lane: Lane, n: WorkNode) => void;
  save: (n: WorkNode) => void;
  reorder: (e: React.PointerEvent, lane: Lane) => void;
}

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
 * The project as a blueprint: a lane per song, framed like a comment, that
 * starts with the song's node and wires its versions from left to right,
 * forks for other branches and the file on disk at the end when it is not
 * saved. The canvas pans and zooms; everything a file allows is done here.
 */
export function BlueprintTab({
  overview,
  files,
  removed,
  drafts,
  refreshKey,
  onChanged,
  onLabelsChanged,
  onAddFiles,
  onOpenFile,
  onUploadVersion,
  onMerge,
}: {
  overview: Overview;
  files: ProjectFile[] | null;
  removed: RemovedFile[];
  drafts: Drafts;
  refreshKey: number;
  onChanged: () => void;
  onLabelsChanged: () => void;
  onAddFiles: (what: "files" | "folder") => void;
  onOpenFile: (path: string) => void;
  onUploadVersion: (path: string) => void;
  onMerge: (branch: string) => void;
}) {
  const root = overview.root;
  const toast = useToast();
  const player = usePlayer();
  const actions = useFileActions(root, onChanged);
  const [versions, setVersions] = useState<GraphVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [savedView] = useState(() => loadView(root));
  const [view, setView] = useState<View>(savedView ?? { x: 32, y: 32, zoom: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [selected, setSelected] = useState<Selection | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  /** The file being renamed. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [reorder, setReorder] = useState<Reorder | null>(null);
  const [panning, setPanning] = useState(false);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const fitted = useRef(savedView !== null);
  const pan = useRef<{ x: number; y: number; origin: View; moved: boolean } | null>(null);
  /** A pan just ended: the click that follows is not a click on a node. */
  const panned = useRef(false);
  const branchesKey = overview.branches.map((b) => `${b.name}@${b.head}`).join();

  useEffect(() => {
    let alive = true;
    api
      .historyGraph(root)
      .then((v) => alive && (setVersions(v), setError(null)))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [root, branchesKey, refreshKey]);

  // Another device may have reordered the songs; a sync moves branches too.
  useEffect(() => {
    let alive = true;
    api
      .sharedSetting(root, ORDER_KEY)
      .then((value) => {
        if (!alive || !value) return;
        const list: unknown = JSON.parse(value);
        if (Array.isArray(list)) setOrder(list.filter((p): p is string => typeof p === "string"));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [root, branchesKey]);

  const removedPaths = useMemo(() => new Set(removed.map((r) => r.path)), [removed]);
  const lanes = useMemo(
    () => (versions && files ? buildLanes(versions, overview.branches, files, removedPaths, order) : null),
    [versions, files, overview.branches, removedPaths, order],
  );
  const visible = useMemo(
    () => lanes?.filter((l) => showRemoved || l.status !== "removed") ?? [],
    [lanes, showRemoved],
  );
  const placed = useMemo(() => {
    let y = 0;
    return visible.map((lane): Placed => {
      const at = { lane, y, w: laneWidth(lane), h: laneHeight(lane) };
      y += at.h + LANE_GAP;
      return at;
    });
  }, [visible]);
  const fileByPath = useMemo(() => new Map((files ?? []).map((f) => [f.path, f])), [files]);
  const tagsOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of overview.tags) map.set(t.target, [...(map.get(t.target) ?? []), t.name]);
    return map;
  }, [overview.tags]);

  // ---- view: fit, pan, zoom -----------------------------------------------------

  /** Everything in sight, or the start of the first songs when that would be too small to read. */
  const fit = useCallback(() => {
    if (!box || !placed.length) return;
    const { width, height } = box.getBoundingClientRect();
    const last = placed[placed.length - 1];
    const w = Math.max(...placed.map((p) => p.w));
    const h = last.y + last.h;
    const m = 32;
    const whole = Math.min(1, (width - m * 2) / w, (height - m * 2) / h);
    if (whole >= 0.6) {
      setView({ zoom: whole, x: (width - w * whole) / 2, y: Math.min(m * 2, (height - h * whole) / 2) });
    } else {
      setView({ zoom: Math.min(1, Math.max(0.85, (width - m * 2) / w)), x: m, y: m });
    }
  }, [box, placed]);

  // The first look: where it was left, unless nothing would be in sight.
  useLayoutEffect(() => {
    if (!box || !placed.length) return;
    if (fitted.current) {
      const { width, height } = box.getBoundingClientRect();
      const last = placed[placed.length - 1];
      const right = view.x + Math.max(...placed.map((p) => p.w)) * view.zoom;
      const bottom = view.y + (last.y + last.h) * view.zoom;
      if (right > 40 && bottom > 40 && view.x < width - 40 && view.y < height - 40) return;
    }
    fitted.current = true;
    fit();
    // Only once, when the lanes are first there.
  }, [box, placed.length > 0]);

  useEffect(() => {
    const t = setTimeout(() => saveView(root, view), 400);
    return () => clearTimeout(t);
  }, [root, view]);

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

  // The wheel scrolls (with Shift, sideways); Ctrl + wheel or a pinch zooms.
  useEffect(() => {
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
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

  // F shows everything, + and − zoom, 0 returns to 100%.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest("button, input, textarea, select, a")) return;
    // The middle button pans too, instead of scrolling by itself.
    if (e.button === 1) e.preventDefault();
    panned.current = false;
    pan.current = { x: e.clientX, y: e.clientY, origin: view, moved: false };
  }

  function onPointerMove(e: React.PointerEvent) {
    const p = pan.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved) {
      // Capture only once it is a drag, so clicks still reach the nodes.
      if (Math.abs(dx) + Math.abs(dy) <= 4) return;
      p.moved = true;
      panned.current = true;
      setPanning(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setView({ ...p.origin, x: p.origin.x + dx, y: p.origin.y + dy });
  }

  function onPointerUp(e: React.PointerEvent) {
    const p = pan.current;
    pan.current = null;
    setPanning(false);
    // A click on the empty canvas closes the panel.
    if (p && !p.moved && !(e.target as HTMLElement).closest(".bp-node, .bp-tagline")) setSelected(null);
  }

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const select = useCallback((path: string, key: string | null, draft = false) => {
    setSelected((s) => ({ path, key, draft, n: (s?.n ?? 0) + 1 }));
  }, []);

  // ---- song order ---------------------------------------------------------------

  function saveOrder(paths: string[]) {
    setOrder(paths);
    api.setSharedSetting(root, ORDER_KEY, JSON.stringify(paths)).catch((e) => toast(errorText(e), "error"));
  }

  /** Puts a song before the lane now at `to` (an index into all lanes). */
  function move(path: string, to: number) {
    if (!lanes) return;
    const all = lanes.map((l) => l.path);
    const from = all.indexOf(path);
    const next = all.filter((p) => p !== path);
    next.splice(to > from ? to - 1 : to, 0, path);
    if (next.some((p, i) => p !== all[i])) saveOrder(next);
  }

  /** Lanes a song can move among: songs move within their group. */
  function groupRange(lane: Lane): [number, number] {
    const g = laneGroup(lane);
    const all = lanes ?? [];
    return [all.findIndex((l) => laneGroup(l) === g), all.length - [...all].reverse().findIndex((l) => laneGroup(l) === g)];
  }

  /** Dragging a song's title moves its lane up or down; a click selects the song. */
  function startReorder(e: React.PointerEvent, lane: Lane) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button") || !box) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const [lo, hi] = groupRange(lane);
    const startY = e.clientY;
    const { zoom } = view;
    const top = box.getBoundingClientRect().top + view.y;
    let target: number | null = null;
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (target === null && Math.abs(dy) < 5) return;
      let to = placed.length;
      for (let i = 0; i < placed.length; i++) {
        if (ev.clientY < top + (placed[i].y + placed[i].h / 2) * zoom) {
          to = i;
          break;
        }
      }
      target = Math.min(Math.max(to, lo), hi);
      setReorder({ path: lane.path, to: target, dy: dy / zoom });
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setReorder(null);
      if (target === null) select(lane.path, null);
      else move(lane.path, target);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  // ---- actions ------------------------------------------------------------------

  const versionTrack = (n: SongVersion): Track => ({
    root,
    rev: n.version.id,
    path: n.path,
    label: `v${n.number} · ${n.version.message || short(n.version.id)}`,
  });
  const nowTrack = (path: string): Track => ({ root, rev: null, path, label: "Сейчас на диске (не сохранено)" });

  async function switchTo(name: string) {
    try {
      await api.switchBranch(root, name);
      toast(`Вы на ветке «${name}»`, "ok");
      onChanged();
    } catch (e) {
      toast(errorText(e), "error");
    }
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
        {
          label: "Вернуть эту версию в папку",
          icon: "restore",
          run: () => actions.restore(lane.path, n.version.id, n.path),
        },
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
    items.push(
      {
        label: "Новая ветка отсюда…",
        icon: "branch",
        run: () => setPrompt({ kind: "branch", rev: n.version.id, label: `версии ${short(n.version.id)}` }),
      },
      {
        label: "Отметить версию…",
        icon: "tag",
        run: () => setPrompt({ kind: "tag", rev: n.version.id, label: `версии ${short(n.version.id)}` }),
      },
    );
    for (const b of n.branches.filter((b) => !b.current)) {
      items.push(
        { label: `Перейти на ветку «${b.name}»`, icon: "check", run: () => switchTo(b.name) },
        { label: `Слить «${b.name}» в «${overview.branch}»…`, icon: "merge", run: () => onMerge(b.name) },
      );
    }
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
    const oldName = files?.find((f) => f.path === w.path)?.from;
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

  function laneMenu(lane: Lane): MenuItem[] {
    const all = lanes ?? [];
    const i = all.indexOf(lane);
    const [lo, hi] = groupRange(lane);
    const items: MenuItem[] = [];
    if (lane.status !== "elsewhere") {
      items.push({ label: "Открыть во вкладке «Файлы»", icon: "doc", run: () => onOpenFile(lane.path) });
    }
    if (lane.status === "removed") {
      const gone = removed.find((r) => r.path === lane.path);
      if (gone) items.push({ label: "Вернуть в проект", icon: "restore", run: () => actions.restore(lane.path, gone.last) });
    } else if (lane.status !== "elsewhere") {
      items.push({ label: "Загрузить новую версию…", icon: "download", run: () => onUploadVersion(lane.path) });
    }
    if (lane.status !== "deleted" && lane.status !== "removed" && lane.status !== "elsewhere") {
      items.push(
        { label: "Переименовать…", icon: "edit", run: () => setRenaming(lane.path) },
        { label: "Показать в папке", icon: "folder", run: () => reveal(lane.path) },
      );
    }
    if (i > lo) {
      items.push(
        { label: "Переместить выше", icon: "up", run: () => move(lane.path, i - 1) },
        { label: "Переместить в начало", icon: "up", run: () => move(lane.path, lo) },
      );
    }
    if (i < hi - 1) {
      items.push(
        { label: "Переместить ниже", icon: "down", run: () => move(lane.path, i + 2) },
        { label: "Переместить в конец", icon: "down", run: () => move(lane.path, hi) },
      );
    }
    return items;
  }

  const canvasMenu: MenuItem[] = [
    { label: "Добавить песни (файлы)…", icon: "plus", run: () => onAddFiles("files") },
    { label: "Добавить папку…", icon: "folder", run: () => onAddFiles("folder") },
    { label: "Показать всё", icon: "wave", run: fit },
  ];

  const laneActions = useRef<LaneActions>(null!);
  laneActions.current = {
    select,
    songMenu: (e, lane) => openMenu(e, laneMenu(lane)),
    versionMenu: (e, lane, n) => openMenu(e, versionMenu(lane, n)),
    workMenu: (e, lane, n) => openMenu(e, workMenu(lane, n)),
    save: quickSave,
    reorder: startReorder,
  };


  // ---- drawing ------------------------------------------------------------------

  if (error) return <div className="center error-text">{error}</div>;
  if (!lanes) return <div className="center muted">Строю схему…</div>;

  if (lanes.length === 0) {
    return (
      <div className="center">
        <Empty icon="wave" title="Здесь появится схема проекта">
          У каждой песни будет своя дорожка: узел песни, от него проводами — её версии, ответвления для других веток и
          то, что сейчас лежит в папке.
          <div className="empty-actions">
            <button className="btn btn-primary" onClick={() => onAddFiles("files")}>
              <Icon name="plus" /> Добавить файлы
            </button>
          </div>
        </Empty>
      </div>
    );
  }

  const songs = lanes.filter((l) => laneGroup(l) === 0).length;
  const unsaved = lanes.filter((l) => l.nodes.some((n) => n.kind === "work")).length;
  const removedCount = lanes.length - lanes.filter((l) => l.status !== "removed").length;

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

  // Where a song being dragged would land.
  const from = reorder ? placed.findIndex((p) => p.lane.path === reorder.path) : -1;
  const last = placed[placed.length - 1];
  const dropY =
    reorder && reorder.to !== from && reorder.to !== from + 1
      ? reorder.to < placed.length
        ? placed[reorder.to].y - LANE_GAP / 2
        : last.y + last.h + LANE_GAP / 2
      : null;

  // Once the songs' own nodes are out of sight on the left, their names stay
  // at the edge of the canvas.
  const namesAside = view.x + (LANE_PAD + SONG_W) * view.zoom < 40;

  return (
    <div className="bp-wrap">
      <div className="bp-main">
        <div className="bp-toolbar">
          <span className="muted">
            {songs} {plural(songs, "песня", "песни", "песен")}
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
          <span className="grow" />
          <span className="bp-legend muted">
            <i className="bp-sw sw-song" /> песня
            <i className="bp-sw sw-version" /> версия
            <i className="bp-sw sw-other" /> другая ветка
            <i className="bp-sw sw-work" /> не сохранено
          </span>
          <button className="btn btn-small" onClick={fit} title="Показать всю схему (F)">
            Показать всё
          </button>
          <span
            className="bp-help"
            title={
              "Тащите полотно мышью (или средней кнопкой)\n" +
              "Колесо — прокрутка, Shift + колесо — вбок\n" +
              "Ctrl + колесо — масштаб, 0 — 100%\n" +
              "F — показать всё\n" +
              "Заголовок песни тащите вверх или вниз — порядок песен\n" +
              "Правая кнопка — действия"
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
          className={`bp ${panning ? "panning" : ""}`}
          style={gridStyle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            pan.current = null;
            setPanning(false);
          }}
          onClickCapture={(e) => {
            if (panned.current) {
              panned.current = false;
              e.stopPropagation();
            }
          }}
          onContextMenu={(e) => openMenu(e, canvasMenu)}
        >
          <div className="bp-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
            {placed.map(({ lane, y, w, h }) => (
              <LaneView
                key={lane.path}
                root={root}
                lane={lane}
                y={y}
                w={w}
                h={h}
                file={fileByPath.get(lane.path)}
                draft={drafts.get(lane.path)}
                tagsOf={tagsOf}
                selectedKey={selected?.path === lane.path ? (selected.key ?? "") : null}
                lift={reorder?.path === lane.path ? reorder.dy : null}
                act={laneActions}
              />
            ))}
            {dropY !== null && (
              <div className="bp-drop" style={{ top: dropY, width: Math.max(...placed.map((p) => p.w)) }} />
            )}
          </div>

          {namesAside &&
            placed.map(({ lane, y, h }) => {
              const top = view.y + y * view.zoom;
              const bottom = top + h * view.zoom;
              if (bottom < 36 || top > size.h) return null;
              return (
                <button
                  key={lane.path}
                  className={`bp-tagline ${selected?.path === lane.path ? "selected" : ""}`}
                  style={{ top: Math.min(Math.max(top + 6, 8), bottom - 32), ["--hue" as string]: songHue(lane.path) }}
                  onClick={() => {
                    select(lane.path, null);
                    setView((v) => ({ ...v, x: 32 }));
                  }}
                  onContextMenu={(e) => openMenu(e, laneMenu(lane))}
                  title="Показать начало дорожки"
                >
                  <span className="bp-event" />
                  <span>{splitPath(lane.path).name}</span>
                </button>
              );
            })}

          <div className="bp-watermark">СХЕМА</div>
        </div>
      </div>

      {menu && (
        <div
          className="popover bp-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 276),
            top: Math.min(menu.y, window.innerHeight - menu.items.length * 36 - 20),
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.items.map((item) => (
            <button
              key={item.label}
              className="popover-main"
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

      {prompt && (
        <PromptDialog
          title={prompt.kind === "branch" ? "Новая ветка" : "Отметить версию"}
          label={prompt.kind === "branch" ? "Название ветки" : "Название метки"}
          placeholder={prompt.kind === "branch" ? "Например: acoustic" : "Например: master-v1"}
          confirm={prompt.kind === "branch" ? "Создать и перейти" : "Отметить"}
          hint={
            prompt.kind === "branch"
              ? `Ветка начнётся с ${prompt.label}. Если это не текущая версия, файлы в папке заменятся.`
              : `Метка навсегда привязана к ${prompt.label}.`
          }
          onSubmit={async (name) => {
            if (prompt.kind === "branch") await api.createBranch(root, name, prompt.rev, true);
            else await api.createTag(root, name, prompt.rev);
            onChanged();
          }}
          onClose={() => setPrompt(null)}
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

const parentsOf = (n: LaneNode) => (n.kind === "work" ? (n.parent ? [n.parent] : []) : n.parents);

/**
 * One song: its own node, then its versions and the file on disk, wired.
 * Drawn again only when the song changes, not while the canvas moves.
 */
const LaneView = memo(function LaneView({
  root,
  lane,
  y,
  w,
  h,
  file,
  draft,
  tagsOf,
  selectedKey,
  lift,
  act,
}: {
  root: string;
  lane: Lane;
  y: number;
  w: number;
  h: number;
  file: ProjectFile | undefined;
  /** The description written for the file's next version. */
  draft: string;
  tagsOf: Map<string, string[]>;
  /** The selected node in this lane; "" for the song itself, null when the selection is elsewhere. */
  selectedKey: string | null;
  /** How far the lane is being dragged, in canvas pixels. */
  lift: number | null;
  act: React.RefObject<LaneActions>;
}) {
  const { dir, name } = splitPath(lane.path);
  const kind = previewKind(lane.path);
  const icon: IconName = kind === "audio" ? "wave" : kind === "image" ? "image" : "doc";
  const keys = new Set(lane.nodes.map((n) => n.key));
  const fed = new Set(lane.nodes.flatMap(parentsOf));
  const starts = lane.nodes.filter((n) => !parentsOf(n).some((p) => keys.has(p)));

  const versionTrack = (n: SongVersion): Track => ({
    root,
    rev: n.version.id,
    path: n.path,
    label: `v${n.number} · ${n.version.message || short(n.version.id)}`,
  });
  const nowTrack: Track = { root, rev: null, path: lane.path, label: "Сейчас на диске (не сохранено)" };

  const songOut = { x: LANE_PAD + SONG_W - 6, y: LANE_PAD + PIN_Y };
  const pinIn = (n: LaneNode) => ({ x: nodeX(n.col) + 6, y: nodeY(n.row) + PIN_Y });
  const pinOut = (n: LaneNode) => ({ x: nodeX(n.col) + NODE_W - 6, y: nodeY(n.row) + PIN_Y });
  const wireClass = (n: LaneNode) =>
    `bp-wire ${n.kind === "work" ? "work" : ""} ${n.kind === "version" && !n.onCurrent ? "elsewhere" : ""}`;
  const muted = lane.status === "removed" || lane.status === "elsewhere";

  return (
    <div
      className={[
        "bp-lane",
        `lane-${lane.status}`,
        selectedKey !== null ? "selected" : "",
        lift !== null ? "lifted" : "",
      ].join(" ")}
      style={{ top: y + (lift ?? 0), width: w, height: h, ["--hue" as string]: songHue(lane.path) }}
    >
      <svg className="bp-wires" width={w} height={h}>
        {starts.map((n) => {
          const to = pinIn(n);
          return <path key={`song>${n.key}`} d={wire(songOut.x, songOut.y, to.x, to.y)} className={wireClass(n)} />;
        })}
        {lane.nodes.flatMap((n) =>
          parentsOf(n).map((p) => {
            const parent = lane.nodes.find((x) => x.key === p);
            if (!parent) return null;
            const a = pinOut(parent);
            const b = pinIn(n);
            return <path key={`${p}>${n.key}`} d={wire(a.x, a.y, b.x, b.y)} className={wireClass(n)} />;
          }),
        )}
      </svg>

      <div
        className={`bp-node bp-song ${muted ? "muted" : ""} ${selectedKey === "" ? "selected" : ""}`}
        style={{ left: LANE_PAD, top: LANE_PAD, width: SONG_W, height: NODE_H }}
        onClick={() => act.current.select(lane.path, null)}
        onContextMenu={(e) => act.current.songMenu(e, lane)}
      >
        <div
          className="bp-node-head"
          onPointerDown={(e) => act.current.reorder(e, lane)}
          title={`${lane.path}\nПеретащите вверх или вниз, чтобы поменять порядок песен (он общий для всех устройств)`}
        >
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
          <div className="bp-row bp-meta">{dir && <span className="bp-text">{dir.slice(0, -1)}</span>}</div>
          <div className="bp-row">{file && <FileLabels labels={file.labels} />}</div>
        </div>
        <ExecPin side="out" on={starts.length > 0} />
      </div>

      {lane.nodes.map((n) => {
        const style = { left: nodeX(n.col), top: nodeY(n.row), width: NODE_W, height: NODE_H };
        const isSelected = selectedKey === n.key;
        const prev = previousVersion(lane, n);
        if (n.kind === "work") {
          return (
            <div
              key={n.key}
              className={`bp-node bp-work status-${n.status} ${isSelected ? "selected" : ""}`}
              style={style}
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
            className={[
              "bp-node bp-version",
              `change-${n.change}`,
              n.onCurrent ? "" : "elsewhere",
              merge ? "merge" : "",
              isSelected ? "selected" : "",
            ].join(" ")}
            style={style}
            onClick={() => act.current.select(lane.path, n.key)}
            onContextMenu={(e) => act.current.versionMenu(e, lane, n)}
            title={`${v.message || "без описания"}\n${formatDate(v.createdAt)} · ${v.author} · ${short(v.id)}`}
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
                {n.branches.map((b) => (
                  <span key={b.name} className={`bp-branch ${b.current ? "current" : ""}`}>
                    <Icon name="branch" size={10} />
                    {b.name}
                  </span>
                ))}
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
