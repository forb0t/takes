import { ask } from "@tauri-apps/plugin-dialog";
import { api, errorText, isCommandError } from "../api";
import { useToast } from "../ui";
import { copyName, splitPath } from "../util";

/** Restoring old versions, with a confirmation before replacing unsaved work. */
export function useFileActions(root: string, onChanged: () => void) {
  const toast = useToast();

  async function restoreTo(path: string, rev: string, dest: string | null, success: string) {
    try {
      await api.restore(root, path, rev, dest, false);
    } catch (e) {
      if (!isCommandError(e) || e.kind !== "wouldOverwrite") {
        toast(errorText(e), "error");
        return;
      }
      const target = splitPath(dest ?? path).name;
      const replace = await ask(
        `В файле «${target}» есть изменения, которых нет ни в одной версии. Заменить его?`,
        { title: "Заменить файл?", kind: "warning", okLabel: "Заменить", cancelLabel: "Отмена" },
      );
      if (!replace) return;
      try {
        await api.restore(root, path, rev, dest, true);
      } catch (e2) {
        toast(errorText(e2), "error");
        return;
      }
    }
    toast(success, "ok");
    onChanged();
  }

  return {
    /** Put the file back as it was in `rev`. */
    restore: (path: string, rev: string) =>
      restoreTo(path, rev, null, `«${splitPath(path).name}» возвращён. Сохраните версию, чтобы закрепить.`),

    /** Put that version next to the current file as `name (label).ext`. */
    saveCopy: (path: string, rev: string, label: string) => {
      const dest = copyName(path, label);
      return restoreTo(path, rev, dest, `Копия сохранена как «${splitPath(dest).name}»`);
    },

    /** Throw away unsaved edits of a file. */
    discard: async (path: string) => {
      const ok = await ask(`Отменить несохранённые изменения в «${splitPath(path).name}»?`, {
        title: "Отменить изменения?",
        kind: "warning",
        okLabel: "Отменить изменения",
        cancelLabel: "Оставить",
      });
      if (!ok) return;
      try {
        await api.restore(root, path, "HEAD", null, true);
        toast("Изменения отменены", "ok");
        onChanged();
      } catch (e) {
        toast(errorText(e), "error");
      }
    },
  };
}
