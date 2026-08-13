import type { ITerminalAddon, Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebglAddon } from "@xterm/addon-webgl";

/**
 * Which renderer each pane draws with, and how the WebGL ones are rationed.
 *
 * xterm ships three: a DOM renderer (slowest, always available), a canvas 2D
 * renderer, and a WebGL one that is markedly faster for the full-screen redraws
 * a coding CLI does constantly. WebGL cannot simply be given to every pane —
 * a browser keeps only a handful of live GL contexts and silently drops the
 * oldest when the limit is passed, which shows up as panes going blank. So
 * contexts are a pool: visible panes take one, most-recently-focused first, and
 * everything else uses canvas.
 *
 * The pane you are working in is the one whose redraw latency you can feel, so
 * the eviction order is by focus rather than by age.
 */

/** Live GL contexts to allow. WebKit's ceiling is around sixteen and hitting it
 *  loses contexts silently, so this stays well under it — a screenful of panes
 *  you can actually read is a handful, not a dozen. */
const MAX_WEBGL = 6;

export type RendererChoice = "auto" | "webgl" | "canvas" | "dom";

interface Attached {
  term: Terminal;
  addon: ITerminalAddon | null;
  kind: "webgl" | "canvas" | "dom";
}

const attached = new Map<string, Attached>();
/** Pane ids holding a GL context, least-recently-focused first. */
const glOrder: string[] = [];
/** Set once WebGL has failed, so a machine without working GL (a VM, a driver
 *  WebKit refuses) stops paying for a failed context creation per pane. */
let webglBroken = false;
let choice: RendererChoice = "auto";

function wantsWebgl(visible: boolean): boolean {
  if (!visible || webglBroken) return false;
  return choice === "auto" || choice === "webgl";
}

function load(term: Terminal, kind: "webgl" | "canvas" | "dom"): Attached {
  if (kind === "dom") return { term, addon: null, kind };
  const addon = kind === "webgl" ? new WebglAddon() : new CanvasAddon();
  term.loadAddon(addon);
  return { term, addon, kind };
}

/** Give up a pane's GL context so another pane can have it. */
function demote(paneId: string) {
  const current = attached.get(paneId);
  if (!current || current.kind !== "webgl") return;
  current.addon?.dispose();
  attached.set(paneId, load(current.term, "canvas"));
  const at = glOrder.indexOf(paneId);
  if (at !== -1) glOrder.splice(at, 1);
}

/**
 * Attach the right renderer for a pane's current state. Safe to call again on
 * every show, focus and setting change: it only does work when the choice
 * actually changes.
 */
export function apply(paneId: string, term: Terminal, visible: boolean) {
  const current = attached.get(paneId);
  let kind: "webgl" | "canvas" | "dom";
  if (choice === "dom") {
    kind = "dom";
  } else if (choice === "canvas") {
    kind = "canvas";
  } else if (wantsWebgl(visible) && (current?.kind === "webgl" || takeGlSlot(paneId))) {
    kind = "webgl";
  } else {
    kind = "canvas";
  }

  if (current?.kind === kind) return;
  if (current?.kind === "webgl") releaseGlSlot(paneId);
  current?.addon?.dispose();

  if (kind !== "webgl") {
    attached.set(paneId, load(term, kind));
    return;
  }

  // Context creation is the one step that can fail on the user's machine
  // rather than in our logic (no GPU, a blocklisted driver, an exhausted
  // pool). Fall back to canvas for this pane and stop trying for the rest.
  try {
    const next = load(term, "webgl") as Attached & { addon: WebglAddon };
    next.addon.onContextLoss(() => {
      // The context can still be lost later — on a GPU reset, or when the
      // browser reclaims it. Left alone the pane simply stops painting.
      releaseGlSlot(paneId);
      next.addon.dispose();
      attached.set(paneId, load(term, "canvas"));
    });
    attached.set(paneId, next);
  } catch (err) {
    console.warn("[renderers] WebGL unavailable, falling back to canvas:", err);
    webglBroken = true;
    releaseGlSlot(paneId);
    attached.set(paneId, load(term, "canvas"));
  }
}

/** Claim a GL context, evicting the least-recently-focused holder if the pool
 *  is full. Returns false only when this pane is itself the eviction candidate. */
function takeGlSlot(paneId: string): boolean {
  if (glOrder.includes(paneId)) return true;
  if (glOrder.length >= MAX_WEBGL) {
    const victim = glOrder[0];
    if (victim === paneId) return false;
    demote(victim);
  }
  glOrder.push(paneId);
  return true;
}

function releaseGlSlot(paneId: string) {
  const at = glOrder.indexOf(paneId);
  if (at !== -1) glOrder.splice(at, 1);
}

/** Move a pane to the front of the eviction queue. */
export function noteFocus(paneId: string) {
  const at = glOrder.indexOf(paneId);
  if (at === -1) return;
  glOrder.splice(at, 1);
  glOrder.push(paneId);
}

/** Drop a pane's renderer. The addon is disposed with the terminal anyway, but
 *  releasing the slot promptly is what lets the next visible pane have it. */
export function release(paneId: string) {
  const current = attached.get(paneId);
  if (!current) return;
  if (current.kind === "webgl") {
    releaseGlSlot(paneId);
    current.addon?.dispose();
  }
  attached.delete(paneId);
}

/** Apply a changed `terminal.renderer` setting to every attached pane. */
export function setChoice(next: RendererChoice, isVisible: (paneId: string) => boolean) {
  if (next === choice) return;
  choice = next;
  // Snapshot first: `apply` mutates the map as it demotes and promotes.
  for (const [paneId, current] of [...attached]) {
    apply(paneId, current.term, isVisible(paneId));
  }
}

/** What each pane is actually drawing with, for the perf readout. */
export function summary(): Record<string, number> {
  const counts: Record<string, number> = { webgl: 0, canvas: 0, dom: 0 };
  for (const current of attached.values()) counts[current.kind]++;
  return counts;
}
