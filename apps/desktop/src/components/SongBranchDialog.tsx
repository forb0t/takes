import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { errorText } from "../api";
import { Icon, Modal } from "../ui";
import { baseName, splitPath } from "../util";

/**
 * A new branch of one song: another take of it from a file on disk, e.g. a
 * remix or an acoustic version. The folder keeps what it has unless asked.
 */
export function SongBranchDialog({
  path,
  taken,
  start,
  onCreate,
  onClose,
}: {
  /** The song. */
  path: string;
  /** Branches the song has already. */
  taken: string[];
  /** What the branch starts from, for the hint: "текущей версии", "версии 3"… */
  start: string;
  onCreate: (name: string, source: string, intoFolder: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const song = splitPath(path).name;
  const [name, setName] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [intoFolder, setIntoFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick() {
    const picked = await open({ multiple: false, title: `Другой вариант «${song}»` });
    if (typeof picked === "string") setSource(picked);
  }

  async function create() {
    const branch = name.trim();
    if (!branch || !source || busy) return;
    if (taken.some((t) => t.toLowerCase() === branch.toLowerCase())) {
      setError(`У «${song}» уже есть ветка «${branch}».`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(branch, source, intoFolder);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Новая ветка «${song}»`}
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
        <span>Название ветки</span>
        <input
          autoFocus
          value={name}
          placeholder="Например: акустика, ремикс, вариант-2"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
      </label>

      <div className="field">
        <span>Файл с диска — первая версия ветки</span>
        <button className={`btn branch-file ${source ? "" : "btn-primary"}`} onClick={pick} title={source ?? undefined}>
          <Icon name={source ? "doc" : "folder"} size={14} />
          <span className="branch-file-name">{source ? baseName(source) : "Выбрать файл…"}</span>
        </button>
      </div>

      <label className="check">
        <input type="checkbox" checked={intoFolder} onChange={(e) => setIntoFolder(e.target.checked)} />
        <span>Сразу положить в папку проекта вместо нынешнего «{song}»</span>
      </label>

      <div className="hint">
        Ветка есть только у «{song}» и начинается от {start}. Остальные треки и папка не меняются
        {intoFolder ? ", кроме этого файла" : ""}; на схеме у трека появится новый ряд.
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
