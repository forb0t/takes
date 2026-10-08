import { useEffect, useMemo, useState } from "react";
import { api, errorText, type FileInfo, type FileVersion, type Overview } from "../api";
import { CompareButton, PlayButton } from "../player";
import { Empty, Icon, KindBadge } from "../ui";
import { formatDate, formatSize, short, splitPath } from "../util";
import { useFileActions } from "./useFileActions";

export function FilesTab({ overview, onChanged }: { overview: Overview; onChanged: () => void }) {
  const root = overview.root;
  const head = overview.head;
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!head) return;
    let alive = true;
    api
      .files(root, head)
      .then((list) => {
        if (!alive) return;
        setFiles(list);
        setSelected((s) => (s && list.some((f) => f.path === s) ? s : (list[0]?.path ?? null)));
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [root, head]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byDir = new Map<string, FileInfo[]>();
    for (const f of files ?? []) {
      if (q && !f.path.toLowerCase().includes(q)) continue;
      const { dir } = splitPath(f.path);
      byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files, query]);

  if (!head) {
    return (
      <div className="center">
        <Empty icon="folder" title="Пока нет сохранённых файлов">
          Здесь будут файлы последней версии и история каждого из них.
        </Empty>
      </div>
    );
  }

  const total = files?.reduce((sum, f) => sum + f.size, 0) ?? 0;
  return (
    <div className="split">
      <div className="split-left">
        <div className="list-head">
          <input
            className="search"
            placeholder="Найти файл"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {files && (
            <span className="muted nowrap">
              {files.length} · {formatSize(total)}
            </span>
          )}
        </div>
        {error && <div className="error-text pad">{error}</div>}
        <div className="scroll">
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
                  className={`file ${f.path === selected ? "selected" : ""} ${dir ? "nested" : ""}`}
                  onClick={() => setSelected(f.path)}
                >
                  <span className="file-name">{splitPath(f.path).name}</span>
                  <span className="size">{formatSize(f.size)}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="split-right scroll">
        {selected ? (
          <FileHistory key={selected} root={root} path={selected} onChanged={onChanged} />
        ) : (
          <div className="center muted">Выберите файл</div>
        )}
      </div>
    </div>
  );
}

function FileHistory({ root, path, onChanged }: { root: string; path: string; onChanged: () => void }) {
  const actions = useFileActions(root, onChanged);
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .fileHistory(root, path)
      .then((v) => alive && setVersions(v))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [root, path]);

  const { dir, name } = splitPath(path);
  return (
    <div className="detail">
      <div className="detail-head">
        <h2>{name}</h2>
        {dir && <div className="detail-meta">{dir}</div>}
      </div>
      <div className="section-title">
        Версии файла{versions ? ` · ${versions.length}` : ""}
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="versions">
        {versions?.map((v, i) => {
          const id = v.snapshot.id;
          const exists = v.kind !== "deleted";
          return (
            <div key={id} className="version">
              <div className="version-main">
                <div className="version-title">
                  <KindBadge kind={v.kind} />
                  <span className="version-message">{v.snapshot.message || "Без описания"}</span>
                  {i === 0 && exists && <span className="label label-current">последняя</span>}
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
                  {versions[i + 1] && versions[i + 1].kind !== "deleted" && (
                    <CompareButton
                      a={{
                        root,
                        rev: versions[i + 1].snapshot.id,
                        path,
                        label: `Предыдущая · ${versions[i + 1].snapshot.message}`,
                      }}
                      b={{ root, rev: id, path, label: `${short(id)} · ${v.snapshot.message}` }}
                    />
                  )}
                  <PlayButton track={{ root, rev: id, path, label: `Версия ${short(id)} · ${v.snapshot.message}` }} />
                  <button className="btn btn-small btn-ghost" onClick={() => actions.restore(path, id)}>
                    <Icon name="restore" size={14} /> Вернуть
                  </button>
                  <button className="btn btn-small btn-ghost" onClick={() => actions.saveCopy(path, id, short(id))}>
                    <Icon name="copy" size={14} /> Копия
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
