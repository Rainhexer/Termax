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
  };
}

let counters = empty();
let since = performance.now();

type Counter = "batches" | "bytes" | "paneChunks" | "dropped" | "acked" | "drainMs" | "decodeMs";

export const perf = {
  note(key: Counter, n: number) {
    counters[key] += n;
    // The drain is the number that matters most — it is what a keystroke can
    // end up queued behind — so it is tracked at its worst, not only summed.
    if (key === "drainMs" && n > counters.worstDrainMs) counters.worstDrainMs = n;
  },
  reset() {
    counters = empty();
    since = performance.now();
  },
  report() {
    const seconds = (performance.now() - since) / 1000 || 1;
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
    };
  },
};

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
