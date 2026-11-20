import { ask, open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type Overview, type RemovedFile, type TakeSource } from "../api";
import {
  BRANCH_PREFIX,
  LOOSE_KEY,
  NEW_BRANCH_KEY,
  PIN_Y,
  SONG_KEY,
  addKey,
  branchKey,
  growing,
  laneGroup,
  nodeKey,
  nodeSize,
  placeLanes,
  previousVersion,
  songHue,
  type Lane,
  type Layout,
  type Point,
  type Rect,
  type SongBranch,
  type SongLinks,
  type SongVersion,
  type WorkNode,
} from "../blueprint";
import { usePlayer, type Track } from "../player";
import { Empty, Icon, PromptDialog, useToast } from "../ui";
import { baseName, plural, previewKind, short, splitPath } from "../util";
import { FileDetail, type Drafts, type ProjectFile } from "./FilesTab";
import { FileMetaDialog } from "./FileMetaDialog";
import { SongBranchDialog } from "./SongBranchDialog";
import type { Songs } from "../songs";
import { useFileActions } from "./useFileActions";
import { connect, follows, moveOne, unplug } from "../wiring";
import {
  COLORS,
  GRID,
  TILE_MIN,
  TILE_NEW,
  inside,
  laneRect,
  loadFlag,
  menuTop,
  newId,
  noSelecting,
  saveFlag,
  snap,
  wiresOf,
  type Actions,
  type BranchStart,
  type Drag,
  type Match,
  type Menu,
  type MenuItem,
  type Meta,
  type Plan,
  type Pull,
  type Selection,
  type Tile,
  type Wire,
  type WireEnd,
} from "./diagram/model";
import { HelpSheet } from "./diagram/HelpSheet";
import { LaneView } from "./diagram/LaneView";
import { Minimap } from "./diagram/Minimap";
import { LiveWire } from "./diagram/pins";
import { TileView } from "./diagram/TileView";
import { useShared } from "./diagram/useShared";
import { useSteps } from "./diagram/useSteps";
import { useView } from "./diagram/useView";


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
  const { layout, tiles, layoutNow, tilesNow, putLayout, putTiles } = useShared(root, overview);
  /** A version just moved to another branch, shown for a moment. */
  const [flash, setFlash] = useState<string | null>(null);
  /** A song's branch being renamed. */
  const [renamingBranch, setRenamingBranch] = useState<{ lane: Lane; name: string } | null>(null);
  /** A new branch of a song, waiting for its name. */
  const [naming, setNaming] = useState<{
    lane: Lane;
    hint: string;
    confirm: string;
    make: (name: string) => unknown;
  } | null>(null);
  /** A wire being pulled. */
  const [pull, setPull] = useState<Pull | null>(null);
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
  /** The sheet of what can be done on the diagram and how. */
  const [help, setHelp] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const lanes = songs.lanes;

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
        // Nodes taken out of the lane stay where they are.
        const at = new Map(p.at);
        for (const key of p.free) {
          const was = at.get(key)!;
          at.set(key, { x: was.x - drag.by.x, y: was.y - drag.by.y });
        }
        return { ...p, at, origin: { x: p.origin.x + drag.by.x, y: p.origin.y + drag.by.y } };
      }
      // A dragged node follows the pointer; its lane stays as it was.
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
    if (!drag || drag.kind === "node") return tiles;
    return tiles.map((t) => {
      if (drag.kind === "lane") {
        return drag.tiles.includes(t.id) ? { ...t, x: t.x + drag.by.x, y: t.y + drag.by.y } : t;
      }
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

  const tagsOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of overview.tags) map.set(t.target, [...(map.get(t.target) ?? []), t.name]);
    return map;
  }, [overview.tags]);

  // What the search finds: songs by any of their names or branches, versions by
  // their description, labels and marks, tiles by their text.
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return null;
    const lanesFound: Match[] = basePlaced
      .filter((p) => [...p.lane.names, ...p.lane.branches.map((b) => b.name)].some((n) => n.toLowerCase().includes(q)))
      .map((p) => ({ key: p.lane.path, rect: laneRect(p) }));
    const versionsFound: Match[] = basePlaced.flatMap((p) =>
      p.lane.nodes.flatMap((n) => {
        const at = p.at.get(n.key);
        if (n.kind !== "version" || !at) return [];
        const text = [n.version.message, ...n.labels, ...(tagsOf.get(n.version.id) ?? [])].join(" ");
        if (!text.toLowerCase().includes(q)) return [];
        const rect = { x: p.origin.x + at.x, y: p.origin.y + at.y, ...nodeSize(n.key) };
        return [{ key: n.key, lane: p.lane.path, rect }];
      }),
    );
    const tilesFound: Match[] = tiles
      .filter((t) => `${t.title} ${t.text}`.toLowerCase().includes(q))
      .map((t) => ({ key: t.id, rect: t as Rect }));
    return [...lanesFound, ...versionsFound, ...tilesFound].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  }, [q, basePlaced, tiles, tagsOf]);
  /** Lanes and tiles the search keeps lit; a lane stays lit for a version found in it. */
  const matched = useMemo(() => (matches ? new Set(matches.map((m) => m.lane ?? m.key)) : null), [matches]);
  /** The versions found, by lane. */
  const hits = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const m of matches ?? []) if (m.lane) map.set(m.lane, (map.get(m.lane) ?? new Set()).add(m.key));
    return map;
  }, [matches]);
  /** The version Enter went to last, marked apart from the other ones found. */
  const hitNow = found >= 0 && matches?.[found]?.lane ? matches[found] : null;

  // The sheet closes on a press anywhere else.
  useEffect(() => {
    if (!help) return;
    const close = (e: Event) => !(e.target as Element | null)?.closest?.(".bp-help, .bp-help-sheet") && setHelp(false);
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [help]);

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

  const menuBox = useRef<HTMLDivElement>(null);
  // Labels may wrap, so how tall a menu is shows only once drawn: one that runs
  // past the bottom of the window goes up (and scrolls if still too tall).
  useLayoutEffect(() => {
    const el = menuBox.current;
    if (!el || !menu) return;
    el.style.top = `${menuTop(menu)}px`;
    const { height } = el.getBoundingClientRect();
    if (menuTop(menu) + height > window.innerHeight - 8) {
      el.style.top = `${Math.max(8, window.innerHeight - 8 - height)}px`;
    }
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

  const { box, setBox, view, setView, size, panning, fitted, suppressClick, panelBox, ...look } = useView(root, {
    bounds,
    hasContent: basePlaced.length + tiles.length > 0,
    onEmptyClick: () => {
      setSelected(null);
      setSelectedTile(null);
    },
  });
  const { fit, zoomBy, focusRect, focusNode, toCanvas } = look;

  /** The file `nextUnsaved` showed last, and the order the unsaved files were in then. */
  const unsavedSeen = useRef<{ path: string; order: string[] } | null>(null);

  /**
   * The next file not saved yet: in sight, with its panel open to describe and save it.
   * "Next" is the one after the file shown last, also when that one has been saved since
   * and so is no longer in the list.
   */
  function nextUnsaved() {
    const all = basePlaced
      .flatMap((p) =>
        p.lane.nodes.flatMap((n) => {
          const at = p.at.get(nodeKey(n));
          if (n.kind !== "work" || !at) return [];
          const rect = { x: p.origin.x + at.x, y: p.origin.y + at.y, ...nodeSize(nodeKey(n)) };
          return [{ lane: p.lane, n, rect }];
        }),
      )
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    if (!all.length) return;
    const order = all.map((u) => u.lane.path);
    const seen = unsavedSeen.current;
    let at = 0;
    if (seen && order.includes(seen.path)) {
      at = (order.indexOf(seen.path) + 1) % order.length;
    } else if (seen) {
      const after = seen.order.slice(seen.order.indexOf(seen.path) + 1).find((p) => order.includes(p));
      at = after ? order.indexOf(after) : 0;
    }
    unsavedSeen.current = { path: order[at], order };
    const { lane, n, rect } = all[at];
    select(lane.path, n.key, true);
    focusNode(rect);
  }

  function findNext(step: 1 | -1) {
    if (!matches?.length) return;
    const next = (found + step + matches.length) % matches.length;
    setFound(next);
    const m = matches[next];
    if (m.lane) {
      focusNode(m.rect);
      shine(m.key);
    } else {
      focusRect(m.rect);
    }
  }


  // ---- saving where things lie --------------------------------------------------

  const { steps, remember, step } = useSteps({ songs, layout, tiles, layoutNow, tilesNow, putLayout, putTiles });
  const stepNow = useRef(step);
  stepNow.current = step;

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
    return { lanes, free: layout.free };
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
    saveLayout({ lanes: {}, free: layout.free });
    fitted.current = false;
    requestAnimationFrame(() => fit());
  }

  const finish = useRef<(d: Drag) => void>(() => {});
  finish.current = (d: Drag) => {
    if (d.kind === "node") {
      // A node lies wherever it is put; only wires change what it is wired to.
      const p = basePlaced.find((x) => x.lane.path === d.lane);
      if (!p) return;
      const was = p.at.get(d.key)!;
      setFree(p.lane, d.key, [snap(p.origin.x + was.x + d.by.x), snap(p.origin.y + was.y + d.by.y)]);
    } else if (d.kind === "lane") {
      saveLayout(pinAll({ lanes: [d.lane], by: d.by }));
      // What lies on the lane goes with it.
      if (d.tiles.length) {
        saveTiles(tiles.map((t) => (d.tiles.includes(t.id) ? { ...t, x: snap(t.x + d.by.x), y: snap(t.y + d.by.y) } : t)));
      }
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

  /** Any node of a lane can be taken out of it and put anywhere, with its wires. */
  function dragNode(e: React.PointerEvent, lane: Lane, key: string) {
    beginDrag(e, (by) => ({ kind: "node", lane: lane.path, key, by }));
  }

  /** The song with everything in its lane, and whatever lies on it. */
  function dragLane(e: React.PointerEvent, lane: Lane) {
    const p = basePlaced.find((x) => x.lane === lane);
    const on = p ? tiles.filter((t) => t.kind !== "frame" && inside(t, laneRect(p))).map((t) => t.id) : [];
    beginDrag(e, (by) => ({ kind: "lane", lane: lane.path, by, tiles: on }));
  }

  /** Takes a node out of its lane to lie at `at`, or (null) puts it back in. */
  function setFree(lane: Lane, key: string, at: [number, number] | null) {
    const own = { ...(lane.names.map((n) => layout.free[n]).find((m) => m !== undefined) ?? {}) };
    if (at) own[key] = at;
    else if (own[key] === undefined) return;
    else delete own[key];
    const free = { ...layout.free };
    for (const n of lane.names) delete free[n];
    if (Object.keys(own).length) free[lane.path] = own;
    saveLayout({ ...pinAll(), free });
  }

  const isFree = (lane: Lane, key: string) => !!basePlaced.find((p) => p.lane === lane)?.free.has(key);
  /** "Back into the lane" for a node taken out of it. */
  const backIn = (lane: Lane, key: string): MenuItem[] =>
    isFree(lane, key) ? [{ label: "Вернуть в дорожку", icon: "undo", run: () => setFree(lane, key, null) }] : [];

  /** Every node of the lane back in it. */
  function gather(lane: Lane) {
    const free = { ...layout.free };
    for (const n of lane.names) delete free[n];
    saveLayout({ ...pinAll(), free });
  }

  // ---- wires --------------------------------------------------------------------

  const songName = (lane: Lane) => splitPath(lane.path).name;
  const versionName = (n: SongVersion) => (n.number ? `версия ${n.number}` : "удаление");

  /** A pin's place on the canvas, as drawn now. */
  function pinAt(lanePath: string, key: string, side: "in" | "out"): Point | null {
    const p = placed.find((x) => x.lane.path === lanePath);
    const at = p?.at.get(key);
    if (!p || !at) return null;
    return { x: p.origin.x + at.x + (side === "out" ? nodeSize(key).w - 6 : 6), y: p.origin.y + at.y + PIN_Y };
  }

  /** The node under the pointer a wire can go to; for an output also "+ файл" and "+ ветка". */
  function endAt(x: number, y: number, side: "in" | "out"): WireEnd | null {
    const el = document.elementFromPoint(x, y);
    const lane = el?.closest<HTMLElement>(".bp-lane[data-lane]")?.dataset.lane;
    if (!el || lane === undefined) return null;
    if (side === "out") {
      const add = el.closest<HTMLElement>("[data-add-to]")?.dataset.addTo;
      if (add !== undefined) return { lane, key: addKey(add), side };
      if (el.closest("[data-new-branch]")) return { lane, key: NEW_BRANCH_KEY, side };
    }
    const key = el.closest<HTMLElement>("[data-node]")?.dataset.node;
    return key === undefined ? null : { lane, key, side };
  }

  /**
   * What plugging the input of `into` into the output of `anchor` does. In
   * one song it rewires the version (with what follows it); a file of
   * another song is copied in as a new version there, and stays as it is.
   */
  function planWire(anchor: WireEnd, into: WireEnd, moving: Wire | null): Plan {
    const la = lanes?.find((l) => l.path === anchor.lane);
    const ln = lanes?.find((l) => l.path === into.lane);
    if (!la || !ln) return { ok: false, hint: "" };
    const n = ln.nodes.find((x) => nodeKey(x) === into.key);
    if (!n) {
      return {
        ok: false,
        hint: into.key.startsWith(BRANCH_PREFIX) ? "Ветка всегда идёт от своей песни" : "Сюда провод не подключить",
      };
    }
    // After a version, first in a branch, last in a branch, or in a new one (null).
    let after: string | null = null;
    let branch = "";
    let where = "в новую ветку…";
    if (anchor.key === LOOSE_KEY) {
      return { ok: false, hint: "Здесь версии без ветки: подключите провод к ветке или к версии" };
    } else if (anchor.key.startsWith("+:")) {
      branch = anchor.key.slice(2);
      after = la.branches.find((b) => b.name === branch)?.head || branchKey(branch);
      where = `в конец ветки «${branch}»`;
    } else if (anchor.key.startsWith(BRANCH_PREFIX)) {
      branch = anchor.key.slice(BRANCH_PREFIX.length);
      after = anchor.key;
      where = `первой в ветку «${branch}»`;
    } else if (anchor.key !== SONG_KEY && anchor.key !== NEW_BRANCH_KEY) {
      const v = la.nodes.find((x) => nodeKey(x) === anchor.key);
      if (v?.kind !== "version")
        return { ok: false, hint: "От «Сейчас в папке» провода нет: сначала сохраните версию" };
      after = v.key;
      branch = v.branch;
      where = v.branch ? `в ветку «${v.branch}» после: ${versionName(v)}` : `после: ${versionName(v)}, без ветки`;
    }

    if (la === ln) {
      if (n.kind === "work") return { ok: false, hint: "«Сейчас в папке» всегда идёт от версии, которая в папке" };
      const label = n.number ? `Версия ${n.number}` : "Удаление";
      // A wire moved off this version leaves it unplugged.
      const base = moving && moving.to !== n.key ? { ...la, links: unplug(la, moving.to) } : la;
      if (after === null) {
        return {
          ok: true,
          hint: `${label} — в новую ветку…`,
          run: () =>
            setNaming({
              lane: la,
              hint: `${label} «${songName(la)}» и то, что идёт за ней, уйдут в новую ветку. Файлы не меняются.`,
              confirm: "Перенести",
              make: (name) => {
                const links = connect(base, branchKey(name), n.key);
                if (links) rewire(la, links, n.key);
              },
            }),
        };
      }
      if (after === n.key) return { ok: false, hint: "Версию не подключить к самой себе" };
      if (base === la && follows(la, after, n.key)) return { ok: false, hint: "Уже подключена здесь" };
      const links = connect(base, after, n.key);
      if (!links) return { ok: false, hint: "Получится круг: та версия идёт после этой" };
      return { ok: true, hint: `${label} ${where}`, run: () => rewire(la, links, n.key) };
    }

    if (!growing(la)) return { ok: false, hint: `«${songName(la)}» нет в папке: в неё не добавить версию` };
    let source: TakeSource;
    let what: string;
    if (n.kind === "work") {
      if (n.status === "deleted") return { ok: false, hint: "Этого файла нет на диске" };
      source = { folder: n.path };
      what = songName(ln);
    } else {
      if (n.change === "deleted" || n.pruned) return { ok: false, hint: "У этой версии нет файла" };
      source = { version: { rev: n.version.id, path: n.path } };
      what = `${songName(ln)}, ${versionName(n)}`;
    }
    const hint = `Копия «${what}» → «${songName(la)}», ${where}`;
    if (after === null) {
      return {
        ok: true,
        hint,
        run: () =>
          setNaming({
            lane: la,
            hint: `Копия «${what}» станет первой версией новой ветки «${songName(la)}». «${songName(ln)}» не меняется.`,
            confirm: "Создать ветку",
            make: (name) => songs.copyInto(la, null, name, source, what),
          }),
      };
    }
    return { ok: true, hint, run: () => songs.copyInto(la, after, branch, source, what) };
  }

  /** The song wired anew; Ctrl+Z brings back how it was, and `moved` shines for a moment. */
  function rewire(lane: Lane, links: SongLinks, moved?: string) {
    remember(lane);
    songs.relink(lane, links);
    if (moved) shine(moved);
  }

  /** A version shines for a moment, to be seen. */
  function shine(key: string) {
    setFlash(key);
    setTimeout(() => setFlash((f) => (f === key ? null : f)), 1600);
  }

  /** Unplugs version `key`: it and what follows it are wired into no branch. */
  function cut(lane: Lane, key: string) {
    const n = lane.nodes.find((x): x is SongVersion => x.kind === "version" && x.key === key);
    if (!n) return;
    rewire(lane, unplug(lane, key), key);
    toast(`${n.number ? `Версия ${n.number}` : "Удаление"} «${songName(lane)}» без ветки · Ctrl+Z — вернуть`, "info");
  }

  function breakWire(lane: Lane, w: Wire) {
    if (w.kind === "song")
      toast("Ветка всегда идёт от своей песни. Чтобы разобрать ветку, оборвите провод к её первой версии", "info");
    else if (w.kind === "work") toast("«Сейчас в папке» всегда идёт от версии, которая лежит в папке", "info");
    else cut(lane, w.to);
  }

  /** Read when the pointer moves, so a long pull always works on what is drawn now. */
  const wiresNow = useRef({ endAt, planWire, toCanvas, cut });
  wiresNow.current = { endAt, planWire, toCanvas, cut };

  /** Pulls a wire from `fixed`; let go over a node, it plugs in there. Esc lets go of it. */
  function startPull(e: React.PointerEvent, fixed: WireEnd, moving: Wire | null) {
    if (e.button !== 0) return;
    e.stopPropagation();
    suppressClick.current = false;
    const start = { x: e.clientX, y: e.clientY };
    const want = fixed.side === "out" ? "in" : "out";
    let last: Pull | null = null;
    const plan = (target: WireEnd | null): Plan => {
      const now = wiresNow.current;
      if (!target) return moving ? { ok: true, hint: "Отпустите — провод оборвётся" } : { ok: false, hint: "" };
      return fixed.side === "out" ? now.planWire(fixed, target, moving) : now.planWire(target, fixed, moving);
    };
    const onMove = (ev: PointerEvent) => {
      if (!last && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) <= 4) return;
      if (!last) noSelecting(true);
      suppressClick.current = true;
      const now = wiresNow.current;
      const target = now.endAt(ev.clientX, ev.clientY, want);
      const { ok, hint } = plan(target);
      const r = box?.getBoundingClientRect() ?? { left: 0, top: 0 };
      last = {
        fixed,
        moving,
        at: now.toCanvas(ev.clientX, ev.clientY),
        screen: { x: ev.clientX - r.left, y: ev.clientY - r.top },
        target,
        hint,
        ok,
      };
      setPull(last);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("keydown", onKey, true);
      noSelecting(false);
      setPull(null);
    };
    const onUp = () => {
      stop();
      if (!last) return;
      const lane = lanes?.find((l) => l.path === fixed.lane);
      if (!last.target) {
        if (moving && lane) wiresNow.current.cut(lane, moving.to);
        return;
      }
      const todo = plan(last.target);
      if (todo.ok) todo.run?.();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      last = null;
      stop();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("keydown", onKey, true);
  }

  /** A new wire from a pin; Alt + click unplugs it, as in a blueprint. */
  function pullPin(e: React.PointerEvent, lane: Lane, key: string, side: "in" | "out") {
    if (e.button === 0 && e.altKey) {
      e.stopPropagation();
      const into = side === "in" ? key : wiresOf(lane).find((w) => w.kind === "chain" && w.from === key)?.to;
      if (into) cut(lane, into);
      return;
    }
    startPull(e, { lane: lane.path, key, side }, null);
  }

  /** A wire there is, by the end nearer the pointer; the other end stays. */
  function grabWire(e: React.PointerEvent, lane: Lane, w: Wire) {
    const at = toCanvas(e.clientX, e.clientY);
    const a = pinAt(lane.path, w.from, "out");
    const b = pinAt(lane.path, w.to, "in");
    if (!a || !b) return;
    const nearIn = Math.hypot(at.x - b.x, at.y - b.y) < Math.hypot(at.x - a.x, at.y - a.y);
    startPull(
      e,
      nearIn ? { lane: lane.path, key: w.from, side: "out" } : { lane: lane.path, key: w.to, side: "in" },
      w,
    );
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

  // Esc closes the help sheet, then the file panel with the selection; an open menu and a pulled wire take it first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || menu || editing || (!help && !selected && !selectedTile)) return;
      // A field in the file panel (the description) gives Esc to the panel: what was typed stays as the draft.
      const field = (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
      if (e.isComposing || (field && !field.closest(".bp-panel"))) return;
      // A dialog takes Esc, also one it has closed already (its listener may come first): the target is gone then.
      const target = e.target as HTMLElement;
      if (target.closest(".modal-backdrop") || !document.contains(target)) return;
      if (document.querySelector(".modal-backdrop")) return;
      if (help) {
        setHelp(false);
        return;
      }
      setSelected(null);
      setSelectedTile(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // F shows everything, + and − zoom, 0 returns to 100%, Ctrl+F finds,
  // Ctrl+Z takes back, Ctrl+Shift+Z (or Ctrl+Y) brings back what was taken back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const forth = (e.code === "KeyZ" && e.shiftKey) || (e.code === "KeyY" && !e.shiftKey);
      if ((e.ctrlKey || e.metaKey) && !e.altKey && ((e.code === "KeyZ" && !e.shiftKey) || forth)) {
        if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
        if (document.querySelector(".modal-backdrop")) return;
        e.preventDefault();
        stepNow.current(forth ? "forth" : "back");
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
      if (e.key === "?") setHelp((h) => !h);
      else if (e.code === "KeyF" || e.code === "Home") fit();
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

  /** Only this version to another branch of its song; the versions after it close up. Files do not change. */
  function moveToBranch(lane: Lane, n: SongVersion, to: string) {
    if (n.branch === to) return;
    rewire(lane, moveOne(lane, n, to), n.key);
    toast(`${n.number ? `Версия ${n.number}` : "Удаление"} «${songName(lane)}» теперь в ветке «${to}»`, "ok");
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
    const items: MenuItem[] = backIn(lane, n.key);
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
    for (const b of lane.branches.filter((b) => b.name !== n.branch)) {
      items.push({ label: `Перенести в ветку «${b.name}»`, icon: "branch", run: () => moveToBranch(lane, n, b.name) });
    }
    items.push({
      label: "Перенести в новую ветку…",
      icon: "branch",
      run: () =>
        setNaming({
          lane,
          hint: `Только ${versionName(n)} уйдёт ${n.branch ? `из ветки «${n.branch}» ` : ""}в новую ветку. Файлы не меняются.`,
          confirm: "Перенести",
          make: (name) => moveToBranch(lane, n, name),
        }),
    });
    if (n.branch) items.push({ label: "Оборвать провод (без ветки)", icon: "close", run: () => cut(lane, n.key) });
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
      ...backIn(lane, "work"),
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
    const items: MenuItem[] = backIn(lane, branchKey(b.name));
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
          remember(lane);
          songs.joinBranch(lane, b.name, o.name);
        },
      });
    }
    if (!b.active && growing(lane)) {
      // Not a step to take back: the space it took is freed.
      items.push({ label: "Удалить ветку…", icon: "trash", danger: true, run: () => songs.deleteBranch(lane, b.name) });
    }
    return items;
  }

  function laneMenu(lane: Lane): MenuItem[] {
    const items: MenuItem[] = [];
    if (basePlaced.find((p) => p.lane === lane)?.free.size) {
      items.push({ label: "Собрать узлы в дорожку", icon: "undo", run: () => gather(lane) });
    }
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
    pullPin,
    grabWire,
    breakWire,
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
          </span>
          {unsaved > 0 && (
            <button
              className="chip bp-unsaved"
              onClick={nextUnsaved}
              title="Показать следующий несохранённый файл и открыть его сохранение"
            >
              <Icon name="edit" size={12} /> не сохранено · {unsaved}
            </button>
          )}
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
              placeholder="Найти песню, ветку, версию, заметку"
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
          <span className="bp-steps">
            <button
              className="icon-btn"
              disabled={!steps.back}
              onClick={() => step("back")}
              title="Отменить (Ctrl+Z)"
              aria-label="Отменить"
            >
              <Icon name="undo" size={14} />
            </button>
            <button
              className="icon-btn bp-redo"
              disabled={!steps.forth}
              onClick={() => step("forth")}
              title="Вернуть отменённое (Ctrl+Shift+Z)"
              aria-label="Вернуть отменённое"
            >
              <Icon name="undo" size={14} />
            </button>
          </span>
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
          <button
            className={`bp-help ${help ? "on" : ""}`}
            onClick={() => setHelp((h) => !h)}
            title="Как работать со схемой (?)"
            aria-expanded={help}
          >
            ?
          </button>
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
          className={`bp ${panning ? "panning" : ""} ${drag ? "dragging" : ""} ${pull ? "wiring" : ""}`}
          style={gridStyle}
          {...look.panHandlers}
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
                hits={hits.get(p.lane.path) ?? null}
                hitNow={hitNow?.lane === p.lane.path ? hitNow.key : null}
                pullAt={pull?.target?.lane === p.lane.path ? `${pull.ok ? "ok" : "bad"}:${pull.target.key}` : null}
                pullWire={
                  pull?.moving && pull.fixed.lane === p.lane.path ? `${pull.moving.from}>${pull.moving.to}` : null
                }
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
            {pull && <LiveWire pull={pull} pinAt={pinAt} />}
          </div>
          {pull?.hint && (
            <div
              className={`bp-pull-hint ${pull.ok ? "" : "bad"}`}
              style={{ left: pull.screen.x + 18, top: pull.screen.y + 14 }}
            >
              {pull.hint}
            </div>
          )}

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
          {help && <HelpSheet />}
        </div>
      </div>

      {menu && (
        <div
          ref={menuBox}
          className="popover bp-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 276),
            top: menuTop(menu),
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
        <aside ref={panelBox} className="bp-panel scroll">
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
            remember(lane);
            songs.renameBranch(lane, name, to);
          }}
          onClose={() => setRenamingBranch(null)}
        />
      )}
      {naming && (
        <PromptDialog
          title={`Новая ветка «${songName(naming.lane)}»`}
          label="Название ветки"
          placeholder="Например: акустика, ремикс"
          confirm={naming.confirm}
          hint={naming.hint}
          onSubmit={async (name) => {
            if (naming.lane.branches.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
              throw new Error(`У трека уже есть ветка «${name}»`);
            }
            await naming.make(name);
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
