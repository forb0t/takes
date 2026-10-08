import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { api, errorText, type Project, type RemoteConfig } from "../api";
import { Icon, Modal } from "../ui";
import { baseName, prettyPath } from "../util";
import { KindTabs, WebDavFields, YANDEX_WEBDAV, joinPath } from "./RemoteDialog";
import { progressText, useSyncProgress } from "./SyncControl";

/** Get a project that another device put into a remote. */
export function CloneDialog({ onClose, onCloned }: { onClose: () => void; onCloned: (p: Project) => void }) {
  const [kind, setKind] = useState<RemoteConfig["kind"]>("folder");
  const [folderPath, setFolderPath] = useState("");
  const [url, setUrl] = useState(YANDEX_WEBDAV);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [parent, setParent] = useState("Takes");
  const [found, setFound] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [destParent, setDestParent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"search" | "clone" | null>(null);

  const remote: RemoteConfig | null =
    kind === "folder"
      ? folderPath
        ? { kind: "folder", path: folderPath }
        : null
      : picked && username.trim()
        ? { kind: "webDav", url: url.trim(), folder: `${parent.replace(/\/+$/, "")}/${picked}`, username: username.trim() }
        : null;
  const name = kind === "folder" ? (folderPath ? baseName(folderPath) : "") : (picked ?? "");
  const dest = destParent && name ? joinPath(destParent, name) : "";
  const progress = useSyncProgress(dest, busy === "clone");

  async function pickRemoteFolder() {
    const dir = await open({ directory: true, title: "Папка с историей проекта" });
    if (typeof dir !== "string") return;
    setError(null);
    try {
      const ok = await api.isRemoteProject({ kind: "folder", path: dir }, null);
      if (ok) setFolderPath(dir);
      else setError("В этой папке нет проекта Takes. Выберите папку, которую подключали на другом устройстве.");
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function search() {
    setBusy("search");
    setError(null);
    setFound(null);
    setPicked(null);
    try {
      const projects = await api.findRemoteProjects(
        { kind: "webDav", url: url.trim(), folder: parent, username: username.trim() },
        password,
      );
      setFound(projects);
      if (projects.length === 1) setPicked(projects[0]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function pickDest() {
    const dir = await open({ directory: true, title: "Куда сохранить проект на этом компьютере" });
    if (typeof dir === "string") setDestParent(dir);
  }

  async function clone() {
    if (!remote || !dest) return;
    setBusy("clone");
    setError(null);
    try {
      const project = await api.cloneProject(remote, kind === "webDav" ? password : null, dest);
      onCloned(project);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title="Получить проект из хранилища"
      wide
      onClose={onClose}
      footer={
        <>
          {busy === "clone" && <span className="muted grow">{progressText(progress)}</span>}
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={!remote || !dest || busy !== null} onClick={clone}>
            <Icon name="download" /> {busy === "clone" ? "Получаю…" : "Получить"}
          </button>
        </>
      }
    >
      <div className="hint">
        Выберите хранилище, которое подключили к проекту на другом устройстве. Сюда скачаются все версии и
        комментарии, а дальше синхронизация пойдёт в обе стороны.
      </div>

      <KindTabs
        kind={kind}
        onChange={(k) => {
          setKind(k);
          setError(null);
        }}
      />

      {kind === "folder" ? (
        <div className="field">
          <span>Папка с историей проекта</span>
          <div className="path-picker">
            <span className={folderPath ? "" : "muted"} title={folderPath}>
              {folderPath ? prettyPath(folderPath) : "не выбрана"}
            </span>
            <button className="btn btn-small" onClick={pickRemoteFolder}>
              Выбрать…
            </button>
          </div>
        </div>
      ) : (
        <>
          <WebDavFields
            url={url}
            username={username}
            password={password}
            onChange={(field, value) =>
              field === "url" ? setUrl(value) : field === "username" ? setUsername(value) : setPassword(value)
            }
          />
          <div className="field-row align-end">
            <label className="field">
              <span>Где искать проекты на сервере</span>
              <input value={parent} onChange={(e) => setParent(e.target.value)} />
            </label>
            <button
              className="btn"
              disabled={!url.trim() || !username.trim() || !password || busy !== null}
              onClick={search}
            >
              {busy === "search" ? "Ищу…" : "Найти проекты"}
            </button>
          </div>
          {found && found.length === 0 && <div className="muted">В «{parent}» нет проектов Takes.</div>}
          {found && found.length > 0 && (
            <div className="choice-list">
              {found.map((p) => (
                <button key={p} className={p === picked ? "active" : ""} onClick={() => setPicked(p)}>
                  <Icon name="folder" size={14} /> {p}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div className="field">
        <span>Куда сохранить на этом компьютере</span>
        <div className="path-picker">
          <span className={dest ? "" : "muted"} title={dest}>
            {dest ? prettyPath(dest) : destParent ? "сначала выберите проект" : "не выбрано"}
          </span>
          <button className="btn btn-small" onClick={pickDest}>
            Выбрать…
          </button>
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
