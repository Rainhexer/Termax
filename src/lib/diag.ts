import { get } from "svelte/store";
import { ipc } from "./ipc";
import { perf, startMonitors } from "./perf";
import * as terminals from "./terminals";
import * as renderers from "./renderers";
import * as scheduler from "./writeScheduler";
import * as cliStatus from "./cliStatus";
import * as agentFiles from "./agentFiles";
import { attentionPanes, bellPanes } from "./bell";
import { tabs, vaultRuns, gitByRoot } from "./stores";

/**
 * Periodic snapshot of everything in the frontend that is keyed by pane, tab or
 * root, written to `<app data dir>/diag.log` by the backend (see diag.rs).
 *
 * The failure this exists for is a slow one: the app grows choppier over a
 * working day of opening panes and closing them again, and is fine after a
 * restart with the very same layout. That shape — cost that survives the pane
 * it belongs to — is a leak, and the only way to name it is to watch every
 * candidate counter across hours rather than guess at a moment. Each count
 * below should track the number of panes currently open; the one that climbs
 * past that instead is the answer.
 *
 * Off unless `TERMAX_DIAG` is set in the environment, so a normal run pays
 * nothing for it:
 *
 *     TERMAX_DIAG=1 termax
 */

const SAMPLE_MS = 30_000;

/** DOM counts. A disposed terminal takes its element subtree with it, so these
 *  are what catch a pane whose xterm outlived its component: canvases are the
 *  expensive part (the renderer keeps several per terminal, each the size of
 *  the pane), and `.xterm` roots are one per live terminal. */
function domCounts(): Record<string, number> {
  return {
    domNodes: document.getElementsByTagName("*").length,
    domCanvases: document.getElementsByTagName("canvas").length,
    domXterms: document.querySelectorAll(".xterm").length,
    domTextareas: document.getElementsByTagName("textarea").length,
    domDetachedHosts: document.querySelectorAll("[data-pane-id]").length,
  };
}

function storeCounts(): Record<string, number> {
  return {
    tabs: get(tabs).length,
    bellPanes: get(bellPanes).size,
    attentionPanes: get(attentionPanes).size,
    vaultRuns: get(vaultRuns).size,
    gitRoots: get(gitByRoot).size,
  };
}

function sample(): string {
  const counts: Record<string, number> = {
    ...terminals.diagCounts(),
    ...renderers.diagCounts(),
    ...scheduler.diagCounts(),
    ...cliStatus.diagCounts(),
    ...agentFiles.diagCounts(),
    ...storeCounts(),
    ...domCounts(),
  };
  // Rates since the last sample, so a line describes its own window rather than
  // the whole session.
  const report = perf.report();
  perf.reset();
  const fields = Object.entries(counts).map(([key, value]) => `${key}=${value}`);
  for (const [key, value] of Object.entries(report)) fields.push(`${key}=${value}`);
  fields.push(`glRenderer=${renderers.diagDriver()}`);
  fields.push(`uptimeS=${Math.round(performance.now() / 1000)}`);
  return fields.join(" ");
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Start sampling, if the backend says diagnostics are on. Idempotent. */
export async function initDiag() {
  if (timer) return;
  if (!(await ipc.diagEnabled().catch(() => false))) return;
  startMonitors();
  timer = setInterval(() => {
    ipc.diagSample(sample()).catch(() => {
      // A failed sample is a missing line in a log, and nothing more.
    });
  }, SAMPLE_MS);
  // One line straight away, so the log has a baseline to compare against.
  void ipc.diagSample(sample()).catch(() => {});
}

if (typeof window !== "undefined") {
  // Reachable from a dev build's console, and from an `initDiag` that decided
  // not to run: `__termaxDiag()` returns the same line the log would get.
  (window as unknown as Record<string, unknown>).__termaxDiag = sample;
}
