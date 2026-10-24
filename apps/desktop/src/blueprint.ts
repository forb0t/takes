/**
 * Layout of the project diagram: versions as nodes on branch lanes (older
 * to the left), songs as nodes on the far left, and wires: version order
 * (white), each song's own history (in its colour) and branch heads.
 */
import type { Branch, Change, GraphVersion } from "./api";

export const NODE_W = 236;
export const NODE_H = 98;
export const SONG_W = 210;
export const SONG_H = 56;
export const BRANCH_W = 190;
export const BRANCH_H = 56;
const COL = NODE_W + 64;
const LANE = NODE_H + 130;
const SONG_X = -SONG_W - 140;
const SONG_GAP = 18;

/** Where pins sit on a node, from its top-left corner. */
export const PIN_EXEC_Y = 15;
export const PIN_SONG_Y = 62;

export type NodeKey = string;

export interface VersionNode {
  kind: "version";
  key: NodeKey;
  x: number;
  y: number;
  version: GraphVersion;
  /** The file this version is about; null for merges of many files. */
  song: string | null;
  change: Change | null;
}

export interface SongNode {
  kind: "song";
  key: NodeKey;
  x: number;
  y: number;
  path: string;
  versions: number;
}

export interface BranchNode {
  kind: "branch";
  key: NodeKey;
  x: number;
  y: number;
  branch: Branch;
}

export type DiagramNode = VersionNode | SongNode | BranchNode;

export interface Wire {
  key: string;
  from: NodeKey;
  to: NodeKey;
  /** exec: version order; merge: a second parent; song: a song's history; branch: a head. */
  kind: "exec" | "merge" | "song" | "branch";
  /** The song a song wire belongs to. */
  song?: string;
}

export interface Diagram {
  nodes: Map<NodeKey, DiagramNode>;
  wires: Wire[];
}

export const versionKey = (id: string) => `v:${id}`;
export const songKey = (path: string) => `s:${path}`;
export const branchKey = (name: string) => `b:${name}`;

/** A stable colour per song. */
export function songHue(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

/**
 * Places every node. `versions` come newest first (children before parents);
 * `branches` with the current one marked.
 */
export function layout(versions: GraphVersion[], branches: Branch[]): Diagram {
  const byId = new Map(versions.map((v) => [v.id, v]));
  const oldestFirst = [...versions].reverse();
  const nodes = new Map<NodeKey, DiagramNode>();
  const wires: Wire[] = [];

  // Column: one step right of the latest parent, so parallel work on
  // different branches shares columns.
  const column = new Map<string, number>();
  for (const v of oldestFirst) {
    const parents = v.parents.filter((p) => column.has(p));
    column.set(v.id, parents.length ? 1 + Math.max(...parents.map((p) => column.get(p)!)) : 0);
  }

  // Lane: the current branch first, then main, then the most recent ones;
  // each takes the versions along its first parents that no lane has yet.
  const order = [...branches]
    .filter((b) => b.head && byId.has(b.head))
    .sort((a, b) => {
      const rank = (x: Branch) => (x.current ? 0 : x.name === "main" ? 1 : 2);
      return rank(a) - rank(b) || byId.get(b.head!)!.createdAt - byId.get(a.head!)!.createdAt;
    });
  const lane = new Map<string, number>();
  let lanes = 0;
  const claim = (head: string) => {
    let id: string | undefined = head;
    let took = false;
    while (id && byId.has(id) && !lane.has(id)) {
      lane.set(id, lanes);
      took = true;
      id = byId.get(id)!.parents[0];
    }
    if (took) lanes++;
  };
  order.forEach((b) => claim(b.head!));
  versions.forEach((v) => claim(v.id)); // versions only tags or old merges lead to

  for (const v of versions) {
    const single = v.changes.length === 1 && v.parents.length < 2 ? v.changes[0] : null;
    nodes.set(versionKey(v.id), {
      kind: "version",
      key: versionKey(v.id),
      x: column.get(v.id)! * COL,
      y: lane.get(v.id)! * LANE,
      version: v,
      song: single?.path ?? null,
      change: single,
    });
    v.parents.forEach((p, i) => {
      if (byId.has(p)) {
        wires.push({ key: `p:${p}>${v.id}`, from: versionKey(p), to: versionKey(v.id), kind: i ? "merge" : "exec" });
      }
    });
  }

  // Each song's history: from the version that last touched it before
  // (along first parents) to the next; the first one hangs off the song.
  const touched = new Map<string, Map<string, string>>(); // version → song → last version touching it
  const songs = new Map<string, { first: number; count: number }>();
  for (const v of oldestFirst) {
    const inherited = touched.get(v.parents[0]) ?? new Map<string, string>();
    const own = new Map(inherited);
    const node = nodes.get(versionKey(v.id)) as VersionNode;
    if (node.song) {
      const song = node.song;
      const before = inherited.get(song);
      wires.push({
        key: `s:${song}>${v.id}`,
        from: before ? versionKey(before) : songKey(song),
        to: versionKey(v.id),
        kind: "song",
        song,
      });
      own.set(song, v.id);
    }
    // A merge has no song pins: the thread goes on from before it.
    for (const c of v.changes) {
      const seen = songs.get(c.path);
      if (seen) seen.count++;
      else songs.set(c.path, { first: songs.size, count: 1 });
    }
    touched.set(v.id, own);
  }
  [...songs.entries()]
    .sort((a, b) => a[1].first - b[1].first)
    .forEach(([path, s], i) => {
      nodes.set(songKey(path), {
        kind: "song",
        key: songKey(path),
        x: SONG_X,
        y: i * (SONG_H + SONG_GAP),
        path,
        versions: s.count,
      });
    });

  // Branch nodes below and right of their head; several on one head stack.
  const perHead = new Map<string, number>();
  for (const b of order) {
    const head = nodes.get(versionKey(b.head!))!;
    const k = perHead.get(b.head!) ?? 0;
    perHead.set(b.head!, k + 1);
    nodes.set(branchKey(b.name), {
      kind: "branch",
      key: branchKey(b.name),
      x: head.x + NODE_W + 36 + k * (BRANCH_W + 16),
      y: head.y + NODE_H + 22,
      branch: b,
    });
    wires.push({ key: `b:${b.name}`, from: head.key, to: branchKey(b.name), kind: "branch" });
  }
  return { nodes, wires };
}

export function nodeSize(node: DiagramNode): { w: number; h: number } {
  if (node.kind === "version") return { w: NODE_W, h: NODE_H };
  if (node.kind === "song") return { w: SONG_W, h: SONG_H };
  return { w: BRANCH_W, h: BRANCH_H };
}

/** Pin positions: where a wire of `kind` leaves `from` and enters `to`. */
export function wireEnds(
  wire: Wire,
  from: DiagramNode,
  to: DiagramNode,
): { x1: number; y1: number; x2: number; y2: number } {
  const out = wire.kind === "song" && from.kind === "version" ? PIN_SONG_Y : from.kind === "song" ? SONG_H / 2 : PIN_EXEC_Y;
  const into = wire.kind === "song" ? PIN_SONG_Y : to.kind === "branch" ? BRANCH_H / 2 : PIN_EXEC_Y;
  return {
    x1: from.x + nodeSize(from).w,
    y1: from.y + out,
    x2: to.x,
    y2: to.y + into,
  };
}

/**
 * A blueprint-style curve: out to the right, into the left. A wire that
 * skips over nodes on its own lane dips below them, so it never looks like
 * it plugs into the nodes it passes; `lift` keeps parallel ones apart.
 */
export function wirePath(
  { x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number },
  lift = 0,
): string {
  if (Math.abs(y2 - y1) < NODE_H && x2 - x1 > COL * 1.2) {
    const below = Math.max(y1, y2) + (NODE_H - PIN_SONG_Y) + 26 + lift;
    const r = 46;
    return [
      `M ${x1} ${y1}`,
      `C ${x1 + r} ${y1}, ${x1 + r} ${below}, ${x1 + 2 * r} ${below}`,
      `L ${x2 - 2 * r} ${below}`,
      `C ${x2 - r} ${below}, ${x2 - r} ${y2}, ${x2} ${y2}`,
    ].join(" ");
  }
  const pull = Math.max(40, Math.min(220, Math.abs(x2 - x1) * 0.5 + Math.abs(y2 - y1) * 0.15));
  return `M ${x1} ${y1} C ${x1 + pull} ${y1}, ${x2 - pull} ${y2}, ${x2} ${y2}`;
}
