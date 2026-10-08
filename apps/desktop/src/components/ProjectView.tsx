import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, type Change, type DivergedBranch, type Overview, type Stats, type SyncState } from "../api";
import { Icon, PromptDialog, useToast } from "../ui";
import { formatSize, prettyPath } from "../util";
import { BranchMenu } from "./BranchMenu";
import { ChangesTab } from "./ChangesTab";
import { CleanupDialog } from "./CleanupDialog";
import { FilesTab } from "./FilesTab";
import { HistoryTab } from "./HistoryTab";
import { MergeDialog } from "./MergeDialog";
import { SyncControl } from "./SyncControl";

type Tab = "changes" | "history" | "files";

export function ProjectView({ root }: { root: string }) {
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("changes");
  const [editAuthor, setEditAuthor] = useState(false);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [mergeFrom, setMergeFrom] = useState<DivergedBranch | null>(null);
  const [cleanup, setCleanup] = useState(false);
  const [updating, setUpdating] = useState(false);

  // Status can take a while on big files; never run two at once, but
  // remember that another run was requested meanwhile.
  const statusRunning = useRef(false);
  const statusAgain = useRef(false);
  const refreshStatus = useCallback(async () => {
    if (statusRunning.current) {
      statusAgain.current = true;
      return;
    }
    statusRunning.current = true;
    try {
      do {
        statusAgain.current = false;
        try {
          setChanges(await api.status(root));
          setStatusError(null);
        } catch (e) {
          // Typically a file mid-write in the DAW; the next event retries.
          setStatusError(errorText(e));
        }
      } while (statusAgain.current);
    } finally {
      statusRunning.current = false;
    }
  }, [root]);

  const refreshAll = useCallback(async () => {
    // Disk usage walks the whole store: never let it hold up the rest.
    api.stats(root).then(setStats, () => {});
    try {
      const [o, sync] = await Promise.all([api.overview(root), api.syncState(root)]);
      setOverview(o);
      setSyncState(sync);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
    await refreshStatus();
  }, [root, refreshStatus]);

  async function updateFiles() {
    setUpdating(true);
    try {
      const report = await api.updateCurrent(root);
      if (report.currentBlocked === "unsaved") {
        toast("Сначала сохраните или отмените изменения.", "error");
      } else if (report.currentBlocked) {
        toast(`Не получилось обновить: мешают файлы ${report.blockedPaths.join(", ")}.`, "error");
      } else {
        toast("Файлы обновлены до новой версии", "ok");
      }
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setUpdating(false);
      refreshAll();
    }
  }

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // Follow changes made in other apps.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(refreshStatus, 400);
    };
    api.watchProject(root).catch((e) => toast(`Не удалось следить за папкой: ${errorText(e)}`, "error"));
    const unlisten = listen<string>("worktree-changed", (e) => e.payload === root && schedule());
    window.addEventListener("focus", schedule);
    return () => {
      clearTimeout(timer);
      unlisten.then((f) => f());
      window.removeEventListener("focus", schedule);
    };
  }, [root, refreshStatus, toast]);

  if (loadError && !overview) {
    return <div className="center error-text">{loadError}</div>;
  }
  if (!overview) {
    return <div className="center muted">Открываю проект…</div>;
  }

  const count = changes?.length ?? 0;
  return (
    <div className="project">
      <header className="project-head">
        <div className="project-title">
          <h1>{overview.name}</h1>
          <button className="project-path" title="Показать в файловом менеджере" onClick={() => api.reveal(root)}>
            <Icon name="folder" size={13} />
            {prettyPath(overview.root)}
          </button>
        </div>
        <div className="project-tools">
          {stats && stats.snapshots > 0 && (
            <button className="chip muted nowrap" title="Сколько места занимает история · освободить" onClick={() => setCleanup(true)}>
              {stats.snapshots} верс. · {formatSize(stats.storedBytes)}
            </button>
          )}
          <button className="chip" title="Автор новых версий" onClick={() => setEditAuthor(true)}>
            {overview.author} <Icon name="edit" size={12} />
          </button>
          <BranchMenu overview={overview} onChanged={refreshAll} />
          <SyncControl root={root} projectName={overview.name} state={syncState} onSynced={refreshAll} />
        </div>
      </header>

      {syncState?.diverged.map((d) => (
        <div key={d.rev} className="banner">
          <Icon name="merge" size={15} />
          <span>
            Ветка «{d.branch}» изменилась и здесь, и на устройстве «{d.device}». Слейте версии, чтобы продолжить
            вместе.
          </span>
          <button className="btn btn-small" onClick={() => setMergeFrom(d)}>
            Слить…
          </button>
        </div>
      ))}
      {syncState?.waiting.includes(overview.branch) &&
        (count > 0 ? (
          <div className="banner">
            <Icon name="download" size={15} />
            <span>
              С другого устройства пришла новая версия «{overview.branch}», но здесь есть несохранённые изменения.
              Сохраните или отмените их, чтобы получить её.
            </span>
          </div>
        ) : (
          <div className="banner">
            <Icon name="download" size={15} />
            <span>С другого устройства пришла новая версия «{overview.branch}».</span>
            <button className="btn btn-small" disabled={updating} onClick={updateFiles}>
              {updating ? "Обновляю…" : "Обновить файлы"}
            </button>
          </div>
        ))}

      <nav className="tabs">
        <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
          Изменения {count > 0 && <span className="badge">{count}</span>}
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          История
        </button>
        <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
          Файлы
        </button>
      </nav>

      <div className="tab-body">
        {tab === "changes" && (
          <ChangesTab overview={overview} changes={changes} statusError={statusError} onChanged={refreshAll} />
        )}
        {tab === "history" && <HistoryTab overview={overview} onChanged={refreshAll} />}
        {tab === "files" && <FilesTab overview={overview} onChanged={refreshAll} />}
      </div>

      {mergeFrom && (
        <MergeDialog
          overview={overview}
          remoteSources={syncState?.diverged ?? []}
          initialSource={mergeFrom.rev}
          onClose={() => setMergeFrom(null)}
          onMerged={refreshAll}
        />
      )}
      {cleanup && (
        <CleanupDialog root={root} stats={stats} onClose={() => setCleanup(false)} onDone={refreshAll} />
      )}
      {editAuthor && (
        <PromptDialog
          title="Автор версий"
          label="Имя"
          initial={overview.author}
          confirm="Сохранить"
          hint="Это имя будет у новых версий в этом проекте."
          onSubmit={async (name) => {
            await api.setAuthor(root, name);
            await refreshAll();
          }}
          onClose={() => setEditAuthor(false)}
        />
      )}
    </div>
  );
}
