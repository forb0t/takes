/**
 * The project diagram, drawn as a blueprint: one lane per song (file) that
 * starts with the song's own node. Every song has branches of its own, each
 * a band of the lane: the branch's node, its versions from left to right
 * and a place to add a file. Takes are sorted into branches (people drag a
 * take from one band to another); one branch is the one in the folder,
 * where new versions of the file go on, and its file on disk, when not
 * saved, stands at the end of its band.
 */
import type { Branch, ChangeKind, GraphVersion } from "./api";
import type { FileStatus, ProjectFile } from "./components/FilesTab";
import { naturalCompare } from "./util";

/** Refs that keep takes not in the folder's history (as the core names them). */
export const TAKE_PREFIX = "take/";

/** Geometry, in canvas pixels at 100%. */
/** The title of a lane's frame. */
export const TITLE_H = 30;
export const SONG_W = 248;
export const NODE_W = 232;
export const NODE_H = 104;
/** The coloured title of a node. */
export const HEAD_H = 28;
/** Execution pins, from the top of a node. */
export const PIN_Y = HEAD_H + 14;
export const COL_W = NODE_W + 64;
export const ROW_H = NODE_H + 26;
export const LANE_PAD = 18;
export const LANE_GAP = 30;
/** A branch's own node, at the start of its band. */
export const BRANCH_W = 196;
/** The place at the end of a band to add a file to the branch. */
export const ADD_W = 136;
/** The place below the bands to start a branch. */
export const NEW_BRANCH_H = 56;
/** Branch nodes sit past the song's own node and a wire's length. */
const BRANCH_X = LANE_PAD + SONG_W + 64;
/** The first version of each branch, past its branch node. */
const VERSION_X = BRANCH_X + BRANCH_W + 56;

/** A version in which the song changed. */
export interface SongVersion {
  kind: "version";
  key: string;
  path: string;
  version: GraphVersion;
  change: ChangeKind;
  /** For a rename, the name before. */
  from: string | null;
  /** Content removed by cleanup: cannot be played or restored. */
  pruned: boolean;
  labels: string[];
  /** The content's hash. */
  blob: string | null;
  /** Earlier versions of this song it was made from (in the history of the project). */
  parents: string[];
  /** The version before it in its branch. */
  links: string[];
  /** For the first version of a branch: the version of another branch it started from. */
  fork: string | null;
  /** v1, v2… in the order the song's versions were saved; null for a deletion. */
  number: number | null;
  /** The song's branch it belongs to. */
  branch: string;
  /** In the history of the folder. */
  onCurrent: boolean;
  /** The project's branch whose line it is on: the folder's, an old project branch or a take kept beside the folder. */
  owner: string | null;
  /** The content the project folder has now. */
  inFolder: boolean;
  col: number;
  row: number;
}

/** The file on disk when it differs from the saved version. */
export interface WorkNode {
  kind: "work";
  key: string;
  path: string;
  status: ChangeKind;
  /** The saved version it differs from. */
  parent: string | null;
  col: number;
  row: number;
}

export type LaneNode = SongVersion | WorkNode;

/** "removed": deleted and saved as deleted; "elsewhere": only on other branches. */
export type LaneStatus = FileStatus | "removed" | "elsewhere";

/** A branch of one song: a band of its lane. */
export interface SongBranch {
  name: string;
  row: number;
  /** Its latest version; "" for a branch with none yet (a new file). */
  head: string;
  versions: number;
  /** The one in the folder. */
  active: boolean;
  /** The version of another branch it started from, by number. */
  from: number | null;
  /** Where its "add a file" place stands, after its last node. */
  addCol: number;
}

export interface Lane {
  path: string;
  /** Stays the same when the song is renamed: its branches are kept under it. */
  id: string;
  /** Every name the song had, its current one first. */
  names: string[];
  /** The song's branches, the one in the folder first. */
  branches: SongBranch[];
  /** Version (short id) → its branch, for every version of the song. */
  branchOf: SongBranches;
  status: LaneStatus;
  nodes: LaneNode[];
  rows: number;
  cols: number;
  /** Saved versions, deletions not counted. */
  versions: number;
  /** Branches that have the song, for a song only on other branches. */
  branchNames: string[];
}

export const nodeX = (col: number) => VERSION_X + col * COL_W;
export const nodeY = (row: number) => TITLE_H + LANE_PAD + row * ROW_H;

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Where songs lie on the diagram, shared by every device of the project. */
export interface Layout {
  /** Song → where its lane lies. */
  lanes: Record<string, [number, number]>;
}

/** The song's own node, as the layout knows it. */
export const SONG_KEY = "song";
/** The start of a new branch, below the bands. */
export const NEW_BRANCH_KEY = "+branch";
export const branchKey = (name: string) => `b:${name}`;
export const addKey = (name: string) => `+:${name}`;
/** A node as the layout knows it: the file on disk keeps its key across versions. */
export const nodeKey = (n: LaneNode) => (n.kind === "work" ? "work" : n.key);
export const nodeSize = (key: string) => ({
  w: key === SONG_KEY ? SONG_W : key.startsWith("b:") || key === NEW_BRANCH_KEY ? BRANCH_W : key.startsWith("+:") ? ADD_W : NODE_W,
  h: key === NEW_BRANCH_KEY ? NEW_BRANCH_H : NODE_H,
});
/** Whether a song can get new branches and versions here: it is in the folder. */
export const growing = (lane: Lane) => lane.status !== "removed" && lane.status !== "elsewhere";

export interface PlacedLane {
  lane: Lane;
  /** Where the lane lies; its nodes are placed from here. */
  origin: Point;
  /** Each node's place from the origin, the song's own under SONG_KEY. */
  at: Map<string, Point>;
  /** The frame around the nodes, from the origin. */
  frame: Rect;
  /** Placed by hand; the others go one under another below. */
  pinned: boolean;
}

/** The frame around a lane's nodes, with its title on top. */
export function frameOf(at: Map<string, Point>): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [key, p] of at) {
    const { w, h } = nodeSize(key);
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + w);
    y1 = Math.max(y1, p.y + h);
  }
  return {
    x: x0 - LANE_PAD,
    y: y0 - LANE_PAD - TITLE_H,
    w: x1 - x0 + LANE_PAD * 2,
    h: y1 - y0 + LANE_PAD * 2 + TITLE_H,
  };
}

/** Places every lane where people put it, or one under another; its nodes in its bands. */
export function placeLanes(lanes: Lane[], layout: Layout): PlacedLane[] {
  const placed = lanes.map((lane): PlacedLane => {
    const at = new Map<string, Point>();
    at.set(SONG_KEY, { x: LANE_PAD, y: nodeY(0) });
    for (const b of lane.branches) {
      at.set(branchKey(b.name), { x: BRANCH_X, y: nodeY(b.row) });
      if (growing(lane)) at.set(addKey(b.name), { x: nodeX(b.addCol), y: nodeY(b.row) });
    }
    for (const n of lane.nodes) at.set(nodeKey(n), { x: nodeX(n.col), y: nodeY(n.row) });
    if (growing(lane)) at.set(NEW_BRANCH_KEY, { x: BRANCH_X, y: nodeY(lane.branches.length) });
    const pos = lane.names.map((n) => layout.lanes[n]).find((p) => p !== undefined);
    return { lane, origin: pos ? { x: pos[0], y: pos[1] } : { x: 0, y: 0 }, at, frame: frameOf(at), pinned: !!pos };
  });
  const pinned = placed.filter((p) => p.pinned);
  let y = pinned.length ? Math.max(...pinned.map((p) => p.origin.y + p.frame.y + p.frame.h)) + LANE_GAP * 2 : 0;
  const x = pinned.length ? Math.min(...pinned.map((p) => p.origin.x + p.frame.x)) : 0;
  for (const p of placed) {
    if (p.pinned) continue;
    p.origin = { x: x - p.frame.x, y: y - p.frame.y };
    y += p.frame.h + LANE_GAP;
  }
  return placed;
}

/** The branch every song starts with. */
export const MAIN_BRANCH = "основная";
/** A song's branches as kept in the project: version (short id) → branch. */
export type SongBranches = Record<string, string>;
export const shortId = (id: string) => id.slice(0, 16);
/** Where a song's branches are kept, as a shared setting. */
export const SONG_BRANCHES = "track.";

function fnv(text: string, seed: number): string {
  let h = seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A song's id from the name of its first version. */
export const songId = (firstPath: string) => fnv(firstPath, 2166136261) + fnv(firstPath, 0x9e3779b9);

/** A stable colour per song. */
export function songHue(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

const keyOf = (id: string, path: string) => `${id}:${path}`;

/**
 * Builds every lane. `versions` come newest first (children before
 * parents), `order` is the song order people chose (others follow by name),
 * `songBranches` the songs' branches by song id.
 */
export function buildLanes(
  versions: GraphVersion[],
  branches: Branch[],
  files: ProjectFile[],
  removed: Set<string>,
  order: string[],
  songBranches: Map<string, SongBranches>,
): Lane[] {
  const nodes = new Map<string, SongVersion>();
  /** Per version: for each song, the latest versions of it in that version's history. */
  const latest = new Map<string, Map<string, string[]>>();

  // Is `a` an earlier version of the same song than `b`?
  const isBefore = (a: string, b: string) => {
    const stack = [b];
    const seen = new Set<string>();
    while (stack.length) {
      const k = stack.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const p of nodes.get(k)?.parents ?? []) {
        if (p === a) return true;
        stack.push(p);
      }
    }
    return false;
  };
  const newest = (keys: string[]) => {
    const unique = [...new Set(keys)];
    return unique.filter((k) => !unique.some((o) => o !== k && isBefore(k, o)));
  };

  // A renamed song keeps its lane: names of one song are joined here.
  const alias = new Map<string, string>();
  const song = (path: string): string => {
    let at = path;
    while (alias.has(at)) at = alias.get(at)!;
    return at;
  };
  const join = (a: string, b: string) => {
    const ra = song(a);
    const rb = song(b);
    if (ra !== rb) alias.set(ra, rb);
  };

  for (const v of [...versions].reverse()) {
    const from = v.parents.map((p) => latest.get(p)).filter((m): m is Map<string, string[]> => !!m);
    const inherited = new Map(from[0] ?? []);
    for (const other of from.slice(1)) {
      for (const [path, keys] of other) {
        const mine = inherited.get(path);
        inherited.set(path, mine && mine !== keys ? newest([...mine, ...keys]) : keys);
      }
    }
    for (const c of v.changes) {
      const key = keyOf(v.id, c.path);
      // A rename continues the song's history under its new name.
      const before = c.kind === "renamed" && c.from ? c.from : c.path;
      if (before !== c.path) join(before, c.path);
      nodes.set(key, {
        kind: "version",
        key,
        path: c.path,
        version: v,
        change: c.kind,
        from: c.from ?? null,
        pruned: c.pruned,
        labels: c.labels,
        blob: c.blob ?? null,
        parents: inherited.get(before) ?? [],
        links: [],
        fork: null,
        number: null,
        branch: MAIN_BRANCH,
        onCurrent: false,
        owner: null,
        inFolder: false,
        col: 0,
        row: 0,
      });
      if (before !== c.path) inherited.delete(before);
      inherited.set(c.path, [key]);
    }
    latest.set(v.id, inherited);
  }
  for (const f of files) if (f.from) join(f.from, f.path);

  const current = branches.find((b) => b.current);
  const atHead = (current?.head && latest.get(current.head)) || new Map<string, string[]>();
  const stack = [...atHead.values()].flat();
  while (stack.length) {
    const node = nodes.get(stack.pop()!);
    if (!node || node.onCurrent) continue;
    node.onCurrent = true;
    stack.push(...node.parents);
  }

  // Which project branch each version is on: the folder's first, then
  // main, then the most recent ones.
  const branchOrder = branches
    .filter((b) => b.head && latest.has(b.head))
    .sort((a, b) => {
      const rank = (x: Branch) => (x.current ? 0 : x.name === "main" ? 1 : 2);
      const time = (x: Branch) => versions.find((v) => v.id === x.head)?.createdAt ?? 0;
      return rank(a) - rank(b) || time(b) - time(a);
    });

  // Each lane: one song, all its names, its versions oldest first.
  const groups = new Map<string, { names: Set<string>; list: SongVersion[] }>();
  const group = (path: string) => {
    const id = song(path);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { names: new Set(), list: [] }));
    g.names.add(path);
    return g;
  };
  for (const node of nodes.values()) group(node.path).list.push(node);
  for (const f of files) group(f.path);
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  /** The latest versions of the song (under any of its names) in version `id`. */
  const tipsAt = (id: string | null | undefined, names: Set<string>) => {
    const at = id ? latest.get(id) : undefined;
    return at ? [...names].flatMap((n) => at.get(n) ?? []) : [];
  };

  const lanes: Lane[] = [];
  for (const { names, list } of groups.values()) {
    // Named as the file is now, else as its latest version.
    const file = [...names].map((n) => fileByPath.get(n)).find((f) => f !== undefined);
    const path = file?.path ?? list[list.length - 1].path;

    const id = songId(list[0]?.path ?? path);
    const kept = songBranches.get(id) ?? {};

    let n = 0;
    for (const node of list) if (node.change !== "deleted") node.number = ++n;

    // The project branch each version is on.
    const owned = new Set<string>();
    for (const b of branchOrder) {
      for (const tip of tipsAt(b.head, names)) {
        const stack = [tip];
        while (stack.length) {
          const key = stack.pop()!;
          const node = nodes.get(key);
          if (!node || owned.has(key)) continue;
          owned.add(key);
          node.owner = b.name;
          stack.push(...node.parents);
        }
      }
    }

    // The song's branch of each version: as kept, else the one of the
    // project branch it is on (from before songs had branches), else the
    // one of the version it was made from.
    const branchOf: SongBranches = {};
    for (const node of list) {
      const old = node.owner && node.owner !== current?.name && !node.owner.startsWith(TAKE_PREFIX);
      const before = node.parents.map((p) => nodes.get(p)?.branch).find((b) => b !== undefined);
      node.branch = kept[shortId(node.version.id)] ?? (old ? node.owner! : (before ?? MAIN_BRANCH));
      branchOf[shortId(node.version.id)] = node.branch;
    }

    // A version with the content its branch had just before adds nothing
    // to see (it brought that branch into the folder): it stands for the one before.
    const same = new Map<string, string>();
    const lastIn = new Map<string, SongVersion>();
    for (const node of list) {
      const before = lastIn.get(node.branch);
      if (before && node.blob && before.blob === node.blob && node.change !== "deleted") {
        same.set(node.key, before.key);
      } else {
        lastIn.set(node.branch, node);
      }
    }
    const shown = list.filter((node) => !same.has(node.key));
    const seen = (key: string) => same.get(key) ?? key;

    // Bands: the main branch first, then in the order they started; they
    // keep their places when another branch goes into the folder.
    const tip = tipsAt(current?.head, names).map(seen);
    const inFolder = tip.map((k) => nodes.get(k)!).find((node) => node.change !== "deleted");
    const active = inFolder?.branch ?? (list.length ? list[list.length - 1].branch : MAIN_BRANCH);
    const started = [...new Set([...shown.map((node) => node.branch), active])];
    const rowNames = [...started.filter((b) => b === MAIN_BRANCH), ...started.filter((b) => b !== MAIN_BRANCH)];

    // Each band: its versions one after another; the first one may have
    // started from a version of another branch.
    const prevIn = new Map<string, SongVersion>();
    const count = new Map<string, number>();
    const shownKeys = new Set(shown.map((node) => node.key));
    for (const node of shown) {
      const before = prevIn.get(node.branch);
      node.links = before ? [before.key] : [];
      node.fork = before
        ? null
        : (node.parents.map(seen).find((k) => shownKeys.has(k) && nodes.get(k)!.branch !== node.branch) ?? null);
      node.col = count.get(node.branch) ?? 0;
      node.row = rowNames.indexOf(node.branch);
      count.set(node.branch, node.col + 1);
      prevIn.set(node.branch, node);
    }
    if (inFolder) inFolder.inFolder = file?.status === "saved";

    const laneNodes: LaneNode[] = [...shown];
    if (file && file.status !== "saved") {
      const row = rowNames.indexOf(active);
      const col = count.get(active) ?? 0;
      count.set(active, col + 1);
      laneNodes.push({
        kind: "work",
        key: `w:${path}`,
        path,
        status: file.status,
        parent: inFolder?.key ?? (tip[0] ? nodes.get(tip[0])!.key : null),
        col,
        row,
      });
    }

    const branches = rowNames.map((name, row): SongBranch => {
      const own = shown.filter((node) => node.branch === name);
      const fork = own[0]?.fork ? nodes.get(own[0].fork) : undefined;
      return {
        name,
        row,
        head: own[own.length - 1]?.key ?? "",
        versions: own.filter((node) => node.change !== "deleted").length,
        active: name === active && !!file,
        from: fork?.number ?? null,
        addCol: count.get(name) ?? 0,
      };
    });
    lanes.push({
      path,
      id,
      names: [path, ...[...names].filter((n) => n !== path)],
      branches,
      branchOf,
      status: file ? file.status : removed.has(path) ? "removed" : "elsewhere",
      nodes: laneNodes,
      rows: branches.length,
      cols: Math.max(0, ...branches.map((b) => b.addCol + 1)),
      versions: n,
      branchNames: file
        ? []
        : branchOrder
            .filter((b) => tipsAt(b.head, names).some((k) => nodes.get(k)?.change !== "deleted"))
            .map((b) => b.name),
    });
  }

  const rank = new Map(order.map((p, i) => [p, i]));
  return lanes.sort((a, b) => {
    const ra = rank.get(a.path);
    const rb = rank.get(b.path);
    return (
      laneGroup(a) - laneGroup(b) ||
      (ra !== undefined && rb !== undefined ? ra - rb : ra !== undefined ? -1 : rb !== undefined ? 1 : 0) ||
      naturalCompare(a.path, b.path)
    );
  });
}

/** Songs of the folder first, then songs only on other branches, then removed ones. */
export const laneGroup = (l: Lane) => (l.status === "removed" ? 2 : l.status === "elsewhere" ? 1 : 0);

/** The earlier saved version of the song a node continues, for comparing. */
export function previousVersion(lane: Lane, node: LaneNode): SongVersion | null {
  const parents =
    node.kind === "work" ? (node.parent ? [node.parent] : []) : [...node.links, ...(node.fork ? [node.fork] : [])];
  for (const key of parents) {
    const found = lane.nodes.find((n): n is SongVersion => n.kind === "version" && n.key === key);
    if (found && found.change !== "deleted") return found;
  }
  return null;
}

/** A wire from an output pin to an input pin, as in a blueprint. */
export function wire(x1: number, y1: number, x2: number, y2: number): string {
  const pull = Math.max(32, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + pull} ${y1}, ${x2 - pull} ${y2}, ${x2} ${y2}`;
}
