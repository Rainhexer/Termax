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
 * no error to catch, and a software WebGL renderer is slower than the canvas
 * one. That was reported here as exactly the latency you can feel in a terminal
 * emulator, so the automatic choice stays on canvas; users on a machine where GL
 * really works can still pin "webgl" in the settings.
 *
 * That rule is a guess, and it is worth saying which parts of it have since been
 * checked. Measured on an Intel iGPU under Wayland, at four panes redrawing
 * 25 KB/s, WebGL and canvas came out within noise of each other — so the rule is
 * not currently costing anything measurable here, and it is also not earning
 * anything. What it rests on — "GL on this machine is a software rasterizer" —
 * is now at least askable rather than assumed: {@link probeGl} reports the driver
 * behind a context into the diagnostics log (`glRenderer`), alongside a count of
 * which renderer each pane actually got. A heavier workload than the one above,
 * on a machine whose log names a real GPU, is what would settle it; until then
 * the conservative rule stands rather than being flipped on a hunch.
 *
 * ## Atlas memory
 *
 * Both renderers draw from a glyph atlas: a set of canvases caching every
 * distinct glyph + foreground + background ever drawn. xterm never gives that
 * memory back while a renderer is attached, and nothing in it bounds the total:
 *
 *  - entries are never evicted, and `clearTextureAtlas` wipes pages but keeps
 *    them, so the only way to shrink an atlas is to dispose it;
 *  - the canvas renderer has no page limit at all, because `maxAtlasPages` is
 *    only ever assigned by the WebGL renderer;
 *  - the WebGL limit counts pages rather than bytes. At the limit pages merge
 *    four into one at double the width, up to the GPU's maximum texture size,
 *    and each doubling quadruples the page.
 *
 * A coding CLI animating in truecolor mints new colour combinations for as long
 * as it runs, so the atlas climbs for the life of the session: measured on macOS
 * at gigabytes in the web process, until the system kills it. {@link ATLAS_BUDGET}
 * is the bound xterm does not have. Going over it recycles every renderer of that
 * kind, which disposes the atlas; what is on screen is simply rasterized again.
 */

/** Live GL contexts to allow. WebKit's ceiling is around sixteen and hitting it
 *  loses contexts silently, so this stays well under it — a screenful of panes
 *  you can actually read is a handful, not a dozen. */
const MAX_WEBGL = 6;

/** Most bytes of atlas canvas to hold per renderer kind before recycling.
 *
 *  Ordinary terminal output is a few megabytes, so this is only reached by
 *  output that keeps producing new colours, and for that a recycle costs one
 *  re-rasterization of the visible screen. The WebGL figure is also what each
 *  live context holds in texture memory, so it is kept to a size that stays
 *  harmless multiplied by {@link MAX_WEBGL}. */
const ATLAS_BUDGET = 128 * 1024 * 1024;

export type RendererChoice = "auto" | "webgl" | "canvas" | "dom";

interface Attached {
  term: Terminal;
  addon: ITerminalAddon | null;
  kind: "webgl" | "canvas" | "dom";
}

type AtlasKind = "webgl" | "canvas";

interface AtlasRemoval {
  onRemoveTextureAtlasCanvas: (listener: (page: HTMLCanvasElement) => void) => unknown;
}

const attached = new Map<string, Attached>();
/** Atlas pages alive per renderer kind. Each addon bundles its own copy of the
 *  atlas cache, so the two kinds never share pages and are budgeted apart.
 *
 *  These are strong references, so a page of an atlas xterm disposed on its own
 *  (a font or theme change) stays here until the next recycle. That is bounded
 *  by the budget, and the entries still count towards it. */
const atlasPages: Record<AtlasKind, Set<HTMLCanvasElement>> = {
  webgl: new Set(),
  canvas: new Set(),
};
const recycleQueued: Record<AtlasKind, boolean> = { webgl: false, canvas: false };
let recycles = 0;
/** Pane ids holding a GL context, least-recently-focused first. */
const glOrder: string[] = [];
/** Set once WebGL has failed, so a machine without working GL (a VM, a driver
 *  WebKit refuses) stops paying for a failed context creation per pane. */
let webglBroken = false;
let choice: RendererChoice = "auto";

/** Renderer names that mean "this GL context is being drawn by the CPU".
 *  Matched case-insensitively against the unmasked renderer string. */
const SOFTWARE_GL = /llvmpipe|softpipe|swiftshader|swrast|soft|virgl|lavapipe|microsoft basic/i;

/** What the probe found, once. `null` until it has run. `glIsSoftware` is only
 *  ever set by a driver naming itself; "we could not tell" leaves it false. */
let glDriver: string | null = null;
let glIsSoftware = false;

/** Ask a throwaway context which driver is behind it.
 *
 *  Diagnostic only: nothing here chooses a renderer by it, because on this
 *  webview the answer is often a masked string that names no driver at all. It
 *  is recorded because when it *does* answer — "llvmpipe" — that single word is
 *  the whole explanation for a slow session, and is not otherwise knowable from
 *  a release build.
 *
 *  Runs at most once, and the context is released immediately: this must not
 *  spend one of the handful of live contexts the pool is rationing. */
function probeGl(): void {
  if (glDriver !== null) return;
  glDriver = "";
  try {
    const probe = document.createElement("canvas");
    const gl =
      (probe.getContext("webgl2") as WebGL2RenderingContext | null) ??
      (probe.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    glDriver = info
      ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "")
      : "";
    glIsSoftware = SOFTWARE_GL.test(glDriver);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch (err) {
    console.warn("[renderers] could not probe the WebGL driver:", err);
  }
}

/** The app's webview is WebKitGTK here, whose WebGL can silently land on a slow
 *  path — see the module note. The automatic choice therefore skips WebGL, and
 *  only an explicit "webgl" setting overrides that. */
const isWebkitGtk = /Linux/i.test(navigator.userAgent);

function wantsWebgl(visible: boolean): boolean {
  if (!visible || webglBroken) return false;
  if (isWebkitGtk && choice === "auto") return false;
  return choice === "auto" || choice === "webgl";
}

function atlasBytes(kind: AtlasKind): number {
  let bytes = 0;
  for (const page of atlasPages[kind]) bytes += page.width * page.height * 4;
  return bytes;
}

function notePage(kind: AtlasKind, page: HTMLCanvasElement) {
  atlasPages[kind].add(page);
  if (recycleQueued[kind] || atlasBytes(kind) <= ATLAS_BUDGET) return;
  recycleQueued[kind] = true;
  // Pages are added from inside a render pass, which is still using the
  // renderer this would dispose.
  setTimeout(() => recycle(kind), 0);
}

function load(term: Terminal, kind: "webgl" | "canvas" | "dom"): Attached {
  if (kind === "dom") return { term, addon: null, kind };
  const addon = kind === "webgl" ? new WebglAddon() : new CanvasAddon();
  // Subscribed before activation, though the very first page is announced from
  // the renderer's constructor and is missed: one small page, not worth more.
  addon.onChangeTextureAtlas((page) => notePage(kind, page));
  addon.onAddTextureAtlasCanvas((page) => notePage(kind, page));
  if (addon instanceof WebglAddon) {
    // Public on the addon, missing from its typings. A merge replaces four pages
    // with one, and the four must stop counting or the merge reads as growth.
    (addon as unknown as AtlasRemoval).onRemoveTextureAtlasCanvas((page) =>
      atlasPages.webgl.delete(page),
    );
  }
  term.loadAddon(addon);
  return { term, addon, kind };
}

/** Load a GL renderer for a pane that already holds a slot. Context creation is
 *  the one step that can fail on the user's machine rather than in our logic (no
 *  GPU, a blocklisted driver, an exhausted pool), so a failure falls back to
 *  canvas for this pane and stops WebGL being tried for the rest. */
function attachWebgl(paneId: string, term: Terminal) {
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

/** The last pane of a kind took its atlas with it, so those pages are dead:
 *  counting them would spend the budget on nothing, and holding them keeps
 *  their memory. Every tab switch can get here, since hidden panes have no
 *  atlas. */
function forgetOwnerlessAtlases() {
  for (const kind of ["webgl", "canvas"] as const) {
    if (![...attached.values()].some((current) => current.kind === kind)) {
      atlasPages[kind].clear();
    }
  }
}

/** Dispose this kind's atlas and give its panes a fresh one.
 *
 *  Two passes, because the atlas is shared by every pane with the same font and
 *  is only disposed along with its last owner: a pane reloaded while another
 *  still held the old atlas would simply be handed it back. */
function recycle(kind: AtlasKind) {
  recycleQueued[kind] = false;
  if (atlasBytes(kind) <= ATLAS_BUDGET) return;
  recycles++;
  const panes = [...attached].filter(([, current]) => current.kind === kind);
  for (const [, current] of panes) unload(current);
  // Every owner is gone, so nothing draws from these any more. Emptying them
  // returns the backing store now rather than whenever the collector next runs,
  // which under the output that got us here is later than the memory can wait.
  for (const page of atlasPages[kind]) {
    page.width = 0;
    page.height = 0;
  }
  atlasPages[kind].clear();
  for (const [paneId, current] of panes) {
    if (kind === "webgl") attachWebgl(paneId, current.term);
    else attached.set(paneId, loadSafely(current.term, "canvas"));
  }
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
  // Collected first: disposing the addon takes these out of the document.
  const canvases =
    current.kind === "webgl" ? [...(current.term.element?.querySelectorAll("canvas") ?? [])] : [];
  try {
    current.addon?.dispose();
  } catch (err) {
    console.error("[renderers] renderer teardown failed:", err);
  }
  // xterm drops its last reference to the context and leaves the rest to the
  // collector, so the textures it holds outlive the renderer until then. The
  // addon's listeners went with it, so this cannot read as a lost context.
  for (const canvas of canvases) {
    try {
      canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch (err) {
      console.warn("[renderers] could not release a GL context:", err);
    }
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
  if (choice === "dom" || !visible) {
    // A pane that is not on screen draws nothing, and xterm's own renderer holds
    // no canvases, so a hidden pane costs no pixels and no share of the atlas.
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
    forgetOwnerlessAtlases();
    return;
  }

  attachWebgl(paneId, term);
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
  forgetOwnerlessAtlases();
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

/** Renderer bookkeeping sizes, for the diagnostics log. `attached` is keyed by
 *  pane id and released in `release`, so it should never exceed the number of
 *  open panes; `glOrder` should never exceed {@link MAX_WEBGL}. */
export function diagCounts(): Record<string, number> {
  const kinds = summary();
  return {
    rendererAttached: attached.size,
    rendererGlSlots: glOrder.length,
    rendererWebgl: kinds.webgl,
    rendererCanvas: kinds.canvas,
    rendererDom: kinds.dom,
    atlasWebglKb: Math.round(atlasBytes("webgl") / 1024),
    atlasCanvasKb: Math.round(atlasBytes("canvas") / 1024),
    atlasRecycles: recycles,
    glSoftware: glIsSoftware ? 1 : 0,
  };
}

/** The GL driver the probe found, as one log-safe token. Worth writing down
 *  next to the frame times: "this machine is drawing terminals on llvmpipe" is
 *  the whole explanation for a slow session, and is not otherwise knowable from
 *  a release build. */
export function diagDriver(): string {
  probeGl();
  return (glDriver || "unknown").replace(/\s+/g, "_").replace(/[^\w.:/()-]/g, "");
}
