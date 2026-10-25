/**
 * The project's songs with their own branches, shared by the diagram, the
 * Files tab and cleanup: the history of every version, sorted per song into
 * lanes (see `buildLanes`), plus what people keep about them in the project
 * (the song order, how each song's versions are wired into its branches).
 */
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type GraphVersion, type Overview, type RemovedFile, type TakeSource } from "./api";
import {
  SONG_BRANCHES,
  branchKey,
  buildLanes,
  shortId,
  type Lane,
  type SongLinks,
  type SongVersion,
  type SongWiring,
} from "./blueprint";
import type { ProjectFile } from "./components/FilesTab";
import { useToast } from "./ui";
import { splitPath } from "./util";
import { follow, joinBranch, renameBranch, type Anchor } from "./wiring";

/** The order songs are laid out in, shared by every device of the project. */
export const ORDER_KEY = "songs.order";
/** Reading the project back right after an edit here may still give the old value. */
export const SETTLE_MS = 3000;

export interface Songs {
  root: string;
  /** null while loading. */
  lanes: Lane[] | null;
  error: string | null;
  order: string[];
  setOrder: (paths: string[]) => void;
  /** The song's lane, under any of its names. */
  laneOf: (path: string) => Lane | undefined;
  /** The last version on every wire, in a branch or not: kept whole by cleanup. */
  heads: () => string[];
  /** Wires the song's versions anew (see `wiring.ts`); files do not change. */
  relink: (lane: Lane, links: SongLinks) => void;
  /** Puts a version into the folder, saved there; its branch is then the song's branch in the folder. */
  intoFolder: (lane: Lane, n: SongVersion) => Promise<void>;
  /**
   * A file from disk (picked, or `source`) as the next version of a branch:
   * into the folder for the branch in the folder, beside it for another.
   */
  addFile: (lane: Lane, branch: string, source?: string) => Promise<void>;
  /** A new branch whose first version is a file from disk, after version `parent` ("HEAD": the folder's). */
  createBranch: (lane: Lane, parent: string, name: string, source: string, intoFolder: boolean) => Promise<void>;
  /**
   * Another song's file (a saved version, or the one on disk) as a version
   * of this song in `branch`, after `anchor`; with none, the first of a new branch.
   */
  copyInto: (lane: Lane, anchor: Anchor | null, branch: string, source: TakeSource, what: string) => Promise<void>;
  renameBranch: (lane: Lane, from: string, to: string) => void;
  /** All versions of branch `from` go to `into`. */
  joinBranch: (lane: Lane, from: string, into: string) => void;
}

function parseWiring(values: Record<string, string>): Map<string, SongWiring> {
  const songs = new Map<string, SongWiring>();
  for (const [key, value] of Object.entries(values)) {
    try {
      const kept: unknown = JSON.parse(value);
      if (!kept || typeof kept !== "object") continue;
      const id = key.slice(SONG_BRANCHES.length);
      const links = (kept as { links?: unknown }).links;
      // From before songs were wired: version → branch.
      songs.set(
        id,
        links && typeof links === "object"
          ? { links: links as SongLinks, branches: {} }
          : { links: {}, branches: kept as Record<string, string> },
      );
    } catch {
      // Unreadable: the song's versions fall back to where they came from.
    }
  }
  return songs;
}

/** A file from disk as a take's source: one in the project folder is taken as it is there. */
export function sourceOf(root: string, file: string): TakeSource {
  const inside = file.startsWith(`${root}/`) || file.startsWith(`${root}\\`);
  return inside ? { folder: file.slice(root.length + 1).replace(/\\/g, "/") } : { outside: file };
}

export function useSongs(
  root: string,
  overview: Overview | null,
  files: ProjectFile[] | null,
  removed: RemovedFile[],
  refreshKey: number,
  onChanged: () => void,
): Songs {
  const toast = useToast();
  const [versions, setVersions] = useState<GraphVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrderState] = useState<string[]>([]);
  const [wiring, setWiring] = useState(new Map<string, SongWiring>());
  const localEdit = useRef(0);
  const branchesKey = overview?.branches.map((b) => `${b.name}@${b.head}`).join();

  useEffect(() => {
    let alive = true;
    if (branchesKey === undefined) return;
    api
      .historyGraph(root)
      .then((v) => alive && (setVersions(v), setError(null)))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [root, branchesKey, refreshKey]);

  // Another device may have changed them; a sync reloads the overview.
  useEffect(() => {
    let alive = true;
    if (!overview) return;
    Promise.all([api.sharedSetting(root, ORDER_KEY), api.sharedSettings(root, SONG_BRANCHES)])
      .then(([orderValue, songs]) => {
        if (!alive || Date.now() - localEdit.current < SETTLE_MS) return;
        setWiring(parseWiring(songs));
        try {
          const list: unknown = JSON.parse(orderValue ?? "[]");
          if (Array.isArray(list)) setOrderState(list.filter((p): p is string => typeof p === "string"));
        } catch {
          // Keep the order there is.
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [root, overview]);

  const removedPaths = useMemo(() => new Set(removed.map((r) => r.path)), [removed]);
  const lanes = useMemo(
    () =>
      versions && files && overview
        ? buildLanes(versions, overview.branches, files, removedPaths, order, wiring)
        : null,
    [versions, files, overview?.branches, removedPaths, order, wiring],
  );

  const save = useCallback(
    (key: string, value: unknown) => {
      localEdit.current = Date.now();
      api.setSharedSetting(root, key, JSON.stringify(value)).catch((e) => toast(errorText(e), "error"));
    },
    [root, toast],
  );

  const relink = useCallback(
    (lane: Lane, links: SongLinks) => {
      setWiring((all) => new Map(all).set(lane.id, { links, branches: {} }));
      save(SONG_BRANCHES + lane.id, { links });
    },
    [save],
  );

  const name = (lane: Lane) => splitPath(lane.path).name;
  const busy = (lane: Lane) => {
    if (lane.status === "saved" || lane.status === "deleted") return false;
    toast(`Сначала сохраните или отмените изменения «${name(lane)}»: они не должны потеряться.`, "error");
    return true;
  };

  return {
    root,
    lanes,
    error,
    order,
    setOrder: (paths) => {
      setOrderState(paths);
      save(ORDER_KEY, paths);
    },
    laneOf: (path) => lanes?.find((l) => l.names.includes(path)),
    heads: () =>
      (lanes ?? []).flatMap((l) => {
        const before = new Set(l.nodes.flatMap((n) => (n.kind === "version" ? n.links : [])));
        return l.nodes.flatMap((n) => (n.kind === "version" && !before.has(n.key) ? [n.version.id] : []));
      }),
    relink,
    intoFolder: async (lane, n) => {
      if (busy(lane)) return;
      try {
        const id = await api.useTake(root, n.version.id, n.path, lane.path, n.branch || "без ветки");
        // The folder's new version stands for this one, where it is wired.
        if (id) relink(lane, follow(lane, n.key, shortId(id)));
        toast(
          n.branch ? `В папке «${name(lane)}» из ветки «${n.branch}»` : `В папке «${name(lane)}» версия ${n.number}`,
          "ok",
        );
        onChanged();
      } catch (e) {
        toast(errorText(e), "error");
      }
    },
    addFile: async (lane, branch, source) => {
      const file = source ?? (await open({ multiple: false, title: `Новая версия «${name(lane)}», ветка «${branch}»` }));
      if (typeof file !== "string") return;
      const b = lane.branches.find((x) => x.name === branch);
      const head = lane.nodes.find((n): n is SongVersion => n.kind === "version" && n.key === b?.head);
      try {
        if (!b || b.active || !head) {
          if (busy(lane)) return;
          const result = await api.importFiles(root, [file], { asPath: lane.path, save: true });
          if (result.saved === 0) toast("Такой файл уже сохранён", "info");
          else toast(`Новая версия «${name(lane)}» в ветке «${branch}»`, "ok");
        } else {
          const id = await api.saveTake(root, sourceOf(root, file), lane.path, head.version.id, branch);
          relink(lane, follow(lane, head.key, shortId(id)));
          toast(`Новая версия «${name(lane)}» в ветке «${branch}»`, "ok");
        }
        onChanged();
      } catch (e) {
        toast(errorText(e), "error");
      }
    },
    createBranch: async (lane, parent, branch, source, intoFolder) => {
      const id = await api.saveTake(root, sourceOf(root, source), lane.path, parent, branch);
      const links: SongLinks = { ...lane.links, [shortId(id)]: branchKey(branch) };
      if (intoFolder) {
        const used = await api.useTake(root, id, lane.path, lane.path, branch);
        if (used) links[shortId(used)] = shortId(id);
      }
      relink(lane, links);
      toast(`У «${name(lane)}» новая ветка «${branch}»`, "ok");
      onChanged();
    },
    copyInto: async (lane, anchor, branch, source, what) => {
      const after = anchor && !anchor.startsWith("b:") ? lane.nodes.find((n) => n.key === anchor) : undefined;
      const head = lane.nodes.find((n) => n.key === lane.branches.find((b) => b.name === branch)?.head);
      const parent = after?.kind === "version" ? after.version.id : head?.kind === "version" ? head.version.id : "HEAD";
      try {
        const id = await api.saveTake(root, source, lane.path, parent, branch || "без ветки");
        relink(lane, anchor ? follow(lane, anchor, shortId(id)) : { ...lane.links, [shortId(id)]: branchKey(branch) });
        toast(`«${what}» теперь версия «${name(lane)}»${branch ? ` в ветке «${branch}»` : ""}`, "ok");
        onChanged();
      } catch (e) {
        toast(errorText(e), "error");
      }
    },
    renameBranch: (lane, from, to) => {
      relink(lane, renameBranch(lane, from, to));
      toast(`Ветка «${from}» теперь «${to}»`, "ok");
    },
    joinBranch: (lane, from, into) => {
      relink(lane, joinBranch(lane, from, into));
      toast(`Версии ветки «${from}» перенесены в «${into}»`, "ok");
    },
  };
}
