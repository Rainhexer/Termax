import type { ITerminalAddon, Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
// Renderer addons reach into xterm's internals, which are not API and are not
// versioned like it: they must be kept on the release that ships alongside the
// installed @xterm/xterm (5.5.0 → canvas 0.7.0, webgl 0.18.0). Later addons
// build against unreleased xterm and fail where the internals moved — webgl
// 0.19.0 tore its renderer down through `terminal._core._store`, which 5.5.0
// does not have, so every pane hidden by a tab switch threw.
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
 *
 * One platform never gets WebGL from the automatic choice. On Linux the webview
 * is WebKitGTK, which can back a WebGL context with a software rasterizer with
 * no error to catch — context creation succeeds and the renderer string is
 * masked, so the slow path is invisible from inside the app. In practice that
 * shows up as exactly the latency you can feel in a terminal emulator: keystroke
 * echoes lag by a frame or more while the rest of the app stays smooth. The
 * automatic choice stays on the canvas renderer there, which is the responsive,
 * predictable path; users on a machine where GL really works can still pin
 * "webgl" in the settings.
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

/** The app's webview is WebKitGTK here, whose WebGL can silently land on a slow
 *  path — see the module note. The automatic choice therefore skips WebGL, and
 *  only an explicit "webgl" setting overrides that. */
const isWebkitGtk = /Linux/i.test(navigator.userAgent);

function wantsWebgl(visible: boolean): boolean {
  if (!visible || webglBroken) return false;
  if (isWebkitGtk && choice === "auto") return false;
  return choice === "auto" || choice === "webgl";
}

function load(term: Terminal, kind: "webgl" | "canvas" | "dom"): Attached {
  if (kind === "dom") return { term, addon: null, kind };
  const addon = kind === "webgl" ? new WebglAddon() : new CanvasAddon();
  term.loadAddon(addon);
  return { term, addon, kind };
}

/** Attach a non-WebGL renderer, dropping to xterm's built-in DOM renderer if
 *  even that fails. A pane that draws slowly still beats a pane that is gone. */
function loadSafely(term: Terminal, kind: "canvas" | "dom"): Attached {
  if (kind === "dom") return load(term, "dom");
  try {
    return load(term, "canvas");
  } catch (err) {
    console.error("[renderers] canvas renderer unavailable, using the DOM renderer:", err);
    return load(term, "dom");
  }
}

/** Drop a renderer, and never let its teardown escape.
 *
 *  Detaching a renderer means putting xterm's own back, which the addons do by
 *  reaching into terminal internals — so anything the installed xterm does not
 *  expose the way an addon expects surfaces here rather than at load time. This
 *  runs from a pane effect's teardown on every tab switch, where a throw takes
 *  the pane's error boundary down with it and leaves this map claiming a
 *  renderer that is already gone, so the pane never gets a working one back. */
function unload(current: Attached) {
  try {
    current.addon?.dispose();
  } catch (err) {
    console.error("[renderers] renderer teardown failed:", err);
  }
}

/** Give up a pane's GL context so another pane can have it. */
function demote(paneId: string) {
  const current = attached.get(paneId);
  if (!current || current.kind !== "webgl") return;
  unload(current);
  attached.set(paneId, loadSafely(current.term, "canvas"));
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
  if (current) unload(current);

  if (kind !== "webgl") {
    attached.set(paneId, loadSafely(term, kind));
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
      unload(next);
      attached.set(paneId, loadSafely(term, "canvas"));
    });
    attached.set(paneId, next);
  } catch (err) {
    console.warn("[renderers] WebGL unavailable, falling back to canvas:", err);
    webglBroken = true;
    releaseGlSlot(paneId);
    attached.set(paneId, loadSafely(term, "canvas"));
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
    unload(current);
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
