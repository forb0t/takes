import { useEffect, useState } from "react";
import {
  api,
  errorText,
  isCommandError,
  type Conflict,
  type DivergedBranch,
  type MergePreview,
  type Overview,
  type Resolution,
} from "../api";
import { CompareButton, PlayButton } from "../player";
import { Icon, KindBadge, Modal, PathLabel, useToast } from "../ui";
import { copyName, formatSize, plural, short, splitPath } from "../util";

export function MergeDialog({
  overview,
  remoteSources = [],
  initialSource,
  onClose,
  onMerged,
}: {
  overview: Overview;
  /** Branches that also changed on other devices, merged as `branch@device`. */
  remoteSources?: DivergedBranch[];
  initialSource?: string;
  onClose: () => void;
  onMerged: () => void;
}) {
  const root = overview.root;
  const toast = useToast();
  const sources = [
    ...remoteSources.map((d) => ({ value: d.rev, label: `${d.branch} с устройства «${d.device}»` })),
    ...overview.branches.filter((b) => !b.current && b.head).map((b) => ({ value: b.name, label: b.name })),
  ];
  const [source, setSource] = useState(initialSource ?? sources[0]?.value ?? "");
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [choices, setChoices] = useState<Record<string, Resolution>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    setPreview(null);
    setChoices({});
    setError(null);
    api
      .mergePreview(root, source)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [root, source]);

  const conflicts = preview?.conflicts ?? [];
  const unresolved = conflicts.filter((c) => !choices[c.path]).length;
  const canMerge = preview && preview.kind !== "upToDate" && unresolved === 0 && !busy;

  async function merge() {
    if (!canMerge) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.merge(root, source, choices);
      if (outcome.kind === "conflicts") {
        // The branches moved meanwhile; show the fresh conflicts.
        setPreview({ kind: "merge", changes: preview.changes, conflicts: outcome.conflicts });
        return;
      }
      toast(
        outcome.kind === "fastForward"
          ? `«${overview.branch}» обновлена до «${source}»`
          : outcome.kind === "merged"
            ? `«${source}» слита в «${overview.branch}» (${short(outcome.id ?? "")})`
            : "Нечего сливать",
        "ok",
      );
      onMerged();
      onClose();
    } catch (e) {
      setError(
        isCommandError(e) && e.kind === "wouldOverwrite"
          ? `Мешают несохранённые файлы: ${e.paths.join(", ")}`
          : errorText(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Слить ветку в «${overview.branch}»`}
      wide
      onClose={onClose}
      footer={
        <>
          {unresolved > 0 && (
            <span className="muted grow">
              Осталось решить: {unresolved} {plural(unresolved, "файл", "файла", "файлов")}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={!canMerge} onClick={merge}>
            <Icon name="merge" /> {busy ? "Сливаю…" : "Слить"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Какую ветку слить</span>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          {sources.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      {error && <div className="error-text">{error}</div>}
      {!preview && !error && <div className="muted">Сравниваю ветки…</div>}

      {preview?.kind === "upToDate" && (
        <div className="notice">Все версии из «{source}» уже есть в «{overview.branch}». Сливать нечего.</div>
      )}
      {preview?.kind === "fastForward" && (
        <div className="notice">
          В «{overview.branch}» нет ничего нового относительно «{source}», поэтому она просто получит версии из
          «{source}».
        </div>
      )}

      {preview && preview.changes.length > 0 && (
        <>
          <div className="section-title">Применится автоматически · {preview.changes.length}</div>
          <div className="list compact">
            {preview.changes.map((c) => (
              <div key={c.path} className="row">
                <KindBadge kind={c.kind} />
                <PathLabel path={c.path} />
              </div>
            ))}
          </div>
        </>
      )}

      {conflicts.length > 0 && (
        <>
          <div className="section-title">
            Изменены в обеих ветках · {conflicts.length}
            <span className="muted"> · выберите, что оставить</span>
          </div>
          <div className="conflicts">
            {conflicts.map((c) => (
              <ConflictRow
                key={c.path}
                conflict={c}
                root={root}
                ours={overview.branch}
                oursRev={overview.head ?? "HEAD"}
                theirs={source}
                theirsName={remoteSources.find((d) => d.rev === source)?.device ?? source}
                choice={choices[c.path]}
                onChoose={(r) => setChoices((all) => ({ ...all, [c.path]: r }))}
              />
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function ConflictRow({
  conflict,
  root,
  ours,
  oursRev,
  theirs,
  theirsName,
  choice,
  onChoose,
}: {
  conflict: Conflict;
  root: string;
  ours: string;
  oursRev: string;
  /** Rev to load their version from. */
  theirs: string;
  /** How to call their side: a branch, or the other device's name. */
  theirsName: string;
  choice: Resolution | undefined;
  onChoose: (r: Resolution) => void;
}) {
  const path = conflict.path;
  const describe = (side: Conflict["ours"]) => (side ? formatSize(side.size) : "удалён");
  const options: { value: Resolution; title: string; sub: string; disabled?: boolean }[] = [
    { value: "ours", title: `Из «${ours}»`, sub: describe(conflict.ours) },
    { value: "theirs", title: `Из «${theirsName}»`, sub: describe(conflict.theirs) },
    {
      value: "both",
      title: "Оставить обе",
      sub: `вторая: ${splitPath(copyName(path, theirs.replace(/\//g, "-"))).name}`,
      disabled: !conflict.ours || !conflict.theirs,
    },
  ];
  return (
    <div className="conflict">
      <div className="conflict-head">
        <PathLabel path={path} />
        <div className="row-actions">
          {conflict.ours && conflict.theirs && (
            <CompareButton
              a={{ root, rev: oursRev, path, label: `Из «${ours}»` }}
              b={{ root, rev: theirs, path, label: `Из «${theirsName}»` }}
            />
          )}
          {conflict.ours && (
            <PlayButton track={{ root, rev: oursRev, path, label: `Из «${ours}»` }} text={ours} />
          )}
          {conflict.theirs && (
            <PlayButton track={{ root, rev: theirs, path, label: `Из «${theirsName}»` }} text={theirsName} />
          )}
        </div>
      </div>
      <div className="segmented">
        {options.map((o) => (
          <button
            key={o.value}
            className={choice === o.value ? "active" : ""}
            disabled={o.disabled}
            onClick={() => onChoose(o.value)}
          >
            <span>{o.title}</span>
            <small>{o.sub}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
