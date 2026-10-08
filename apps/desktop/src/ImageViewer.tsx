import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import type { Track } from "./player";
import { Modal } from "./ui";
import { splitPath } from "./util";

/** The web view's URL for a file version (`rev: null` = the file on disk). */
function useImage(track: Track | undefined): { src: string | null; error: string | null } {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!track) return;
    let alive = true;
    api
      .previewFile(track.root, track.rev, track.path)
      .then((file) => alive && setSrc(convertFileSrc(file)))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [track]);
  return { src, error };
}

/** One image, or two versions with a slider ("curtain") between them. */
export function ImageViewer({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const a = useImage(tracks[0]);
  const b = useImage(tracks[1]);
  const [split, setSplit] = useState(50);
  const ab = tracks.length === 2;
  const error = a.error ?? b.error;

  function drag(e: React.PointerEvent<HTMLDivElement>) {
    if (e.type === "pointermove" && e.buttons !== 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setSplit(Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)));
  }

  return (
    <Modal title={splitPath(tracks[0].path).name} wide onClose={onClose}>
      {error && <div className="error-text">{error}</div>}
      {!ab ? (
        <div className="image-view">
          <div className="muted">{tracks[0].label}</div>
          {a.src && <img src={a.src} alt={tracks[0].label} />}
        </div>
      ) : (
        <>
          <div className="image-compare-labels">
            <span>
              <b>A</b> {tracks[0].label}
            </span>
            <span>
              {tracks[1].label} <b>B</b>
            </span>
          </div>
          <div
            className="image-compare"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drag(e);
            }}
            onPointerMove={drag}
          >
            {b.src && <img src={b.src} alt={tracks[1].label} draggable={false} />}
            {a.src && (
              <img
                className="image-top"
                src={a.src}
                alt={tracks[0].label}
                draggable={false}
                style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
              />
            )}
            <div className="image-split" style={{ left: `${split}%` }} />
          </div>
          <div className="muted">Потяните по картинке, чтобы сдвинуть шторку.</div>
        </>
      )}
    </Modal>
  );
}
