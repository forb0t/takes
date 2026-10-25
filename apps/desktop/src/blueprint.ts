/**
 * The project diagram, drawn as a blueprint: one lane per song (file) that
 * starts with the song's own node. Every song has branches of its own, each
 * a band of the lane: the branch's node, its versions wired one after
 * another and a place to add a file. The wires are what people change:
 * each version follows a branch's node, another version, or nothing when
 * unplugged (those stand apart, below the bands). One branch is the one in
 * the folder, where new versions of the file go on, and its file on disk,
 * when not saved, stands after the version it was made from.
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
/** Between pieces of unplugged versions in their row. */
export const PIECE_GAP = 56;
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
export const BRANCH_X = LANE_PAD + SONG_W + 64;
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
  size: number | null;
  /** Earlier versions of this song it was made from (in the history of the project). */
  parents: string[];
  /** The version before it on its wire. */
  links: string[];
  /** For the first version on a wire: the version of another branch it started from. */
  fork: string | null;
  /** v1, v2… in the order the song's versions were saved; null for a deletion. */
  number: number | null;
  /** The song's branch it is wired into; "" when unplugged. */
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
  /** The song's branches: the main one first, then in the order they started. */
  branches: SongBranch[];
  /** Version (short id) → its branch ("" when unplugged), for every version of the song. */
  branchOf: Record<string, string>;
  /** How every version of the song is wired, as kept (see SongLinks). */
  links: SongLinks;
  /** Versions not drawn: they bring the content of the one before into the folder. */
  hidden: string[];
  /** The row of versions not wired into any branch, below the bands. */
  looseRow: number | null;
  status: LaneStatus;
  nodes: LaneNode[];
  /** The bands and the row of unplugged versions. */
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
  /** Song → node taken out of its lane → where it lies on the canvas. */
  free: Record<string, Record<string, [number, number]>>;
}

/** The song's own node, as the layout knows it. */
export const SONG_KEY = "song";
/** The start of a new branch, below the bands. */
export const NEW_BRANCH_KEY = "+branch";
/** A branch's node; also what its first version follows, as kept. */
export const BRANCH_PREFIX = "b:";
export const branchKey = (name: string) => `${BRANCH_PREFIX}${name}`;
/** The start of the row of unplugged versions. */
export const LOOSE_KEY = branchKey("");
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
  /** The frame around the nodes in the lane, from the origin. */
  frame: Rect;
  /** Placed by hand; the others go one under another below. */
  pinned: boolean;
  /** Nodes taken out of the lane: each lies on its own wherever it was put. */
  free: Set<string>;
}

/** Whether the lane draws a node of this key (one the layout may know from before). */
function drawn(lane: Lane, key: string): boolean {
  if (key === SONG_KEY) return true;
  if (key === LOOSE_KEY) return lane.looseRow !== null;
  if (key.startsWith(BRANCH_PREFIX)) return lane.branches.some((b) => branchKey(b.name) === key);
  return lane.nodes.some((n) => nodeKey(n) === key);
}

/** A branch's band in its lane, from the lane's origin. */
export const bandRect = (row: number): Rect => ({ x: BRANCH_X - 10, y: nodeY(row) - 9, w: 0, h: NODE_H + 18 });

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

/**
 * Places every lane where people put it, or one under another; the nodes
 * in it in their bands, one after another, and the ones taken out wherever
 * they were put.
 */
export function placeLanes(lanes: Lane[], layout: Layout): PlacedLane[] {
  const loose = new Map<PlacedLane, Record<string, [number, number]>>();
  const placed = lanes.map((lane): PlacedLane => {
    const out = lane.names.map((n) => layout.free[n]).find((m) => m !== undefined) ?? {};
    const at = new Map<string, Point>();
    const put = (key: string, p: Point) => out[key] === undefined && at.set(key, p);
    put(SONG_KEY, { x: LANE_PAD, y: nodeY(0) });
    for (const b of lane.branches) put(branchKey(b.name), { x: BRANCH_X, y: nodeY(b.row) });
    if (lane.looseRow !== null) put(LOOSE_KEY, { x: BRANCH_X, y: nodeY(lane.looseRow) });
    // A band closes up where a node was taken out of it; unplugged pieces stand apart.
    const next = new Map<number, number>();
    for (const n of [...lane.nodes].sort((a, b) => a.row - b.row || a.col - b.col)) {
      if (out[nodeKey(n)] !== undefined) continue;
      let x = next.get(n.row);
      if (x === undefined) x = nodeX(0);
      else if (n.row === lane.looseRow && n.kind === "version" && !n.links.length) x += PIECE_GAP;
      at.set(nodeKey(n), { x, y: nodeY(n.row) });
      next.set(n.row, x + COL_W);
    }
    if (growing(lane)) {
      for (const b of lane.branches) at.set(addKey(b.name), { x: next.get(b.row) ?? nodeX(0), y: nodeY(b.row) });
      at.set(NEW_BRANCH_KEY, { x: BRANCH_X, y: nodeY(lane.rows) });
    }
    const pos = lane.names.map((n) => layout.lanes[n]).find((p) => p !== undefined);
    const free = new Set(Object.keys(out).filter((key) => drawn(lane, key)));
    const lanePlaced = {
      lane,
      origin: pos ? { x: pos[0], y: pos[1] } : { x: 0, y: 0 },
      at,
      frame: frameOf(at),
      pinned: !!pos,
      free,
    };
    loose.set(lanePlaced, out);
    return lanePlaced;
  });
  const pinned = placed.filter((p) => p.pinned);
  let y = pinned.length ? Math.max(...pinned.map((p) => p.origin.y + p.frame.y + p.frame.h)) + LANE_GAP * 2 : 0;
  const x = pinned.length ? Math.min(...pinned.map((p) => p.origin.x + p.frame.x)) : 0;
  for (const p of placed) {
    if (p.pinned) continue;
    p.origin = { x: x - p.frame.x, y: y - p.frame.y };
    y += p.frame.h + LANE_GAP;
  }
  // Nodes taken out lie where they were put on the canvas.
  for (const p of placed) {
    const out = loose.get(p)!;
    for (const key of p.free) p.at.set(key, { x: out[key][0] - p.origin.x, y: out[key][1] - p.origin.y });
  }
  return placed;
}

/** The branch every song starts with. */
export const MAIN_BRANCH = "основная";
/**
 * How a song's versions are wired, as kept in the project: version (short
 * id) → what it follows: a branch's node (`branchKey`), another version
 * (its short id), or nothing ("") when unplugged.
 */
export type SongLinks = Record<string, string>;
/** What the project keeps per song. */
export interface SongWiring {
  links: SongLinks;
  /** From before songs were wired: version → branch, in the order they were saved. */
  branches: Record<string, string>;
}
export const shortId = (id: string) => id.slice(0, 16);
/** A version's short id from its node's key. */
export const sidOf = (key: string) => shortId(key.slice(0, key.indexOf(":")));
/** Where a song's wiring is kept, as a shared setting. */
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
 * `wiring` how the songs' versions are wired, by song id.
 */
export function buildLanes(
  versions: GraphVersion[],
  branches: Branch[],
  files: ProjectFile[],
  removed: Set<string>,
  order: string[],
  wiring: Map<string, SongWiring>,
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
        size: c.size,
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
    const kept = wiring.get(id) ?? { links: {}, branches: {} };

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

    // What each version follows: as wired, else (saved since, or from
    // before songs were wired) the end of the wire the version it was made
    // from is on, or of the branch it was kept in, or of an old project
    // branch it is on.
    const sid = (node: SongVersion) => shortId(node.version.id);
    const bySid = new Map<string, SongVersion>();
    for (const node of list) if (!bySid.has(sid(node))) bySid.set(sid(node), node);
    const inLane = new Set(list.map((node) => node.key));
    /** Version → a branch's node, the version before it, or "" for nothing. */
    const parentOf = new Map<string, string>();
    /** A branch's node or a version → the version after it. */
    const childOf = new Map<string, string>();
    const endOf = (ref: string) => {
      const seen = new Set<string>();
      let at = ref;
      for (let next = childOf.get(at); next !== undefined && !seen.has(next); next = childOf.get(at)) {
        seen.add(next);
        at = next;
      }
      return at;
    };
    // A place taken already (by two devices at once): after what follows it there.
    const attach = (node: SongVersion, ref: string) => {
      const at = ref === "" || ref === node.key ? "" : endOf(ref);
      parentOf.set(node.key, at);
      if (at !== "") childOf.set(at, node.key);
    };
    for (const node of list) {
      const link = kept.links[sid(node)];
      if (link === undefined) continue;
      attach(
        node,
        link.startsWith(BRANCH_PREFIX) && link !== LOOSE_KEY ? link : link ? (bySid.get(link)?.key ?? "") : "",
      );
    }
    for (const node of list) {
      if (kept.links[sid(node)] !== undefined) continue;
      const old = node.owner && node.owner !== current?.name && !node.owner.startsWith(TAKE_PREFIX);
      const branch = kept.branches[sid(node)] ?? (old ? node.owner! : null);
      const before = branch === null ? node.parents.find((k) => inLane.has(k) && parentOf.has(k)) : undefined;
      attach(node, branch !== null ? branchKey(branch) : (before ?? branchKey(MAIN_BRANCH)));
    }

    // The branch's node each version is wired to ("" for none); wired in a
    // circle (two devices at once), the oldest one there is unplugged.
    const rootOf = new Map<string, string>();
    for (const node of list) {
      const path: string[] = [];
      let at = node.key;
      let root: string | undefined;
      while (root === undefined) {
        if (rootOf.has(at)) root = rootOf.get(at)!;
        else if (!inLane.has(at)) root = at;
        else if (path.includes(at)) {
          const circle = path.slice(path.indexOf(at));
          const oldest = list.find((x) => circle.includes(x.key))!;
          childOf.delete(parentOf.get(oldest.key)!);
          parentOf.set(oldest.key, "");
          path.length = 0;
          at = node.key;
        } else {
          path.push(at);
          at = parentOf.get(at)!;
        }
      }
      for (const key of path) rootOf.set(key, root);
    }
    for (const node of list) {
      const root = rootOf.get(node.key)!;
      node.branch = root.startsWith(BRANCH_PREFIX) ? root.slice(BRANCH_PREFIX.length) : "";
    }
    const wireFrom = (start: string) => {
      const wire: SongVersion[] = [];
      const seen = new Set<string>();
      for (let k = childOf.get(start); k !== undefined && !seen.has(k); k = childOf.get(k)) {
        seen.add(k);
        wire.push(nodes.get(k)!);
      }
      return wire;
    };

    // A version with the content of the one before it on its wire adds
    // nothing to see (it brought that one into the folder): it stands for it.
    const same = new Map<string, string>();
    const drawnOf = (wire: SongVersion[]) => {
      let last: SongVersion | undefined;
      return wire.filter((node) => {
        if (last && node.blob && last.blob === node.blob && node.change !== "deleted") {
          same.set(node.key, last.key);
          return false;
        }
        last = node;
        return true;
      });
    };
    const branchWires = new Map<string, SongVersion[]>();
    for (const root of new Set(rootOf.values())) {
      if (root.startsWith(BRANCH_PREFIX)) branchWires.set(root.slice(BRANCH_PREFIX.length), drawnOf(wireFrom(root)));
    }
    const pieces = list
      .filter((node) => parentOf.get(node.key) === "")
      .map((node) => drawnOf([node, ...wireFrom(node.key)]));
    const seen = (key: string) => same.get(key) ?? key;
    const shown = list.filter((node) => !same.has(node.key));
    const shownKeys = new Set(shown.map((node) => node.key));

    // The branch in the folder: the one its version is wired into ("" when unplugged).
    const tip = tipsAt(current?.head, names).map(seen);
    const inFolder = tip.map((k) => nodes.get(k)!).find((node) => node.change !== "deleted");
    const active = inFolder?.branch ?? (list.length ? list[list.length - 1].branch : MAIN_BRANCH);
    if (inFolder) inFolder.inFolder = file?.status === "saved";

    // Bands: the main branch first, then in the order they started; they
    // keep their places when another branch goes into the folder.
    const started = [...new Set([...shown.map((node) => node.branch), active])].filter((b) => b !== "");
    const rowNames = [...started.filter((b) => b === MAIN_BRANCH), ...started.filter((b) => b !== MAIN_BRANCH)];
    const looseRow = pieces.length ? rowNames.length : null;

    // Each wire one node after another; the file on disk after the version it was made from.
    let work: WorkNode | null =
      file && file.status !== "saved"
        ? {
            kind: "work",
            key: `w:${path}`,
            path,
            status: file.status,
            parent: inFolder?.key ?? (tip[0] ? nodes.get(tip[0])!.key : null),
            col: 0,
            row: 0,
          }
        : null;
    const laneNodes: LaneNode[] = [];
    const count = new Map<number, number>();
    const lay = (wire: SongVersion[], row: number, folder: boolean) => {
      let before: SongVersion | undefined;
      for (const node of wire) {
        node.links = before ? [before.key] : [];
        node.fork = before
          ? null
          : (node.parents.map(seen).find((k) => shownKeys.has(k) && nodes.get(k)!.branch !== node.branch) ?? null);
        node.row = row;
        node.col = count.get(row) ?? 0;
        count.set(row, node.col + 1);
        laneNodes.push(node);
        before = node;
      }
      if (work && folder) {
        work.row = row;
        work.col = count.get(row) ?? 0;
        count.set(row, work.col + 1);
        laneNodes.push(work);
        work = null;
      }
    };
    rowNames.forEach((name, row) => {
      const wire = branchWires.get(name) ?? [];
      lay(wire, row, inFolder ? wire.includes(inFolder) : name === active);
    });
    for (const piece of pieces) lay(piece, looseRow!, !!inFolder && piece.includes(inFolder));
    if (work) lay([], Math.max(0, rowNames.indexOf(active)), true);

    const branches = rowNames.map((name, row): SongBranch => {
      const own = branchWires.get(name) ?? [];
      const fork = own[0]?.fork ? nodes.get(own[0].fork) : undefined;
      return {
        name,
        row,
        head: own[own.length - 1]?.key ?? "",
        versions: own.filter((node) => node.change !== "deleted").length,
        active: name === active && !!file,
        from: fork?.number ?? null,
        addCol: count.get(row) ?? 0,
      };
    });

    // As kept: every version, so the ones saved since go on where they belong.
    const links: SongLinks = {};
    const branchOf: Record<string, string> = {};
    for (const node of list) {
      const p = parentOf.get(node.key)!;
      links[sid(node)] = p === "" || p.startsWith(BRANCH_PREFIX) ? p : sid(nodes.get(p)!);
      branchOf[sid(node)] = node.branch;
    }
    const rows = rowNames.length + (looseRow !== null ? 1 : 0);

    lanes.push({
      path,
      id,
      names: [path, ...[...names].filter((n) => n !== path)],
      branches,
      branchOf,
      links,
      hidden: [...same.keys()].map((k) => sid(nodes.get(k)!)),
      looseRow,
      status: file ? file.status : removed.has(path) ? "removed" : "elsewhere",
      nodes: laneNodes,
      rows,
      cols: Math.max(0, ...[...count.values()].map((c) => c + 1)),
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
