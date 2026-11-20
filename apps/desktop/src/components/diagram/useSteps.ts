import { useEffect, useMemo, useRef, useState } from "react";
import type { Lane, Layout, SongLinks } from "../../blueprint";
import type { Songs } from "../../songs";
import { useToast } from "../../ui";
import { keepSaved } from "../../wiring";
import type { Snapshot, Tile } from "./model";

/**
 * Ctrl+Z on the diagram: what `remember` saw before each change is taken
 * back by `step("back")` and brought again by `step("forth")`. Where things
 * lie, the tiles, and how one song was wired.
 */
export function useSteps({
  songs,
  layout,
  tiles,
  layoutNow,
  tilesNow,
  putLayout,
  putTiles,
}: {
  songs: Songs;
  layout: Layout;
  tiles: Tile[];
  layoutNow: React.RefObject<Layout>;
  tilesNow: React.RefObject<Tile[]>;
  putLayout: (next: Layout) => void;
  putTiles: (next: Tile[]) => void;
}) {
  const toast = useToast();
  const lanes = songs.lanes;

  /** The songs as last built, for a step back or forth made later. */
  const lanesNow = useRef(lanes);
  lanesNow.current = lanes;

  /**
   * What Ctrl+Z takes back (`back`) and Ctrl+Shift+Z brings again (`forth`), newest last;
   * `landed`: how things were right after the last step (see `shape`), null until seen.
   */
  const stack = useRef<{ back: Snapshot[]; forth: Snapshot[]; landed: string | null }>({
    back: [],
    forth: [],
    landed: null,
  });
  /** How many steps there are each way, for the buttons. */
  const [steps, setSteps] = useState({ back: 0, forth: 0 });
  /** How each song was wired when last drawn, by id, to tell a rewiring made elsewhere. */
  const wiredSeen = useRef(new Map<string, SongLinks>());
  /** Songs a change or a step here rewires before the next drawing, by id. */
  const relinking = useRef(new Set<string>());

  /** How things lie now; with `lane`, also how that song is wired now. */
  function snapshot(at: number, lane?: Lane): Snapshot {
    const now = lane && (lanesNow.current?.find((l) => l.id === lane.id) ?? lane);
    return { at, layout: layoutNow.current, tiles: tilesNow.current, wired: now && { lane: now, links: now.links } };
  }

  /**
   * Remembers how things lie before a change, so Ctrl+Z can bring it back;
   * with `lane`, the change rewires that song too. Changes made together
   * (within a moment) are one step. A new change forgets what was undone.
   */
  function remember(lane?: Lane) {
    const h = stack.current;
    const last = h.back[h.back.length - 1];
    if (!lane && last && Date.now() - last.at < 300) return;
    if (lane) relinking.current.add(lane.id);
    h.back.push(snapshot(Date.now(), lane));
    if (h.back.length > 50) h.back.shift();
    h.forth = [];
    setSteps({ back: h.back.length, forth: 0 });
  }

  /** One step back (Ctrl+Z), or forth again after one (Ctrl+Shift+Z). */
  function step(way: "back" | "forth") {
    const h = stack.current;
    const to = h[way].pop();
    if (!to) {
      toast(way === "back" ? "Отменять нечего" : "Возвращать нечего", "info");
      return;
    }
    // How things are now, to come back to; never one step with the next change.
    const now = snapshot(0, to.wired?.lane);
    (way === "back" ? h.forth : h.back).push(now);
    if (now.wired && to.wired) {
      // A branch made since stays; other versions saved since go after the one they were made from.
      relinking.current.add(now.wired.lane.id);
      songs.relink(now.wired.lane, keepSaved(now.wired.lane, to.wired.links));
    }
    putLayout(to.layout);
    putTiles(to.tiles);
    h.landed = null;
    setSteps({ back: h.back.length, forth: h.forth.length });
    toast(way === "back" ? "Отменено" : "Возвращено", "info");
  }

  /** Everything a step puts back, as text, to tell whether anything changed since. */
  const shape = useMemo(
    () => JSON.stringify([layout, tiles, lanes?.map((l) => [l.id, l.links])]),
    [layout, tiles, lanes],
  );

  // What was taken back comes back only onto what the step left. A change made
  // since in any other way (a file copied in by a wire, a new branch, a version
  // saved, a sync from another device) forgets it, as a change on the diagram does.
  useEffect(() => {
    const h = stack.current;
    if (h.landed === null) h.landed = shape;
    else if (h.forth.length && shape !== h.landed) {
      h.forth = [];
      setSteps({ back: h.back.length, forth: 0 });
    }
  });

  // A song rewired some other way (a file copied in by a wire, a version put into
  // the folder, a sync from another device): a step would put its old wires back
  // over the new ones, so the steps that rewire it are forgotten. New versions
  // alone (a save, a new branch) keep them: see `keepSaved` for where those go.
  useEffect(() => {
    const h = stack.current;
    const count = h.back.length + h.forth.length;
    for (const l of lanes ?? []) {
      const before = wiredSeen.current.get(l.id);
      wiredSeen.current.set(l.id, l.links);
      if (!before || before === l.links || relinking.current.has(l.id)) continue;
      if (Object.keys(before).every((v) => l.links[v] === before[v])) continue;
      const other = (s: Snapshot) => s.wired?.lane.id !== l.id;
      h.back = h.back.filter(other);
      h.forth = h.forth.filter(other);
    }
    relinking.current.clear();
    if (h.back.length + h.forth.length !== count) setSteps({ back: h.back.length, forth: h.forth.length });
  }, [lanes]);

  return { steps, remember, step };
}
