import { useEffect, useState } from "react";
import { api, errorText, type Change, type Overview } from "../api";
import { CompareButton, PlayButton } from "../player";
import { Empty, Icon, KindBadge, PathLabel, useToast } from "../ui";
import { plural, short, splitPath } from "../util";
import { useFileActions } from "./useFileActions";

/**
 * Unsaved changes. Every version is about one file: pick a file and save
 * its version, or save all of them, each as a version of its own.
 */
export function ChangesTab({
  overview,
  changes,
  statusError,
  onChanged,
  onAddFiles,
}: {
  overview: Overview;
  changes: Change[] | null;
  statusError: string | null;
  onChanged: () => void;
  /** Opens the "add files to the project" flow. */
  onAddFiles: () => void;
}) {
  const root = overview.root;
  const toast = useToast();
  const actions = useFileActions(root, onChanged);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState<"one" | "all" | null>(null);

  // Keep a file picked: the one chosen before if it is still changed.
  useEffect(() => {
    if (!changes) return;
    setSelected((s) => (s && changes.some((c) => c.path === s) ? s : (changes[0]?.path ?? null)));
  }, [changes]);

  if (changes === null) {
    return <div className="center muted">{statusError ?? "Проверяю файлы…"}</div>;
  }

  if (changes.length === 0) {
    return (
      <div className="center">
        <Empty icon={overview.head ? "check" : "folder"} title={overview.head ? "Всё сохранено" : "Проект пуст"}>
          {overview.head
            ? "Работайте с файлами в папке проекта или добавьте новые. Takes заметит изменения и покажет их здесь."
            : "Добавьте файлы песен — по одному или целой папкой. Каждый файл получит свою историю версий."}
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

  const current = changes.find((c) => c.path === selected) ?? null;
  const name = current ? splitPath(current.path).name : "";

  async function save(all: boolean) {
    if (saving || (!all && !current)) return;
    setSaving(all ? "all" : "one");
    try {
      const ids = await api.commit(root, message.trim() || null, all ? [] : [current!.path]);
      setMessage("");
      toast(
        ids.length === 1
          ? `Версия ${short(ids[0])} «${all ? splitPath(changes![0].path).name : name}» сохранена в «${overview.branch}»`
          : `Сохранено ${ids.length} ${plural(ids.length, "версия", "версии", "версий")} — по одной на файл`,
        "ok",
      );
      onChanged();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSaving(null);
    }
  }

  const head = overview.head;
  return (
    <div className="changes">
      <div className="list-head">
        <span className="muted">
          {changes.length} {plural(changes.length, "изменённый файл", "изменённых файла", "изменённых файлов")} ·
          каждый сохраняется отдельной версией
        </span>
        {statusError && <span className="error-text">{statusError}</span>}
        <span className="grow" />
        <button className="btn btn-small" onClick={onAddFiles} title="Скопировать файлы или папку в проект">
          <Icon name="plus" size={14} /> Добавить
        </button>
      </div>

      <div className="list scroll" role="listbox" aria-label="Изменённые файлы">
        {changes.map((c) => (
          <div
            key={c.path}
            role="option"
            aria-selected={c.path === selected}
            className={`row selectable ${c.path === selected ? "selected" : ""}`}
            onClick={() => setSelected(c.path)}
          >
            <span className="radio" aria-hidden />
            <KindBadge kind={c.kind} />
            <PathLabel path={c.path} />
            <div className="row-actions">
              {c.kind !== "deleted" && (
                <PlayButton
                  track={{ root, rev: null, path: c.path, label: "Сейчас на диске (не сохранено)" }}
                  text={c.kind === "modified" ? "сейчас" : undefined}
                />
              )}
              {c.kind === "modified" && head && (
                <CompareButton
                  a={{ root, rev: head, path: c.path, label: `Последняя версия ${short(head)}` }}
                  b={{ root, rev: null, path: c.path, label: "Сейчас (не сохранено)" }}
                />
              )}
              {c.kind === "deleted" && head && (
                <PlayButton
                  track={{ root, rev: head, path: c.path, label: `Последняя версия ${short(head)}` }}
                  text="было"
                />
              )}
              <div className="action-slot">
                {c.kind === "modified" && (
                  <button
                    className="btn btn-small btn-ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.discard(c.path);
                    }}
                  >
                    <Icon name="undo" size={14} /> Отменить
                  </button>
                )}
                {c.kind === "deleted" && (
                  <button
                    className="btn btn-small btn-ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.restore(c.path, "HEAD");
                    }}
                  >
                    <Icon name="restore" size={14} /> Вернуть
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="composer">
        <div className="composer-target">
          {current ? (
            <>
              <KindBadge kind={current.kind} /> Версия файла <b>{name}</b>
            </>
          ) : (
            <span className="muted">Выберите файл в списке</span>
          )}
        </div>
        <textarea
          value={message}
          placeholder={
            current
              ? `Что изменилось в «${name}»? Например: «Переписал припев, новый вокал». Можно оставить пустым.`
              : ""
          }
          rows={2}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save(false);
          }}
        />
        <div className="composer-bar">
          <span className="muted">
            → ветка «{overview.branch}»<span className="kbd">Ctrl+Enter</span>
          </span>
          {changes.length > 1 && (
            <button
              className="btn"
              disabled={saving !== null}
              onClick={() => save(true)}
              title="Каждый изменённый файл станет отдельной версией (с этим описанием или с автоматическим)"
            >
              {saving === "all" ? "Сохраняю…" : `Сохранить все ${changes.length} по отдельности`}
            </button>
          )}
          <button className="btn btn-primary" disabled={!current || saving !== null} onClick={() => save(false)}>
            <Icon name="check" /> {saving === "one" ? "Сохраняю…" : "Сохранить версию"}
          </button>
        </div>
      </div>
    </div>
  );
}
