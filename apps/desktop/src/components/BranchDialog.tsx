import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, errorText, type Overview } from "../api";
import { Icon, Modal, useToast } from "../ui";
import { baseName, naturalCompare, splitPath } from "../util";

/** The choice of a new file rather than a version of one already there. */
const NEW_FILE = "";

/**
 * A new branch is another take of a song: a file from disk saved in it as
 * the song's version (or as a new file). Where you are and the folder stay
 * as they are; the diagram shows the fork at once.
 */
export function BranchDialog({
  overview,
  from,
  song,
  onClose,
  onCreated,
}: {
  overview: Overview;
  /** The version the branch starts from; none: the current one. */
  from?: { rev: string; label: string };
  /** The song the take is for, when it is known already. */
  song?: string;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const root = overview.root;
  const toast = useToast();
  const [name, setName] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [songs, setSongs] = useState<string[]>([]);
  const [target, setTarget] = useState(song ?? NEW_FILE);
  const [switchTo, setSwitchTo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!overview.head && !from) return;
    api
      .files(root, from?.rev ?? "HEAD")
      .then((list) => alive && setSongs(list.map((f) => f.path).sort(naturalCompare)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [root, from?.rev, overview.head]);

  async function pick() {
    const picked = await open({ multiple: false, title: "Файл для новой ветки" });
    if (typeof picked !== "string") return;
    setSource(picked);
    // A file named like a song of the project is most likely its other take.
    const named = songs.find((p) => splitPath(p).name.toLowerCase() === baseName(picked).toLowerCase());
    if (named) setTarget(named);
    else if (!song) setTarget(NEW_FILE);
  }

  async function create() {
    const branch = name.trim();
    if (!branch || !source || busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = target || baseName(source);
      await api.branchWithFile(root, branch, from?.rev ?? null, source, path);
      if (switchTo) await api.switchBranch(root, branch);
      toast(
        switchTo
          ? `Ветка «${branch}» создана, вы на ней`
          : `Ветка «${branch}» создана: в ней «${splitPath(path).name}» из выбранного файла`,
        "ok",
      );
      onCreated(branch);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const startText = from ? from.label : `текущей версии ветки «${overview.branch}»`;
  return (
    <Modal
      title="Новая ветка"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || !source || busy} onClick={create}>
            <Icon name="branch" /> {busy ? "Создаю…" : "Создать ветку"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Название</span>
        <input
          autoFocus
          value={name}
          placeholder="Например: acoustic, remix, вариант-2"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
      </label>

      <div className="field">
        <span>Файл с диска — что будет в ветке</span>
        <button className={`btn branch-file ${source ? "" : "btn-primary"}`} onClick={pick} title={source ?? undefined}>
          <Icon name={source ? "doc" : "folder"} size={14} />
          <span className="branch-file-name">{source ? baseName(source) : "Выбрать файл…"}</span>
        </button>
      </div>

      {source && (
        <label className="field">
          <span>Чей это вариант</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value={NEW_FILE}>Новый файл «{baseName(source)}»</option>
            {songs.map((p) => (
              <option key={p} value={p}>
                Другой вариант «{p}»
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="check">
        <input type="checkbox" checked={switchTo} onChange={(e) => setSwitchTo(e.target.checked)} />
        <span>Сразу перейти на ветку (файлы в папке заменятся её версией)</span>
      </label>

      <div className="hint">
        Ветка начнётся с {startText}. Выбранный файл сохранится в ней версией
        {target ? ` «${splitPath(target).name}»` : " нового файла"}; на схеме у песни появится развилка.
        {!switchTo && " Вы останетесь на ветке «" + overview.branch + "», папка не изменится."}
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
