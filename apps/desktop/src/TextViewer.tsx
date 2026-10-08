import { useEffect, useMemo, useState } from "react";
import { api, errorText, type TextFile } from "./api";
import { diffLines, diffWords, type DiffLine } from "./diff";
import type { Track } from "./player";
import { Modal } from "./ui";
import { plural, splitPath } from "./util";

/** Unchanged lines kept around each change; longer runs fold away. */
const CONTEXT = 3;

type Row =
  | { kind: "line"; line: DiffLine; words?: [string, boolean][] }
  | { kind: "fold"; lines: DiffLine[] };

/** Diff lines with long unchanged runs folded and changed words marked. */
function rows(lines: DiffLine[]): Row[] {
  const out: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].op === "same") {
      let j = i;
      while (j < lines.length && lines[j].op === "same") j++;
      const run = lines.slice(i, j);
      const keepStart = i === 0 ? 0 : CONTEXT;
      const keepEnd = j === lines.length ? 0 : CONTEXT;
      if (run.length > keepStart + keepEnd + 1) {
        run.slice(0, keepStart).forEach((line) => out.push({ kind: "line", line }));
        out.push({ kind: "fold", lines: run.slice(keepStart, run.length - keepEnd) });
        run.slice(run.length - keepEnd).forEach((line) => out.push({ kind: "line", line }));
      } else {
        run.forEach((line) => out.push({ kind: "line", line }));
      }
      i = j;
      continue;
    }
    // A block of removed lines followed by added ones: pair them up and
    // mark the words that differ, which is what matters in lyrics.
    let j = i;
    while (j < lines.length && lines[j].op === "del") j++;
    let k = j;
    while (k < lines.length && lines[k].op === "add") k++;
    const removed = lines.slice(i, j);
    const added = lines.slice(j, k);
    const paired = Math.min(removed.length, added.length);
    const marks = removed.slice(0, paired).map((r, n) => diffWords(r.text, added[n].text));
    removed.forEach((line, n) => out.push({ kind: "line", line, words: marks[n]?.removed }));
    added.forEach((line, n) => out.push({ kind: "line", line, words: marks[n]?.added }));
    i = Math.max(k, i + 1);
  }
  return out;
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const list = useMemo(() => rows(lines), [lines]);
  const line = (l: DiffLine, words: [string, boolean][] | undefined, key: string | number) => (
    <div key={key} className={`diff-line diff-${l.op}`}>
      <span className="diff-num">{l.a ?? ""}</span>
      <span className="diff-num">{l.b ?? ""}</span>
      <span className="diff-sign">{l.op === "add" ? "+" : l.op === "del" ? "−" : ""}</span>
      <span className="diff-text">
        {words ? words.map(([w, changed], i) => (changed ? <mark key={i}>{w}</mark> : w)) : l.text || " "}
      </span>
    </div>
  );
  return (
    <div className="diff">
      {list.map((row, i) =>
        row.kind === "line" ? (
          line(row.line, row.words, i)
        ) : open.has(i) ? (
          row.lines.map((l, j) => line(l, undefined, `${i}-${j}`))
        ) : (
          <button key={i} className="diff-fold" onClick={() => setOpen((s) => new Set(s).add(i))}>
            … {row.lines.length} {plural(row.lines.length, "строка", "строки", "строк")} без изменений
          </button>
        ),
      )}
    </div>
  );
}

/** A text file (lyrics, notes), or what changed between two versions. */
export function TextViewer({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const [texts, setTexts] = useState<TextFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all(tracks.map((t) => api.textFile(t.root, t.rev, t.path)))
      .then((t) => alive && setTexts(t))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [tracks]);

  const lines = useMemo(
    () => (texts && texts.length === 2 ? diffLines(texts[0].text, texts[1].text) : undefined),
    [texts],
  );
  const added = lines?.filter((l) => l.op === "add").length ?? 0;
  const removed = lines?.filter((l) => l.op === "del").length ?? 0;
  const truncated = texts?.some((t) => t.truncated);

  return (
    <Modal title={splitPath(tracks[0].path).name} className="modal-doc" onClose={onClose}>
      {tracks.length === 2 ? (
        <div className="text-compare-head">
          <span>
            <b className="diff-del-mark">−</b> {tracks[0].label}
          </span>
          <span>
            <b className="diff-add-mark">+</b> {tracks[1].label}
          </span>
          {lines && (
            <span className="muted">
              {added === 0 && removed === 0
                ? "Текст не изменился"
                : `+${added} −${removed} ${plural(added + removed, "строка", "строки", "строк")}`}
            </span>
          )}
        </div>
      ) : (
        <div className="muted">{tracks[0].label}</div>
      )}
      {error && <div className="error-text">{error}</div>}
      {!texts && !error && <div className="muted">Открываю…</div>}
      {truncated && <div className="hint">Файл большой: показано только его начало.</div>}
      {texts && tracks.length === 1 && <pre className="text-view">{texts[0].text}</pre>}
      {lines === null && <div className="notice">Версии слишком разные, чтобы сравнить их построчно.</div>}
      {lines && <DiffView lines={lines} />}
    </Modal>
  );
}
