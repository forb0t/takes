/** Line and word diffs for comparing text versions (lyrics, notes). */

export type Op = "same" | "del" | "add";

export interface DiffLine {
  op: Op;
  text: string;
  /** Line numbers in the old and the new text (1-based), where the line exists. */
  a: number | null;
  b: number | null;
}

/** Edits beyond this make a diff meaningless (and costly); give up instead. */
const MAX_EDITS = 4000;

/**
 * Shortest edit script between `a` and `b` (Myers' O(ND) algorithm), or
 * `null` when they differ in more than {@link MAX_EDITS} items.
 */
export function diff<T>(a: T[], b: T[]): { op: Op; i: number; j: number }[] | null {
  // Common ends need no search.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const at = (x: number) => a[start + x];
  const bt = (y: number) => b[start + y];

  // trace[d][k + d + 1]: furthest x on diagonal k before step d.
  const trace: Int32Array[] = [];
  let v = new Int32Array(3);
  let found = -1;
  for (let d = 0; d <= Math.min(n + m, MAX_EDITS); d++) {
    trace.push(v);
    const next = new Int32Array(2 * d + 3);
    const get = (k: number) => (Math.abs(k) <= d - 1 || (d === 0 && k === 1) ? v[k + d] : -1);
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? get(k + 1) : get(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && at(x) === bt(y)) {
        x++;
        y++;
      }
      next[k + d + 1] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // Walk back from the end through the recorded steps.
  const ops: { op: Op; i: number; j: number }[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const prev = trace[d];
    const get = (k: number) => (Math.abs(k) <= d - 1 || (d === 0 && k === 1) ? prev[k + d] : -1);
    const k = x - y;
    const prevK = d === 0 ? 0 : k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ op: "same", i: start + x, j: start + y });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: "add", i: start + x, j: start + prevY });
      else ops.push({ op: "del", i: start + prevX, j: start + y });
    }
    x = prevX;
    y = prevY;
  }
  const head = Array.from({ length: start }, (_, i) => ({ op: "same" as Op, i, j: i }));
  const tail = Array.from({ length: a.length - endA }, (_, t) => ({
    op: "same" as Op,
    i: endA + t,
    j: endB + t,
  }));
  return [...head, ...ops.reverse(), ...tail];
}

/** Lines of `a` and `b` with what happened to each, or null if too different. */
export function diffLines(a: string, b: string): DiffLine[] | null {
  const linesA = splitLines(a);
  const linesB = splitLines(b);
  const ops = diff(linesA, linesB);
  if (!ops) return null;
  return ops.map(({ op, i, j }) =>
    op === "add"
      ? { op, text: linesB[j], a: null, b: j + 1 }
      : op === "del"
        ? { op, text: linesA[i], a: i + 1, b: null }
        : { op, text: linesA[i], a: i + 1, b: j + 1 },
  );
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Words and the spaces between them, so a changed word can be marked. */
export function diffWords(a: string, b: string): { removed: [string, boolean][]; added: [string, boolean][] } {
  const wa = a.split(/(\s+)/).filter(Boolean);
  const wb = b.split(/(\s+)/).filter(Boolean);
  const ops = diff(wa, wb) ?? [
    ...wa.map((_, i) => ({ op: "del" as Op, i, j: 0 })),
    ...wb.map((_, j) => ({ op: "add" as Op, i: 0, j })),
  ];
  const removed: [string, boolean][] = [];
  const added: [string, boolean][] = [];
  for (const { op, i, j } of ops) {
    if (op !== "add") removed.push([wa[i], op === "del"]);
    if (op !== "del") added.push([wb[j], op === "add"]);
  }
  return { removed, added };
}
