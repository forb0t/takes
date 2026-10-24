import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type ChangeKind, type GraphVersion, type Overview, type RemovedFile } from "../api";
import {
  HEAD_W,
  NODE_H,
  NODE_W,
  bodyWidth,
  buildLanes,
  laneGroup,
  laneHeight,
  nodeX,
  nodeY,
  previousVersion,
  songHue,
  wire,
  type Lane,
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
const ZOOMS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3];

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
 * The project as lanes of songs: each song's versions from left to right,
 * forks for other branches, and the file on disk at the end when it is not
 * saved. Everything a file allows can be done right here.
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
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  /** The file being renamed. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [drag, setDrag] = useState<{ path: string; to: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const laneEls = useRef(new Map<string, HTMLDivElement>());
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
  const tagsOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of overview.tags) map.set(t.target, [...(map.get(t.target) ?? []), t.name]);
    return map;
  }, [overview.tags]);

  // Ctrl + wheel zooms; the plain wheel scrolls as everywhere else.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => step(z, e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [lanes !== null]);

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

  function startDrag(e: React.PointerEvent, lane: Lane) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const [lo, hi] = groupRange(lane);
    let target: number | null = null;
    const onMove = (ev: PointerEvent) => {
      let to = visible.length;
      for (let i = 0; i < visible.length; i++) {
        const r = laneEls.current.get(visible[i].path)?.getBoundingClientRect();
        if (r && ev.clientY < r.top + r.height / 2) {
          to = i;
          break;
        }
      }
      target = Math.min(Math.max(to, lo), hi);
      setDrag({ path: lane.path, to: target });
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      setDrag(null);
      if (target !== null) move(lane.path, target);
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
  ];

  // ---- drawing ------------------------------------------------------------------

  if (error) return <div className="center error-text">{error}</div>;
  if (!lanes) return <div className="center muted">Строю схему…</div>;

  if (lanes.length === 0) {
    return (
      <div className="center">
        <Empty icon="wave" title="Здесь появится схема проекта">
          У каждой песни будет своя дорожка: версии слева направо, ответвления для других веток и то, что сейчас лежит
          в папке.
          <div className="empty-actions">
            <button className="btn btn-primary" onClick={() => onAddFiles("files")}>
              <Icon name="plus" /> Добавить файлы
            </button>
          </div>
        </Empty>
      </div>
    );
  }

  const cols = Math.max(...visible.map((l) => l.cols), 1);
  const width = bodyWidth(cols);
  const songs = lanes.filter((l) => laneGroup(l) === 0).length;
  const unsaved = lanes.filter((l) => l.nodes.some((n) => n.kind === "work")).length;
  const removedCount = lanes.length - lanes.filter((l) => l.status !== "removed").length;

  const panelLane = selected ? lanes.find((l) => l.path === selected.path) : undefined;
  const panelNode = panelLane && selected?.key ? panelLane.nodes.find((n) => n.key === selected.key) : undefined;
  const panelVersion = panelNode?.kind === "version" ? panelNode : null;
  const newestVersion = panelLane
    ? [...panelLane.nodes].reverse().find((n): n is SongVersion => n.kind === "version")
    : undefined;

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
            <span className="bp-swatch-node" /> версия
            <span className="bp-swatch-node work" /> сейчас на диске
            <span className="bp-here">в папке</span> лежит в папке
          </span>
          <div className="bp-zoom" title="Масштаб: Ctrl + колесо мыши">
            <button className="icon-btn" onClick={() => setZoom((z) => step(z, -1))} aria-label="Мельче">
              <Icon name="minus" size={14} />
            </button>
            <button className="bp-zoom-value" onClick={() => setZoom(1)} title="Вернуть 100%">
              {Math.round(zoom * 100)}%
            </button>
            <button className="icon-btn" onClick={() => setZoom((z) => step(z, 1))} aria-label="Крупнее">
              <Icon name="plus" size={14} />
            </button>
          </div>
        </div>

        <div ref={box} className="bp scroll" onContextMenu={(e) => openMenu(e, canvasMenu)}>
          <div className="bp-canvas" style={{ zoom, width: HEAD_W + width }}>
            {visible.map((lane, i) => {
              const { dir, name } = splitPath(lane.path);
              const file = files?.find((f) => f.path === lane.path);
              const height = laneHeight(lane);
              return (
                <div
                  key={lane.path}
                  ref={(el) => {
                    if (el) laneEls.current.set(lane.path, el);
                    else laneEls.current.delete(lane.path);
                  }}
                  className={[
                    "bp-lane",
                    `lane-${lane.status}`,
                    selected?.path === lane.path ? "selected" : "",
                    drag?.to === i && drag.path !== lane.path ? "drop-before" : "",
                    drag && drag.to === visible.length && i === visible.length - 1 ? "drop-after" : "",
                    drag?.path === lane.path ? "dragging" : "",
                  ].join(" ")}
                  style={{ height, ["--hue" as string]: songHue(lane.path) }}
                >
                  <div
                    className="bp-lane-head"
                    onClick={() => select(lane.path, null)}
                    onContextMenu={(e) => openMenu(e, laneMenu(lane))}
                  >
                    <span
                      className="bp-grip"
                      onPointerDown={(e) => startDrag(e, lane)}
                      onClick={(e) => e.stopPropagation()}
                      title="Перетащите, чтобы поменять порядок песен (он общий для всех устройств)"
                    >
                      <Icon name="grip" size={16} />
                    </span>
                    <div className="bp-lane-info">
                      <div className="bp-lane-title">
                        {lane.status !== "saved" && lane.status !== "removed" && lane.status !== "elsewhere" ? (
                          <KindBadge kind={lane.status} />
                        ) : (
                          <span className="bp-lane-dot" />
                        )}
                        <span className="bp-lane-name" title={lane.path}>
                          {name}
                        </span>
                      </div>
                      <div className="bp-lane-meta">
                        {dir && <span className="bp-lane-dir">{dir.slice(0, -1)} · </span>}
                        {laneText(lane)}
                      </div>
                      {file && file.labels.length > 0 && <FileLabels labels={file.labels} />}
                    </div>
                    <button
                      className="icon-btn"
                      title="Действия с песней"
                      onClick={(e) => openMenu(e, laneMenu(lane))}
                    >
                      <Icon name="more" />
                    </button>
                  </div>

                  <div className="bp-lane-body" style={{ width }}>
                    <svg className="bp-wires" width={width} height={height}>
                      {lane.nodes.flatMap((n) =>
                        (n.kind === "work" ? (n.parent ? [n.parent] : []) : n.parents).map((p) => {
                          const from = lane.nodes.find((x) => x.key === p);
                          if (!from) return null;
                          const elsewhere = n.kind === "version" && !n.onCurrent;
                          return (
                            <path
                              key={`${p}>${n.key}`}
                              d={wire(from, n)}
                              className={`bp-wire ${n.kind === "work" ? "work" : ""} ${elsewhere ? "elsewhere" : ""}`}
                            />
                          );
                        }),
                      )}
                    </svg>
                    {lane.nodes.map((n) => {
                      const style = { left: nodeX(n.col), top: nodeY(n.row), width: NODE_W, height: NODE_H };
                      const isSelected = selected?.key === n.key;
                      if (n.kind === "work") {
                        const prev = previousVersion(lane, n);
                        const draft = drafts.get(n.path).trim();
                        return (
                          <div
                            key={n.key}
                            className={`bp-node bp-work status-${n.status} ${isSelected ? "selected" : ""}`}
                            style={style}
                            onClick={() => select(lane.path, n.key, true)}
                            onContextMenu={(e) => openMenu(e, workMenu(lane, n))}
                            title="Файл в папке сейчас: щёлкните, чтобы описать и сохранить"
                          >
                            <div className="bp-node-head">
                              <span className="bp-num">сейчас</span>
                              <span className={`bp-state bp-state-${n.status}`}>{WORK_WORD[n.status]}</span>
                            </div>
                            <div className="bp-node-msg">
                              {draft || <i>{n.status === "deleted" ? "файла нет в папке" : "не сохранено"}</i>}
                            </div>
                            <div className="bp-node-foot">
                              {n.status !== "deleted" && <PlayButton track={nowTrack(n.path)} />}
                              {n.status === "modified" && prev && !prev.pruned && (
                                <CompareButton a={versionTrack(prev)} b={nowTrack(n.path)} />
                              )}
                              <span className="grow" />
                              <button
                                className="btn btn-small btn-primary"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  quickSave(n);
                                }}
                                title={
                                  draft
                                    ? "Сохранить с написанным описанием"
                                    : "Сохранить с автоматическим описанием; своё — щелчком по карточке"
                                }
                              >
                                Сохранить
                              </button>
                            </div>
                          </div>
                        );
                      }
                      const v = n.version;
                      const prev = previousVersion(lane, n);
                      const usable = n.change !== "deleted" && !n.pruned;
                      const tags = tagsOf.get(v.id) ?? [];
                      return (
                        <div
                          key={n.key}
                          className={[
                            "bp-node bp-version",
                            `change-${n.change}`,
                            n.onCurrent ? "" : "elsewhere",
                            v.parents.length > 1 ? "merge" : "",
                            isSelected ? "selected" : "",
                          ].join(" ")}
                          style={style}
                          onClick={() => select(lane.path, n.key)}
                          onContextMenu={(e) => openMenu(e, versionMenu(lane, n))}
                          title={`${v.message || "без описания"}\n${formatDate(v.createdAt)} · ${v.author} · ${short(v.id)}`}
                        >
                          <div className="bp-node-head">
                            {v.parents.length > 1 && <Icon name="merge" size={12} />}
                            <span className="bp-num">{n.number ? `v${n.number}` : "удалён"}</span>
                            {n.change === "renamed" && (
                              <span className="bp-state bp-state-renamed" title={`Было: ${n.from ?? ""}`}>
                                переименован
                              </span>
                            )}
                            {n.inFolder && (
                              <span className="bp-here" title="Эта версия сейчас лежит в папке проекта">
                                в папке
                              </span>
                            )}
                            <FileLabels labels={n.labels} />
                            <span className="grow" />
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
                          </div>
                          <div className="bp-node-msg">{v.message || <i>без описания</i>}</div>
                          <div className="bp-node-foot">
                            <span className="bp-node-date">
                              {formatDate(v.createdAt)} · {v.author}
                            </span>
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
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
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
            file={files?.find((f) => f.path === panelLane.path) ?? null}
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

/** The next zoom step up (+1) or down (−1). */
function step(zoom: number, dir: 1 | -1): number {
  const i = ZOOMS.findIndex((z) => z >= zoom - 0.001);
  const at = i < 0 ? ZOOMS.length - 1 : i;
  return ZOOMS[Math.min(Math.max(at + dir, 0), ZOOMS.length - 1)];
}
