/**
 * Rewiring a song's versions, as people do on the diagram: each version
 * follows a branch's node, another version, or nothing when unplugged.
 * As in a blueprint, what follows a version on its wire comes along with
 * it; plugged in where something follows already, a version goes in
 * between. Every function gives the song's whole wiring anew.
 */
import { BRANCH_PREFIX, branchKey, sidOf, type Lane, type SongLinks, type SongVersion } from "./blueprint";

/** What a wire starts from: a version (its node's key) or a branch's node (`branchKey`). */
export type Anchor = string;

const refOf = (anchor: Anchor) => (anchor.startsWith(BRANCH_PREFIX) ? anchor : sidOf(anchor));

/** What follows each branch's node and version. */
function followers(links: SongLinks): Map<string, string> {
  const after = new Map<string, string>();
  for (const [sid, ref] of Object.entries(links)) if (ref) after.set(ref, sid);
  return after;
}

/** The last version on the wire from `ref`. */
function lastOn(links: SongLinks, ref: string): string {
  const after = followers(links);
  const seen = new Set<string>();
  let at = ref;
  for (let next = after.get(at); next !== undefined && !seen.has(next); next = after.get(at)) {
    seen.add(next);
    at = next;
  }
  return at;
}

/** After `ref` and the versions not drawn that stand for it. */
function pastHidden(lane: Lane, links: SongLinks, ref: string): string {
  const hidden = new Set(lane.hidden);
  const after = followers(links);
  let at = ref;
  for (let next = after.get(at); next !== undefined && hidden.has(next) && next !== ref; next = after.get(at))
    at = next;
  return at;
}

/** Whether `ref` comes after version `sid` on its wire. */
function isAfter(links: SongLinks, sid: string, ref: string): boolean {
  const after = followers(links);
  const seen = new Set<string>();
  for (let next = after.get(sid); next !== undefined && !seen.has(next); next = after.get(next)) {
    if (next === ref) return true;
    seen.add(next);
  }
  return false;
}

/** Plugs version `sid` (with what follows it) in after `ref`; null when that would wire a circle. */
function plug(lane: Lane, links: SongLinks, ref: string, sid: string): SongLinks | null {
  const at = ref.startsWith(BRANCH_PREFIX) ? ref : pastHidden(lane, links, ref);
  if (at === sid || isAfter(links, sid, at)) return null;
  const was = followers(links).get(at);
  const next = { ...links, [sid]: at };
  if (was !== undefined && was !== sid) next[was] = lastOn(next, sid);
  return next;
}

/** The wiring with version `key` (and what follows it) after `anchor`; null for a circle. */
export function connect(lane: Lane, anchor: Anchor, key: string): SongLinks | null {
  return plug(lane, lane.links, refOf(anchor), sidOf(key));
}

/** Whether version `key` follows `anchor` already. */
export function follows(lane: Lane, anchor: Anchor, key: string): boolean {
  const ref = refOf(anchor);
  const at = ref.startsWith(BRANCH_PREFIX) ? ref : pastHidden(lane, lane.links, ref);
  return lane.links[sidOf(key)] === at;
}

/** The wiring with version `key` unplugged: it and what follows it are wired into no branch. */
export function unplug(lane: Lane, key: string): SongLinks {
  return { ...lane.links, [sidOf(key)]: "" };
}

/** The wiring with a new version (short id) after `anchor`. */
export function follow(lane: Lane, anchor: Anchor, sid: string): SongLinks {
  return plug(lane, lane.links, refOf(anchor), sid) ?? { ...lane.links, [sid]: "" };
}

/**
 * Only this version to `branch`, among its versions by when they were
 * saved; the ones after it on its old wire close up behind it.
 */
export function moveOne(lane: Lane, n: SongVersion, branch: string): SongLinks {
  const sid = sidOf(n.key);
  const links = { ...lane.links };
  const last = pastHidden(lane, links, sid);
  const next = followers(links).get(last);
  if (next !== undefined) links[next] = links[sid];
  links[sid] = "";
  const wire = lane.nodes.filter((x): x is SongVersion => x.kind === "version" && x.branch === branch && x !== n);
  const before = [...wire].sort((a, b) => a.col - b.col).filter((x) => x.version.createdAt <= n.version.createdAt);
  const anchor = before.length ? sidOf(before[before.length - 1].key) : branchKey(branch);
  return plug(lane, links, anchor, sid) ?? links;
}

/** Every version of branch `from` after the last one of `into`. */
export function joinBranch(lane: Lane, from: string, into: string): SongLinks {
  const first = followers(lane.links).get(branchKey(from));
  if (first === undefined) return lane.links;
  return { ...lane.links, [first]: lastOn(lane.links, branchKey(into)) };
}

export function renameBranch(lane: Lane, from: string, to: string): SongLinks {
  const links: SongLinks = {};
  for (const [sid, ref] of Object.entries(lane.links)) links[sid] = ref === branchKey(from) ? branchKey(to) : ref;
  return links;
}
