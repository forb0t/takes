import { useEffect, useRef, useState } from "react";
import { api, errorText, type Overview } from "../../api";
import type { Layout } from "../../blueprint";
import { SETTLE_MS } from "../../songs";
import { useToast } from "../../ui";
import { LAYOUT_KEY, TILES_KEY, parseLayout, parseTiles, type Tile } from "./model";

/**
 * Where things lie on the diagram and its tiles, as every device of the
 * project shares them. `put…` changes one here and for the others; the
 * `…Now` refs give it as last changed, also by a change not drawn yet.
 */
export function useShared(root: string, overview: Overview) {
  const toast = useToast();
  const [layout, setLayout] = useState<Layout>({ lanes: {}, free: {} });
  const [tiles, setTiles] = useState<Tile[]>([]);
  const localEdit = useRef(0);

  // Another device may have moved things; a sync reloads the overview.
  useEffect(() => {
    let alive = true;
    Promise.all([api.sharedSetting(root, LAYOUT_KEY), api.sharedSetting(root, TILES_KEY)])
      .then(([layoutValue, tilesValue]) => {
        if (!alive || Date.now() - localEdit.current < SETTLE_MS) return;
        setLayout(parseLayout(layoutValue));
        setTiles(parseTiles(tilesValue));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [root, overview]);

  function saveSetting(key: string, value: unknown) {
    localEdit.current = Date.now();
    api.setSharedSetting(root, key, JSON.stringify(value)).catch((e) => toast(errorText(e), "error"));
  }

  const layoutNow = useRef(layout);
  layoutNow.current = layout;
  const tilesNow = useRef(tiles);
  tilesNow.current = tiles;

  function putLayout(next: Layout) {
    setLayout(next);
    layoutNow.current = next;
    saveSetting(LAYOUT_KEY, next);
  }

  function putTiles(next: Tile[]) {
    setTiles(next);
    tilesNow.current = next;
    saveSetting(TILES_KEY, next);
  }

  return { layout, tiles, layoutNow, tilesNow, putLayout, putTiles };
}
