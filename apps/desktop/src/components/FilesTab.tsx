import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  errorText,
  type Change,
  type ChangeKind,
  type FileInfo,
  type FileVersion,
  type Overview,
  type RemovedFile,
} from "../api";
import { CompareButton, PlayButton, usePlayer, type Track } from "../player";
import { Empty, FileLabels, Icon, KindBadge, PromptDialog, useToast } from "../ui";
import { formatDate, formatSize, naturalCompare, plural, previewKind, short, splitPath } from "../util";
import { previousVersion, type Lane, type SongVersion } from "../blueprint";
import type { Songs } from "../songs";
import { FileMetaDialog } from "./FileMetaDialog";
import { SongBranchDialog } from "./SongBranchDialog";
import { useFileActions } from "./useFileActions";

/** Where a file stands against the latest saved version. */
export type FileStatus = "saved" | ChangeKind;

/** A file of the project as it is now: saved, changed, new or deleted on disk. */
export interface ProjectFile {
  path: string;
  status: FileStatus;
  /** Size of the saved version; null for a file never saved. */
  size: number | null;
  labels: string[];
  /** The saved name of a file renamed on disk. */
  from: string | null;
}

/** Saved files of the current version merged with the unsaved changes. */
export function projectFiles(saved: FileInfo[], changes: Change[]): ProjectFile[] {
  const byPath = new Map<string, ProjectFile>(
    saved.map((f) => [f.path, { path: f.path, status: "saved", size: f.size, labels: f.labels, from: null }]),
  );
  for (const c of changes) {
    const old = c.kind === "renamed" && c.from ? byPath.get(c.from) : undefined;
    if (old) {
      // One file under its new name, not a deleted one and a new one.
      byPath.delete(old.path);
      byPath.set(c.path, { ...old, path: c.path, status: "renamed", from: old.path });
      continue;
    }
    const known = byPath.get(c.path);
    if (known) known.status = c.kind;
    else byPath.set(c.path, { path: c.path, status: c.kind, size: null, labels: [], from: null });
  }
  return [...byPath.values()].sort((a, b) => naturalCompare(a.path, b.path));
}

/** Descriptions typed for unsaved files, kept per file until it is saved. */
export interface Drafts {
  get: (path: string) => string;
  set: (path: string, text: string) => void;
  /** Path → text, for saving several files at once. */
  all: Record<string, string>;
}

const STATUS_TEXT: Record<ChangeKind, string> = {
  modified: "Изменён — не сохранено",
  added: "Новый файл — ещё не сохранён",
  deleted: "Удалён с диска — не сохранено",
  renamed: "Переименован — не сохранено",
};

/**
 * Every file of the project in one place: what is saved, what changed, what
 * is new or gone. A file's panel saves its new version and shows its history.
 */
export function FilesTab({
  overview,
  songs,
  files,
  removed,
  statusError,
  drafts,
  focus,
  refreshKey,
  onChanged,
  onLabelsChanged,
  onUploadVersion,
  onAddFiles,
}: {
  overview: Overview;
  songs: Songs;
  /** null while the folder is being checked. */
  files: ProjectFile[] | null;
  removed: RemovedFile[];
  statusError: string | null;
  drafts: Drafts;
  /** A file to select, e.g. when coming from the diagram. */
  focus: { path: string; n: number } | null;
  refreshKey: number;
  onChanged: () => void;
  onLabelsChanged: () => void;
  onUploadVersion: (path: string) => void;
  onAddFiles: () => void;
}) {
  const root = overview.root;
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(focus?.path ?? null);
  const [query, setQuery] = useState("");
  const [onlyUnsaved, setOnlyUnsaved] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  /** Enter in the list: put the cursor into that file's description. */
  const [focusRequest, setFocusRequest] = useState<{ path: string; n: number } | null>(null);
  const items = useRef(new Map<string, HTMLButtonElement>());

  // A file deleted and saved, then put back, is in the list again.
  const removedHere = useMemo(
    () => removed.filter((r) => !files?.some((f) => f.path === r.path)),
    [removed, files],
  );
  const unsaved = files?.filter((f) => f.status !== "saved") ?? [];

  useEffect(() => {
    if (focus) setSelected(focus.path);
  }, [focus]);

  // Keep the chosen file; else start with one waiting to be saved.
  useEffect(() => {
    if (!files) return;
    setSelected((s) =>
      s && (files.some((f) => f.path === s) || removedHere.some((r) => r.path === s))
        ? s
        : ((files.find((f) => f.status !== "saved") ?? files[0])?.path ?? null),
    );
  }, [files, removedHere]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byDir = new Map<string, ProjectFile[]>();
    for (const f of files ?? []) {
      if (q && !f.path.toLowerCase().includes(q)) continue;
      if (onlyUnsaved && f.status === "saved") continue;
      const { dir } = splitPath(f.path);
      const list = byDir.get(dir);
      if (list) list.push(f);
      else byDir.set(dir, [f]);
    }
    return [...byDir.entries()].sort(([a], [b]) => naturalCompare(a, b));
  }, [files, query, onlyUnsaved]);

  if (onlyUnsaved && unsaved.length === 0 && files) setOnlyUnsaved(false);

  /** ↑ and ↓ walk the list, Enter goes on to describing the file. */
  function onListKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    e.preventDefault();
    if (!selected) return;
    if (e.key === "Enter") {
      setFocusRequest((r) => ({ path: selected, n: (r?.n ?? 0) + 1 }));
      return;
    }
    const order = [
      ...groups.flatMap(([, list]) => list.map((f) => f.path)),
      ...(showRemoved && !onlyUnsaved ? removedHere.map((r) => r.path) : []),
    ];
    const at = order.indexOf(selected);
    const next = order[Math.min(Math.max(at + (e.key === "ArrowDown" ? 1 : -1), 0), order.length - 1)];
    if (next) {
      setSelected(next);
      items.current.get(next)?.focus();
    }
  }
  const keep = (path: string) => (el: HTMLButtonElement | null) => {
    if (el) items.current.set(path, el);
    else items.current.delete(path);
  };

  async function saveAll() {
    if (savingAll) return;
    setSavingAll(true);
    try {
      const ids = await api.commit(root, [], drafts.all);
      for (const f of unsaved) drafts.set(f.path, "");
      toast(
        `Сохранено ${ids.length} ${plural(ids.length, "версия", "версии", "версий")} — по одной на файл`,
        "ok",
      );
      onChanged();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSavingAll(false);
    }
  }

  if (files === null) {
    return <div className="center muted">{statusError ?? "Проверяю файлы…"}</div>;
  }

  if (files.length === 0 && removedHere.length === 0) {
    return (
      <div className="center">
        <Empty icon="folder" title="Проект пуст">
          Добавьте файлы песен — по одному или целой папкой. Каждый файл получит свою историю версий.
          <div className="empty-actions">
            <button className="btn btn-primary" onClick={onAddFiles}>
              <Icon name="plus" /> Добавить файлы
            </button>
            <button className="btn" onClick={() => api.reveal(root)}>
              <Icon name="folder" /> Открыть папку
            </button>
          </div>
        </Empty>
      </div>
    );
  }

  const selectedFile = files.find((f) => f.path === selected) ?? null;
  const selectedRemoved = selectedFile ? null : (removedHere.find((r) => r.path === selected) ?? null);
  const savedTotal = files.reduce((sum, f) => sum + (f.size ?? 0), 0);

  return (
    <div className="split">
      <div className="split-left">
        <div className="list-head">
          <input className="search" placeholder="Найти файл" value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="muted nowrap" title="Файлов в проекте · размер сохранённых версий">
            {files.length} · {formatSize(savedTotal)}
          </span>
        </div>
        {statusError && <div className="error-text pad">{statusError}</div>}
        {unsaved.length > 0 && (
          <div className="unsaved-strip">
            <span>
              Не сохранено: <b>{unsaved.length}</b>
            </span>
            <button
              className={`chip ${onlyUnsaved ? "chip-on" : ""}`}
              onClick={() => setOnlyUnsaved((o) => !o)}
              title="Показать только несохранённые файлы"
            >
              только они
            </button>
            <button
              className="btn btn-small btn-primary"
              disabled={savingAll}
              onClick={saveAll}
              title="Каждый файл станет отдельной версией со своим описанием; у файлов без описания — автоматическим"
            >
              {savingAll ? "Сохраняю…" : "Сохранить все"}
            </button>
          </div>
        )}
        <div
          className="scroll"
          role="listbox"
          aria-label="Файлы проекта"
          title="↑ ↓ — выбрать файл, Enter — описать изменения"
          onKeyDown={onListKey}
        >
          {groups.map(([dir, list]) => (
            <div key={dir} className="file-group">
              {dir && (
                <div className="file-dir">
                  <Icon name="folder" size={13} /> {dir.slice(0, -1)}
                </div>
              )}
              {list.map((f) => (
                <button
                  key={f.path}
                  ref={keep(f.path)}
                  role="option"
                  aria-selected={f.path === selected}
                  className={`file status-${f.status} ${f.path === selected ? "selected" : ""} ${dir ? "nested" : ""}`}
                  onClick={() => setSelected(f.path)}
                >
                  {f.status === "saved" ? <span className="kind-space" /> : <KindBadge kind={f.status} />}
                  <span className="file-name" title={f.path}>
                    {splitPath(f.path).name}
                  </span>
                  {drafts.get(f.path).trim() && (
                    <span className="draft-mark" title="Описание для сохранения уже написано">
                      <Icon name="edit" size={12} />
                    </span>
                  )}
                  <BranchChip songs={songs} path={f.path} />
                  <FileLabels labels={f.labels} />
                  <span className="size">{f.size !== null ? formatSize(f.size) : ""}</span>
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && <div className="muted pad">Ничего не найдено.</div>}
          {removedHere.length > 0 && !onlyUnsaved && (
            <div className="file-group removed-group">
              <button className="file-dir removed-toggle" onClick={() => setShowRemoved((s) => !s)}>
                <Icon name="trash" size={13} /> Удалённые из проекта · {removedHere.length}
                <span className={`chevron ${showRemoved ? "open" : ""}`}>
                  <Icon name="chevron" size={13} />
                </span>
              </button>
              {showRemoved &&
                removedHere.map((r) => (
                  <button
                    key={r.path}
                    ref={keep(r.path)}
                    className={`file removed ${r.path === selected ? "selected" : ""}`}
                    onClick={() => setSelected(r.path)}
                  >
                    <span className="kind-space" />
                    <span className="file-name" title={r.path}>
                      {r.path}
                    </span>
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
      <div className="split-right scroll">
        {selected && (selectedFile || selectedRemoved) ? (
          <FileDetail
            key={selected}
            overview={overview}
            songs={songs}
            path={selected}
            file={selectedFile}
            removed={selectedRemoved}
            drafts={drafts}
            refreshKey={refreshKey}
            focusDraft={focusRequest?.path === selected ? focusRequest.n : 0}
            onChanged={onChanged}
            onLabelsChanged={onLabelsChanged}
            onUploadVersion={() => onUploadVersion(selected)}
            onRenamed={setSelected}
          />
        ) : (
          <div className="center muted">Выберите файл</div>
        )}
      </div>
    </div>
  );
}

/**
 * One file: its unsaved state with a place to describe and save it, its
 * versions with listening, comparing and bringing back. Also the side
 * panel of the diagram.
 */
export function FileDetail({
  overview,
  songs,
  path,
  file,
  removed,
  elsewhere,
  rev,
  drafts,
  highlight,
  focusDraft,
  refreshKey,
  onChanged,
  onLabelsChanged,
  onUploadVersion,
  onRenamed,
}: {
  overview: Overview;
  songs: Songs;
  path: string;
  file: ProjectFile | null;
  /** Set for a file deleted and saved as deleted. */
  removed?: RemovedFile | null;
  /** Branches that have the file, for a file only on other branches. */
  elsewhere?: string[];
  /** Show the history leading to this version (default: the current branch). */
  rev?: string | null;
  drafts: Drafts;
  /** A version to point out in the list. */
  highlight?: string | null;
  /** Changes to put the cursor into the description, e.g. after a click on "сейчас" on the diagram. */
  focusDraft?: number;
  /** Changes when labels were edited: the versions are loaded again. */
  refreshKey: number;
  onChanged: () => void;
  onLabelsChanged: () => void;
  onUploadVersion: () => void;
  /** The file got another name (or folder) on disk. */
  onRenamed: (path: string) => void;
}) {
  const root = overview.root;
  const head = overview.head;
  const toast = useToast();
  const actions = useFileActions(root, onChanged);
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FileVersion | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  /** A version picked to be compared with another one. */
  const [pick, setPick] = useState<FileVersion | null>(null);
  const player = usePlayer();
  const comparable = previewKind(path) !== null;
  const draftBox = useRef<HTMLTextAreaElement>(null);
  const highlighted = useRef<HTMLDivElement>(null);
  // The versions as the diagram wires them; the history of the folder until it is built.
  const lane = songs.laneOf(path);

  useEffect(() => {
    let alive = true;
    api
      .fileHistory(root, path, rev ?? null)
      .then((v) => alive && (setVersions(v), setError(null)))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [root, path, head, rev, refreshKey]);

  useEffect(() => {
    if (focusDraft) draftBox.current?.focus();
  }, [focusDraft]);

  useEffect(() => {
    highlighted.current?.scrollIntoView({ block: "nearest" });
  }, [highlight, versions]);

  const { dir, name } = splitPath(path);
  const status = file?.status ?? "saved";
  const pending = status !== "saved" ? status : null;
  const draft = drafts.get(path);

  async function save() {
    if (saving || !pending) return;
    setSaving(true);
    try {
      const [id] = await api.commit(root, [path], { [path]: draft });
      drafts.set(path, "");
      toast(
        pending === "deleted"
          ? `Удаление «${name}» сохранено`
          : `Версия ${short(id)} «${name}» сохранена`,
        "ok",
      );
      onChanged();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSaving(false);
    }
  }

  const versionTrack = (v: FileVersion): Track => ({
    root,
    rev: v.snapshot.id,
    path: v.path,
    label: `${short(v.snapshot.id)} · ${v.snapshot.message || "без описания"}`,
  });

  /** Opens two versions side by side, the older one as A; `null` is the file on disk. */
  function compare(a: FileVersion, b: FileVersion | null) {
    setPick(null);
    const older = b && b.snapshot.createdAt < a.snapshot.createdAt ? b : a;
    const newer = older === a ? b : a;
    player.open([
      versionTrack(older!),
      newer ? versionTrack(newer) : { root, rev: null, path, label: "Сейчас на диске (не сохранено)" },
    ]);
  }

  async function rename(to: string) {
    await api.renameFile(root, path, to);
    // The description follows the file to its new name.
    if (draft) {
      drafts.set(to, draft);
      drafts.set(path, "");
    }
    onRenamed(to);
    onChanged();
  }

  const total = lane ? lane.versions : (versions?.filter((v) => v.kind !== "deleted").length ?? 0);

  /** One version: what it is, listening, comparing, labels, bringing it back; `here` when the folder has it. */
  function versionRow(v: FileVersion, previous: FileVersion | undefined, here: boolean) {
    const id = v.snapshot.id;
    const exists = v.kind !== "deleted" && !v.pruned;
    const isHighlight = id === highlight;
    return (
      <div key={id} ref={isHighlight ? highlighted : undefined} className={`version ${isHighlight ? "highlight" : ""}`}>
        <div className="version-main">
          <div className="version-title">
            <KindBadge kind={v.kind} />
            <span className="version-message">{v.snapshot.message || "Без описания"}</span>
            {v.kind === "renamed" && v.from && (
              <span className="muted nowrap" title={`Было: ${v.from}`}>
                из «{splitPath(v.from).name}»
              </span>
            )}
            {v.kind !== "renamed" && v.path !== path && (
              <span className="muted nowrap" title={v.path}>
                как «{splitPath(v.path).name}»
              </span>
            )}
            {here && exists && <span className="label label-current">в папке</span>}
            {v.pruned && (
              <span className="muted" title="Содержимое удалено при очистке места">
                удалён при очистке
              </span>
            )}
            <FileLabels labels={v.labels} />
          </div>
          <div className="commit-meta">
            <span>{formatDate(v.snapshot.createdAt)}</span>
            <span>{v.snapshot.author}</span>
            <code>{short(id)}</code>
            {v.size !== null && <span>{formatSize(v.size)}</span>}
          </div>
        </div>
        {exists && (
          <div className="row-actions">
            {comparable && total > 1 && (
              <button
                className={`btn btn-small btn-ghost ${pick === v ? "picked" : ""}`}
                title={
                  pick && pick !== v
                    ? "Сравнить эту версию с выбранной"
                    : "Выбрать версию, чтобы сравнить её с любой другой"
                }
                onClick={() => (pick && pick !== v ? compare(pick, v) : setPick(pick === v ? null : v))}
              >
                <Icon name="wave" size={14} /> {pick === v ? "Выбрана" : pick ? "С этой" : "Сравнить…"}
              </button>
            )}
            {previous && !previous.pruned && (
              <CompareButton
                a={{
                  root,
                  rev: previous.snapshot.id,
                  path: previous.path,
                  label: `Предыдущая · ${previous.snapshot.message}`,
                }}
                b={{
                  root,
                  rev: id,
                  path: v.path,
                  label: `${short(id)} · ${v.snapshot.message}`,
                }}
              />
            )}
            <PlayButton
              track={{
                root,
                rev: id,
                path: v.path,
                label: `Версия ${short(id)} · ${v.snapshot.message}`,
              }}
            />
            <button
              className="btn btn-small btn-ghost"
              title="Метки («демо», «мастер»…), темп и тональность"
              onClick={() => setEditing(v)}
            >
              <Icon name="label" size={14} /> Метки
            </button>
            <button
              className="btn btn-small btn-ghost"
              title="Вернуть файл в папку проекта в этом виде"
              onClick={() => actions.restore(path, id, v.path)}
            >
              <Icon name="restore" size={14} /> Вернуть
            </button>
            <button
              className="btn btn-small btn-ghost"
              title="Положить эту версию рядом, под другим именем"
              onClick={() => actions.saveCopy(path, id, short(id), v.path)}
            >
              <Icon name="copy" size={14} /> Копия
            </button>
          </div>
        )}
      </div>
    );
  }

  const count = total;
  return (
    <div className="detail">
      <div className="detail-head">
        <h2>{name}</h2>
        <div className="detail-meta">
          {dir && <span>{dir.slice(0, -1)}</span>}
          {elsewhere ? (
            <span className="status-pill removed">
              только в {elsewhere.length > 1 ? "ветках" : "ветке"} {elsewhere.map((b) => `«${b}»`).join(", ")}
            </span>
          ) : removed ? (
            <span className="status-pill removed">удалён из проекта</span>
          ) : pending ? (
            <span className={`status-pill ${pending}`}>не сохранено</span>
          ) : (
            <span className="status-pill saved">сохранён</span>
          )}
          {versions && count > 0 && (
            <span>
              {count} {plural(count, "версия", "версии", "версий")}
            </span>
          )}
          {file && file.labels.length > 0 && <FileLabels labels={file.labels} />}
        </div>
        <div className="detail-actions">
          {elsewhere ? null : removed ? (
            <button className="btn btn-primary" onClick={() => actions.restore(path, removed.last)}>
              <Icon name="restore" /> Вернуть в проект
            </button>
          ) : (
            <button
              className="btn"
              onClick={onUploadVersion}
              title="Выбрать файл на компьютере (имя может быть любым) и сделать его новой версией этого файла"
            >
              <Icon name="download" /> Загрузить новую версию…
            </button>
          )}
          {!removed && !elsewhere && pending !== "deleted" && (
            <>
              <button
                className="btn"
                onClick={() => setRenaming(true)}
                title="Новое имя или папка; история версий останется с файлом"
              >
                <Icon name="edit" /> Переименовать…
              </button>
              <button
                className="btn"
                onClick={() => api.reveal(`${root}/${path}`).catch((e) => toast(errorText(e), "error"))}
              >
                <Icon name="folder" /> Показать в папке
              </button>
            </>
          )}
        </div>
      </div>

      {pending && (
        <div className={`pending pending-${pending}`}>
          <div className="pending-head">
            <KindBadge kind={pending} />
            <b>{STATUS_TEXT[pending]}</b>
            <span className="grow" />
            {pending !== "deleted" && (
              <PlayButton track={{ root, rev: null, path, label: "Сейчас на диске (не сохранено)" }} text="сейчас" />
            )}
            {pending === "modified" && head && (
              <CompareButton
                a={{ root, rev: head, path, label: `Последняя версия ${short(head)}` }}
                b={{ root, rev: null, path, label: "Сейчас (не сохранено)" }}
              />
            )}
            {pending === "deleted" && head && (
              <PlayButton track={{ root, rev: head, path, label: `Последняя версия ${short(head)}` }} text="было" />
            )}
          </div>
          {pending === "renamed" && file?.from && (
            <div className="pending-note muted">
              Было: «{file.from}». Содержимое то же, история версий переходит к новому имени.
            </div>
          )}
          <textarea
            ref={draftBox}
            value={draft}
            rows={2}
            placeholder={
              pending === "deleted"
                ? "Почему удалён? Можно оставить пустым."
                : "Что изменилось? Например: «Переписал припев, новый вокал». Можно оставить пустым."
            }
            onChange={(e) => drafts.set(path, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
            }}
          />
          <div className="pending-bar">
            <span className="muted">
              Сохранить: <span className="kbd">Ctrl+Enter</span>
            </span>
            {pending === "modified" && (
              <button className="btn btn-ghost" onClick={() => actions.discard(path)}>
                <Icon name="undo" size={14} /> Отменить изменения
              </button>
            )}
            {pending === "deleted" && (
              <button className="btn" onClick={() => actions.restore(path, "HEAD")}>
                <Icon name="restore" size={14} /> Вернуть файл
              </button>
            )}
            {pending === "renamed" && file?.from && (
              <button className="btn btn-ghost" onClick={() => rename(file.from!)}>
                <Icon name="undo" size={14} /> Вернуть старое имя
              </button>
            )}
            <button className="btn btn-primary" disabled={saving} onClick={save}>
              <Icon name="check" />{" "}
              {saving ? "Сохраняю…" : pending === "deleted" ? "Сохранить удаление" : "Сохранить версию"}
            </button>
          </div>
        </div>
      )}

      {pick && (
        <div className="pick-strip">
          <span>
            Сравнение: выбрана <b>{short(pick.snapshot.id)}</b> · {pick.snapshot.message || "без описания"}. Выберите
            вторую версию
          </span>
          {file && (pending === "modified" || pending === "renamed") && (
            <button className="btn btn-small" onClick={() => compare(pick, null)}>
              или файл на диске
            </button>
          )}
          <button className="btn btn-small btn-ghost" onClick={() => setPick(null)}>
            Отмена
          </button>
        </div>
      )}
      {lane ? (
        <SongVersions
          songs={songs}
          lane={lane}
          editable={!elsewhere && !removed}
          row={(n) => {
            const before = previousVersion(lane, n);
            return versionRow(asFile(n), before ? asFile(before) : undefined, n.inFolder);
          }}
        />
      ) : (
        <>
          <div className="section-title">
            Версии файла{versions ? ` · ${versions.length}` : ""}
            {rev && <span className="muted"> · по истории выбранной версии (другая ветка)</span>}
          </div>
          {error && <div className="error-text">{error}</div>}
          {versions?.length === 0 && (
            <div className="muted">Сохранённых версий ещё нет — сохраните файл, и здесь начнётся его история.</div>
          )}
          <div className="versions">
            {versions?.map((v, i) =>
              versionRow(
                v,
                versions.slice(i + 1).find((p) => p.kind !== "deleted"),
                i === 0 && !!file && !removed && !rev,
              ),
            )}
          </div>
        </>
      )}
      {renaming && (
        <PromptDialog
          title={`Переименовать «${name}»`}
          label="Новое имя (можно с папкой: «Демо/Ночь.wav»)"
          initial={path}
          confirm="Переименовать"
          hint="Файл переименуется в папке проекта. Сохраните версию — и история останется с ним под новым именем."
          onSubmit={(to) => rename(to.replace(/\\/g, "/"))}
          onClose={() => setRenaming(false)}
        />
      )}
      {editing && (
        <FileMetaDialog
          root={root}
          rev={editing.snapshot.id}
          path={editing.path}
          versionLabel={`Версия ${short(editing.snapshot.id)} · ${editing.snapshot.message || "без описания"}`}
          onClose={() => setEditing(null)}
          onSaved={onLabelsChanged}
        />
      )}
    </div>
  );
}

/** The branch of a song in the folder, when the song has more than one. */
function BranchChip({ songs, path }: { songs: Songs; path: string }) {
  const lane = songs.laneOf(path);
  const active = lane?.branches.find((b) => b.active);
  if (!lane || lane.branches.length < 2 || !active) return null;
  return (
    <span className="branch-chip" title={`В папке ветка «${active.name}», всего веток: ${lane.branches.length}`}>
      <Icon name="branch" size={10} />
      {active.name}
    </span>
  );
}

/** A version of a song as the list of a file's versions shows it. */
function asFile(n: SongVersion): FileVersion {
  const { id, parents, message, author, createdAt } = n.version;
  return {
    snapshot: { id, parents, message, author, createdAt },
    kind: n.change,
    path: n.path,
    from: n.from,
    size: n.size,
    pruned: n.pruned,
    labels: n.labels,
  };
}

/**
 * A song's versions, as the diagram wires them: each branch (which one is
 * in the folder, putting another one there, renaming, joining) with its
 * versions, the latest on top, then the versions wired into no branch.
 */
function SongVersions({
  songs,
  lane,
  editable,
  row,
}: {
  songs: Songs;
  lane: Lane;
  /** The song is in the folder: its branches can change. */
  editable: boolean;
  row: (n: SongVersion) => React.ReactNode;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const headOf = (key: string) => lane.nodes.find((n): n is SongVersion => n.kind === "version" && n.key === key);
  const activeHead = headOf(lane.branches.find((b) => b.active)?.head ?? "");
  const track = (b: string, n: SongVersion) => ({
    root: songs.root,
    rev: n.version.id,
    path: n.path,
    label: `Ветка «${b}», версия ${n.number}`,
  });
  /** A row's versions, the latest first. */
  const versionsIn = (r: number) =>
    lane.nodes.filter((n): n is SongVersion => n.kind === "version" && n.row === r).sort((a, b) => b.col - a.col);
  const loose = lane.looseRow === null ? [] : versionsIn(lane.looseRow);

  return (
    <>
      <div className="section-title with-action">
        Ветки и версии · {lane.branches.length} {plural(lane.branches.length, "ветка", "ветки", "веток")},{" "}
        {lane.versions} {plural(lane.versions, "версия", "версии", "версий")}
        <span className="grow" />
        {editable && (
          <button className="btn btn-small btn-ghost" onClick={() => setCreating(true)}>
            <Icon name="plus" size={13} /> Новая ветка из файла…
          </button>
        )}
      </div>
      {lane.nodes.every((n) => n.kind !== "version") && (
        <div className="muted">Сохранённых версий ещё нет — сохраните файл, и здесь начнётся его история.</div>
      )}
      <div className="song-branches">
        {lane.branches.map((b) => {
          const head = headOf(b.head);
          const usable = head && head.change !== "deleted" && !head.pruned;
          const others = lane.branches.filter((o) => o.name !== b.name);
          return (
            <div key={b.name} className="song-branch-group">
              <div className={`song-branch ${b.active ? "active" : ""}`}>
                <Icon name="branch" size={14} />
                <b className="song-branch-name">{b.name}</b>
                <span className="muted nowrap">
                  {b.versions} {plural(b.versions, "версия", "версии", "версий")}
                </span>
                {b.active && <span className="label label-current">в папке</span>}
                <span className="grow" />
                {usable && !b.active && activeHead && activeHead.change !== "deleted" && !activeHead.pruned && (
                  <CompareButton
                    a={track(lane.branches.find((x) => x.active)!.name, activeHead)}
                    b={track(b.name, head)}
                  />
                )}
                {usable && <PlayButton track={track(b.name, head)} />}
                {usable && !b.active && editable && (
                  <button
                    className="btn btn-small"
                    title="Положить последнюю версию этой ветки в папку проекта"
                    onClick={() => songs.intoFolder(lane, head)}
                  >
                    <Icon name="restore" size={13} /> В папку
                  </button>
                )}
                {editable && (
                  <div className="add-menu">
                    <button className="icon-btn" title="Ещё" onClick={() => setMenu(menu === b.name ? null : b.name)}>
                      <Icon name="more" size={14} />
                    </button>
                    {menu === b.name && (
                      <div className="popover" onMouseLeave={() => setMenu(null)}>
                        <button
                          className="popover-main"
                          onClick={() => {
                            setMenu(null);
                            setRenaming(b.name);
                          }}
                        >
                          <Icon name="edit" size={14} /> Переименовать…
                        </button>
                        {head && !b.active && usable && (
                          <button
                            className="popover-main"
                            onClick={() => {
                              setMenu(null);
                              songs.addFile(lane, b.name);
                            }}
                          >
                            <Icon name="download" size={14} /> Новая версия в ветку…
                          </button>
                        )}
                        {others.map((o) => (
                          <button
                            key={o.name}
                            className="popover-main"
                            onClick={() => {
                              setMenu(null);
                              songs.joinBranch(lane, b.name, o.name);
                            }}
                          >
                            <Icon name="merge" size={14} /> Перенести все версии в «{o.name}»
                          </button>
                        ))}
                        {!b.active && (
                          <button
                            className="popover-main danger-text"
                            onClick={() => {
                              setMenu(null);
                              songs.deleteBranch(lane, b.name);
                            }}
                          >
                            <Icon name="trash" size={14} /> Удалить ветку…
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="versions">{versionsIn(b.row).map(row)}</div>
            </div>
          );
        })}
        {loose.length > 0 && (
          <div className="song-branch-group">
            <div
              className="song-branch loose"
              title="Отсоединены от веток на схеме: проведите к ним провод, чтобы вернуть в ветку"
            >
              <Icon name="close" size={14} />
              <b className="song-branch-name">Без ветки</b>
              <span className="muted nowrap">
                {loose.length} {plural(loose.length, "версия", "версии", "версий")}
              </span>
            </div>
            <div className="versions">{loose.map(row)}</div>
          </div>
        )}
      </div>
      {renaming && (
        <PromptDialog
          title={`Переименовать ветку «${renaming}»`}
          label="Новое название"
          initial={renaming}
          confirm="Переименовать"
          onSubmit={async (to) => {
            if (to !== renaming && lane.branches.some((b) => b.name.toLowerCase() === to.toLowerCase())) {
              throw new Error(`У трека уже есть ветка «${to}»`);
            }
            songs.renameBranch(lane, renaming, to);
          }}
          onClose={() => setRenaming(null)}
        />
      )}
      {creating && (
        <SongBranchDialog
          path={lane.path}
          taken={lane.branches.map((b) => b.name)}
          start="версии, которая сейчас в папке"
          onCreate={(name, source, intoFolder) => songs.createBranch(lane, "HEAD", name, source, intoFolder)}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
