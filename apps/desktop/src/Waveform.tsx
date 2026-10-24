import { useEffect, useRef, useState } from "react";
import type { Analysis, Comment } from "./api";
import { formatTime } from "./util";

const BAR = 2; // px per bar
const GAP = 1;

/** Peak and RMS per bar, `analysis` resampled to `bars` columns. */
function columns(analysis: Analysis | null, bars: number): [number, number][] {
  const peaks = analysis?.peaks ?? [];
  const rms = analysis?.rms ?? [];
  const n = peaks.length;
  return Array.from({ length: bars }, (_, b) => {
    let peak = 0;
    let loud = 0;
    if (n > 0) {
      const from = Math.floor((b * n) / bars);
      const to = Math.max(from + 1, Math.floor(((b + 1) * n) / bars));
      for (let i = from; i < to && i < n; i++) {
        peak = Math.max(peak, peaks[i]);
        loud = Math.max(loud, rms[i]);
      }
    }
    return [peak, loud];
  });
}

function setup(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  ctx?.scale(dpr, dpr);
  return ctx;
}

function drawBars(ctx: CanvasRenderingContext2D, cols: [number, number][], height: number, color: string) {
  const mid = height / 2;
  ctx.fillStyle = color;
  cols.forEach(([peak, loud], b) => {
    const x = b * (BAR + GAP);
    const hp = Math.max(1, (peak / 255) * mid * 0.96);
    const hr = Math.max(1, (loud / 255) * mid * 0.96);
    ctx.globalAlpha = 0.45;
    ctx.fillRect(x, mid - hp, BAR, hp * 2);
    ctx.globalAlpha = 1;
    ctx.fillRect(x, mid - hr, BAR, hr * 2);
  });
}

/** Outline of another version's peaks, to see where two takes differ. */
function drawGhost(ctx: CanvasRenderingContext2D, cols: [number, number][], height: number, color: string) {
  const mid = height / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    cols.forEach(([peak], b) => {
      const x = b * (BAR + GAP) + BAR / 2;
      const y = mid + sign * Math.max(1, (peak / 255) * mid * 0.96);
      if (b === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

/** A part of the track played over and over, [from, to] in ms. */
export type Loop = [number, number];
/** Shorter selections are clicks. */
const MIN_LOOP_MS = 300;

/**
 * Waveform overview with playback progress, click-to-seek, drag-to-loop and
 * comment marks. The bars are drawn once; progress only moves a clip over a
 * second, highlighted copy, so playback does not redraw anything.
 */
export function Waveform({
  analysis,
  ghost,
  durationMs,
  positionMs,
  comments,
  loop,
  onSeek,
  onLoop,
  onMarker,
}: {
  analysis: Analysis | null;
  /** The other version in an A/B comparison, drawn as an outline. */
  ghost?: Analysis | null;
  durationMs: number;
  positionMs: number;
  comments: Comment[];
  loop: Loop | null;
  onSeek: (ms: number) => void;
  /** A part dragged over, to loop. */
  onLoop: (loop: Loop) => void;
  onMarker: (comment: Comment) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const played = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<number | null>(null);
  /** A loop being dragged: where it started and where the pointer is. */
  const [selecting, setSelecting] = useState<Loop | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const { width, height } = size;
    if (!base.current || !played.current || width === 0 || height === 0) return;
    const styles = getComputedStyle(base.current);
    const accent = styles.getPropertyValue("--accent").trim() || "#ff8a4c";
    const rest = styles.getPropertyValue("--wave").trim() || "#5a5663";
    const outline = styles.getPropertyValue("--wave-ghost").trim() || "rgba(143, 199, 255, 0.55)";
    const bars = Math.max(1, Math.floor(width / (BAR + GAP)));
    const cols = columns(analysis, bars);
    const ghostCols = ghost ? columns(ghost, bars) : null;
    for (const [canvas, color] of [
      [base.current, rest],
      [played.current, accent],
    ] as const) {
      const ctx = setup(canvas, width, height);
      if (!ctx) continue;
      drawBars(ctx, cols, height, color);
      if (ghostCols) drawGhost(ctx, ghostCols, height, outline);
    }
  }, [analysis, ghost, size]);

  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const timeAt = (clientX: number) => {
    const rect = box.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * durationMs;
  };

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || durationMs <= 0 || (e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const at = timeAt(e.clientX);
    setSelecting([at, at]);
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!selecting) return;
    const [from, to] = [Math.min(...selecting), Math.max(...selecting)];
    setSelecting(null);
    if (to - from >= MIN_LOOP_MS) onLoop([from, to]);
    else onSeek(timeAt(e.clientX));
  }

  const marks = comments.filter((c) => c.timecodeMs !== null && durationMs > 0);
  const shown = selecting ? ([Math.min(...selecting), Math.max(...selecting)] as Loop) : loop;
  return (
    <div
      ref={box}
      className={`waveform ${analysis ? "" : "loading"}`}
      title="Щелчок — перейти, протяните — повторять фрагмент"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        const at = timeAt(e.clientX);
        setHover(at);
        setSelecting((s) => (s ? [s[0], at] : s));
      }}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setSelecting(null)}
      onMouseLeave={() => setHover(null)}
    >
      <canvas ref={base} />
      <div className="wave-played" style={{ clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)` }}>
        <canvas ref={played} />
      </div>
      {shown && durationMs > 0 && (
        <div
          className={`wave-loop ${selecting ? "selecting" : ""}`}
          style={{
            left: `${(shown[0] / durationMs) * 100}%`,
            width: `${((shown[1] - shown[0]) / durationMs) * 100}%`,
          }}
        />
      )}
      {hover !== null && durationMs > 0 && (
        <div className="wave-hover" style={{ left: `${(hover / durationMs) * 100}%` }}>
          <span>{formatTime(hover)}</span>
        </div>
      )}
      {marks.map((c) => (
        <button
          key={c.id}
          className={`wave-mark ${c.resolved ? "resolved" : ""}`}
          style={{ left: `${(Math.min(c.timecodeMs!, durationMs) / durationMs) * 100}%` }}
          title={`${formatTime(c.timecodeMs!)} · ${c.author}: ${c.text}`}
          onClick={(e) => {
            e.stopPropagation();
            onMarker(c);
          }}
        />
      ))}
    </div>
  );
}
