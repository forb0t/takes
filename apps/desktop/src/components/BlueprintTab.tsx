import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type GraphVersion, type Overview } from "../api";
import {
  BRANCH_H,
  BRANCH_W,
  NODE_H,
  NODE_W,
  PIN_EXEC_Y,
  PIN_SONG_Y,
  SONG_H,
  SONG_W,
  layout,
  nodeSize,
  songHue,
  wireEnds,
  wirePath,
  type DiagramNode,
  type NodeKey,
} from "../blueprint";
import { Empty, Icon, PromptDialog, useToast, type IconName } from "../ui";
import { formatDate, labelsById, plural, short, splitPath } from "../util";
import { VersionDetail } from "./HistoryTab";

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2;

type Point = { x: number; y: number };
type Menu = { at: Point; node: DiagramNode | null };
type Prompt = { kind: "branch" | "tag"; rev: string; label: string };

const KIND_WORD = { added: "новый", modified: "изменён", deleted: "удалён" } as const;

/** Keeps a context menu inside the canvas: it opens up or left near the edges. */
function menuPlace(at: Point, items: number, box: HTMLElement | null): { left: number; top: number } {
  const width = 260;
  const height = items * 36 + 14;
  const rect = box?.getBoundingClientRect();
  if (!rect) return { left: at.x, top: at.y };
  return {
    left: at.x + width > rect.width - 8 ? Math.max(8, at.x - width) : at.x,
    top: at.y + height > rect.height - 8 ? Math.max(8, at.y - height) : at.y,
  };
}

/** Moved nodes per project, so a hand-made arrangement survives restarts. */
function loadPositions(root: string): Record<NodeKey, [number, number]> {
  try {
    return JSON.parse(localStorage.getItem(`takes.blueprint:${root}`) ?? "{}");
  } catch {
    return {};
  }
}

function savePositions(root: string, positions: Record<NodeKey, [number, number]>) {
  try {
    localStorage.setItem(`takes.blueprint:${root}`, JSON.stringify(positions));
  } catch {
    // Storage is a convenience; the layout works without it.
  }
}

/**
 * The project as a node graph, like a blueprint: songs, their versions on
 * branch lanes and the branches, wired together. Right-click for actions.
 */
export function BlueprintTab({
  overview,
  onChanged,
  onAddFiles,
  onOpenFile,
  onUploadVersion,
  onMerge,
}: {
  overview: Overview;
  onChanged: () => void;
  onAddFiles: (what: "files" | "folder") => void;
  onOpenFile: (path: string) => void;
  onUploadVersion: (path: string) => void;
  onMerge: (branch: string) => void;
}) {
  const root = overview.root;
  const toast = useToast();
  const [versions, setVersions] = useState<GraphVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [positions, setPositions] = useState(() => loadPositions(root));
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [selected, setSelected] = useState<NodeKey | null>(null);
  const [hoverSong, setHoverSong] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  const branchesKey = overview.branches.map((b) => `${b.name}@${b.head}`).join() + overview.tags.length;

  useEffect(() => {
    let alive = true;
    api
      .historyGraph(root)
      .then((v) => alive && (setVersions(v), setError(null)))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [root, branchesKey]);

  const diagram = useMemo(() => {
    const d = layout(versions ?? [], overview.branches);
    for (const [key, node] of d.nodes) {
      const moved = positions[key];
      if (moved) d.nodes.set(key, { ...node, x: moved[0], y: moved[1] });
    }
    return d;
  }, [versions, overview.branches, positions]);

  const labels = useMemo(() => labelsById(overview), [overview]);
  const tagsOf = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of overview.tags) map.set(t.target, [...(map.get(t.target) ?? []), t.name]);
    return map;
  }, [overview.tags]);

  // ---- view: fit, pan, zoom -----------------------------------------------------

  const fit = useCallback(
    (focus?: DiagramNode) => {
      const el = box.current;
      if (!el || diagram.nodes.size === 0) return;
      const { width, height } = el.getBoundingClientRect();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of diagram.nodes.values()) {
        const { w, h } = nodeSize(n);
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + w);
        maxY = Math.max(maxY, n.y + h);
      }
      const zoom = Math.min(1, (width - 80) / (maxX - minX), (height - 80) / (maxY - minY));
      if (zoom >= 0.45 || !focus) {
        const z = Math.max(MIN_ZOOM, zoom);
        setView({
          zoom: z,
          x: (width - (maxX - minX) * z) / 2 - minX * z,
          y: (height - (maxY - minY) * z) / 2 - minY * z,
        });
      } else {
        // Too big to see whole: show where work happens now.
        const z = 0.8;
        setView({ zoom: z, x: width * 0.62 - (focus.x + NODE_W / 2) * z, y: height * 0.4 - focus.y * z });
      }
    },
    [diagram],
  );

  useLayoutEffect(() => {
    if (fitted.current || !versions) return;
    fitted.current = true;
    fit(overview.head ? diagram.nodes.get(`v:${overview.head}`) : undefined);
  }, [versions, diagram, fit, overview.head]);

  const drag = useRef<
    | { mode: "pan"; start: Point; origin: Point }
    | { mode: "node"; key: NodeKey; start: Point; origin: Point; moved: boolean; at?: [number, number] }
    | null
  >(null);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button === 2) return;
    setMenu(null);
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-node]");
    if (target && e.button === 0) {
      const key = target.dataset.node!;
      const node = diagram.nodes.get(key)!;
      drag.current = { mode: "node", key, start: { x: e.clientX, y: e.clientY }, origin: { x: node.x, y: node.y }, moved: false };
    } else {
      drag.current = { mode: "pan", start: { x: e.clientX, y: e.clientY }, origin: { x: view.x, y: view.y } };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.start.x;
    const dy = e.clientY - d.start.y;
    // Capture only once it is a drag, so clicks and double clicks still
    // reach the nodes.
    if (Math.abs(dx) + Math.abs(dy) > 3 && !e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (d.mode === "pan") {
      setView((v) => ({ ...v, x: d.origin.x + dx, y: d.origin.y + dy }));
    } else if (d.moved || Math.abs(dx) + Math.abs(dy) > 3) {
      d.moved = true;
      const at: [number, number] = [d.origin.x + dx / view.zoom, d.origin.y + dy / view.zoom];
      d.at = at;
      setPositions((p) => ({ ...p, [d.key]: at }));
    }
  }

  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === "node") {
      // `positions` may not have the last move rendered yet.
      if (d.moved && d.at) savePositions(root, { ...positions, [d.key]: d.at });
      else setSelected(d.key);
    } else if (Math.abs(view.x - d.origin.x) + Math.abs(view.y - d.origin.y) < 3) {
      setSelected(null);
    }
  }

  function onWheel(e: React.WheelEvent) {
    const rect = box.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * Math.exp(-e.deltaY * 0.0015)));
      return { zoom, x: cx - ((cx - v.x) * zoom) / v.zoom, y: cy - ((cy - v.y) * zoom) / v.zoom };
    });
  }

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-node]");
    const rect = box.current!.getBoundingClientRect();
    setMenu({
      at: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      node: target ? (diagram.nodes.get(target.dataset.node!) ?? null) : null,
    });
  }

  function arrange() {
    setPositions({});
    savePositions(root, {});
    // Fitted again by the layout effect, once the new layout is rendered.
    fitted.current = false;
  }

  // ---- actions ------------------------------------------------------------------

  async function switchTo(name: string) {
    try {
      await api.switchBranch(root, name);
      toast(`Вы на ветке «${name}»`, "ok");
      onChanged();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  async function removeBranch(name: string) {
    const ok = await ask(`Удалить ветку «${name}»? Версии, которые есть только в ней, пропадут из истории.`, {
      title: "Удалить ветку?",
      kind: "warning",
      okLabel: "Удалить",
      cancelLabel: "Отмена",
    });
    if (!ok) return;
    try {
      await api.deleteBranch(root, name);
      toast(`Ветка «${name}» удалена`, "ok");
      onChanged();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  function menuItems(node: DiagramNode | null): { label: string; icon: IconName; run: () => void; danger?: boolean }[] {
    const head = overview.head;
    if (!node) {
      return [
        { label: "Добавить песни (файлы)…", icon: "plus", run: () => onAddFiles("files") },
        { label: "Добавить папку…", icon: "folder", run: () => onAddFiles("folder") },
        ...(head
          ? [{ label: "Новая ветка от текущей версии…", icon: "branch" as const, run: () => setPrompt({ kind: "branch", rev: head, label: "текущей версии" }) }]
          : []),
        { label: "Показать всё", icon: "wave", run: () => fit() },
      ];
    }
    if (node.kind === "song") {
      return [
        { label: "История файла", icon: "restore", run: () => onOpenFile(node.path) },
        { label: "Загрузить новую версию…", icon: "download", run: () => onUploadVersion(node.path) },
        {
          label: "Показать в папке",
          icon: "folder",
          run: () => api.reveal(`${root}/${node.path}`).catch((e) => toast(errorText(e), "error")),
        },
      ];
    }
    if (node.kind === "branch") {
      const b = node.branch;
      return [
        ...(b.current
          ? []
          : [
              { label: "Перейти на эту ветку", icon: "check" as const, run: () => switchTo(b.name) },
              { label: `Слить в «${overview.branch}»…`, icon: "merge" as const, run: () => onMerge(b.name) },
            ]),
        { label: "Новая ветка отсюда…", icon: "branch", run: () => setPrompt({ kind: "branch", rev: b.head!, label: `ветки «${b.name}»` }) },
        ...(b.current ? [] : [{ label: "Удалить ветку", icon: "trash" as const, run: () => removeBranch(b.name), danger: true }]),
      ];
    }
    const v = node.version;
    return [
      { label: "Подробнее", icon: "doc", run: () => setSelected(node.key) },
      { label: "Новая ветка отсюда…", icon: "branch", run: () => setPrompt({ kind: "branch", rev: v.id, label: `версии ${short(v.id)}` }) },
      { label: "Отметить версию…", icon: "tag", run: () => setPrompt({ kind: "tag", rev: v.id, label: `версию ${short(v.id)}` }) },
      ...(node.song ? [{ label: "История файла", icon: "restore" as const, run: () => onOpenFile(node.song!) }] : []),
    ];
  }

  // ---- drawing ------------------------------------------------------------------

  const songOfSelection = (() => {
    const n = selected ? diagram.nodes.get(selected) : null;
    return n?.kind === "song" ? n.path : n?.kind === "version" ? n.song : null;
  })();
  const focusSong = hoverSong ?? songOfSelection;

  const wires = useMemo(
    () =>
      diagram.wires.map((w) => {
        const from = diagram.nodes.get(w.from);
        const to = diagram.nodes.get(w.to);
        if (!from || !to) return null;
        const d = wirePath(wireEnds(w, from, to), w.song ? (songHue(w.song) % 5) * 7 : 0);
        const color = w.kind === "song" ? `hsl(${songHue(w.song!)} 70% 62%)` : undefined;
        const dim = focusSong && (w.kind !== "song" || w.song !== focusSong);
        return (
          <path key={w.key} d={d} className={`bp-wire bp-wire-${w.kind} ${dim ? "dim" : ""}`} style={color ? { stroke: color } : undefined} />
        );
      }),
    [diagram, focusSong],
  );

  const nodes = useMemo(
    () =>
      [...diagram.nodes.values()].map((n) => {
        const style = { left: n.x, top: n.y };
        const isSelected = selected === n.key;
        if (n.kind === "song") {
          const hue = songHue(n.path);
          const { dir, name } = splitPath(n.path);
          return (
            <div
              key={n.key}
              data-node={n.key}
              className={`bp-node bp-song ${isSelected ? "selected" : ""} ${focusSong && focusSong !== n.path ? "dim" : ""}`}
              style={{ ...style, width: SONG_W, height: SONG_H, ["--hue" as string]: hue }}
              onPointerEnter={() => setHoverSong(n.path)}
              onPointerLeave={() => setHoverSong(null)}
              onDoubleClick={() => onOpenFile(n.path)}
              title={n.path}
            >
              <div className="bp-head">
                <Icon name="wave" size={13} /> <span className="bp-title">{name}</span>
              </div>
              <div className="bp-body muted">
                {dir && <span className="bp-dir">{dir}</span>}
                {n.versions} {plural(n.versions, "версия", "версии", "версий")}
              </div>
              <span className="bp-pin bp-pin-out bp-pin-data" style={{ top: SONG_H / 2 - 5 }} />
            </div>
          );
        }
        if (n.kind === "branch") {
          const b = n.branch;
          return (
            <div
              key={n.key}
              data-node={n.key}
              className={`bp-node bp-branch ${b.current ? "current" : ""} ${isSelected ? "selected" : ""} ${focusSong ? "dim" : ""}`}
              style={{ ...style, width: BRANCH_W, height: BRANCH_H }}
              onDoubleClick={() => !b.current && switchTo(b.name)}
              title={b.current ? "Текущая ветка" : "Двойной щелчок — перейти на ветку"}
            >
              <div className="bp-head">
                <Icon name="branch" size={13} /> <span className="bp-title">{b.name}</span>
              </div>
              <div className="bp-body muted">{b.current ? "текущая ветка" : "ветка"}</div>
              <span className="bp-pin bp-pin-in" style={{ top: BRANCH_H / 2 - 5 }} />
            </div>
          );
        }
        const v = n.version;
        const merge = v.parents.length > 1 || !n.song;
        const hue = n.song ? songHue(n.song) : 280;
        const tags = tagsOf.get(v.id) ?? [];
        const isHead = v.id === overview.head;
        const dim = focusSong && !v.changes.some((c) => c.path === focusSong);
        return (
          <div
            key={n.key}
            data-node={n.key}
            className={`bp-node bp-version ${merge ? "merge" : ""} ${isSelected ? "selected" : ""} ${isHead ? "head" : ""} ${dim ? "dim" : ""}`}
            style={{ ...style, width: NODE_W, height: NODE_H, ["--hue" as string]: hue }}
            title={`${v.message || "без описания"}\n${formatDate(v.createdAt)} · ${v.author} · ${short(v.id)}`}
          >
            <div className="bp-head">
              <Icon name={merge ? "merge" : "wave"} size={13} />
              <span className="bp-title">
                {merge
                  ? `Слияние · ${v.changes.length} ${plural(v.changes.length, "файл", "файла", "файлов")}`
                  : splitPath(n.song!).name}
              </span>
              {n.change && <span className={`bp-kind bp-kind-${n.change.kind}`}>{KIND_WORD[n.change.kind]}</span>}
            </div>
            <div className="bp-body">
              <div className="bp-message">{v.message || <i className="muted">без описания</i>}</div>
              <div className="bp-meta muted">
                {formatDate(v.createdAt)} · {v.author} · <code>{short(v.id)}</code>
              </div>
              {tags.length > 0 && (
                <div className="bp-tags">
                  {tags.map((t) => (
                    <span key={t} className="label label-tag">
                      <Icon name="tag" size={10} /> {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <span className="bp-pin bp-pin-in bp-pin-exec" style={{ top: PIN_EXEC_Y - 5 }} />
            <span className="bp-pin bp-pin-out bp-pin-exec" style={{ top: PIN_EXEC_Y - 5 }} />
            {!merge && (
              <>
                <span className="bp-pin bp-pin-in bp-pin-data" style={{ top: PIN_SONG_Y - 5 }} />
                {n.change?.kind !== "deleted" && <span className="bp-pin bp-pin-out bp-pin-data" style={{ top: PIN_SONG_Y - 5 }} />}
              </>
            )}
          </div>
        );
      }),
    [diagram, selected, focusSong, tagsOf, overview.head, onOpenFile],
  );

  const selectedNode = selected ? diagram.nodes.get(selected) : null;
  const grid = 24 * view.zoom;

  if (error) return <div className="center error-text">{error}</div>;
  if (!versions) return <div className="center muted">Строю схему…</div>;

  return (
    <div className="bp-wrap">
      <div
        ref={box}
        className="bp"
        style={{
          backgroundSize: `${grid * 8}px ${grid * 8}px, ${grid * 8}px ${grid * 8}px, ${grid}px ${grid}px, ${grid}px ${grid}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
      >
        <div className="bp-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <svg className="bp-wires" width="1" height="1">
            {wires}
          </svg>
          {nodes}
        </div>

        {versions.length === 0 && (
          <div className="bp-empty">
            <Empty icon="wave" title="Здесь появится схема проекта">
              Песни, их версии и ветки — узлами, как в Blueprint. Перетащите файлы в окно или щёлкните правой кнопкой →
              «Добавить песни».
              <div className="empty-actions">
                <button className="btn btn-primary" onClick={() => onAddFiles("files")}>
                  <Icon name="plus" /> Добавить файлы
                </button>
              </div>
            </Empty>
          </div>
        )}

        {versions.length > 0 && (
          <div className="bp-toolbar" onPointerDown={(e) => e.stopPropagation()}>
            <button className="btn btn-small" onClick={() => fit()} title="Показать всю схему">
              Показать всё
            </button>
            <button className="btn btn-small" onClick={arrange} title="Вернуть узлы на свои места">
              Упорядочить
            </button>
            <span className="muted">{Math.round(view.zoom * 100)}%</span>
          </div>
        )}
        <div className="bp-legend muted">
          <span>
            <i className="bp-swatch exec" /> порядок версий
          </span>
          <span>
            <i className="bp-swatch song" /> история песни
          </span>
          <span>
            <i className="bp-swatch branch" /> ветка
          </span>
          <span>ПКМ — действия · колесо — масштаб</span>
        </div>

        {menu && (
          <div
            className="popover bp-menu"
            style={menuPlace(menu.at, menuItems(menu.node).length, box.current)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {menuItems(menu.node).map((item) => (
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
      </div>

      {selectedNode?.kind === "version" && (
        <aside className="bp-panel scroll">
          <button className="icon-btn bp-panel-close" onClick={() => setSelected(null)} aria-label="Закрыть">
            <Icon name="close" size={14} />
          </button>
          <VersionDetail
            key={selectedNode.version.id}
            snapshot={selectedNode.version}
            overview={overview}
            labels={labels.get(selectedNode.version.id)}
            onChanged={onChanged}
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
    </div>
  );
}
