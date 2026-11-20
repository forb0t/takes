import { memo, useEffect, useRef } from "react";
import type { ChangeKind } from "../../api";
import {
  LANE_PAD,
  LOOSE_KEY,
  NEW_BRANCH_KEY,
  PIN_Y,
  SONG_KEY,
  addKey,
  bandRect,
  branchKey,
  growing,
  nodeKey,
  nodeSize,
  previousVersion,
  songHue,
  wire,
  type PlacedLane,
  type SongVersion,
} from "../../blueprint";
import { CompareButton, PlayButton, type Track } from "../../player";
import { FileLabels, Icon, KindBadge, type IconName } from "../../ui";
import { formatDate, plural, previewKind, short, splitPath } from "../../util";
import type { ProjectFile } from "../FilesTab";
import { WORK_WORD, laneText, wiresOf, type Actions } from "./model";
import { ExecPin } from "./pins";

/**
 * One song: a frame with its title and the song's own node, then a band per
 * branch: the branch's node, its versions wired one after another, the file
 * on disk at the end of the branch in the folder, and a place to add a file;
 * below them, a place to start a branch. Drawn again only when the song
 * changes, not while the canvas moves.
 */
export const LaneView = memo(function LaneView({
  root,
  placed,
  file,
  draft,
  tagsOf,
  selectedKey,
  dragging,
  pullAt,
  pullWire,
  flash,
  dim,
  hits,
  hitNow,
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
  /** Where a pulled wire would go in this lane: "ok:<key>" or "bad:<key>". */
  pullAt: string | null;
  /** The wire being moved, hidden meanwhile: "<from>><to>". */
  pullWire: string | null;
  /** A version just moved, shown for a moment. */
  flash: string | null;
  /** Not what the search is looking for. */
  dim: boolean;
  /** Versions the search found here. */
  hits: Set<string> | null;
  /** The one of them Enter went to last. */
  hitNow: string | null;
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

  const wires = wiresOf(lane);
  const fed = new Set(wires.map((w) => w.from));
  /** How a node shows where a pulled wire would go. */
  const pullCls = (key: string) => (pullAt === `ok:${key}` ? "pull-ok" : pullAt === `bad:${key}` ? "pull-bad" : "");
  const pin = (key: string, side: "in" | "out") => (e: React.PointerEvent) => act.current.pullPin(e, lane, key, side);
  const loose = lane.nodes.filter((n) => n.kind === "version" && n.row === lane.looseRow).length;

  return (
    <div
      ref={el}
      data-lane={lane.path}
      className={[
        "bp-lane",
        `lane-${lane.status}`,
        selectedKey !== null ? "selected" : "",
        dragging === "" ? "lifted" : "",
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

      {[
        ...lane.branches.map((b) => ({ key: b.name, row: b.row, cls: b.active ? "active" : "" })),
        ...(lane.looseRow !== null ? [{ key: LOOSE_KEY, row: lane.looseRow, cls: "loose" }] : []),
      ].map((b) => {
        const band = bandRect(b.row);
        const left = band.x - frame.x;
        return (
          <div
            key={b.key}
            className={`bp-band ${b.cls}`}
            style={{
              left,
              top: band.y - frame.y,
              width: frame.w - left - LANE_PAD / 2,
              height: band.h,
            }}
          />
        );
      })}

      <svg className="bp-wires" width={frame.w} height={frame.h}>
        {wires.map((w) => {
          const id = `${w.from}>${w.to}`;
          if (id === pullWire) return null;
          const a = pinOut(w.from);
          const b = pinIn(w.to);
          const d = wire(a.x, a.y, b.x, b.y);
          return (
            <g key={id} className={`bp-wire-g ${w.kind}`}>
              <path
                d={d}
                className="bp-wire-hit"
                onPointerDown={w.kind === "chain" ? (e) => act.current.grabWire(e, lane, w) : undefined}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  act.current.breakWire(lane, w);
                }}
              >
                {w.kind === "chain" && <title>Тащите за провод, чтобы переподключить; двойной щелчок — оборвать</title>}
              </path>
              <path d={d} className={`bp-wire ${w.cls}`} />
            </g>
          );
        })}
      </svg>

      <div
        className={`bp-node bp-song ${muted ? "muted" : ""} ${selectedKey === "" ? "selected" : ""} ${dragging === SONG_KEY ? "dragging" : ""} ${pullCls(SONG_KEY)}`}
        data-node={SONG_KEY}
        style={box(SONG_KEY)}
        onPointerDown={(e) => act.current.dragNode(e, lane, SONG_KEY)}
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
        <ExecPin side="out" on={lane.branches.length > 0} onPull={pin(SONG_KEY, "out")} />
      </div>

      {lane.branches.map((b) => {
        const head = headOf(b.head);
        const usable = head && head.change !== "deleted" && !head.pruned;
        return (
          <div
            key={branchKey(b.name)}
            className={`bp-node bp-branch-node ${b.active ? "active" : ""} ${dragging === branchKey(b.name) ? "dragging" : ""} ${pullCls(branchKey(b.name))}`}
            data-node={branchKey(b.name)}
            style={box(branchKey(b.name))}
            onPointerDown={(e) => act.current.dragNode(e, lane, branchKey(b.name))}
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
            <ExecPin side="out" on={fed.has(branchKey(b.name))} onPull={pin(branchKey(b.name), "out")} />
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
            className={`bp-add ${pullCls(addKey(b.name))}`}
            data-file-drop
            data-add-to={b.name}
            style={box(addKey(b.name))}
            onClick={() => act.current.addFile(lane, b.name)}
            title={`Новая версия в ветку «${b.name}»: выберите файл, бросьте его сюда или проведите сюда провод от версии`}
          >
            <Icon name="plus" size={16} />
            <span>файл</span>
          </button>
        ))}

      {!muted && (
        <button
          className={`bp-newbranch ${pullCls(NEW_BRANCH_KEY)}`}
          data-file-drop
          data-new-branch
          style={box(NEW_BRANCH_KEY)}
          onClick={() => act.current.newBranch(lane)}
          title="Новая ветка трека из файла; можно бросить сюда файл или провести сюда провод от версии"
        >
          <Icon name="plus" size={14} /> ветка
        </button>
      )}

      {lane.looseRow !== null && (
        <div
          className={`bp-node bp-loose-node ${dragging === LOOSE_KEY ? "dragging" : ""} ${pullCls(LOOSE_KEY)}`}
          data-node={LOOSE_KEY}
          style={box(LOOSE_KEY)}
          onPointerDown={(e) => act.current.dragNode(e, lane, LOOSE_KEY)}
          title="Версии, отсоединённые от веток. Проведите провод от ветки или версии к такой версии — и она снова в ветке"
        >
          <div className="bp-node-head">
            <Icon name="close" size={12} />
            <span className="bp-title">Без ветки</span>
          </div>
          <div className="bp-rows">
            <div className="bp-row">
              <span className="bp-text">
                {loose} {plural(loose, "версия", "версии", "версий")}
              </span>
            </div>
            <div className="bp-row bp-meta">
              <span className="bp-text">подключите проводом к ветке</span>
            </div>
          </div>
        </div>
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
              onPointerDown={(e) => act.current.dragNode(e, lane, key)}
              data-node={key}
              className={`bp-node bp-work status-${n.status} ${isSelected ? "selected" : ""} ${dragging === key ? "dragging" : ""} ${pullCls(key)}`}
              onClick={() => act.current.select(lane.path, n.key, true)}
              onContextMenu={(e) => act.current.workMenu(e, lane, n)}
              title="Файл в папке сейчас: щёлкните, чтобы описать и сохранить"
            >
              <div className="bp-node-head">
                <Icon name="edit" size={12} />
                <span className="bp-title">Сейчас в папке</span>
                <span className="bp-state">{WORK_WORD[n.status]}</span>
              </div>
              <ExecPin side="in" on onPull={pin(key, "in")} />
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
            data-node={key}
            className={[
              "bp-node bp-version",
              `change-${n.change}`,
              !n.branch ? "loose" : lane.branches[n.row]?.active ? "" : "elsewhere",
              merge ? "merge" : "",
              isSelected ? "selected" : "",
              dragging === key ? "dragging" : "",
              flash === n.key ? "flash" : "",
              hits?.has(n.key) ? (hitNow === n.key ? "hit hit-now" : "hit") : "",
              pullCls(key),
            ].join(" ")}
            onClick={() => act.current.select(lane.path, n.key)}
            onContextMenu={(e) => act.current.versionMenu(e, lane, n)}
            title={`${v.message || "без описания"}\n${formatDate(v.createdAt)} · ${v.author} · ${short(v.id)}${
              n.branch ? "" : "\nБез ветки: проведите к ней провод от ветки или версии"
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
            <ExecPin side="in" on={n.links.length > 0 || !!n.branch} onPull={pin(key, "in")} />
            <ExecPin side="out" on={fed.has(n.key)} onPull={pin(key, "out")} />
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
