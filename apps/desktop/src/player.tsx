import { convertFileSrc } from "@tauri-apps/api/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, errorText, type Analysis, type Comment } from "./api";
import { Icon } from "./ui";
import { formatDate, formatTime, isAudio, splitPath } from "./util";
import { Waveform } from "./Waveform";

/** A file version to play. `rev: null` is the file as it is on disk now. */
export interface Track {
  root: string;
  rev: string | null;
  path: string;
  /** What version this is, e.g. "Сейчас на диске" or "Версия a1b2c3d4". */
  label: string;
}

/** One track, or two for an A/B comparison. */
interface Session {
  id: number;
  tracks: Track[];
}

interface PlayerApi {
  session: Session | null;
  play: (track: Track) => void;
  compare: (a: Track, b: Track) => void;
  close: () => void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("PlayerProvider is missing");
  return ctx;
}

const sameTrack = (a: Track | undefined, b: Track) =>
  !!a && a.root === b.root && a.rev === b.rev && a.path === b.path;

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const next = useRef(0);
  const play = useCallback((track: Track) => setSession({ id: ++next.current, tracks: [track] }), []);
  const compare = useCallback((a: Track, b: Track) => setSession({ id: ++next.current, tracks: [a, b] }), []);
  const close = useCallback(() => setSession(null), []);
  return <PlayerContext.Provider value={{ session, play, compare, close }}>{children}</PlayerContext.Provider>;
}

/** Play button for audio files; renders nothing for other files. */
export function PlayButton({ track, text }: { track: Track; text?: string }) {
  const { session, play } = usePlayer();
  if (!isAudio(track.path)) return null;
  const active = session?.tracks.length === 1 && sameTrack(session.tracks[0], track);
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

/** Starts an A/B comparison of two versions of an audio file. */
export function CompareButton({ a, b }: { a: Track; b: Track }) {
  const { session, compare } = usePlayer();
  if (!isAudio(a.path) || !isAudio(b.path)) return null;
  const active =
    session?.tracks.length === 2 && sameTrack(session.tracks[0], a) && sameTrack(session.tracks[1], b);
  return (
    <button
      className={`play-btn with-text ab-btn ${active ? "active" : ""}`}
      title={`Сравнить: A — ${a.label}, B — ${b.label}`}
      onClick={(e) => {
        e.stopPropagation();
        compare(a, b);
      }}
    >
      A/B
    </button>
  );
}

export function PlayerBar() {
  const { session, close } = usePlayer();
  if (!session) return null;
  return <Player key={session.id} tracks={session.tracks} onClose={close} />;
}

// ---- the player ---------------------------------------------------------------

interface Deck {
  src: string | null;
  analysis: Analysis | null;
  analysisError: string | null;
  comments: Comment[];
  reloadComments: () => void;
}

function useDeck(track: Track | undefined): Deck {
  const [src, setSrc] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsVersion, setCommentsVersion] = useState(0);

  useEffect(() => {
    if (!track) return;
    let alive = true;
    api
      .previewFile(track.root, track.rev, track.path)
      .then((file) => alive && setSrc(convertFileSrc(file)))
      .catch((e) => alive && setAnalysisError(errorText(e)));
    // Decoding a long file takes a moment; playback does not wait for it.
    api
      .analyzeAudio(track.root, track.rev, track.path)
      .then((a) => alive && setAnalysis(a))
      .catch((e) => alive && setAnalysisError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [track]);

  useEffect(() => {
    if (!track) return;
    let alive = true;
    api
      .comments(track.root, track.rev, track.path)
      .then((c) => alive && setComments(c))
      .catch(() => alive && setComments([]));
    return () => {
      alive = false;
    };
  }, [track, commentsVersion]);

  const reloadComments = useCallback(() => setCommentsVersion((v) => v + 1), []);
  return { src, analysis, analysisError, comments, reloadComments };
}

function Player({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const ab = tracks.length === 2;
  const decks = [useDeck(tracks[0]), useDeck(tracks[1])];
  const audioA = useRef<HTMLAudioElement>(null);
  const audioB = useRef<HTMLAudioElement>(null);
  const audios = [audioA, audioB];

  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [mediaDurations, setMediaDurations] = useState([0, 0]);
  const [mediaErrors, setMediaErrors] = useState<(string | null)[]>([null, null]);
  const [matchLoudness, setMatchLoudness] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);

  const deck = decks[active];
  const track = tracks[active];
  const durationMs = deck.analysis?.durationMs || mediaDurations[active] || 0;

  // Level matching: turn the louder version down to the quieter one, so the
  // comparison is about the mix and not about "louder sounds better".
  const lufs = decks.map((d) => d.analysis?.lufs ?? null);
  const canMatch = ab && lufs[0] !== null && lufs[1] !== null;
  const gainsDb =
    canMatch && matchLoudness
      ? lufs.map((l) => Math.min(lufs[0]!, lufs[1]!) - l!)
      : [0, 0];
  useEffect(() => {
    audios.forEach((a, i) => {
      if (a.current) a.current.volume = Math.min(1, 10 ** (gainsDb[i] / 20));
    });
  });

  // Smooth progress while playing.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const a = audios[active].current;
      if (a) setPositionMs(a.currentTime * 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, active]);

  // Start playing as soon as the first version is ready.
  const autoplayed = useRef(false);
  useEffect(() => {
    if (autoplayed.current || !decks[0].src) return;
    autoplayed.current = true;
    audioA.current?.play().catch(() => setPlaying(false));
  }, [decks[0].src]);

  function toggle() {
    const a = audios[active].current;
    if (!a) return;
    if (a.paused) a.play().catch(() => setPlaying(false));
    else a.pause();
  }

  function seek(ms: number) {
    for (const a of audios) {
      if (a.current && a.current.readyState > 0) a.current.currentTime = ms / 1000;
    }
    setPositionMs(ms);
  }

  function switchTo(i: number) {
    if (!ab || i === active) return;
    const from = audios[active].current;
    const to = audios[i].current;
    if (!from || !to) return;
    const wasPlaying = !from.paused;
    if (to.readyState > 0) to.currentTime = from.currentTime;
    from.pause();
    setActive(i);
    if (wasPlaying) to.play().catch(() => setPlaying(false));
  }

  // Keyboard: Space plays/pauses, X switches A/B.
  const keys = useRef({ toggle, switchTo, active });
  keys.current = { toggle, switchTo, active };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, button, [contenteditable]")) return;
      if (e.code === "Space") {
        e.preventDefault();
        keys.current.toggle();
      } else if (e.code === "KeyX") {
        keys.current.switchTo(1 - keys.current.active);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const mediaError = mediaErrors[active];
  const unresolved = deck.comments.filter((c) => !c.resolved).length;
  return (
    <div className="player">
      {tracks.map((t, i) => (
        <audio
          key={i}
          ref={audios[i]}
          src={decks[i].src ?? undefined}
          preload="auto"
          onPlay={() => i === keys.current.active && setPlaying(true)}
          onPause={() => i === keys.current.active && setPlaying(false)}
          onEnded={() => i === keys.current.active && setPlaying(false)}
          onLoadedMetadata={(e) => {
            const ms = e.currentTarget.duration * 1000;
            setMediaDurations((d) => d.map((v, j) => (j === i && Number.isFinite(ms) ? ms : v)));
          }}
          onError={() => {
            if (i === keys.current.active) setPlaying(false);
            setMediaErrors((errs) =>
              errs.map((v, j) => (j === i ? `Система не умеет воспроизводить этот формат (${t.path.split(".").pop()})` : v)),
            );
          }}
        />
      ))}

      {panelOpen && (
        <CommentsPanel
          track={track}
          deck={deck}
          positionMs={positionMs}
          highlight={highlight}
          onSeek={seek}
          onClose={() => setPanelOpen(false)}
        />
      )}

      <div className="player-top">
        <div className="player-info">
          <div className="player-title">{splitPath(track.path).name}</div>
          <div className="player-sub">{ab ? "Сравнение версий · X — переключить" : track.label}</div>
        </div>

        {ab && (
          <div className="ab-switch">
            {tracks.map((t, i) => (
              <button key={i} className={i === active ? "active" : ""} onClick={() => switchTo(i)} title={t.label}>
                <span className="ab-letter">{i === 0 ? "A" : "B"}</span>
                <span className="ab-label">{t.label}</span>
                {lufs[i] !== null && <span className="ab-lufs">{lufs[i]!.toFixed(1)} LUFS</span>}
              </button>
            ))}
          </div>
        )}

        <div className="player-tools">
          {ab && (
            <label className="check" title="Приглушить более громкую версию до уровня тихой">
              <input
                type="checkbox"
                checked={matchLoudness}
                disabled={!canMatch}
                onChange={(e) => setMatchLoudness(e.target.checked)}
              />
              <span>
                Выровнять громкость
                {canMatch && matchLoudness && gainsDb.some((g) => g < -0.05) && (
                  <span className="muted">
                    {" "}
                    ({gainsDb[0] < gainsDb[1] ? "A" : "B"} {Math.min(...gainsDb).toFixed(1)} дБ)
                  </span>
                )}
              </span>
            </label>
          )}
          {!ab && deck.analysis?.lufs != null && (
            <span className="muted nowrap">{deck.analysis.lufs.toFixed(1)} LUFS</span>
          )}
          <button
            className={`chip ${panelOpen ? "chip-on" : ""}`}
            onClick={() => {
              setHighlight(null);
              setPanelOpen((o) => !o);
            }}
            title="Комментарии к этой версии"
          >
            <Icon name="comment" size={13} /> {unresolved > 0 ? unresolved : ""}
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть плеер">
            <Icon name="close" />
          </button>
        </div>
      </div>

      <div className="player-main">
        <button
          className="transport"
          onClick={toggle}
          disabled={!deck.src}
          aria-label={playing ? "Пауза" : "Играть"}
          title="Пробел"
        >
          <Icon name={playing ? "pause" : "play"} size={18} />
        </button>
        <span className="time">{formatTime(positionMs)}</span>
        <div className="wave-wrap">
          <Waveform
            analysis={deck.analysis}
            durationMs={durationMs}
            positionMs={positionMs}
            comments={deck.comments}
            onSeek={seek}
            onMarker={(c) => {
              seek(c.timecodeMs ?? 0);
              setHighlight(c.id);
              setPanelOpen(true);
            }}
          />
          {(mediaError || (!deck.analysis && deck.analysisError)) && (
            <div className="wave-note error-text">{mediaError ?? deck.analysisError}</div>
          )}
          {!deck.analysis && !deck.analysisError && <div className="wave-note muted">Строю волну…</div>}
        </div>
        <span className="time">{formatTime(durationMs)}</span>
      </div>
    </div>
  );
}

function CommentsPanel({
  track,
  deck,
  positionMs,
  highlight,
  onSeek,
  onClose,
}: {
  track: Track;
  deck: Deck;
  positionMs: number;
  highlight: number | null;
  onSeek: (ms: number) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [pinnedMs, setPinnedMs] = useState<number | null>(null);
  const [atTime, setAtTime] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const at = pinnedMs ?? positionMs;

  async function add() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addComment(track.root, track.rev, track.path, atTime ? Math.round(at) : null, text.trim());
      setText("");
      setPinnedMs(null);
      deck.reloadComments();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function resolve(id: number) {
    try {
      await api.resolveComment(track.root, id);
      deck.reloadComments();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="comments-panel">
      <div className="comments-head">
        <span>Комментарии · {splitPath(track.path).name}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Скрыть комментарии">
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="comments-list scroll">
        {deck.comments.length === 0 && (
          <div className="muted pad">Пока нет комментариев к этой версии. Отметьте момент в треке ниже.</div>
        )}
        {deck.comments.map((c) => (
          <div
            key={c.id}
            className={`comment ${c.resolved ? "resolved" : ""} ${c.id === highlight ? "highlight" : ""}`}
          >
            {c.timecodeMs !== null ? (
              <button className="comment-time" onClick={() => onSeek(c.timecodeMs!)}>
                {formatTime(c.timecodeMs)}
              </button>
            ) : (
              <span className="comment-time none">—</span>
            )}
            <div className="comment-body">
              <div className="comment-text">{c.text}</div>
              <div className="comment-meta">
                {c.author} · {formatDate(c.createdAt)}
                {c.resolved && " · решено"}
              </div>
            </div>
            {!c.resolved && (
              <button className="btn btn-small btn-ghost" onClick={() => resolve(c.id)} title="Отметить как решённый">
                <Icon name="check" size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="comment-form">
        <label className="check" title="Привязать комментарий к моменту в треке">
          <input type="checkbox" checked={atTime} onChange={(e) => setAtTime(e.target.checked)} />
          <span className="comment-at">{formatTime(at)}</span>
        </label>
        <input
          value={text}
          placeholder="Что услышали? Например: «бочка слишком громкая»"
          onFocus={() => setPinnedMs(positionMs)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn btn-primary btn-small" disabled={!text.trim() || busy} onClick={add}>
          Добавить
        </button>
      </div>
      {error && <div className="error-text pad">{error}</div>}
    </div>
  );
}
