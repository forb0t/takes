import { useEffect, useMemo, useState } from "react";
import { api, errorText, type Change, type Overview, type Snapshot } from "../api";
import { PlayButton } from "../player";
import { Empty, Icon, KindBadge, PathLabel, PromptDialog } from "../ui";
import {
  formatDate,
  formatFullDate,
  formatSize,
  isMerge,
  labelsById,
  short,
  type Label,
} from "../util";
import { useFileActions } from "./useFileActions";

export function HistoryTab({ overview, onChanged }: { overview: Overview; onChanged: () => void }) {
  const root = overview.root;
  const [view, setView] = useState(overview.branch);
  const [log, setLog] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const labels = useMemo(() => labelsById(overview), [overview]);
  const branchesKey = overview.branches.map((b) => `${b.name}@${b.head}`).join();

  useEffect(() => setView(overview.branch), [overview.branch]);

  useEffect(() => {
    let alive = true;
    const viewed = overview.branches.find((b) => b.name === view);
    if (!viewed?.head) {
      setLog([]);
      return;
    }
    api
      .log(root, view)
      .then((list) => {
        if (!alive) return;
        setLog(list);
        setError(null);
        setSelectedId((id) => (id && list.some((s) => s.id === id) ? id : (list[0]?.id ?? null)));
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [root, view, branchesKey]);

  if (!overview.head && overview.branches.every((b) => !b.head)) {
    return (
      <div className="center">
        <Empty icon="restore" title="Пока нет версий">
          Сохраните первую версию на вкладке «Изменения». После этого здесь появится история.
        </Empty>
      </div>
    );
  }

  const selected = log?.find((s) => s.id === selectedId) ?? null;
  const withHistory = overview.branches.filter((b) => b.head);

  return (
    <div className="split">
      <div className="split-left">
        <div className="list-head">
          <span className="muted">Ветка</span>
          <select value={view} onChange={(e) => setView(e.target.value)}>
            {withHistory.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
                {b.current ? " (текущая)" : ""}
              </option>
            ))}
          </select>
          {log && <span className="muted">{log.length} верс.</span>}
        </div>
        {error && <div className="error-text pad">{error}</div>}
        <div className="timeline scroll">
          {log?.map((s, i) => (
            <button
              key={s.id}
              className={`commit ${s.id === selectedId ? "selected" : ""}`}
              onClick={() => setSelectedId(s.id)}
            >
              <div className="commit-rail">
                <span className={`commit-dot ${isMerge(s) ? "merge" : ""}`} />
                {i < log.length - 1 && <span className="commit-line" />}
              </div>
              <div className="commit-body">
                <div className="commit-message">{s.message || <i className="muted">без описания</i>}</div>
                <div className="commit-meta">
                  <span>{formatDate(s.createdAt)}</span>
                  <span>{s.author}</span>
                  <code>{short(s.id)}</code>
                </div>
                <Labels labels={labels.get(s.id)} />
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="split-right scroll">
        {selected ? (
          <VersionDetail
            key={selected.id}
            snapshot={selected}
            overview={overview}
            labels={labels.get(selected.id)}
            onChanged={onChanged}
          />
        ) : (
          <div className="center muted">Выберите версию</div>
        )}
      </div>
    </div>
  );
}

export function Labels({ labels }: { labels: Label[] | undefined }) {
  if (!labels?.length) return null;
  return (
    <div className="labels">
      {labels.map((l) => (
        <span key={`${l.kind}:${l.text}`} className={`label label-${l.kind}`}>
          <Icon name={l.kind === "tag" ? "tag" : "branch"} size={11} />
          {l.text}
        </span>
      ))}
    </div>
  );
}

function VersionDetail({
  snapshot,
  overview,
  labels,
  onChanged,
}: {
  snapshot: Snapshot;
  overview: Overview;
  labels: Label[] | undefined;
  onChanged: () => void;
}) {
  const root = overview.root;
  const actions = useFileActions(root, onChanged);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"tag" | "branch" | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .snapshotChanges(root, snapshot.id)
      .then((c) => alive && setChanges(c))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [root, snapshot.id]);

  const id = snapshot.id;
  const label = `версия ${short(id)}`;
  return (
    <div className="detail">
      <div className="detail-head">
        <h2>{snapshot.message || "Без описания"}</h2>
        <div className="detail-meta">
          <span>{snapshot.author}</span>
          <span>{formatFullDate(snapshot.createdAt)}</span>
          <code title={id}>{short(id)}</code>
          {isMerge(snapshot) && (
            <span className="label label-branch">
              <Icon name="merge" size={11} /> слияние
            </span>
          )}
        </div>
        <Labels labels={labels} />
        <div className="detail-actions">
          <button className="btn" onClick={() => setDialog("tag")}>
            <Icon name="tag" /> Отметить версию
          </button>
          <button className="btn" onClick={() => setDialog("branch")}>
            <Icon name="branch" /> Новая ветка отсюда
          </button>
        </div>
      </div>

      <div className="section-title">
        {isMerge(snapshot) ? "Изменения относительно основной ветки" : "Изменённые файлы"}
      </div>
      {error && <div className="error-text">{error}</div>}
      {changes?.length === 0 && <div className="muted">Файлы не менялись.</div>}
      <div className="list">
        {changes?.map((c) => {
          // A deleted file still exists in the previous version.
          const rev = c.kind === "deleted" ? snapshot.parents[0] : id;
          return (
            <div key={c.path} className="row">
              <KindBadge kind={c.kind} />
              <PathLabel path={c.path} />
              {c.size !== null && <span className="size">{formatSize(c.size)}</span>}
              <div className="row-actions">
                {rev && (
                  <PlayButton
                    track={{
                      root,
                      rev,
                      path: c.path,
                      label: c.kind === "deleted" ? `До удаления, ${short(rev)}` : `Версия ${short(id)}`,
                    }}
                  />
                )}
                <div className="action-slot wide">
                  {rev && (
                    <button
                      className="btn btn-small btn-ghost"
                      title="Вернуть файл в папку проекта в этом виде"
                      onClick={() => actions.restore(c.path, rev)}
                    >
                      <Icon name="restore" size={14} /> Вернуть
                    </button>
                  )}
                  {c.kind !== "deleted" && (
                    <button
                      className="btn btn-small btn-ghost"
                      title="Положить эту версию рядом с текущим файлом"
                      onClick={() => actions.saveCopy(c.path, id, short(id))}
                    >
                      <Icon name="copy" size={14} /> Копия
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {dialog === "tag" && (
        <PromptDialog
          title="Отметить версию"
          label="Название метки"
          placeholder="Например: master-v1 или «отправлено на лейбл»"
          confirm="Отметить"
          hint={`Метка навсегда привязана к ${label} и видна в истории.`}
          onSubmit={async (name) => {
            await api.createTag(root, name, id);
            onChanged();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "branch" && (
        <PromptDialog
          title="Новая ветка"
          label="Название ветки"
          placeholder="Например: acoustic"
          confirm="Создать и перейти"
          hint={`Ветка начнётся с ${label}. Файлы в папке заменятся на эту версию.`}
          onSubmit={async (name) => {
            await api.createBranch(root, name, id, true);
            onChanged();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
