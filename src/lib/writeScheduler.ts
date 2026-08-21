import type { Terminal } from "@xterm/xterm";
import { ipc } from "./ipc";
import { perf } from "./perf";

/**
 * Fair, bounded delivery of PTY output into xterm instances.
 *
 * ## Why this exists
 *
 * `Terminal.write` looks like it defers its work, and it does — but only per
 * instance. xterm's `WriteBuffer` parses for up to `WRITE_TIMEOUT_MS` (12ms)
 * synchronously before it yields with a `setTimeout(0)`, and that budget is
 * spent by *each* terminal independently. Writing straight into every pane as
 * its output arrives therefore costs `panes × 12ms` of uninterruptible parsing
 * per round of the event loop, and the keystroke queued behind it waits for all
 * of it. That is the whole of the reported lag: one busy agent holds a slice
 * almost continuously, and a screenful of them holds the main thread outright.
 *
 * So output is queued here instead, and handed over under three rules:
 *
 *  - **Bounded slices.** A terminal never receives more than {@link MAX_CHUNK}
 *    at once, which caps how long its 12ms budget can actually run for.
 *  - **One slice in flight per pane.** The next slice is only handed over once
 *    `write`'s callback says the previous one was parsed, so a pane cannot
 *    queue work faster than it retires it.
 *  - **A cap on concurrent panes, visible ones first.** The pane you are
 *    looking at (and typing into) is served before the fifty that are merely
 *    running, and background panes still drain — just behind them.
 *
 * With one exception, which is the case a terminal is judged on: a small slice
 * for a pane that is on screen and has nothing queued is handed over on the
 * spot rather than a task later. That is the echo of a keystroke, and there is
 * nothing for it to be fair to — see {@link FAST_SLICE}.
 *
 * ## Backpressure
 *
 * Retired bytes are reported to the backend, which parks a pane's reader thread
 * once too many are outstanding (see `HIGH_WATERMARK` in `src-tauri/src/pty.rs`).
 * That is what makes an agent producing faster than we can draw slow *itself*
 * down, exactly as it would against a native terminal, instead of having its
 * output dropped on the floor.
 */

/** Most bytes handed to one terminal in a single `write`. Small enough that the
 *  parse it triggers stays well inside one frame, large enough that a fast
 *  producer is not carved into hundreds of slices. */
const MAX_CHUNK = 16 * 1024;

/** Panes allowed to be mid-parse at once. Above this, output waits: the point
 *  is to leave room in the frame for rendering and for input. */
const MAX_INFLIGHT = 4;

/** Of those, how many may be panes that are not on screen. Reserving the rest
 *  for visible panes is what stops fifty background agents from starving the
 *  one pane the user is typing into. */
const MAX_INFLIGHT_HIDDEN = 1;

/** Ceiling on output queued for one pane. Only reachable if a pane stops
 *  retiring writes entirely (its terminal was disposed mid-flight); the backend
 *  holds its own, larger, buffer and stops reading long before this. */
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;

/** A slice small enough that handing it over costs less than deferring it.
 *
 *  Below this, and with the pane on screen and nothing queued for it, the write
 *  happens inside the call that received the bytes. That case is the echo of a
 *  keystroke, and every hop it skips is latency a user feels directly: the
 *  deferral, and the frame xterm would otherwise wait for — `write` parses
 *  synchronously when the last thing that happened was the user typing, so
 *  reaching it in the same turn is what puts the character on screen this
 *  frame instead of the next one.
 *
 *  It cannot make the app less fair, which is the reason it is safe: the slice
 *  is counted against the same {@link MAX_INFLIGHT} budget and marks the pane
 *  in-flight exactly as a scheduled one does, so the second chunk to arrive for
 *  a pane queues normally. Only the first, on an idle pane, skips the queue. */
const FAST_SLICE = 4 * 1024;

/** How often retired byte counts are reported. Batched because each report is
 *  an IPC call, and the watermark it feeds is measured in kilobytes — reporting
 *  per slice would spend more on the accounting than on the output. */
const ACK_INTERVAL_MS = 50;

/** Report immediately once a pane has retired this much, rather than waiting
 *  out the interval.
 *
 *  The watermark exists to bound latency, so it wants to be small; the reporting
 *  interval is what stops a small watermark from also bounding *throughput*,
 *  since a parked reader cannot resume until a report lands. Reporting on volume
 *  as well as on time separates the two: a pane drawing hard is acknowledged as
 *  fast as it retires, and an idle one still costs nothing. */
const ACK_EAGER_BYTES = 64 * 1024;

/** One batch's worth of a pane's output, still to be handed over.
 *
 *  `bytes` is what the *backend* charged for this chunk — its UTF-8 length —
 *  and is what has to be acknowledged. It is carried alongside the text rather
 *  than derived from it because `text.length` counts UTF-16 units: every
 *  non-ASCII character a CLI draws (a box rule, a spinner glyph, an emoji)
 *  would under-report, the debt would creep upward, and panes would eventually
 *  sit parked against a watermark they could never get back under. */
interface Chunk {
  text: string;
  bytes: number;
}

interface Queued {
  /** Chunks waiting to be handed to the terminal, in arrival order. */
  chunks: Chunk[];
  bytes: number;
  /** A slice is with the terminal and its callback has not fired yet. */
  inflight: boolean;
  /** Whether that slice was counted against the hidden-pane budget, so it is
   *  released from the same budget however it ends. */
  inflightHidden: boolean;
  /** Bytes retired since the last report to the backend. */
  retired: number;
}

/** Everything the scheduler needs to know about a pane, supplied by the caller
 *  so this module stays independent of the terminal registry. */
export interface PaneTarget {
  term: Terminal;
  /** Whether the pane is currently mounted in the DOM. Drives priority only —
   *  a hidden pane is never starved, because its screen still has to be
   *  readable for the sidebar's status scan. */
  visible: boolean;
}

const queues = new Map<string, Queued>();
/** Panes with data queued and no slice in flight, oldest first. Kept as an
 *  array rather than derived from `queues` so the drain loop is a shift, not a
 *  scan over every pane in the workspace, with a parallel set so membership is
 *  a lookup rather than a scan of *this* list — both are on the path a hundred
 *  agents take, several times a second. */
const ready: string[] = [];
const readySet = new Set<string>();
let inflight = 0;
let inflightHidden = 0;
let draining = false;

let lookup: (paneId: string) => PaneTarget | undefined = () => undefined;

/** Tell the scheduler how to resolve a pane id. Called once, at setup. */
export function setPaneLookup(fn: (paneId: string) => PaneTarget | undefined) {
  lookup = fn;
}

function enqueueReady(paneId: string) {
  if (readySet.has(paneId)) return;
  readySet.add(paneId);
  ready.push(paneId);
}

function takeReady(): string | undefined {
  const paneId = ready.shift();
  if (paneId !== undefined) readySet.delete(paneId);
  return paneId;
}

/** Queue a pane's output. Returns immediately; the write happens later.
 *
 *  `bytes` is the chunk's length as the backend measured it (UTF-8), taken
 *  straight off the wire — see {@link Chunk}. */
export function enqueue(paneId: string, text: string, bytes: number) {
  if (!text) return;
  let queue = queues.get(paneId);
  if (!queue) {
    queue = { chunks: [], bytes: 0, inflight: false, inflightHidden: false, retired: 0 };
    queues.set(paneId, queue);
  }
  // The interactive case: this pane is on screen, it has nothing outstanding,
  // and the slice is small. Nothing is gained by making the echo of a keystroke
  // wait for a task that exists to share the thread out between panes that are
  // all busy — there is nobody to share with. See FAST_SLICE.
  if (
    !queue.inflight &&
    queue.chunks.length === 0 &&
    text.length <= FAST_SLICE &&
    inflight < MAX_INFLIGHT
  ) {
    const target = lookup(paneId);
    if (target?.visible) {
      queue.chunks.push({ text, bytes });
      queue.bytes += bytes;
      hand(paneId, queue, target);
      return;
    }
  }

  queue.chunks.push({ text, bytes });
  queue.bytes += bytes;

  // A pane this far behind has stopped retiring writes at all; the alternative
  // to dropping is unbounded growth. Oldest first, matching what the backend
  // does with its own buffer.
  while (queue.bytes > MAX_QUEUE_BYTES && queue.chunks.length > 1) {
    const dropped = queue.chunks.shift()!;
    queue.bytes -= dropped.bytes;
    // Still reported as retired: the backend is owed an acknowledgement for
    // every byte it handed over, whether or not we managed to draw it.
    queue.retired += dropped.bytes;
    perf.note("dropped", dropped.bytes);
  }

  if (!queue.inflight) enqueueReady(paneId);
  schedule();
}

/** The port {@link nextTask} posts to, built on first use. */
let hop: MessagePort | undefined;

/** Run `drain` on the next turn of the event loop.
 *
 *  `setTimeout(…, 0)` is the obvious way to yield and the wrong one here.
 *  Browsers clamp a timeout scheduled from inside a timer callback to 4ms once
 *  the chain is a few deep, and this chain is exactly that: one round per
 *  slice, for as long as any pane is behind. At {@link MAX_CHUNK} a round that
 *  turns the backend's watermark into a wall-clock delay — every byte a pane is
 *  behind is time a keystroke queued behind it waits — and it is the difference
 *  between a backlog draining in a tenth of a second and in a whole one.
 *
 *  A `MessageChannel` message is a task like any other, dispatched on the next
 *  turn with no clamp, and still a task rather than a microtask: the browser
 *  gets to render and to deliver input between rounds, which is the entire
 *  point of scheduling at all. */
function nextTask(): void {
  if (hop === undefined) {
    if (typeof MessageChannel === "undefined") {
      // No MessageChannel (a non-browser test host): the timer is correct, just
      // slower, so fall back rather than refusing to drain at all.
      setTimeout(drain, 0);
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => drain();
    hop = channel.port2;
  }
  hop.postMessage(0);
}

function schedule() {
  if (draining || !ready.length || inflight >= MAX_INFLIGHT) return;
  draining = true;
  nextTask();
}

/** Hand out as many slices as the concurrency rules allow. */
function drain() {
  draining = false;
  const started = performance.now();

  // Visible panes first, and each pane's target resolved exactly once: this
  // runs many times a second with every pane in the workspace on the list, so
  // a lookup per comparison would be the expensive part of the round.
  const targets = new Map<string, PaneTarget | undefined>();
  for (const paneId of ready) targets.set(paneId, lookup(paneId));
  ready.sort(
    (a, b) => Number(targets.get(b)?.visible ?? false) - Number(targets.get(a)?.visible ?? false),
  );

  let skipped: string[] | null = null;
  let handed = 0;
  while (ready.length && inflight < MAX_INFLIGHT) {
    const paneId = takeReady()!;
    const queue = queues.get(paneId);
    if (!queue || !queue.chunks.length) continue;

    const target = targets.get(paneId);
    if (!target) {
      // The pane was closed while its output was queued: nothing can draw it,
      // but the backend is still owed the acknowledgement.
      queue.retired += queue.bytes;
      queue.chunks.length = 0;
      queue.bytes = 0;
      continue;
    }

    if (!target.visible && inflightHidden >= MAX_INFLIGHT_HIDDEN) {
      // Its turn will come once a visible pane retires; hold it aside rather
      // than re-queueing, or the loop spins on the same pane forever.
      (skipped ??= []).push(paneId);
      continue;
    }

    hand(paneId, queue, target);
    handed++;
  }
  for (const paneId of skipped ?? []) enqueueReady(paneId);

  perf.note("drainMs", performance.now() - started);
  // Only come back if this round actually made progress. A round where every
  // ready pane was held for the hidden-pane cap would otherwise reschedule
  // itself immediately and spin — burning exactly the main-thread time this
  // scheduler exists to protect. The retire that frees the cap calls
  // `schedule` itself, so nothing is left stranded; `inflight === 0` is only a
  // safety valve for a state that should be unreachable.
  if (ready.length && (handed > 0 || inflight === 0)) schedule();
}

/** Give back the concurrency a pane's in-flight slice was holding. Safe to call
 *  on a pane that has none. */
function release(queue: Queued) {
  if (!queue.inflight) return;
  queue.inflight = false;
  inflight--;
  if (queue.inflightHidden) inflightHidden--;
  queue.inflightHidden = false;
}

/** Give one bounded slice to a terminal and wait for it to be parsed. */
function hand(paneId: string, queue: Queued, target: PaneTarget) {
  const slice = takeSlice(queue);
  if (!slice.text) return;

  queue.inflight = true;
  queue.inflightHidden = !target.visible;
  inflight++;
  if (queue.inflightHidden) inflightHidden++;

  const retire = () => {
    // Already released — the pane was forgotten while this slice was with its
    // terminal, and xterm called back anyway. Counting it twice would drive the
    // budget negative and let the scheduler hand out more than MAX_INFLIGHT.
    if (!queue.inflight) return;
    release(queue);
    queue.retired += slice.bytes;
    // A pane far enough behind that its reader may be parked is reported at
    // once; see ACK_EAGER_BYTES. Everything else rides the interval.
    if (queue.retired >= ACK_EAGER_BYTES) flushAcks();
    if (queue.chunks.length) enqueueReady(paneId);
    schedule();
  };

  try {
    target.term.write(slice.text, retire);
  } catch (err) {
    // A terminal disposed between the lookup and the write. Retire the slice so
    // the pane's accounting — and the backend's watermark — do not stick.
    console.error(`[writeScheduler] write failed for pane ${paneId}:`, err);
    retire();
  }
}

/** Pull up to {@link MAX_CHUNK} off the front of a queue.
 *
 *  Whole chunks are preferred; one larger than the cap is split. The split is
 *  by UTF-16 code unit and can land inside a surrogate pair or an escape
 *  sequence, which is harmless: xterm's parser is a state machine across
 *  writes, so the halves reassemble exactly as two PTY reads would.
 *
 *  A split chunk contributes nothing to `bytes` until its final piece is taken,
 *  which is what keeps the acknowledged total exactly equal to what the backend
 *  charged without having to measure a slice's UTF-8 length. */
function takeSlice(queue: Queued): { text: string; bytes: number } {
  if (!queue.chunks.length) return { text: "", bytes: 0 };

  const first = queue.chunks[0];
  if (first.text.length > MAX_CHUNK) {
    const head = first.text.slice(0, MAX_CHUNK);
    first.text = first.text.slice(MAX_CHUNK);
    return { text: head, bytes: 0 };
  }

  let length = 0;
  let bytes = 0;
  let taken = 0;
  while (taken < queue.chunks.length && length + queue.chunks[taken].text.length <= MAX_CHUNK) {
    length += queue.chunks[taken].text.length;
    bytes += queue.chunks[taken].bytes;
    taken++;
  }
  const text =
    taken === 1 ? first.text : queue.chunks.slice(0, taken).map((c) => c.text).join("");
  queue.chunks.splice(0, taken);
  queue.bytes -= bytes;
  return { text, bytes };
}

/** Account for bytes that will never be drawn — a pane the frontend does not
 *  know about — so the backend's watermark is still released. */
export function discard(paneId: string, bytes: number) {
  const queue = queues.get(paneId);
  if (queue) queue.retired += bytes;
  else
    queues.set(paneId, {
      chunks: [],
      bytes: 0,
      inflight: false,
      inflightHidden: false,
      retired: bytes,
    });
}

/** Forget a pane. Its outstanding bytes are still reported, or the backend
 *  would keep its reader parked against a debt nobody can settle. */
export function forget(paneId: string) {
  const queue = queues.get(paneId);
  if (!queue) return;
  // A slice handed to a terminal that is about to be disposed will never be
  // reported back: xterm drops the pending callbacks of a `write` when it is
  // disposed. Released here instead, or the budget it holds is lost for good —
  // and after MAX_INFLIGHT panes closed mid-write the scheduler would stop
  // handing anything to anyone, freezing every pane's output.
  release(queue);
  queue.retired += queue.bytes;
  queue.chunks.length = 0;
  queue.bytes = 0;
  if (readySet.delete(paneId)) {
    const at = ready.indexOf(paneId);
    if (at !== -1) ready.splice(at, 1);
  }
  // Kept in `queues` until the next report so the final acknowledgement is
  // sent; `flushAcks` drops it afterwards.
}

/** Bytes queued for a pane but not yet drawn. Exposed for the perf readout. */
export function queueDepth(): { panes: number; bytes: number } {
  let bytes = 0;
  for (const queue of queues.values()) bytes += queue.bytes;
  return { panes: queues.size, bytes };
}

let ackTimer: ReturnType<typeof setInterval> | undefined;

function flushAcks() {
  const acks: { paneId: string; bytes: number }[] = [];
  for (const [paneId, queue] of queues) {
    if (queue.retired > 0) {
      acks.push({ paneId, bytes: queue.retired });
      queue.retired = 0;
    }
    // A pane that is gone and fully settled has nothing left to track.
    if (!queue.chunks.length && !queue.inflight && queue.retired === 0 && !lookup(paneId)) {
      queues.delete(paneId);
    }
  }
  if (!acks.length) return;
  perf.note("acked", acks.length);
  ipc.ackPtyOutput(acks).catch(() => {
    // A failed report only means the pane's reader parks until the next one; it
    // must never take the scheduler down with it.
  });
}

/** Start reporting retired bytes. Idempotent. */
export function startAcks() {
  ackTimer ??= setInterval(flushAcks, ACK_INTERVAL_MS);
}

/** Scheduler bookkeeping, for the diagnostics log. A queue lingers for one ack
 *  interval after its pane is forgotten and is then dropped, so `queues` should
 *  track the number of open panes. */
export function diagCounts(): Record<string, number> {
  const depth = queueDepth();
  return {
    queues: depth.panes,
    queuedBytes: depth.bytes,
    queuesReady: ready.length,
    queuesInflight: inflight,
  };
}
