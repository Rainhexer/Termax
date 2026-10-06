/**
 * Counters for the terminal hot path, so the next "it feels slow" report can
 * carry numbers.
 *
 * Everything here is an integer add on a plain object — cheap enough to leave
 * on in release builds, which matters because the interesting case is a real
 * session with real agents, not a synthetic one.
 *
 * Read it from the devtools console:
 *
 *     __termaxPerf()          // totals and rates since the last reset
 *     __termaxPerf(true)      // …and reset the window
 *
 * The three latency counters — {@link Counters.lateMs}, {@link Counters.frameMs}
 * and {@link Counters.ipcMs} — are what a user actually feels, and they are the
 * only ones that can tell the three candidate causes of "it got slow" apart:
 *
 *  - the main thread is busy → event-loop lateness climbs;
 *  - drawing is slow → frame interval climbs while lateness stays flat;
 *  - the IPC bridge has degraded → round-trip time climbs while both of the
 *    others stay flat.
 *
 * The first two need a monitor running, which costs a timer and a rAF chain, so
 * they are started only by {@link startMonitors} (see diag.ts).
 */

interface Counters {
  /** Batches received from the backend. */
  batches: number;
  /** Bytes of decoded terminal output received. */
  bytes: number;
  /** Panes named across those batches (so, bytes/pane ratios). */
  paneChunks: number;
  /** Bytes dropped because a pane's queue overflowed. Should stay at zero;
   *  anything else means the webview fell behind the backend's watermark. */
  dropped: number;
  /** Acknowledgement reports sent back to the backend. */
  acked: number;
  /** Total time spent handing slices to terminals. */
  drainMs: number;
  /** Worst single drain, which is what a keystroke can end up waiting behind. */
  worstDrainMs: number;
  /** Time spent decoding batches off the wire. */
  decodeMs: number;

  /** IPC calls issued, and the wall time they took to come back. Counted for
   *  every `invoke`, because the volume is itself a suspect: each one is a
   *  `fetch` across the webview's process boundary. */
  invokes: number;
  ipcMs: number;
  worstIpcMs: number;

  /** The same, for `write_pty` alone — the call a keystroke makes. Separated
   *  because the average over every command is not a latency anyone feels: it
   *  is dominated by the handful that do real work (a `git status`, a directory
   *  read), and those say nothing about how the terminal responds. */
  writes: number;
  writeMs: number;
  worstWriteMs: number;

  /** Event-loop lateness: how much later than asked a fixed-period timer
   *  actually ran. This is main-thread contention measured directly — the
   *  keystroke queued behind the same work waits exactly as long. */
  lateSamples: number;
  lateMs: number;
  worstLateMs: number;
  /** Lateness samples over {@link JANK_MS}, i.e. hitches a user notices. */
  janks: number;

  /** Frame intervals, from a rAF chain. 16.7 on an idle 60Hz display. */
  frames: number;
  frameMs: number;
  worstFrameMs: number;
}

function empty(): Counters {
  return {
    batches: 0,
    bytes: 0,
    paneChunks: 0,
    dropped: 0,
    acked: 0,
    drainMs: 0,
    worstDrainMs: 0,
    decodeMs: 0,
    invokes: 0,
    ipcMs: 0,
    worstIpcMs: 0,
    writes: 0,
    writeMs: 0,
    worstWriteMs: 0,
    lateSamples: 0,
    lateMs: 0,
    worstLateMs: 0,
    janks: 0,
    frames: 0,
    frameMs: 0,
    worstFrameMs: 0,
  };
}

let counters = empty();
let since = performance.now();

type Counter =
  | "batches"
  | "bytes"
  | "paneChunks"
  | "dropped"
  | "acked"
  | "drainMs"
  | "decodeMs"
  | "invokes"
  | "ipcMs"
  | "writes"
  | "writeMs";

export const perf = {
  note(key: Counter, n: number) {
    counters[key] += n;
    // The drain is the number that matters most — it is what a keystroke can
    // end up queued behind — so it is tracked at its worst, not only summed.
    if (key === "drainMs" && n > counters.worstDrainMs) counters.worstDrainMs = n;
    if (key === "ipcMs" && n > counters.worstIpcMs) counters.worstIpcMs = n;
    if (key === "writeMs" && n > counters.worstWriteMs) counters.worstWriteMs = n;
  },
  reset() {
    counters = empty();
    since = performance.now();
  },
  report() {
    const seconds = (performance.now() - since) / 1000 || 1;
    const avg = (total: number, n: number) => (n ? Number((total / n).toFixed(2)) : 0);
    return {
      windowSeconds: Number(seconds.toFixed(1)),
      batchesPerSecond: Math.round(counters.batches / seconds),
      kbPerSecond: Math.round(counters.bytes / seconds / 1024),
      bytesPerBatch: counters.batches ? Math.round(counters.bytes / counters.batches) : 0,
      panesPerBatch: counters.batches
        ? Number((counters.paneChunks / counters.batches).toFixed(2))
        : 0,
      droppedBytes: counters.dropped,
      ackReports: counters.acked,
      drainMsPerSecond: Number((counters.drainMs / seconds).toFixed(1)),
      worstDrainMs: Number(counters.worstDrainMs.toFixed(2)),
      decodeMsPerSecond: Number((counters.decodeMs / seconds).toFixed(1)),
      invokesPerSecond: Math.round(counters.invokes / seconds),
      ipcMs: avg(counters.ipcMs, counters.invokes),
      worstIpcMs: Number(counters.worstIpcMs.toFixed(2)),
      writesPerSecond: Math.round(counters.writes / seconds),
      writeMs: avg(counters.writeMs, counters.writes),
      worstWriteMs: Number(counters.worstWriteMs.toFixed(2)),
      lateMs: avg(counters.lateMs, counters.lateSamples),
      worstLateMs: Number(counters.worstLateMs.toFixed(2)),
      janksPerSecond: Number((counters.janks / seconds).toFixed(2)),
      frameMs: avg(counters.frameMs, counters.frames),
      worstFrameMs: Number(counters.worstFrameMs.toFixed(2)),
    };
  },
};

/** Period of the lateness probe. Short enough to catch a hitch, long enough
 *  that the probe is not itself a contributor. */
const PROBE_MS = 250;
/** Lateness a user perceives as the app "stopping". */
const JANK_MS = 100;

let monitoring = false;

/** Start the event-loop and frame monitors. Idempotent, and deliberately not
 *  automatic: a permanent rAF chain keeps the compositor awake, which is not
 *  something an ordinary run should pay for. */
export function startMonitors() {
  if (monitoring || typeof window === "undefined") return;
  monitoring = true;

  let expected = performance.now() + PROBE_MS;
  setInterval(() => {
    const now = performance.now();
    const late = Math.max(0, now - expected);
    expected = now + PROBE_MS;
    counters.lateSamples++;
    counters.lateMs += late;
    if (late > counters.worstLateMs) counters.worstLateMs = late;
    if (late > JANK_MS) counters.janks++;
  }, PROBE_MS);

  let last = performance.now();
  const frame = (now: number) => {
    const delta = now - last;
    last = now;
    counters.frames++;
    counters.frameMs += delta;
    if (delta > counters.worstFrameMs) counters.worstFrameMs = delta;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Queue depth is owned by the scheduler; it registers a reader here so the
 *  console report can include it without this module importing it (which would
 *  be a cycle, since the scheduler reports into `perf`). */
let depth: () => { panes: number; bytes: number } = () => ({ panes: 0, bytes: 0 });

export function setQueueDepthSource(fn: () => { panes: number; bytes: number }) {
  depth = fn;
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__termaxPerf = (reset = false) => {
    const report = { ...perf.report(), queued: depth() };
    if (reset) perf.reset();
    return report;
  };
}
