import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Point, Rect } from "../../blueprint";
import { MAX_ZOOM, MIN_ZOOM, loadView, noSelecting, saveView, type View } from "./model";

/**
 * Looking at the diagram: where it is in sight and how big (kept per
 * project on this device), panning by dragging the empty canvas, the
 * wheel, a pinch, and bringing things into sight.
 */
export function useView(
  root: string,
  {
    bounds,
    hasContent,
    onEmptyClick,
  }: {
    /** Everything there is on the canvas. */
    bounds: () => Rect | null;
    hasContent: boolean;
    /** A click on the empty canvas. */
    onEmptyClick: () => void;
  },
) {
  const [savedView] = useState(() => loadView(root));
  const [view, setView] = useState<View>(savedView ?? { x: 32, y: 32, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const fitted = useRef(savedView !== null);
  const pan = useRef<{ x: number; y: number; origin: View; moved: boolean } | null>(null);
  /** A drag just ended: the click that follows is not a click on what was under it. */
  const suppressClick = useRef(false);
  /** The file panel beside the canvas, when open. */
  const panelBox = useRef<HTMLElement>(null);

  /** Everything in sight, or its top left when that would be too small to read. */
  const fit = useCallback(() => {
    const b = bounds();
    if (!box || !b) return;
    const { width, height } = box.getBoundingClientRect();
    const m = 32;
    const whole = Math.min(1, (width - m * 2) / b.w, (height - m * 2) / b.h);
    const zoom = whole >= 0.6 ? whole : Math.min(1, Math.max(0.85, (width - m * 2) / b.w));
    setView({
      zoom,
      x: whole >= 0.6 ? (width - b.w * zoom) / 2 - b.x * zoom : m - b.x * zoom,
      y: whole >= 0.6 ? Math.min(m * 2, (height - b.h * zoom) / 2) - b.y * zoom : m - b.y * zoom,
    });
  }, [box, bounds]);

  // The first look: where it was left, unless nothing would be in sight.
  useLayoutEffect(() => {
    const b = bounds();
    if (!box || !b) return;
    if (fitted.current) {
      const { width, height } = box.getBoundingClientRect();
      const left = view.x + b.x * view.zoom;
      const top = view.y + b.y * view.zoom;
      const right = left + b.w * view.zoom;
      const bottom = top + b.h * view.zoom;
      if (right > 40 && bottom > 40 && left < width - 40 && top < height - 40) return;
    }
    fitted.current = true;
    fit();
    // Only once, when there is something to show.
  }, [box, hasContent]);

  useEffect(() => {
    const t = setTimeout(() => saveView(root, view), 400);
    return () => clearTimeout(t);
  }, [root, view]);

  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!box) return;
    const observer = new ResizeObserver(() => setSize({ w: box.clientWidth, h: box.clientHeight }));
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      return { zoom, x: cx - ((cx - v.x) * zoom) / v.zoom, y: cy - ((cy - v.y) * zoom) / v.zoom };
    });
  }, []);
  const zoomBy = useCallback(
    (factor: number) => box && zoomAt(box.clientWidth / 2, box.clientHeight / 2, factor),
    [box, zoomAt],
  );

  /** Brings a place on the canvas into sight: centred, or its start when it is too wide. */
  const focusRect = useCallback(
    (rect: Rect) => {
      if (!box) return;
      const { clientWidth: w, clientHeight: h } = box;
      setView((v) => ({
        ...v,
        x: rect.w * v.zoom > w - 80 ? 40 - rect.x * v.zoom : w / 2 - (rect.x + rect.w / 2) * v.zoom,
        y: rect.h * v.zoom > h - 80 ? 40 - rect.y * v.zoom : h / 2 - (rect.y + rect.h / 2) * v.zoom,
      }));
    },
    [box],
  );

  /**
   * Brings one node into sight, big enough to read and clear of the file panel.
   * Measured in the next frame, so a panel that has just opened counts: beside a
   * wide canvas it takes its room, in a narrow window it covers the right.
   */
  function focusNode(rect: Rect) {
    requestAnimationFrame(() => {
      if (!box) return;
      const { clientWidth: w, clientHeight: h } = box;
      const panel = panelBox.current;
      const covered = panel && getComputedStyle(panel).position === "absolute" ? panel.offsetWidth : 0;
      setView((v) => {
        const zoom = Math.max(v.zoom, 0.75);
        return {
          zoom,
          x: Math.max(16, (w - covered - rect.w * zoom) / 2) - rect.x * zoom,
          y: h / 2 - (rect.y + rect.h / 2) * zoom,
        };
      });
    });
  }

  /** A point on the screen, on the canvas. */
  const toCanvas = useCallback(
    (clientX: number, clientY: number): Point => {
      const r = box?.getBoundingClientRect() ?? { left: 0, top: 0 };
      return { x: (clientX - r.left - view.x) / view.zoom, y: (clientY - r.top - view.y) / view.zoom };
    },
    [box, view],
  );

  // The wheel scrolls (with Shift, sideways); Ctrl + wheel or a pinch zooms.
  useEffect(() => {
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      // The help sheet scrolls by itself.
      if ((e.target as HTMLElement).closest(".bp-help-sheet")) return;
      const area = (e.target as HTMLElement).closest("textarea");
      if (area && area.scrollHeight > area.clientHeight && !e.ctrlKey) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.clientHeight : 1;
      if (e.ctrlKey) {
        // A pinch on a trackpad comes as small steps, a mouse wheel as big ones.
        const d = e.deltaY * unit;
        const factor = Math.abs(d) < 40 ? Math.exp(-d * 0.01) : d < 0 ? 1.15 : 1 / 1.15;
        const r = box.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
      } else {
        const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
        const dy = e.shiftKey ? 0 : e.deltaY * unit;
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    // Pinching on a Mac (Safari's gesture events) zooms the canvas, not the window.
    let pinched = 1;
    const onGesture = (e: Event) => {
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      e.preventDefault();
      if (e.type === "gesturestart") pinched = 1;
      else if (e.type === "gesturechange") {
        const r = box.getBoundingClientRect();
        zoomAt(g.clientX - r.left, g.clientY - r.top, g.scale / pinched);
        pinched = g.scale;
      }
    };
    const gestures = ["gesturestart", "gesturechange", "gestureend"];
    box.addEventListener("wheel", onWheel, { passive: false });
    for (const g of gestures) box.addEventListener(g, onGesture);
    // On Linux the app takes the pinch from the system and passes it on.
    const unlisten = listen<[number, number, number]>("pinch", (e) => {
      const [factor, x, y] = e.payload;
      const r = box.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
      zoomAt(x - r.left, y - r.top, factor);
    });
    return () => {
      box.removeEventListener("wheel", onWheel);
      for (const g of gestures) box.removeEventListener(g, onGesture);
      unlisten.then((f) => f()).catch(() => {});
    };
  }, [box, zoomAt]);

  /** Dragging the empty canvas pans it. */
  const panHandlers = {
    onPointerDown(e: React.PointerEvent) {
      suppressClick.current = false;
      if (e.button !== 0 && e.button !== 1) return;
      if ((e.target as HTMLElement).closest("button, input, textarea, select, a")) return;
      // The middle button pans too, instead of scrolling by itself.
      if (e.button === 1) e.preventDefault();
      pan.current = { x: e.clientX, y: e.clientY, origin: view, moved: false };
    },
    onPointerMove(e: React.PointerEvent) {
      const p = pan.current;
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (!p.moved) {
        // Capture only once it is a drag, so clicks still reach what was clicked.
        if (Math.abs(dx) + Math.abs(dy) <= 4) return;
        p.moved = true;
        suppressClick.current = true;
        noSelecting(true);
        setPanning(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      setView({ ...p.origin, x: p.origin.x + dx, y: p.origin.y + dy });
    },
    onPointerUp(e: React.PointerEvent) {
      const p = pan.current;
      pan.current = null;
      if (p?.moved) noSelecting(false);
      setPanning(false);
      // A click on the empty canvas lets go of what was selected.
      if (p && !p.moved && !(e.target as HTMLElement).closest(".bp-node, .bp-lane-title, .bp-group-title")) {
        onEmptyClick();
      }
    },
    onPointerCancel() {
      pan.current = null;
      noSelecting(false);
      setPanning(false);
    },
  };

  return {
    box,
    setBox,
    view,
    setView,
    size,
    panning,
    fitted,
    suppressClick,
    panelBox,
    fit,
    zoomBy,
    focusRect,
    focusNode,
    toCanvas,
    panHandlers,
  };
}
