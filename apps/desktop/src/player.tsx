import { convertFileSrc } from "@tauri-apps/api/core";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { api, errorText } from "./api";
import { Icon } from "./ui";
import { isAudio, splitPath } from "./util";

/** A file version to play. `rev: null` is the file as it is on disk now. */
export interface Track {
  root: string;
  rev: string | null;
  path: string;
  /** What version this is, e.g. "несохранённая" or "версия a1b2c3d4". */
  label: string;
}

interface PlayerState {
  track: Track | null;
  src: string | null;
  error: string | null;
  play: (track: Track) => void;
  close: () => void;
}

const PlayerContext = createContext<PlayerState | null>(null);

function usePlayer(): PlayerState {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("PlayerProvider is missing");
  return ctx;
}

const sameTrack = (a: Track | null, b: Track) =>
  !!a && a.root === b.root && a.rev === b.rev && a.path === b.path;

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [track, setTrack] = useState<Track | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const play = useCallback((next: Track) => {
    const id = ++request.current;
    setTrack(next);
    setSrc(null);
    setError(null);
    // Stored versions are extracted to a cache file first; this can take a
    // moment for long recordings.
    api
      .previewFile(next.root, next.rev, next.path)
      .then((file) => id === request.current && setSrc(convertFileSrc(file)))
      .catch((e) => id === request.current && setError(errorText(e)));
  }, []);

  const close = useCallback(() => {
    request.current++;
    setTrack(null);
    setSrc(null);
  }, []);

  return (
    <PlayerContext.Provider value={{ track, src, error, play, close }}>{children}</PlayerContext.Provider>
  );
}

export function PlayerBar() {
  const { track, src, error, close } = usePlayer();
  if (!track) return null;
  return (
    <div className="player">
      <div className="player-icon">
        <Icon name="wave" size={18} />
      </div>
      <div className="player-info">
        <div className="player-title">{splitPath(track.path).name}</div>
        <div className="player-sub">{track.label}</div>
      </div>
      <div className="player-audio">
        {error ? (
          <span className="error-text">{error}</span>
        ) : src ? (
          <audio key={src} src={src} controls autoPlay />
        ) : (
          <span className="muted">Готовлю файл…</span>
        )}
      </div>
      <button className="icon-btn" onClick={close} aria-label="Закрыть плеер">
        <Icon name="close" />
      </button>
    </div>
  );
}

/** Play button for audio files; renders nothing for other files. */
export function PlayButton({ track, text }: { track: Track; text?: string }) {
  const { track: current, play } = usePlayer();
  if (!isAudio(track.path)) return null;
  const active = sameTrack(current, track);
  return (
    <button
      className={`play-btn ${active ? "active" : ""} ${text ? "with-text" : ""}`}
      title={`Слушать: ${track.label}`}
      onClick={(e) => {
        e.stopPropagation();
        play(track);
      }}
    >
      <Icon name="play" size={12} />
      {text && <span>{text}</span>}
    </button>
  );
}
