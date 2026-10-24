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
import { CompareButton, PlayButton } from "../player";
import { Empty, FileLabels, Icon, KindBadge, useToast } from "../ui";
import { formatDate, formatSize, naturalCompare, plural, short, splitPath } from "../util";
import { FileMetaDialog } from "./FileMetaDialog";
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
}

/** Saved files of the current version merged with the unsaved changes. */
export function projectFiles(saved: FileInfo[], changes: Change[]): ProjectFile[] {
  const byPath = new Map<string, ProjectFile>(
    saved.map((f) => [f.path, { path: f.path, status: "saved", size: f.size, labels: f.labels }]),
  );
  for (const c of changes) {
    const known = byPath.get(c.path);
    if (known) known.status = c.kind;
    else byPath.set(c.path, { path: c.path, status: c.kind, size: null, labels: [] });
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
};

/**
 * Every file of the project in one place: what is saved, what changed, what
 * is new or gone. A file's panel saves its new version and shows its history.
 */
export function FilesTab({
  overview,
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

  async function saveAll() {
    if (savingAll) return;
    setSavingAll(true);
    try {
      const ids = await api.commit(root, [], drafts.all);
      for (const f of unsaved) drafts.set(f.path, "");
      toast(
        `Сохранено ${ids.length} ${plural(ids.length, "версия", "версии", "версий")} в «${overview.branch}» — по одной на файл`,
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
        <div className="scroll" role="listbox" aria-label="Файлы проекта">
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
            path={selected}
            file={selectedFile}
            removed={selectedRemoved}
            drafts={drafts}
            refreshKey={refreshKey}
            onChanged={onChanged}
            onLabelsChanged={onLabelsChanged}
            onUploadVersion={() => onUploadVersion(selected)}
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
  path,
  file,
  removed,
  drafts,
  highlight,
  focusDraft,
  refreshKey,
  onChanged,
  onLabelsChanged,
  onUploadVersion,
}: {
  overview: Overview;
  path: string;
  file: ProjectFile | null;
  /** Set for a file deleted and saved as deleted. */
  removed?: RemovedFile | null;
  drafts: Drafts;
  /** A version to point out in the list. */
  highlight?: string | null;
  /** Put the cursor into the description, e.g. after "Сохранить…" on the diagram. */
  focusDraft?: boolean;
  /** Changes when labels were edited: the versions are loaded again. */
  refreshKey: number;
  onChanged: () => void;
  onLabelsChanged: () => void;
  onUploadVersion: () => void;
}) {
  const root = overview.root;
  const head = overview.head;
  const toast = useToast();
  const actions = useFileActions(root, onChanged);
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FileVersion | null>(null);
  const [saving, setSaving] = useState(false);
  const draftBox = useRef<HTMLTextAreaElement>(null);
  const highlighted = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .fileHistory(root, path)
      .then((v) => alive && (setVersions(v), setError(null)))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [root, path, head, refreshKey]);

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
          ? `Удаление «${name}» сохранено в «${overview.branch}»`
          : `Версия ${short(id)} «${name}» сохранена в «${overview.branch}»`,
        "ok",
      );
      onChanged();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSaving(false);
    }
  }

  const count = versions?.filter((v) => v.kind !== "deleted").length ?? 0;
  return (
    <div className="detail">
      <div className="detail-head">
        <h2>{name}</h2>
        <div className="detail-meta">
          {dir && <span>{dir.slice(0, -1)}</span>}
          {removed ? (
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
          {removed ? (
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
          {!removed && pending !== "deleted" && (
            <button
              className="btn"
              onClick={() => api.reveal(`${root}/${path}`).catch((e) => toast(errorText(e), "error"))}
            >
              <Icon name="folder" /> Показать в папке
            </button>
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
              → ветка «{overview.branch}»<span className="kbd">Ctrl+Enter</span>
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
            <button className="btn btn-primary" disabled={saving} onClick={save}>
              <Icon name="check" />{" "}
              {saving ? "Сохраняю…" : pending === "deleted" ? "Сохранить удаление" : "Сохранить версию"}
            </button>
          </div>
        </div>
      )}

      <div className="section-title">Версии файла{versions ? ` · ${versions.length}` : ""}</div>
      {error && <div className="error-text">{error}</div>}
      {versions?.length === 0 && (
        <div className="muted">Сохранённых версий ещё нет — сохраните файл, и здесь начнётся его история.</div>
      )}
      <div className="versions">
        {versions?.map((v, i) => {
          const id = v.snapshot.id;
          const exists = v.kind !== "deleted" && !v.pruned;
          const previous = versions.slice(i + 1).find((p) => p.kind !== "deleted");
          const isHighlight = id === highlight;
          return (
            <div key={id} ref={isHighlight ? highlighted : undefined} className={`version ${isHighlight ? "highlight" : ""}`}>
              <div className="version-main">
                <div className="version-title">
                  <KindBadge kind={v.kind} />
                  <span className="version-message">{v.snapshot.message || "Без описания"}</span>
                  {i === 0 && exists && !removed && <span className="label label-current">последняя</span>}
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
                  {previous && !previous.pruned && (
                    <CompareButton
                      a={{ root, rev: previous.snapshot.id, path, label: `Предыдущая · ${previous.snapshot.message}` }}
                      b={{ root, rev: id, path, label: `${short(id)} · ${v.snapshot.message}` }}
                    />
                  )}
                  <PlayButton track={{ root, rev: id, path, label: `Версия ${short(id)} · ${v.snapshot.message}` }} />
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
                    onClick={() => actions.restore(path, id)}
                  >
                    <Icon name="restore" size={14} /> Вернуть
                  </button>
                  <button
                    className="btn btn-small btn-ghost"
                    title="Положить эту версию рядом, под другим именем"
                    onClick={() => actions.saveCopy(path, id, short(id))}
                  >
                    <Icon name="copy" size={14} /> Копия
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {editing && (
        <FileMetaDialog
          root={root}
          rev={editing.snapshot.id}
          path={path}
          versionLabel={`Версия ${short(editing.snapshot.id)} · ${editing.snapshot.message || "без описания"}`}
          onClose={() => setEditing(null)}
          onSaved={onLabelsChanged}
        />
      )}
    </div>
  );
}
