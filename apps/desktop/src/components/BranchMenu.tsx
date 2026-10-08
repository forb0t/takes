import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { api, errorText, isCommandError, type Overview } from "../api";
import { Icon, PromptDialog, useToast } from "../ui";
import { plural } from "../util";
import { MergeDialog } from "./MergeDialog";

export function BranchMenu({ overview, onChanged }: { overview: Overview; onChanged: () => void }) {
  const root = overview.root;
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"create" | "merge" | null>(null);
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  async function switchTo(name: string) {
    setOpen(false);
    setBusy(true);
    try {
      await api.switchBranch(root, name);
      toast(`Вы на ветке «${name}». Файлы в папке обновлены.`, "ok");
      onChanged();
    } catch (e) {
      if (isCommandError(e) && e.kind === "dirtyWorktree") {
        const n = e.changes.length;
        toast(
          `Сначала сохраните или отмените изменения: ${n} ${plural(n, "файл", "файла", "файлов")}. Иначе они потеряются при переключении.`,
          "error",
        );
      } else if (isCommandError(e) && e.kind === "wouldOverwrite") {
        toast(`Мешают несохранённые файлы: ${e.paths.join(", ")}. Переместите их из папки.`, "error");
      } else {
        toast(errorText(e), "error");
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    const ok = await ask(
      `Удалить ветку «${name}»? Версии, которые есть только в ней, пропадут из истории.`,
      { title: "Удалить ветку?", kind: "warning", okLabel: "Удалить", cancelLabel: "Отмена" },
    );
    if (!ok) return;
    try {
      await api.deleteBranch(root, name);
      toast(`Ветка «${name}» удалена`, "ok");
      onChanged();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  const others = overview.branches.filter((b) => !b.current && b.head);
  return (
    <div className="branch-menu" ref={menu}>
      <button className="btn branch-btn" disabled={busy} onClick={() => setOpen((o) => !o)}>
        <Icon name="branch" />
        <span className="branch-name">{overview.branch}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="popover">
          <div className="popover-title">Ветки</div>
          {overview.branches.map((b) => (
            <div key={b.name} className={`popover-item ${b.current ? "current" : ""}`}>
              <button className="popover-main" disabled={b.current} onClick={() => switchTo(b.name)}>
                <span className="popover-check">{b.current && <Icon name="check" size={14} />}</span>
                {b.name}
              </button>
              {!b.current && (
                <button className="icon-btn danger" title="Удалить ветку" onClick={() => remove(b.name)}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
          ))}
          <div className="popover-sep" />
          <button
            className="popover-action"
            disabled={!overview.head}
            title={overview.head ? undefined : "Сначала сохраните первую версию"}
            onClick={() => {
              setOpen(false);
              setDialog("create");
            }}
          >
            <Icon name="plus" size={14} /> Новая ветка…
          </button>
          <button
            className="popover-action"
            disabled={others.length === 0}
            onClick={() => {
              setOpen(false);
              setDialog("merge");
            }}
          >
            <Icon name="merge" size={14} /> Слить в «{overview.branch}»…
          </button>
        </div>
      )}

      {dialog === "create" && (
        <PromptDialog
          title="Новая ветка"
          label="Название"
          placeholder="Например: acoustic, remix, вариант-2"
          confirm="Создать и перейти"
          hint={`Ветка начнётся с текущей версии «${overview.branch}». Можно экспериментировать, основная ветка не изменится.`}
          onSubmit={async (name) => {
            await api.createBranch(root, name, null, true);
            toast(`Создана ветка «${name}»`, "ok");
            onChanged();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "merge" && (
        <MergeDialog overview={overview} onClose={() => setDialog(null)} onMerged={onChanged} />
      )}
    </div>
  );
}
