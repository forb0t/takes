import { ask, open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { api, errorText, type Project } from "./api";
import { ProjectView } from "./components/ProjectView";
import { PlayerBar } from "./player";
import { Empty, Icon, useToast } from "./ui";
import { baseName, prettyPath } from "./util";

const SELECTED_KEY = "takes.selectedProject";

function readSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

export default function App() {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selected, setSelected] = useState<string | null>(readSelected);

  const reload = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      toast(errorText(e), "error");
    }
  }, [toast]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    try {
      if (selected) localStorage.setItem(SELECTED_KEY, selected);
    } catch {
      // Remembering the last project is only a convenience.
    }
  }, [selected]);

  const current =
    projects?.find((p) => p.path === selected) ?? projects?.find((p) => p.exists) ?? null;

  async function addProject() {
    const dir = await open({ directory: true, title: "Папка проекта" });
    if (typeof dir !== "string") return;
    try {
      const exists = await api.isProject(dir);
      if (!exists) {
        const name = baseName(dir);
        const create = await ask(
          `Создать проект в папке «${name}»? Файлы останутся на месте, а история версий будет храниться в скрытой папке .takes внутри неё.`,
          { title: "Новый проект", okLabel: "Создать", cancelLabel: "Отмена" },
        );
        if (!create) return;
      }
      const project = await api.addProject(dir, !exists);
      await reload();
      setSelected(project.path);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  async function forget(project: Project) {
    const ok = await ask(
      `Убрать «${project.name}» из списка? Файлы и история останутся в папке, проект можно будет добавить снова.`,
      { title: "Убрать из списка?", okLabel: "Убрать", cancelLabel: "Отмена" },
    );
    if (!ok) return;
    await api.removeProject(project.path).catch((e) => toast(errorText(e), "error"));
    await reload();
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="wave" size={16} />
          </span>
          Takes
        </div>
        <div className="sidebar-head">
          <span>Проекты</span>
          <button className="icon-btn" title="Добавить проект" onClick={addProject}>
            <Icon name="plus" />
          </button>
        </div>
        <div className="project-list scroll">
          {projects?.map((p) => (
            <div
              key={p.path}
              className={`project-item ${p.path === current?.path ? "selected" : ""} ${p.exists ? "" : "missing"}`}
            >
              <button
                className="project-item-main"
                title={p.path}
                disabled={!p.exists}
                onClick={() => setSelected(p.path)}
              >
                <span className="project-item-name">{p.name}</span>
                <span className="project-item-path">{p.exists ? prettyPath(p.path) : "папка не найдена"}</span>
              </button>
              <button className="icon-btn" title="Убрать из списка" onClick={() => forget(p)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {current ? (
          <ProjectView key={current.path} root={current.path} />
        ) : (
          projects && (
            <div className="center">
              <Empty icon="wave" title="Создайте первый проект">
                Выберите папку с файлами, например с песнями альбома. Takes будет хранить версии прямо в ней: можно
                сохранять демки, вести ветки и возвращаться к любой версии.
                <button className="btn btn-primary" onClick={addProject}>
                  <Icon name="folder" /> Выбрать папку
                </button>
              </Empty>
            </div>
          )
        )}
      </main>

      <PlayerBar />
    </div>
  );
}
