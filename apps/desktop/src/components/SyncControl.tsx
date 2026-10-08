import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { api, errorText, isCommandError, type SyncProgress, type SyncReport, type SyncState } from "../api";
import { Icon, PromptDialog, useToast } from "../ui";
import { formatDate, formatSize, plural } from "../util";
import { RemoteDialog } from "./RemoteDialog";

/** Latest sync progress event for `root` (a project, or a clone's target). */
export function useSyncProgress(root: string, active: boolean): SyncProgress | null {
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }
    const unlisten = listen<SyncProgress>("sync-progress", (e) => e.payload.root === root && setProgress(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, [root, active]);
  return progress;
}

export function progressText(p: SyncProgress | null): string {
  if (!p || p.phase === "connecting") return "Подключаюсь…";
  const verb = p.phase === "downloading" ? "Получаю" : "Отправляю";
  return p.total > 0 ? `${verb} ${formatSize(p.done)} из ${formatSize(p.total)}` : `${verb}…`;
}

/** Automatic sync: shortly after opening and after saving, then every few minutes. */
const AUTO_AFTER_OPEN_MS = 2_000;
const AUTO_AFTER_SAVE_MS = 4_000;
const AUTO_EVERY_MS = 5 * 60_000;

/** What came from other devices, for a quiet note after an automatic sync. */
function received(r: SyncReport): string | null {
  const parts: string[] = [];
  if (r.receivedVersions > 0)
    parts.push(`${r.receivedVersions} ${plural(r.receivedVersions, "версия", "версии", "версий")}`);
  if (r.commentsReceived > 0)
    parts.push(`${r.commentsReceived} ${plural(r.commentsReceived, "комментарий", "комментария", "комментариев")}`);
  return parts.length > 0 ? `С других устройств: ${parts.join(", ")}` : null;
}

function summary(r: SyncReport): string {
  const parts: string[] = [];
  if (r.receivedVersions > 0)
    parts.push(`получено ${r.receivedVersions} ${plural(r.receivedVersions, "версия", "версии", "версий")}`);
  if (r.sentVersions > 0)
    parts.push(`отправлено ${r.sentVersions} ${plural(r.sentVersions, "версия", "версии", "версий")}`);
  const comments = r.commentsReceived + r.commentsSent;
  if (comments > 0) parts.push(`${comments} ${plural(comments, "комментарий", "комментария", "комментариев")}`);
  if (parts.length === 0) return "Всё уже синхронизировано";
  const text = parts.join(", ");
  return text[0].toUpperCase() + text.slice(1);
}

/** "Sync" button with progress, plus the remote settings. */
export function SyncControl({
  root,
  projectName,
  state,
  onSynced,
}: {
  root: string;
  projectName: string;
  state: SyncState | null;
  onSynced: () => void;
}) {
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState(false);
  const [askPassword, setAskPassword] = useState(false);
  /** Why the last automatic sync failed (shown on the button, not as a toast). */
  const [autoError, setAutoError] = useState<string | null>(null);
  const progress = useSyncProgress(root, syncing);
  const busy = useRef(false);

  async function run(password: string | null = null, auto = false) {
    if (busy.current) return;
    busy.current = true;
    setSyncing(true);
    try {
      // Automatic syncs never replace files under an open DAW; a newer
      // version waits behind the "update files" banner instead.
      const report = await api.sync(root, password, auto);
      setAutoError(null);
      if (auto) {
        const note = received(report);
        if (note) toast(note, "ok");
      } else {
        toast(summary(report), "ok");
      }
      if (report.deletedBranches.length > 0) {
        toast(`Удалены на другом устройстве: ${report.deletedBranches.join(", ")}`, "ok");
      }
      if (report.currentBlocked === "unsaved") {
        toast("Есть новая версия с другого устройства, но у вас несохранённые изменения. Сохраните или отмените их и синхронизируйте снова.", "error");
      } else if (report.currentBlocked) {
        toast(`Новую версию не получилось применить: мешают файлы ${report.blockedPaths.join(", ")}.`, "error");
      }
    } catch (e) {
      if (auto) {
        // Offline or the like: say so quietly and try again later.
        if (!(isCommandError(e) && e.kind === "alreadySyncing")) setAutoError(errorText(e));
      } else if (isCommandError(e) && (e.kind === "passwordNeeded" || e.kind === "remoteAuth")) {
        if (e.kind === "remoteAuth") toast(errorText(e), "error");
        setAskPassword(true);
      } else {
        toast(errorText(e), "error");
      }
    } finally {
      busy.current = false;
      setSyncing(false);
      onSynced();
    }
  }

  const auto = !!state?.remote && state.auto && state.hasPassword;
  const runRef = useRef(run);
  runRef.current = run;

  // On open, then every few minutes.
  useEffect(() => {
    if (!auto) return;
    const first = setTimeout(() => runRef.current(null, true), AUTO_AFTER_OPEN_MS);
    const every = setInterval(() => runRef.current(null, true), AUTO_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [auto, root]);

  // Soon after a new version is saved here.
  const unsentBefore = useRef(state?.unsentVersions ?? 0);
  useEffect(() => {
    const unsent = state?.unsentVersions ?? 0;
    const grew = unsent > unsentBefore.current;
    unsentBefore.current = unsent;
    if (!auto || !grew) return;
    const timer = setTimeout(() => runRef.current(null, true), AUTO_AFTER_SAVE_MS);
    return () => clearTimeout(timer);
  }, [auto, state?.unsentVersions]);

  if (!state) return null;

  if (!state.remote) {
    return (
      <>
        <button className="btn" onClick={() => setSettings(true)} title="Хранить историю в облаке или на другом диске">
          <Icon name="cloud" /> Синхронизация
        </button>
        {settings && (
          <RemoteDialog
            root={root}
            projectName={projectName}
            state={state}
            onClose={() => setSettings(false)}
            onConnected={() => {
              setSettings(false);
              onSynced();
              run();
            }}
            onChanged={onSynced}
          />
        )}
      </>
    );
  }

  const unsent = state.unsentVersions;
  const title = [
    `Хранилище: ${state.location}`,
    state.lastSync ? `Синхронизировано ${formatDate(state.lastSync)}` : "Ещё не синхронизировано",
    unsent > 0 ? `Не отправлено версий: ${unsent}` : null,
    auto ? "Синхронизируется автоматически" : null,
    autoError ? `Не удалось синхронизировать: ${autoError}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="sync-control">
      <button className={`btn sync-main ${syncing ? "busy" : ""}`} onClick={() => run()} disabled={syncing} title={title}>
        <span className={syncing ? "spin" : ""}>
          <Icon name="sync" />
        </span>
        {syncing ? progressText(progress) : "Синхронизировать"}
        {!syncing && unsent > 0 && <span className="badge">↑{unsent}</span>}
        {!syncing && autoError && <span className="sync-warn" aria-label="ошибка синхронизации" />}
      </button>
      <button className="btn sync-gear" onClick={() => setSettings(true)} title="Настройки синхронизации" disabled={syncing}>
        <Icon name="settings" size={14} />
      </button>

      {settings && (
        <RemoteDialog
          root={root}
          projectName={projectName}
          state={state}
          onClose={() => setSettings(false)}
          onConnected={() => {
            setSettings(false);
            onSynced();
            run();
          }}
          onChanged={onSynced}
        />
      )}
      {askPassword && (
        <PromptDialog
          title="Пароль от хранилища"
          label={state.location ?? "Пароль"}
          password
          confirm="Синхронизировать"
          hint="Пароль сохранится в системной связке ключей этого компьютера."
          onSubmit={async (password) => {
            setAskPassword(false);
            await run(password);
          }}
          onClose={() => setAskPassword(false)}
        />
      )}
    </div>
  );
}
