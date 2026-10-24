/**
 * The project diagram, drawn as a blueprint: one lane per song (file) that
 * starts with the song's own node, then its versions from left to right
 * and, at the end, the file as it is on disk when it is not saved. A song's
 * versions on other branches fork into rows below and merges join them
 * back, so each lane is that song's own history.
 */
import type { Branch, ChangeKind, GraphVersion } from "./api";
import type { FileStatus, ProjectFile } from "./components/FilesTab";
import { naturalCompare } from "./util";

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
/** The first version sits past the song's own node and a wire's length. */
const FIRST_X = LANE_PAD + SONG_W + 64;

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
  /** Earlier versions of this song it continues; two when branches joined. */
  parents: string[];
  /** v1, v2… in the order the song's versions were saved; null for a deletion. */
  number: number | null;
  /** Branches whose latest version of the song this is, shown when branches differ. */
  branches: Branch[];
  /** In the history of the current branch. */
  onCurrent: boolean;
  /** The branch whose line this version is drawn on; null for one only a tag or an old merge leads to. */
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

export interface Lane {
  path: string;
  /** Every name the song had, its current one first. */
  names: string[];
  /** Branch → the song's name in that branch's latest version, where it has the song. */
  tipPaths: Record<string, string>;
  status: LaneStatus;
  nodes: LaneNode[];
  rows: number;
  cols: number;
  /** Saved versions, deletions not counted. */
  versions: number;
  /** Branches that have the song, for a song only on other branches. */
  branchNames: string[];
}

export const nodeX = (col: number) => FIRST_X + col * COL_W;
export const nodeY = (row: number) => TITLE_H + LANE_PAD + row * ROW_H;

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Where things lie on the diagram, shared by every device of the project. */
export interface Layout {
  /** Song → where its lane lies. */
  lanes: Record<string, [number, number]>;
  /** Song → node → where the node lies, from its lane's place. */
  nodes: Record<string, Record<string, [number, number]>>;
}

/** The song's own node, as the layout knows it. */
export const SONG_KEY = "song";
/** A node as the layout knows it: the file on disk keeps its key across versions. */
export const nodeKey = (n: LaneNode) => (n.kind === "work" ? "work" : n.key);
export const nodeSize = (key: string) => ({ w: key === SONG_KEY ? SONG_W : NODE_W, h: NODE_H });

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

/** Places every lane and node: where people put them, or laid out in order. */
export function placeLanes(lanes: Lane[], layout: Layout): PlacedLane[] {
  const placed = lanes.map((lane): PlacedLane => {
    const saved = lane.names.map((n) => layout.nodes[n]).find((m) => m !== undefined) ?? {};
    const at = new Map<string, Point>();
    const put = (key: string, auto: Point) => {
      const p = saved[key];
      at.set(key, p ? { x: p[0], y: p[1] } : auto);
    };
    put(SONG_KEY, { x: LANE_PAD, y: TITLE_H + LANE_PAD });
    for (const n of lane.nodes) put(nodeKey(n), { x: nodeX(n.col), y: nodeY(n.row) });
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
 * parents), `order` is the song order people chose (others follow by name).
 */
export function buildLanes(
  versions: GraphVersion[],
  branches: Branch[],
  files: ProjectFile[],
  removed: Set<string>,
  order: string[],
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
        parents: inherited.get(before) ?? [],
        number: null,
        branches: [],
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

  // The current branch claims the first row of every lane, then main, then
  // the most recent branches.
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

    let n = 0;
    for (const node of list) {
      if (node.change !== "deleted") node.number = ++n;
      node.col = node.parents.length ? 1 + Math.max(...node.parents.map((p) => nodes.get(p)?.col ?? 0)) : 0;
    }

    const rowOf = new Map<string, number>();
    let rows = 0;
    const claim = (start: string, owner: string | null) => {
      let key: string | undefined = start;
      let took = false;
      while (key && nodes.has(key) && !rowOf.has(key)) {
        rowOf.set(key, rows);
        nodes.get(key)!.owner = owner;
        took = true;
        key = nodes.get(key)!.parents[0];
      }
      if (took) rows++;
    };
    const tips = new Map<string, Branch[]>();
    const tipPaths: Record<string, string> = {};
    for (const b of branchOrder) {
      for (const key of tipsAt(b.head, names)) {
        claim(key, b.name);
        tips.set(key, [...(tips.get(key) ?? []), b]);
        const node = nodes.get(key)!;
        if (node.change !== "deleted") tipPaths[b.name] = node.path;
      }
    }
    for (const node of [...list].reverse()) claim(node.key, null); // only tags or old merges lead here
    for (const node of list) node.row = rowOf.get(node.key) ?? 0;

    // Branch names only where branches disagree about the song.
    if (tips.size > 1) {
      for (const [key, owners] of tips) nodes.get(key)!.branches = owners;
    }

    const tip = tipsAt(current?.head, names);
    for (const key of tip) {
      const node = nodes.get(key)!;
      node.inFolder = file?.status === "saved" && node.change !== "deleted";
    }

    const laneNodes: LaneNode[] = [...list];
    if (file && file.status !== "saved") {
      const parent = tip.find((k) => nodes.get(k)?.change !== "deleted") ?? tip[0] ?? null;
      const from = parent ? nodes.get(parent)! : null;
      laneNodes.push({
        kind: "work",
        key: `w:${path}`,
        path,
        status: file.status,
        parent,
        col: from ? from.col + 1 : 0,
        // A file new here but known on another branch gets a row of its own.
        row: from ? from.row : list.length ? rows++ : 0,
      });
    }

    lanes.push({
      path,
      names: [path, ...[...names].filter((n) => n !== path)],
      tipPaths,
      status: file ? file.status : removed.has(path) ? "removed" : "elsewhere",
      nodes: laneNodes,
      rows: Math.max(rows, 1),
      cols: Math.max(0, ...laneNodes.map((x) => x.col + 1)),
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
  const parents = node.kind === "work" ? (node.parent ? [node.parent] : []) : node.parents;
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
