import { useEffect, useState } from "react";
import { api, errorText, isCommandError, type Overview } from "../api";
import { Icon, Modal, useToast } from "../ui";
import { baseName, plural, splitPath } from "../util";

/** Folders of the project, for "put it into…". */
function folders(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

/**
 * Copies files or folders from elsewhere into the project and saves each
 * file as a version of its own. With `asPath`, one file becomes the new
 * version of that project file, whatever it is called outside.
 */
export function ImportDialog({
  overview,
  sources,
  asPath,
  onClose,
  onDone,
}: {
  overview: Overview;
  sources: string[];
  asPath?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const root = overview.root;
  const toast = useToast();
  const [dirs, setDirs] = useState<string[]>([]);
  const [dest, setDest] = useState("");
  const [message, setMessage] = useState("");
  const [save, setSave] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (asPath || !overview.head) return;
    api.files(root, overview.head).then((files) => setDirs(folders(files.map((f) => f.path))), () => {});
  }, [root, overview.head, asPath]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.importFiles(root, sources, {
        dest,
        asPath: asPath ?? null,
        message: message.trim() || null,
        save,
      });
      const n = result.paths.length;
      toast(
        asPath
          ? save
            ? `Новая версия «${splitPath(asPath).name}» сохранена`
            : `«${splitPath(asPath).name}» заменён, версия ждёт сохранения`
          : [
              `Добавлено ${n} ${plural(n, "файл", "файла", "файлов")}`,
              result.replaced > 0 && `${result.replaced} — новые версии существующих`,
              save && `сохранено ${result.saved} ${plural(result.saved, "версия", "версии", "версий")}`,
            ]
              .filter(Boolean)
              .join(" · "),
        "ok",
      );
      onDone();
      onClose();
    } catch (e) {
      setError(
        isCommandError(e) && e.kind === "wouldOverwrite"
          ? `В папке проекта уже есть ${e.paths.map((p) => `«${p}»`).join(", ")} с несохранёнными изменениями или вне истории. Сохраните или переименуйте их, чтобы не потерять.`
          : errorText(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={asPath ? `Новая версия «${splitPath(asPath).name}»` : "Добавить в проект"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={run}>
            <Icon name="plus" /> {busy ? "Добавляю…" : asPath ? "Загрузить" : "Добавить"}
          </button>
        </>
      }
    >
      <div className="import-list">
        {sources.map((s) => (
          <div key={s} className="import-item" title={s}>
            {/* A name with an extension is a file; without one, most likely a folder. */}
            <Icon name={/\.[^.\\/]+$/.test(baseName(s)) ? "doc" : "folder"} size={13} />
            <span>{baseName(s)}</span>
            {asPath && <span className="muted">→ {asPath}</span>}
          </div>
        ))}
      </div>

      {!asPath && (
        <label className="field">
          <span>Куда положить</span>
          <select value={dest} onChange={(e) => setDest(e.target.value)}>
            <option value="">В корень проекта</option>
            {dirs.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        <span>Описание версии (необязательно)</span>
        <input
          value={message}
          placeholder={asPath ? "Например: финальный рендер после сведения" : "Например: демки с репетиции"}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && run()}
        />
      </label>

      <label className="check multiline">
        <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
        <span>
          Сразу сохранить версии
          <span className="muted">
            {" "}
            — каждый файл отдельной версией. Файл с таким же именем станет новой версией существующего.
          </span>
        </span>
      </label>

      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
