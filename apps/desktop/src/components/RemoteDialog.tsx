import { ask, open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { api, errorText, type RemoteConfig, type SyncState } from "../api";
import { Icon, Modal, useToast } from "../ui";
import { prettyPath } from "../util";

export const YANDEX_WEBDAV = "https://webdav.yandex.ru";

/** `base` + `name` with the separator `base` already uses. */
export function joinPath(base: string, name: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return base.endsWith(sep) ? base + name : base + sep + name;
}

/** Fields shared by the connect and the "get project" dialogs. */
export function WebDavFields({
  url,
  username,
  password,
  onChange,
  passwordHint,
}: {
  url: string;
  username: string;
  password: string;
  onChange: (field: "url" | "username" | "password", value: string) => void;
  passwordHint?: string;
}) {
  return (
    <>
      <label className="field">
        <span>Адрес сервера</span>
        <input value={url} onChange={(e) => onChange("url", e.target.value)} placeholder={YANDEX_WEBDAV} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Логин</span>
          <input value={username} onChange={(e) => onChange("username", e.target.value)} autoComplete="username" />
        </label>
        <label className="field">
          <span>Пароль</span>
          <input
            type="password"
            value={password}
            placeholder={passwordHint}
            onChange={(e) => onChange("password", e.target.value)}
            autoComplete="current-password"
          />
        </label>
      </div>
      {url.includes("yandex") && (
        <div className="hint">
          Для Яндекс Диска нужен не основной пароль, а пароль приложения: id.yandex.ru → Безопасность → Пароли
          приложений → «Файлы» (WebDAV).
        </div>
      )}
    </>
  );
}

export function KindTabs({ kind, onChange }: { kind: RemoteConfig["kind"]; onChange: (k: RemoteConfig["kind"]) => void }) {
  return (
    <div className="seg-tabs">
      <button className={kind === "folder" ? "active" : ""} onClick={() => onChange("folder")}>
        <Icon name="folder" size={14} /> Папка
      </button>
      <button className={kind === "webDav" ? "active" : ""} onClick={() => onChange("webDav")}>
        <Icon name="cloud" size={14} /> WebDAV · Яндекс Диск
      </button>
    </div>
  );
}

/** Connect the project to a remote, or change / disconnect it. */
export function RemoteDialog({
  root,
  projectName,
  state,
  onClose,
  onConnected,
  onChanged,
}: {
  root: string;
  projectName: string;
  state: SyncState;
  onClose: () => void;
  onConnected: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const current = state.remote;
  const [kind, setKind] = useState<RemoteConfig["kind"]>(current?.kind ?? "folder");
  const [folderPath, setFolderPath] = useState(current?.kind === "folder" ? current.path : "");
  const [url, setUrl] = useState(current?.kind === "webDav" ? current.url : YANDEX_WEBDAV);
  const [davFolder, setDavFolder] = useState(current?.kind === "webDav" ? current.folder : `Takes/${projectName}`);
  const [username, setUsername] = useState(current?.kind === "webDav" ? current.username : "");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(state.deviceName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remote: RemoteConfig | null =
    kind === "folder"
      ? folderPath
        ? { kind: "folder", path: folderPath }
        : null
      : url.trim() && davFolder.trim() && username.trim()
        ? { kind: "webDav", url: url.trim(), folder: davFolder.trim(), username: username.trim() }
        : null;
  const unchanged = JSON.stringify(remote) === JSON.stringify(current);
  const needsPassword = kind === "webDav" && !(unchanged && state.hasPassword) && !password;

  async function pickFolder() {
    const dir = await open({ directory: true, title: "Где хранить историю проекта" });
    if (typeof dir === "string") setFolderPath(joinPath(dir, projectName));
  }

  async function save() {
    if (!remote || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (deviceName.trim() && deviceName.trim() !== state.deviceName) {
        await api.setDeviceName(root, deviceName.trim());
      }
      if (unchanged && !password) {
        onChanged();
        onClose();
        return;
      }
      await api.setRemote(root, remote, password || null);
      toast("Хранилище подключено", "ok");
      onConnected();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    const ok = await ask(
      "Отключить синхронизацию? Версии в хранилище и на этом компьютере останутся, просто перестанут обмениваться.",
      { title: "Отключить хранилище?", okLabel: "Отключить", cancelLabel: "Отмена" },
    );
    if (!ok) return;
    try {
      await api.removeRemote(root);
      onChanged();
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Modal
      title={current ? "Синхронизация" : "Подключить хранилище"}
      wide
      onClose={onClose}
      footer={
        <>
          {current && (
            <button className="btn btn-ghost danger-text grow-right" onClick={disconnect}>
              Отключить
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={!remote || needsPassword || busy} onClick={save}>
            {busy ? "Проверяю…" : current ? "Сохранить" : "Подключить"}
          </button>
        </>
      }
    >
      <div className="hint">
        История проекта будет храниться ещё и в выбранном месте. На другом компьютере проект можно получить
        оттуда и работать над ним вместе: каждое устройство отправляет свои версии и получает чужие.
      </div>

      <KindTabs kind={kind} onChange={setKind} />

      {kind === "folder" ? (
        <>
          <div className="field">
            <span>Папка для истории</span>
            <div className="path-picker">
              <span className={folderPath ? "" : "muted"} title={folderPath}>
                {folderPath ? prettyPath(folderPath) : "не выбрана"}
              </span>
              <button className="btn btn-small" onClick={pickFolder}>
                Выбрать…
              </button>
            </div>
          </div>
          <div className="hint">
            Подойдёт папка Google Диска, Dropbox или Яндекс Диска на этом компьютере (их приложение само загрузит
            её в облако), сетевой диск или флешка. Внутри выбранного места появится папка «{projectName}».
          </div>
        </>
      ) : (
        <>
          <WebDavFields
            url={url}
            username={username}
            password={password}
            passwordHint={unchanged && state.hasPassword ? "сохранён" : undefined}
            onChange={(field, value) =>
              field === "url" ? setUrl(value) : field === "username" ? setUsername(value) : setPassword(value)
            }
          />
          <label className="field">
            <span>Папка проекта на сервере</span>
            <input value={davFolder} onChange={(e) => setDavFolder(e.target.value)} />
          </label>
        </>
      )}

      <label className="field">
        <span>Имя этого компьютера (видно на других устройствах)</span>
        <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
      </label>

      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
