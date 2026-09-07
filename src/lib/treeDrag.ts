// Dragging entries out of the explorer: onto a folder to move them, onto a
// terminal pane to type their paths.
//
// Pointer events, not HTML5 drag-and-drop, for the reasons written out at the
// top of paneDrag.ts: the native API is unusable in this app's webview, and a
// drag whose source row unmounts mid-flight — which is exactly what a
// spring-loaded folder expansion does to the rows below it — kills the session
// and takes every later `dragstart` with it.
//
// This is a separate gesture from paneDrag's rather than a mode of it. They
// share only the shape: what is in hand is a set of paths, the things it can
// land on are folders and terminals, and the drop is a filesystem call that can
// fail. Folding that into the pane/tab state machine would have meant
// threading a union through every branch of it.

import { get, writable } from "svelte/store";
import { expandedDirs, isSelfOrDescendant, parentDir, toggleDir } from "./filetree";
import { fileDropPaneId } from "./terminals";

/** Where the paths in hand would land if the pointer were released now. */
export type TreeDropTarget =
  /** A folder in the tree ("" = the project root). Moves the entries into it. */
  | { kind: "dir"; path: string }
  /** A terminal pane. Types the paths at its prompt. */
  | { kind: "pane"; paneId: string };

/** Paths currently being dragged, so their rows can show themselves in hand. */
export const treeDragPaths = writable<string[]>([]);
/** The folder that would receive the drop, for the row highlight. */
export const treeDropDir = writable<string | null>(null);

/** Pointer travel before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** Hover this long over a closed folder and it opens, so a nested folder can
 *  be reached without letting go. */
const SPRING_DELAY = 550;
/** How close to the list's edge the pointer scrolls it, and how fast. */
const SCROLL_EDGE = 24;
const SCROLL_STEP = 6;

/** Captured on the element that outlives the gesture. The rows under the
 *  cursor are re-created by every expansion and every refresh, so capturing on
 *  the source row would drop the pointer part-way through. */
const captureHost = () => document.documentElement;

type Gesture = {
  paths: string[];
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  ghost: HTMLElement | null;
  label: string;
  onDrop: (target: TreeDropTarget, paths: string[]) => void;
  /** Whether a pane counts as a drop target — only terminals take typed text. */
  canDropInPane: (paneId: string) => boolean;
  springTimer: ReturnType<typeof setTimeout> | undefined;
  springDir: string | null;
  scrollTimer: ReturnType<typeof setInterval> | undefined;
};

let gesture: Gesture | null = null;

/** Begin a possible drag of `paths`.
 *
 *  Safe to call on any press: nothing is published and nothing is captured
 *  until the pointer actually travels, so plain clicks — which in a file tree
 *  are how you select and open things — behave exactly as they did.
 *
 *  The caller supplies the drop, because what a drop means is the explorer's
 *  business: it owns the lock, the error line, and the reload. */
export function startTreeDrag(
  e: PointerEvent,
  paths: string[],
  label: string,
  opts: {
    onDrop: (target: TreeDropTarget, paths: string[]) => void;
    canDropInPane: (paneId: string) => boolean;
  },
) {
  if (e.button !== 0 || paths.length === 0) return;
  cancel();
  gesture = {
    paths,
    label,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    ghost: null,
    onDrop: opts.onDrop,
    canDropInPane: opts.canDropInPane,
    springTimer: undefined,
    springDir: null,
    scrollTimer: undefined,
  };
  const host = captureHost();
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerup", onUp);
  host.addEventListener("pointercancel", onCancel);
  host.addEventListener("lostpointercapture", onCancel);
  window.addEventListener("keydown", onKey, true);
  // No pointerup is delivered if the window goes away mid-drag (an OS switcher,
  // a native dialog); treat that as a cancel rather than leaking the listeners.
  window.addEventListener("blur", onCancel);
}

function onMove(e: PointerEvent) {
  const g = gesture;
  if (!g) return;

  if (!g.active) {
    const far =
      Math.abs(e.clientX - g.startX) > DRAG_THRESHOLD ||
      Math.abs(e.clientY - g.startY) > DRAG_THRESHOLD;
    if (!far) return;
    g.active = true;
    try {
      captureHost().setPointerCapture(g.pointerId);
    } catch {
      // No capture for this pointer: everything still works except a cursor
      // crossing an iframe, which would take the pointer with it.
    }
    g.ghost = makeGhost(g.label);
    document.body.style.cursor = "grabbing";
    treeDragPaths.set(g.paths);
  }

  if (g.ghost) {
    g.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
  }
  const target = hitTest(e.clientX, e.clientY, g);
  publish(target);
  edgeScroll(g, e.clientX, e.clientY);
}

function onUp(e: PointerEvent) {
  const g = gesture;
  if (!g) return;
  // Re-tested at the release point: on a fast flick there may have been only
  // one move event, and the pointer has travelled since.
  const target = g.active ? hitTest(e.clientX, e.clientY, g) : null;
  const { paths, onDrop } = g;
  cancel();
  if (target) onDrop(target, paths);
}

function onCancel() {
  cancel();
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !gesture) return;
  e.preventDefault();
  e.stopPropagation();
  cancel();
}

/** Tear down the gesture without dropping anything. */
function cancel() {
  const g = gesture;
  gesture = null;
  const host = captureHost();
  // Detached before the capture is released, or the release fires
  // `lostpointercapture` straight back into this function.
  host.removeEventListener("pointermove", onMove);
  host.removeEventListener("pointerup", onUp);
  host.removeEventListener("pointercancel", onCancel);
  host.removeEventListener("lostpointercapture", onCancel);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", onCancel);
  if (!g) return;
  if (host.hasPointerCapture?.(g.pointerId)) {
    try {
      host.releasePointerCapture(g.pointerId);
    } catch {
      // Already released with the pointer itself; nothing to undo.
    }
  }
  stopSpring(g);
  clearInterval(g.scrollTimer);
  g.ghost?.remove();
  if (g.active) {
    document.body.style.cursor = "";
    swallowNextClick();
  }
  treeDragPaths.set([]);
  publish(null);
}

/** Eat the click the browser synthesises after the release that ended a drag.
 *  Letting it through would open the file that was only being moved. */
function swallowNextClick() {
  const eat = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    done();
  };
  const done = () => window.removeEventListener("click", eat, true);
  window.addEventListener("click", eat, true);
  // No click follows a release outside any element; don't leave the trap armed.
  setTimeout(done);
}

/** Light up whichever of the two highlights the target calls for.
 *
 *  Panes reuse `fileDropPaneId` — the store an *OS* file drag already sets —
 *  rather than getting a second one: to a terminal pane the two gestures are
 *  the same offer, and one store means one highlight that cannot get out of
 *  step with itself. */
function publish(target: TreeDropTarget | null) {
  treeDropDir.set(target?.kind === "dir" ? target.path : null);
  fileDropPaneId.set(target?.kind === "pane" ? target.paneId : null);
}

function makeGhost(label: string): HTMLElement {
  const el = document.createElement("div");
  el.textContent = label;
  el.setAttribute("aria-hidden", "true");
  // `pointer-events: none` is load-bearing: `elementFromPoint` must see what is
  // under the cursor, not the ghost riding on top of it.
  el.style.cssText = [
    "position: fixed",
    "left: 0",
    "top: 0",
    "z-index: 9999",
    "pointer-events: none",
    "max-width: 16rem",
    "overflow: hidden",
    "text-overflow: ellipsis",
    "white-space: nowrap",
    "padding: 0.25rem 0.5rem",
    "border-radius: 0.375rem",
    "border: 1px solid rgb(16 185 129 / 0.6)",
    "background: rgb(24 24 27 / 0.95)",
    "color: rgb(212 212 216)",
    "font-family: ui-monospace, monospace",
    "font-size: 11px",
    "box-shadow: 0 8px 24px rgb(0 0 0 / 0.5)",
  ].join(";");
  document.body.appendChild(el);
  return el;
}

function hitTest(x: number, y: number, g: Gesture): TreeDropTarget | null {
  const el = document.elementFromPoint(x, y);

  // A row carries the folder a drop on it lands in: its own path if it is a
  // folder, its parent's if it is a file. Dropping "onto" a file means into
  // the folder you can see it sitting in, which is what every file manager
  // does and what the pointer looks like it is pointing at.
  const rowEl = el?.closest<HTMLElement>("[data-tree-dir]");
  if (rowEl) {
    stopSpring(g);
    const dir = rowEl.dataset.treeDir ?? "";
    if (rowEl.dataset.treeIsDir === "true") springLoad(g, dir);
    return acceptsDir(dir, g.paths) ? { kind: "dir", path: dir } : null;
  }

  // Empty space below the rows is the root, so an entry can be moved back out
  // of a folder without hunting for a row to aim at.
  const listEl = el?.closest<HTMLElement>("[data-tree-root]");
  if (listEl) {
    stopSpring(g);
    return acceptsDir("", g.paths) ? { kind: "dir", path: "" } : null;
  }

  stopSpring(g);
  const paneEl = el?.closest<HTMLElement>("[data-pane-id]");
  const paneId = paneEl?.dataset.paneId;
  if (paneEl && paneId && g.canDropInPane(paneId)) return { kind: "pane", paneId };
  return null;
}

/** Whether `dir` is a folder these paths can actually be moved into: not one
 *  of them, not inside one of them, and not the folder they are already in. */
function acceptsDir(dir: string, paths: string[]): boolean {
  return paths.some((path) => !isSelfOrDescendant(dir, path) && parentDir(path) !== dir);
}

function springLoad(g: Gesture, dir: string) {
  if (g.springDir === dir) return;
  stopSpring(g);
  if (dir === "" || get(expandedDirs).has(dir)) return;
  g.springDir = dir;
  g.springTimer = setTimeout(() => void toggleDir(dir), SPRING_DELAY);
}

function stopSpring(g: Gesture) {
  clearTimeout(g.springTimer);
  g.springTimer = undefined;
  g.springDir = null;
}

/** Scroll the tree when the pointer rests near its top or bottom edge — the
 *  explorer is a few rows tall, and a folder off screen is otherwise
 *  unreachable without letting go of what you are dragging. */
function edgeScroll(g: Gesture, x: number, y: number) {
  clearInterval(g.scrollTimer);
  g.scrollTimer = undefined;
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tree-root]");
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const dy = y < rect.top + SCROLL_EDGE ? -SCROLL_STEP : y > rect.bottom - SCROLL_EDGE ? SCROLL_STEP : 0;
  if (dy === 0) return;
  g.scrollTimer = setInterval(() => (el.scrollTop += dy), 16);
}
