import { useEffect, useRef, useState } from "react";
import type { Analysis, Comment } from "./api";
import { formatTime } from "./util";

const BAR = 2; // px per bar
const GAP = 1;

/** Waveform overview with playback progress, click-to-seek and comment marks. */
export function Waveform({
  analysis,
  durationMs,
  positionMs,
  comments,
  onSeek,
  onMarker,
}: {
  analysis: Analysis | null;
  durationMs: number;
  positionMs: number;
  comments: Comment[];
  onSeek: (ms: number) => void;
  onMarker: (comment: Comment) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;

  useEffect(() => {
    const c = canvas.current;
    if (!c || width === 0) return;
    const height = c.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(c);
    const played = styles.getPropertyValue("--accent").trim() || "#ff8a4c";
    const rest = styles.getPropertyValue("--wave").trim() || "#5a5663";
    const mid = height / 2;
    const bars = Math.max(1, Math.floor(width / (BAR + GAP)));
    const peaks = analysis?.peaks ?? [];
    const rms = analysis?.rms ?? [];
    const n = peaks.length;

    for (let b = 0; b < bars; b++) {
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
      const x = b * (BAR + GAP);
      ctx.fillStyle = b / bars < progress ? played : rest;
      const hp = Math.max(1, (peak / 255) * mid * 0.96);
      const hr = Math.max(1, (loud / 255) * mid * 0.96);
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x, mid - hp, BAR, hp * 2);
      ctx.globalAlpha = 1;
      ctx.fillRect(x, mid - hr, BAR, hr * 2);
    }
  }, [analysis, width, progress]);

  const timeAt = (clientX: number) => {
    const rect = box.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * durationMs;
  };

  const marks = comments.filter((c) => c.timecodeMs !== null && durationMs > 0);
  return (
    <div
      ref={box}
      className={`waveform ${analysis ? "" : "loading"}`}
      onMouseMove={(e) => setHover(timeAt(e.clientX))}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => durationMs > 0 && onSeek(timeAt(e.clientX))}
    >
      <canvas ref={canvas} />
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
