import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import type { Track } from "./player";
import { Modal } from "./ui";
import { plural, splitPath } from "./util";

/** Pages rendered at most; long scores and contracts show their start. */
const MAX_PAGES = 40;

/** One PDF version, its pages drawn one after another as they are ready. */
function PdfDocument({ track, width }: { track: Track; width: number }) {
  const pages = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string | null>("Открываю…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const box = pages.current;
    if (!box || width === 0) return;
    let cancelled = false;
    let destroy: (() => void) | undefined;
    (async () => {
      try {
        const [pdfjs, bytes] = await Promise.all([
          import("pdfjs-dist"),
          api.fileBytes(track.root, track.rev, track.path),
        ]);
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        const task = pdfjs.getDocument({
          data: new Uint8Array(bytes),
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          wasmUrl: "/pdfjs/wasm/",
        });
        destroy = () => void task.destroy();
        const doc = await task.promise;
        const count = Math.min(doc.numPages, MAX_PAGES);
        box.replaceChildren();
        for (let n = 1; n <= count && !cancelled; n++) {
          const page = await doc.getPage(n);
          const natural = page.getViewport({ scale: 1 });
          const dpr = window.devicePixelRatio || 1;
          const viewport = page.getViewport({ scale: (width / natural.width) * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${width}px`;
          box.append(canvas);
          await page.render({ canvas, viewport }).promise;
        }
        if (cancelled) return;
        setStatus(
          doc.numPages > count
            ? `Показаны первые ${count} из ${doc.numPages} страниц`
            : `${doc.numPages} ${plural(doc.numPages, "страница", "страницы", "страниц")}`,
        );
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      }
    })();
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [track, width]);

  return (
    <div className="pdf-doc">
      <div className="muted pdf-label" title={track.label}>
        {track.label}
        {status && !error && <span> · {status}</span>}
      </div>
      {error && <div className="error-text">{error}</div>}
      <div ref={pages} className="pdf-pages" />
    </div>
  );
}

/** A PDF (chords, scores, contracts), or two versions side by side. */
export function PdfViewer({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      // Fix the page width once: re-rendering on every resize is costly.
      setWidth((w) => w || Math.floor((entry.contentRect.width - 12 * (tracks.length - 1)) / tracks.length));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [tracks.length]);

  return (
    <Modal title={splitPath(tracks[0].path).name} className="modal-doc" onClose={onClose}>
      <div ref={body} className={`pdf-columns ${tracks.length > 1 ? "two" : ""}`}>
        {tracks.map((t, i) => (
          <PdfDocument key={i} track={t} width={width} />
        ))}
      </div>
    </Modal>
  );
}
