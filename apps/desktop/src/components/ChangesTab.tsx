import { useState } from "react";
import { api, errorText, type Change, type Overview } from "../api";
import { PlayButton } from "../player";
import { Empty, Icon, KindBadge, PathLabel, useToast } from "../ui";
import { plural, short } from "../util";
import { useFileActions } from "./useFileActions";

export function ChangesTab({
  overview,
  changes,
  statusError,
  onChanged,
}: {
  overview: Overview;
  changes: Change[] | null;
  statusError: string | null;
  onChanged: () => void;
}) {
  const root = overview.root;
  const toast = useToast();
  const actions = useFileActions(root, onChanged);
  // Track what is unticked, so files that appear later are ticked by default.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  if (changes === null) {
    return <div className="center muted">{statusError ?? "Проверяю файлы…"}</div>;
  }

  if (changes.length === 0) {
    return (
      <div className="center">
        <Empty icon={overview.head ? "check" : "folder"} title={overview.head ? "Всё сохранено" : "Проект пуст"}>
          {overview.head
            ? "Работайте с файлами в папке проекта. Takes заметит изменения и покажет их здесь."
            : "Положите файлы в папку проекта, например демки песен. Они появятся здесь."}
          <button className="btn" onClick={() => api.reveal(root)}>
            <Icon name="folder" /> Открыть папку
          </button>
        </Empty>
      </div>
    );
  }

  const selected = changes.filter((c) => !excluded.has(c.path));
  const all = selected.length === changes.length;
  const canSave = selected.length > 0 && message.trim().length > 0 && !saving;

  function toggle(path: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const id = await api.commit(root, message.trim(), all ? [] : selected.map((c) => c.path));
      setMessage("");
      setExcluded(new Set());
      toast(`Версия ${short(id)} сохранена в «${overview.branch}»`, "ok");
      onChanged();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSaving(false);
    }
  }

  const head = overview.head;
  return (
    <div className="changes">
      <div className="list-head">
        <label className="check">
          <input
            type="checkbox"
            checked={all}
            ref={(el) => {
              if (el) el.indeterminate = !all && selected.length > 0;
            }}
            onChange={() => setExcluded(all ? new Set(changes.map((c) => c.path)) : new Set())}
          />
          <span>
            {changes.length} {plural(changes.length, "изменённый файл", "изменённых файла", "изменённых файлов")}
          </span>
        </label>
        {statusError && <span className="error-text">{statusError}</span>}
      </div>

      <div className="list scroll">
        {changes.map((c) => (
          <div key={c.path} className={`row ${excluded.has(c.path) ? "row-off" : ""}`}>
            <input type="checkbox" checked={!excluded.has(c.path)} onChange={() => toggle(c.path)} />
            <KindBadge kind={c.kind} />
            <PathLabel path={c.path} />
            <div className="row-actions">
              {c.kind !== "deleted" && (
                <PlayButton
                  track={{ root, rev: null, path: c.path, label: "Сейчас на диске (не сохранено)" }}
                  text={c.kind === "modified" ? "сейчас" : undefined}
                />
              )}
              {c.kind !== "added" && head && (
                <PlayButton
                  track={{ root, rev: head, path: c.path, label: `Последняя версия ${short(head)}` }}
                  text="было"
                />
              )}
              <div className="action-slot">
                {c.kind === "modified" && (
                  <button className="btn btn-small btn-ghost" onClick={() => actions.discard(c.path)}>
                    <Icon name="undo" size={14} /> Отменить
                  </button>
                )}
                {c.kind === "deleted" && (
                  <button className="btn btn-small btn-ghost" onClick={() => actions.restore(c.path, "HEAD")}>
                    <Icon name="restore" size={14} /> Вернуть
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="composer">
        <textarea
          value={message}
          placeholder="Что изменилось? Например: «Переписал припев, новый вокал»"
          rows={2}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
          }}
        />
        <div className="composer-bar">
          <span className="muted">
            {all
              ? `Все файлы → ветка «${overview.branch}»`
              : `${selected.length} из ${changes.length} → ветка «${overview.branch}»`}
            <span className="kbd">Ctrl+Enter</span>
          </span>
          <button className="btn btn-primary" disabled={!canSave} onClick={save}>
            <Icon name="check" /> {saving ? "Сохраняю…" : "Сохранить версию"}
          </button>
        </div>
      </div>
    </div>
  );
}
