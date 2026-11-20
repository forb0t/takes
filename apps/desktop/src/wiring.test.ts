import { describe, expect, it } from "vitest";
import type { GraphVersion } from "./api";
import type { ProjectFile } from "./components/FilesTab";
import { DROPPED, MAIN_BRANCH, branchKey, buildLanes, shortId, songId, type Lane, type SongLinks, type SongVersion } from "./blueprint";
import { connect, dropBranch, follow, follows, joinBranch, keepSaved, moveOne, renameBranch, unplug } from "./wiring";

const PATH = "song.wav";
const id = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const sid = (n: number) => shortId(id(n));
const key = (n: number, path = PATH) => `${id(n)}:${path}`;
const ACOUSTIC = "акустика";

/**
 * Versions 1…count of one song, newest first, each made from the one before;
 * `same` gives a version the content of an earlier one.
 */
function history(count: number, same: Record<number, number> = {}): GraphVersion[] {
  const out: GraphVersion[] = [];
  for (let n = 1; n <= count; n++) {
    out.unshift({
      id: id(n),
      parents: n > 1 ? [id(n - 1)] : [],
      message: `v${n}`,
      author: "me",
      createdAt: n * 100,
      changes: [
        { path: PATH, kind: n === 1 ? "added" : "modified", size: 1, pruned: false, labels: [], blob: `c${same[n] ?? n}` },
      ],
    });
  }
  return out;
}

function laneOf(versions: GraphVersion[], links: SongLinks = {}, file: Partial<ProjectFile> = {}): Lane {
  const wiring = new Map([[songId(PATH), { links, branches: {} }]]);
  const files = [{ path: PATH, status: "saved" as const, size: 1, labels: [], from: null, ...file }];
  const lanes = buildLanes(versions, [{ name: "main", head: versions[0].id, current: true }], files, new Set(), [], wiring);
  expect(lanes).toHaveLength(1);
  return lanes[0];
}

/** Each branch's versions, by number, along its wire; "" for the unplugged ones. */
function wires(lane: Lane): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const versions = lane.nodes.filter((n): n is SongVersion => n.kind === "version");
  for (const n of versions.sort((a, b) => a.row - b.row || a.col - b.col)) (out[n.branch] ??= []).push(n.number!);
  return out;
}

const version = (lane: Lane, n: number) =>
  lane.nodes.find((x): x is SongVersion => x.kind === "version" && x.key === key(n))!;

/** Versions 1 and 2 on the main branch, 3 on the acoustic one. */
const withAcoustic = (count = 3) =>
  laneOf(history(count), { [sid(1)]: branchKey(MAIN_BRANCH), [sid(2)]: sid(1), [sid(3)]: branchKey(ACOUSTIC) });

describe("buildLanes", () => {
  it("puts a song's versions on its main branch in the order they were saved", () => {
    const lane = laneOf(history(3));
    expect(wires(lane)).toEqual({ [MAIN_BRANCH]: [1, 2, 3] });
    expect(lane.branches.map((b) => b.name)).toEqual([MAIN_BRANCH]);
    expect(lane.branches[0]).toMatchObject({ active: true, versions: 3, head: key(3) });
    expect(version(lane, 3).inFolder).toBe(true);
    expect(lane.looseRow).toBeNull();
  });

  it("keeps the main branch first and others in the order they started", () => {
    const lane = laneOf(history(4), {
      [sid(1)]: branchKey("ремикс"),
      [sid(2)]: branchKey(MAIN_BRANCH),
      [sid(3)]: branchKey(ACOUSTIC),
      [sid(4)]: sid(2),
    });
    expect(lane.branches.map((b) => b.name)).toEqual([MAIN_BRANCH, "ремикс", ACOUSTIC]);
    expect(wires(lane)).toEqual({ [MAIN_BRANCH]: [2, 4], ремикс: [1], [ACOUSTIC]: [3] });
    expect(lane.branches.find((b) => b.active)?.name).toBe(MAIN_BRANCH);
  });

  it("goes on with the branch a version saved since was made from", () => {
    // Version 3 is not wired yet: it follows version 2, wherever that one is.
    const lane = laneOf(history(3), { [sid(1)]: branchKey(MAIN_BRANCH), [sid(2)]: branchKey(ACOUSTIC) });
    expect(wires(lane)).toEqual({ [MAIN_BRANCH]: [1], [ACOUSTIC]: [2, 3] });
    expect(lane.branches.find((b) => b.active)?.name).toBe(ACOUSTIC);
  });

  it("puts two versions wired into one place (from two devices) one after another", () => {
    const lane = laneOf(history(3), { [sid(1)]: branchKey(MAIN_BRANCH), [sid(2)]: sid(1), [sid(3)]: sid(1) });
    expect(wires(lane)).toEqual({ [MAIN_BRANCH]: [1, 2, 3] });
    expect(lane.links[sid(3)]).toBe(sid(2));
  });

  it("unplugs the oldest version of a circle", () => {
    const lane = laneOf(history(3), { [sid(1)]: branchKey(MAIN_BRANCH), [sid(2)]: sid(3), [sid(3)]: sid(2) });
    expect(wires(lane)).toEqual({ [MAIN_BRANCH]: [1], "": [2, 3] });
    expect(lane.links[sid(2)]).toBe("");
  });

  it("leaves out a version with the content of the one before it", () => {
    const lane = laneOf(history(4, { 3: 2 }));
    expect(wires(lane)).toEqual({ [MAIN_BRANCH]: [1, 2, 4] });
    expect(lane.hidden).toEqual([sid(3)]);
  });

  it("stands the file on disk after the version in the folder", () => {
    const lane = laneOf(history(2), {}, { status: "modified" });
    const work = lane.nodes.find((n) => n.kind === "work");
    expect(work).toMatchObject({ parent: key(2), row: 0, col: 2 });
    expect(version(lane, 2).inFolder).toBe(false);
  });

  it("keeps one lane for a renamed song, under its new name", () => {
    const versions: GraphVersion[] = [
      {
        id: id(2),
        parents: [id(1)],
        message: "rename",
        author: "me",
        createdAt: 200,
        changes: [{ path: "new.wav", kind: "renamed", from: "old.wav", size: 1, pruned: false, labels: [], blob: "c1" }],
      },
      {
        id: id(1),
        parents: [],
        message: "add",
        author: "me",
        createdAt: 100,
        changes: [{ path: "old.wav", kind: "added", size: 1, pruned: false, labels: [], blob: "c1" }],
      },
    ];
    const files = [{ path: "new.wav", status: "saved" as const, size: 1, labels: [], from: null }];
    const lanes = buildLanes(versions, [{ name: "main", head: id(2), current: true }], files, new Set(), [], new Map());
    expect(lanes.map((l) => l.names)).toEqual([["new.wav", "old.wav"]]);
    expect(lanes[0].id).toBe(songId("old.wav"));
  });
});

describe("wiring", () => {
  it("unplugs a version together with what follows it", () => {
    const lane = laneOf(history(3));
    expect(wires(laneOf(history(3), unplug(lane, key(2))))).toEqual({ [MAIN_BRANCH]: [1], "": [2, 3] });
  });

  it("plugs a version in between when something follows there already", () => {
    const loose = laneOf(history(3), unplug(laneOf(history(3)), key(3)));
    expect(wires(loose)).toEqual({ [MAIN_BRANCH]: [1, 2], "": [3] });
    const links = connect(loose, key(1), key(3))!;
    expect(wires(laneOf(history(3), links))).toEqual({ [MAIN_BRANCH]: [1, 3, 2] });
  });

  it("starts a branch with a version and what follows it", () => {
    const links = connect(laneOf(history(3)), branchKey(ACOUSTIC), key(2))!;
    const lane = laneOf(history(3), links);
    expect(wires(lane)).toEqual({ [MAIN_BRANCH]: [1], [ACOUSTIC]: [2, 3] });
    expect(lane.branches.find((b) => b.name === ACOUSTIC)?.from).toBe(1);
  });

  it("never wires a circle", () => {
    const lane = laneOf(history(3));
    expect(connect(lane, key(3), key(1))).toBeNull();
    expect(connect(lane, key(2), key(2))).toBeNull();
    expect(connect(lane, key(1), key(2))).not.toBeNull();
  });

  it("plugs in past versions that are not drawn", () => {
    const lane = laneOf(history(4, { 3: 2 }));
    expect(follows(lane, key(2), key(4))).toBe(true);
    expect(follows(lane, branchKey(MAIN_BRANCH), key(4))).toBe(false);
    const loose = laneOf(history(4, { 3: 2 }), unplug(lane, key(4)));
    expect(connect(loose, key(2), key(4))![sid(4)]).toBe(sid(3));
  });

  it("moves only one version, closing up behind it", () => {
    const lane = laneOf(history(4), {
      [sid(1)]: branchKey(MAIN_BRANCH),
      [sid(2)]: sid(1),
      [sid(3)]: sid(2),
      [sid(4)]: branchKey(ACOUSTIC),
    });
    const moved = laneOf(history(4), moveOne(lane, version(lane, 2), ACOUSTIC));
    // Version 2 is older than 4, so it goes first among the acoustic ones.
    expect(wires(moved)).toEqual({ [MAIN_BRANCH]: [1, 3], [ACOUSTIC]: [2, 4] });
  });

  it("moves every version of one branch to the end of another", () => {
    const lane = withAcoustic();
    const joined = laneOf(history(3), joinBranch(lane, ACOUSTIC, MAIN_BRANCH));
    expect(wires(joined)).toEqual({ [MAIN_BRANCH]: [1, 2, 3] });
    expect(joined.branches.map((b) => b.name)).toEqual([MAIN_BRANCH]);
  });

  it("renames a branch", () => {
    const renamed = laneOf(history(3), renameBranch(withAcoustic(), ACOUSTIC, "ремикс"));
    expect(wires(renamed)).toEqual({ [MAIN_BRANCH]: [1, 2], ремикс: [3] });
  });

  it("puts a new version after what it is plugged into", () => {
    const lane = withAcoustic();
    expect(follow(lane, branchKey(ACOUSTIC), sid(9))[sid(9)]).toBe(branchKey(ACOUSTIC));
    // Where it would make a circle, it is left unplugged.
    expect(follow(lane, key(3), sid(3))[sid(3)]).toBe("");
  });

  it("takes a step back without losing versions saved since", () => {
    const before = { [sid(1)]: branchKey(MAIN_BRANCH), [sid(2)]: sid(1) };
    // Saved since on the folder's branch: it goes after the version it was made from.
    const back = keepSaved(laneOf(history(3)), before);
    expect(back).not.toHaveProperty(sid(3));
    expect(wires(laneOf(history(3), back))).toEqual({ [MAIN_BRANCH]: [1, 2, 3] });
    // A branch made since keeps the versions it starts with.
    const kept = keepSaved(withAcoustic(), before);
    expect(kept[sid(3)]).toBe(branchKey(ACOUSTIC));
    expect(wires(laneOf(history(3), kept))).toEqual({ [MAIN_BRANCH]: [1, 2], [ACOUSTIC]: [3] });
  });
});

describe("deleting a branch", () => {
  it("leaves its versions out, keeping the numbers of the others", () => {
    const lane = withAcoustic(4);
    const links = dropBranch(lane, ACOUSTIC);
    expect(links[sid(3)]).toBe(DROPPED);
    // Version 4, saved after 3, went on in its branch: it goes too.
    expect(links[sid(4)]).toBe(DROPPED);
    const left = laneOf(history(4), { ...links, [sid(4)]: sid(2) });
    expect(wires(left)).toEqual({ [MAIN_BRANCH]: [1, 2, 4] });
    expect(left.branches.map((b) => b.name)).toEqual([MAIN_BRANCH]);
    expect(left.versions).toBe(3);
    // Kept as deleted, also when the song is rewired later.
    expect(left.links[sid(3)]).toBe(DROPPED);
    expect(unplug(left, key(4))[sid(3)]).toBe(DROPPED);
    expect(wires(laneOf(history(4), links))).toEqual({ [MAIN_BRANCH]: [1, 2] });
  });

  it("never brings deleted versions back with a step back", () => {
    const before = withAcoustic().links;
    const now = laneOf(history(3), dropBranch(withAcoustic(), ACOUSTIC));
    expect(keepSaved(now, before)[sid(3)]).toBe(DROPPED);
  });
});
