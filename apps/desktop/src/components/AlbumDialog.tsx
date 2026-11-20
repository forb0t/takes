import { save } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
import { api, errorText } from "../api";
import { laneGroup, type Lane, type SongVersion } from "../blueprint";
import { usePlayer, type Track } from "../player";
import type { Songs } from "../songs";
import { Icon, Modal, useToast } from "../ui";
import { plural, previewKind, splitPath } from "../util";
import type { ProjectFile } from "./FilesTab";

const GAPS: [number, string][] = [
  [0, "без паузы"],
  [2000, "2 секунды"],
  [5000, "5 секунд"],
];

/** A song as it goes on the album: from which branch, if at all. */
interface Pick {
  on: boolean;
  branch: string;
}

/** The latest version of a song's branch, when it has a file to take. */
function headOf(lane: Lane, branch: string): SongVersion | null {
  const b = lane.branches.find((x) => x.name === branch);
  const n = lane.nodes.find((x): x is SongVersion => x.kind === "version" && x.key === b?.head);
  return n && n.change !== "deleted" && !n.pruned ? n : null;
}

/**
 * The project's songs in their order, as an album: each from the branch
 * chosen for it, played one after another or packed into a ZIP. The folder
 * is not touched; the song order is the project's (the diagram's) own.
 */
export function AlbumDialog({
  root,
  name,
  songs,
  files,
  onClose,
}: {
  root: string;
  name: string;
  songs: Songs;
  files: ProjectFile[] | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const player = usePlayer();
  const lanes = useMemo(() => (songs.lanes ?? []).filter((l) => laneGroup(l) === 0), [songs.lanes]);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [gapMs, setGapMs] = useState(2000);
  const [numbered, setNumbered] = useState(false);
  const [packing, setPacking] = useState(false);

  const pickOf = (lane: Lane): Pick => {
    const branch = lane.branches.find((b) => b.active)?.name ?? lane.branches[0]?.name ?? "";
    return picks[lane.id] ?? { on: previewKind(lane.path) === "audio" && !!headOf(lane, branch), branch };
  };
  const setPick = (lane: Lane, change: Partial<Pick>) =>
    setPicks((all) => ({ ...all, [lane.id]: { ...pickOf(lane), ...change } }));

  const chosen = lanes.flatMap((lane) => {
    const pick = pickOf(lane);
    const head = pick.on ? headOf(lane, pick.branch) : null;
    return head ? [{ lane, branch: pick.branch, head }] : [];
  });
  const playable = chosen.filter((c) => previewKind(c.lane.path) === "audio");
  const fileOf = (lane: Lane) => files?.find((f) => f.path === lane.path);

  const track = (c: (typeof chosen)[number]): Track => ({
    root,
    rev: c.head.version.id,
    path: c.head.path,
    label: `ветка «${c.branch}», версия ${c.head.number}`,
  });

  function play(from: Lane | null) {
    const at = from ? playable.findIndex((c) => c.lane === from) : 0;
    if (at < 0 || !playable.length) return;
    player.playAlbum({ tracks: playable.map(track), at, gapMs });
    // The player shows the album from here on, below the dialog otherwise.
    onClose();
  }

  /** One place up or down in the project's song order. */
  function move(lane: Lane, by: -1 | 1) {
    const paths = lanes.map((l) => l.path);
    const i = paths.indexOf(lane.path);
    const j = i + by;
    if (j < 0 || j >= paths.length) return;
    [paths[i], paths[j]] = [paths[j], paths[i]];
    songs.setOrder([...paths, ...songs.order.filter((p) => !paths.includes(p))]);
  }

  async function pack() {
    const dest = await save({
      title: "Сохранить альбом как ZIP",
      defaultPath: `${name}.zip`.replace(/[\\/:*?"<>|]/g, "-"),
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!dest) return;
    setPacking(true);
    try {
      const list = chosen.map((c, i) => ({
        rev: c.head.version.id,
        path: c.head.path,
        name: numbered ? `${String(i + 1).padStart(2, "0")} ${splitPath(c.lane.path).name}` : c.lane.path,
      }));
      const count = await api.exportAlbum(root, list, dest);
      toast(`Альбом сохранён в ZIP: ${count} ${plural(count, "файл", "файла", "файлов")}`, "ok");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setPacking(false);
    }
  }

  return (
    <Modal
      title="Альбом"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted grow">
            {chosen.length} {plural(chosen.length, "файл", "файла", "файлов")}
          </span>
          <button className="btn" disabled={!chosen.length || packing} onClick={pack}>
            <Icon name="archive" /> {packing ? "Упаковываю…" : "Скачать ZIP…"}
          </button>
          <button className="btn btn-primary" disabled={!playable.length} onClick={() => play(null)}>
            <Icon name="play" /> Слушать подряд
          </button>
        </>
      }
    >
      <div className="hint">
        Песни по порядку проекта, каждая — из выбранной ветки (её последняя версия). Папка не меняется.
      </div>
      {!lanes.length && <div className="muted">В проекте пока нет файлов.</div>}
      <ol className="album-list">
        {lanes.map((lane, i) => {
          const pick = pickOf(lane);
          const head = headOf(lane, pick.branch);
          const active = lane.branches.find((b) => b.name === pick.branch)?.active;
          const file = fileOf(lane);
          const unsaved = active && file && file.status !== "saved";
          const audio = previewKind(lane.path) === "audio";
          return (
            <li key={lane.id} className={`album-row ${pick.on ? "" : "off"}`}>
              <label className="check album-name" title={lane.path}>
                <input type="checkbox" checked={pick.on} onChange={(e) => setPick(lane, { on: e.target.checked })} />
                <span className="album-no muted">{i + 1}.</span>
                <span className="nowrap">{splitPath(lane.path).name}</span>
              </label>
              <select
                value={pick.branch}
                disabled={!pick.on}
                onChange={(e) => setPick(lane, { branch: e.target.value })}
                title="Из какой ветки взять песню"
              >
                {lane.branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
              <span
                className="album-note muted"
                title={unsaved ? "В папке есть несохранённые изменения: в альбом идёт последняя сохранённая версия" : undefined}
              >
                {!head
                  ? "у ветки нет файла"
                  : [`версия ${head.number}`, active && "в папке", unsaved && "не сохранено"].filter(Boolean).join(" · ")}
              </span>
              <span className="album-tools">
                {audio && pick.on && head && (
                  <button className="icon-btn" onClick={() => play(lane)} title="Слушать альбом с этой песни">
                    <Icon name="play" size={14} />
                  </button>
                )}
                <button className="icon-btn" disabled={i === 0} onClick={() => move(lane, -1)} title="Выше">
                  <Icon name="up" size={14} />
                </button>
                <button
                  className="icon-btn"
                  disabled={i === lanes.length - 1}
                  onClick={() => move(lane, 1)}
                  title="Ниже"
                >
                  <Icon name="down" size={14} />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="album-options">
        <label className="field">
          <span>Между песнями</span>
          <select value={gapMs} onChange={(e) => setGapMs(Number(e.target.value))}>
            {GAPS.map(([ms, label]) => (
              <option key={ms} value={ms}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="check" title="«01 Intro.wav», «02 Ночь.wav»… в архиве; без этого — имена и папки как в проекте">
          <input type="checkbox" checked={numbered} onChange={(e) => setNumbered(e.target.checked)} />
          <span>Номера по порядку в именах файлов архива</span>
        </label>
      </div>
    </Modal>
  );
}
