/**
 * The project's songs with their own branches, shared by the Files tab, the
 * diagram and cleanup: the history of every version, sorted per song into
 * lanes (see `buildLanes`), plus what people keep about them in the project
 * (the song order, which branch each version is in).
 */
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type GraphVersion, type Overview, type RemovedFile } from "./api";
import { SONG_BRANCHES, buildLanes, shortId, type Lane, type SongBranches, type SongVersion } from "./blueprint";
import type { ProjectFile } from "./components/FilesTab";
import { useToast } from "./ui";
import { splitPath } from "./util";

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
  /** The latest version of every song's branch: kept whole by cleanup. */
  heads: () => string[];
  /** Puts versions into branches (new or not); files do not change. */
  sortInto: (lane: Lane, change: SongBranches) => void;
  /** Puts a version into the folder, saved there; its branch is then the song's branch in the folder. */
  intoFolder: (lane: Lane, n: SongVersion) => Promise<void>;
  /** A file from disk as the next version of a branch not in the folder. */
  addToBranch: (lane: Lane, n: SongVersion) => Promise<void>;
  /** A new branch whose first version is a file from disk, after version `parent` ("HEAD": the folder's). */
  createBranch: (lane: Lane, parent: string, name: string, source: string, intoFolder: boolean) => Promise<void>;
  renameBranch: (lane: Lane, from: string, to: string) => void;
  /** All versions of branch `from` go to `into`. */
  joinBranch: (lane: Lane, from: string, into: string) => void;
}

function parseBranches(values: Record<string, string>): Map<string, SongBranches> {
  const branches = new Map<string, SongBranches>();
  for (const [key, value] of Object.entries(values)) {
    try {
      const map: unknown = JSON.parse(value);
      if (map && typeof map === "object") branches.set(key.slice(SONG_BRANCHES.length), map as SongBranches);
    } catch {
      // Unreadable: the song's versions fall back to where they came from.
    }
  }
  return branches;
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
  const [branches, setBranches] = useState(new Map<string, SongBranches>());
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
        setBranches(parseBranches(songs));
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
        ? buildLanes(versions, overview.branches, files, removedPaths, order, branches)
        : null,
    [versions, files, overview?.branches, removedPaths, order, branches],
  );

  const save = useCallback(
    (key: string, value: unknown) => {
      localEdit.current = Date.now();
      api.setSharedSetting(root, key, JSON.stringify(value)).catch((e) => toast(errorText(e), "error"));
    },
    [root, toast],
  );

  const sortInto = useCallback(
    (lane: Lane, change: SongBranches) => {
      // Every version is named, so the ones made from a moved one stay where they are.
      const next = { ...lane.branchOf, ...change };
      setBranches((all) => new Map(all).set(lane.id, next));
      save(SONG_BRANCHES + lane.id, next);
    },
    [save],
  );

  const name = (lane: Lane) => splitPath(lane.path).name;

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
      (lanes ?? []).flatMap((l) =>
        l.branches.flatMap((b) => {
          const head = l.nodes.find((n) => n.key === b.head);
          return head?.kind === "version" ? [head.version.id] : [];
        }),
      ),
    sortInto,
    intoFolder: async (lane, n) => {
      if (lane.status !== "saved" && lane.status !== "deleted") {
        toast(`Сначала сохраните или отмените изменения «${name(lane)}»: они не должны потеряться.`, "error");
        return;
      }
      try {
        const id = await api.useTake(root, n.version.id, n.path, lane.path, n.branch);
        if (id) sortInto(lane, { [shortId(id)]: n.branch });
        toast(`В папке «${name(lane)}» из ветки «${n.branch}»`, "ok");
        onChanged();
      } catch (e) {
        toast(errorText(e), "error");
      }
    },
    addToBranch: async (lane, n) => {
      const source = await open({ multiple: false, title: `Новая версия «${name(lane)}», ветка «${n.branch}»` });
      if (typeof source !== "string") return;
      try {
        const id = await api.saveTake(root, source, lane.path, n.version.id, n.branch);
        sortInto(lane, { [shortId(id)]: n.branch });
        toast(`Версия сохранена в ветке «${n.branch}»`, "ok");
        onChanged();
      } catch (e) {
        toast(errorText(e), "error");
      }
    },
    createBranch: async (lane, parent, branch, source, intoFolder) => {
      const id = await api.saveTake(root, source, lane.path, parent, branch);
      const change: SongBranches = { [shortId(id)]: branch };
      if (intoFolder) {
        const used = await api.useTake(root, id, lane.path, lane.path, branch);
        if (used) change[shortId(used)] = branch;
      }
      sortInto(lane, change);
      toast(`У «${name(lane)}» новая ветка «${branch}»`, "ok");
      onChanged();
    },
    renameBranch: (lane, from, to) => {
      const change: SongBranches = {};
      for (const [id, b] of Object.entries(lane.branchOf)) if (b === from) change[id] = to;
      sortInto(lane, change);
      toast(`Ветка «${from}» теперь «${to}»`, "ok");
    },
    joinBranch: (lane, from, into) => {
      const change: SongBranches = {};
      for (const [id, b] of Object.entries(lane.branchOf)) if (b === from) change[id] = into;
      sortInto(lane, change);
      toast(`Версии ветки «${from}» перенесены в «${into}»`, "ok");
    },
  };
}
