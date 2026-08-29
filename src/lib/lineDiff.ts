/**
 * Line diff, used to fold a new version of a file into a live Monaco buffer.
 *
 * `model.setValue` is the obvious way to show a file that changed on disk and
 * the wrong one while an agent is working: it throws away the undo stack, drops
 * the selection, scrolls to the top, and — the part that matters most here —
 * says nothing about *which* lines the agent touched, so there is nothing to
 * highlight. Diffing first turns "the file changed" into a handful of edits and
 * a handful of line ranges: Monaco keeps the cursor and the undo history, and
 * the ranges are what gets flashed.
 *
 * Myers, with a bounded edit distance. A wholesale rewrite (a formatter, a
 * generated file) is exactly the case where the diff is both expensive and
 * useless, so it gives up instead and lets the caller fall back to setValue.
 */

export interface LineHunk {
  /** Replaced range in the old text, as 0-based line indices, end-exclusive. */
  oldStart: number;
  oldEnd: number;
  /** Replacement range in the new text, same convention. */
  newStart: number;
  newEnd: number;
}

/** Edit distance past which the two texts are treated as unrelated. */
const MAX_D = 1500;
/** Line count past which even a small edit distance is not worth the arrays. */
const MAX_LINES = 60_000;

/** Matched line pairs between `a` and `b`, or null when the two are too far
 *  apart to diff inside the bounds above. */
function matches(a: string[], b: string[]): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_D);
  const offset = limit + 1;
  let v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m);
    }
  }
  return null;
}

/** Walk the recorded frontiers backwards, collecting the diagonal (equal-line)
 *  steps. Everything not on a diagonal is a change. */
function backtrack(
  trace: Int32Array[],
  offset: number,
  n: number,
  m: number,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const v = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  pairs.reverse();
  return pairs;
}

/** Changed regions taking `oldText` to `newText`, or null when the texts are
 *  too large or too different to be worth diffing. Empty when they are equal. */
export function lineHunks(oldText: string, newText: string): LineHunk[] | null {
  if (oldText === newText) return [];
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length + b.length > MAX_LINES) return null;

  // Common head and tail are the bulk of any agent edit; trimming them is what
  // keeps the bounded search from ever being reached on a normal file.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const pairs = matches(midA, midB);
  if (!pairs) return null;

  const hunks: LineHunk[] = [];
  let oldPos = 0;
  let newPos = 0;
  const push = (oldEnd: number, newEnd: number) => {
    if (oldEnd > oldPos || newEnd > newPos) {
      hunks.push({
        oldStart: head + oldPos,
        oldEnd: head + oldEnd,
        newStart: head + newPos,
        newEnd: head + newEnd,
      });
    }
  };
  for (const [x, y] of pairs) {
    push(x, y);
    oldPos = x + 1;
    newPos = y + 1;
  }
  push(midA.length, midB.length);
  return hunks;
}
