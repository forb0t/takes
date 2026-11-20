import type { Rect } from "../../blueprint";
import type { View } from "./model";

/**
 * The whole canvas in small, with the part in sight: a click or a drag
 * brings another part into sight.
 */
export function Minimap({
  rects,
  view,
  size,
  onCenter,
}: {
  rects: (Rect & { hue: number; frame: boolean })[];
  view: View;
  size: { w: number; h: number };
  onCenter: (x: number, y: number) => void;
}) {
  const W = 200;
  const H = 130;
  const pad = 60;
  const x0 = Math.min(...rects.map((r) => r.x)) - pad;
  const y0 = Math.min(...rects.map((r) => r.y)) - pad;
  const x1 = Math.max(...rects.map((r) => r.x + r.w)) + pad;
  const y1 = Math.max(...rects.map((r) => r.y + r.h)) + pad;
  const scale = Math.min(W / (x1 - x0), H / (y1 - y0));
  const to = (x: number, y: number) => ({ x: (x - x0) * scale, y: (y - y0) * scale });
  const seen = to(-view.x / view.zoom, -view.y / view.zoom);

  function center(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    onCenter(x0 + (e.clientX - r.left) / scale, y0 + (e.clientY - r.top) / scale);
  }

  return (
    <svg
      className="bp-map"
      width={(x1 - x0) * scale}
      height={(y1 - y0) * scale}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        center(e);
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && center(e)}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {rects.map((r, i) => {
        const p = to(r.x, r.y);
        return (
          <rect
            key={i}
            x={p.x}
            y={p.y}
            width={Math.max(2, r.w * scale)}
            height={Math.max(2, r.h * scale)}
            rx={2}
            fill={`hsl(${r.hue} 50% 55% / ${r.frame ? 0.35 : 0.8})`}
          />
        );
      })}
      <rect
        className="bp-map-view"
        x={seen.x}
        y={seen.y}
        width={(size.w / view.zoom) * scale}
        height={(size.h / view.zoom) * scale}
      />
    </svg>
  );
}
