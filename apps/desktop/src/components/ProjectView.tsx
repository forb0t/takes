import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  errorText,
  type Change,
  type DivergedBranch,
  type FileInfo,
  type Overview,
  type RemovedFile,
  type Stats,
  type SyncState,
} from "../api";
import { Icon, PromptDialog, useToast } from "../ui";
import { formatSize, prettyPath } from "../util";
import { BlueprintTab } from "./BlueprintTab";
import { CleanupDialog } from "./CleanupDialog";
import { FilesTab, projectFiles, type Drafts } from "./FilesTab";
import { HistoryTab } from "./HistoryTab";
import { ImportDialog } from "./ImportDialog";
import { MergeDialog } from "./MergeDialog";
import { SyncControl } from "./SyncControl";
import { useSongs } from "../songs";

type Tab = "files" | "blueprint" | "history";

/** Files to bring into the project; `asPath` makes one the new version of that file. */
type Importing = { sources: string[]; asPath?: string };

const draftsKey = (root: string) => `takes.drafts:${root}`;

function loadDrafts(root: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(draftsKey(root)) ?? "{}");
  } catch {
    return {};
  }
}

export function ProjectView({ root }: { root: string }) {
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("files");
  const [editAuthor, setEditAuthor] = useState(false);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [mergeFrom, setMergeFrom] = useState<DivergedBranch | null>(null);
  const [cleanup, setCleanup] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [importing, setImporting] = useState<Importing | null>(null);
  const [dropping, setDropping] = useState(false);
  /** A file to show in the Files tab (e.g. from the diagram). */
  const [focus, setFocus] = useState<{ path: string; n: number } | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  /** Files of the current version and files deleted from it, loaded per version. */
  const [saved, setSaved] = useState<FileInfo[] | null>(null);
  const [removed, setRemoved] = useState<RemovedFile[]>([]);
  /** Bumped when labels change, so lists and histories load again. */
  const [labelsVersion, setLabelsVersion] = useState(0);
  const [draftMap, setDraftMap] = useState<Record<string, string>>(() => loadDrafts(root));

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

  const head = overview?.head ?? null;
  useEffect(() => {
    if (!overview) return;
    if (!head) {
      setSaved([]);
      setRemoved([]);
      return;
    }
    let alive = true;
    Promise.all([api.files(root, head), api.removedFiles(root)])
      .then(([files, gone]) => {
        if (!alive) return;
        setSaved(files);
        setRemoved(gone);
      })
      .catch((e) => alive && toast(errorText(e), "error"));
    return () => {
      alive = false;
    };
  }, [root, head, labelsVersion, overview === null, toast]);

  const files = useMemo(() => (saved && changes ? projectFiles(saved, changes) : null), [saved, changes]);
  const songs = useSongs(root, overview, files, removed, labelsVersion, refreshAll);

  // Descriptions survive restarts, but only while their file is unsaved.
  useEffect(() => {
    if (!changes) return;
    setDraftMap((d) => {
      const kept = Object.fromEntries(Object.entries(d).filter(([path]) => changes.some((c) => c.path === path)));
      return Object.keys(kept).length === Object.keys(d).length ? d : kept;
    });
  }, [changes]);
  useEffect(() => {
    try {
      localStorage.setItem(draftsKey(root), JSON.stringify(draftMap));
    } catch {
      // Keeping drafts across restarts is a convenience.
    }
  }, [root, draftMap]);
  const drafts: Drafts = useMemo(
    () => ({
      all: draftMap,
      get: (path) => draftMap[path] ?? "",
      set: (path, text) =>
        setDraftMap((d) => {
          const next = { ...d };
          if (text) next[path] = text;
          else delete next[path];
          return next;
        }),
    }),
    [draftMap],
  );
  const labelsChanged = useCallback(() => setLabelsVersion((v) => v + 1), []);

  // Files dragged onto the window from a file manager are added, unless
  // they land on something that takes a file (a song to come on the diagram).
  useEffect(() => {
    let over: HTMLElement | null = null;
    const targetAt = ({ x, y }: { x: number; y: number }) => {
      const scale = window.devicePixelRatio || 1;
      return document.elementFromPoint(x / scale, y / scale)?.closest<HTMLElement>("[data-file-drop]") ?? null;
    };
    const hover = (target: HTMLElement | null) => {
      if (target === over) return;
      over?.classList.remove("drop-over");
      target?.classList.add("drop-over");
      over = target;
    };
    const unlisten = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "enter" || e.payload.type === "over") {
        const target = targetAt(e.payload.position);
        hover(target);
        setDropping(!target);
      } else if (e.payload.type === "leave") {
        hover(null);
        setDropping(false);
      } else if (e.payload.type === "drop") {
        const target = targetAt(e.payload.position);
        hover(null);
        setDropping(false);
        if (target) target.dispatchEvent(new CustomEvent("filedrop", { detail: e.payload.paths }));
        else if (e.payload.paths.length > 0) setImporting({ sources: e.payload.paths });
      }
    });
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  async function pickToAdd(what: "files" | "folder") {
    setAddMenu(false);
    const picked = await open(
      what === "files"
        ? { multiple: true, title: "Файлы для проекта" }
        : { directory: true, title: "Папка для проекта" },
    );
    const sources = typeof picked === "string" ? [picked] : (picked ?? []);
    if (sources.length > 0) setImporting({ sources });
  }

  async function uploadVersion(path: string) {
    const picked = await open({ multiple: false, title: `Новая версия «${path.split("/").pop()}»` });
    if (typeof picked === "string") setImporting({ sources: [picked], asPath: path });
  }

  async function backToMain() {
    try {
      await api.switchBranch(root, "main");
      refreshAll();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  function openFile(path: string) {
    setFocus((f) => ({ path, n: (f?.n ?? 0) + 1 }));
    setTab("files");
  }

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
          <div className="add-menu">
            <button className="btn" onClick={() => setAddMenu((o) => !o)} title="Скопировать файлы или папку в проект">
              <Icon name="plus" /> Добавить
            </button>
            {addMenu && (
              <div className="popover" onMouseLeave={() => setAddMenu(false)}>
                <button className="popover-main" onClick={() => pickToAdd("files")}>
                  <Icon name="wave" size={14} /> Файлы…
                </button>
                <button className="popover-main" onClick={() => pickToAdd("folder")}>
                  <Icon name="folder" size={14} /> Папку…
                </button>
                <div className="popover-hint muted">Или перетащите их в окно</div>
              </div>
            )}
          </div>
          <SyncControl root={root} projectName={overview.name} state={syncState} onSynced={refreshAll} />
        </div>
      </header>

      {syncState?.diverged.map((d) => (
        <div key={d.rev} className="banner">
          <Icon name="merge" size={15} />
          <span>
            Проект изменился и здесь, и на устройстве «{d.device}». Объедините версии, чтобы продолжить вместе.
          </span>
          <button className="btn btn-small" onClick={() => setMergeFrom(d)}>
            Объединить…
          </button>
        </div>
      ))}
      {syncState?.waiting.includes(overview.branch) &&
        (count > 0 ? (
          <div className="banner">
            <Icon name="download" size={15} />
            <span>
              С другого устройства пришли новые версии, но здесь есть несохранённые изменения. Сохраните или
              отмените их, чтобы получить их.
            </span>
          </div>
        ) : (
          <div className="banner">
            <Icon name="download" size={15} />
            <span>С другого устройства пришли новые версии.</span>
            <button className="btn btn-small" disabled={updating} onClick={updateFiles}>
              {updating ? "Обновляю…" : "Обновить файлы"}
            </button>
          </div>
        ))}

      {overview.branch !== "main" && overview.branches.some((b) => b.name === "main" && b.head) && (
        <div className="banner">
          <Icon name="branch" size={15} />
          <span>
            Папка сейчас на старой ветке проекта «{overview.branch}». Теперь ветки есть у каждого трека, а папка
            проекта одна.
          </span>
          <button className="btn btn-small" onClick={backToMain}>
            Вернуться к основной папке
          </button>
        </div>
      )}

      <nav className="tabs">
        <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
          Файлы {count > 0 && <span className="badge" title="Не сохранено">{count}</span>}
        </button>
        <button className={tab === "blueprint" ? "active" : ""} onClick={() => setTab("blueprint")}>
          Схема
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          История
        </button>
      </nav>

      <div className="tab-body">
        {tab === "files" && (
          <FilesTab
            songs={songs}
            overview={overview}
            files={files}
            removed={removed}
            statusError={statusError}
            drafts={drafts}
            focus={focus}
            refreshKey={labelsVersion}
            onChanged={refreshAll}
            onLabelsChanged={labelsChanged}
            onUploadVersion={uploadVersion}
            onAddFiles={() => pickToAdd("files")}
          />
        )}
        {tab === "blueprint" && (
          <BlueprintTab
            songs={songs}
            overview={overview}
            files={files}
            removed={removed}
            drafts={drafts}
            refreshKey={labelsVersion}
            onChanged={refreshAll}
            onLabelsChanged={labelsChanged}
            onAddFiles={pickToAdd}
            onOpenFile={openFile}
            onUploadVersion={uploadVersion}
          />
        )}
        {tab === "history" && <HistoryTab overview={overview} onChanged={refreshAll} />}
        {dropping && (
          <div className="drop-overlay">
            <Icon name="plus" size={28} />
            <div>Отпустите, чтобы добавить в «{overview.name}»</div>
            <div className="muted">Каждый файл сохранится отдельной версией</div>
          </div>
        )}
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
      {importing && (
        <ImportDialog
          overview={overview}
          sources={importing.sources}
          asPath={importing.asPath}
          onClose={() => setImporting(null)}
          onDone={refreshAll}
        />
      )}
      {cleanup && (
        <CleanupDialog
          root={root}
          stats={stats}
          keep={songs.heads()}
          onClose={() => setCleanup(false)}
          onDone={refreshAll}
        />
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
