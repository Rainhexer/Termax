// Dragging panes and tabs, built on pointer events rather than HTML5
// drag-and-drop.
//
// The native API is unusable in this app's webview (webkit2gtk): a drag dies if
// its source element moves or unmounts while it is in flight — which is exactly
// what happens here, because showing the drag-only tab bar reflows the grid and
// a spring-loaded tab switch tears the source pane out — and the engine then
// keeps the session half-open, swallowing every later `dragstart`. That is the
// "dragging just stops reacting" in issue #34. A drag also runs inside a nested
// event loop where `setTimeout` never fires, so spring-loading could not work,
// and `dataTransfer.getData` is empty on some platforms.
//
// Pointer events have none of those properties: they keep firing on `window` no
// matter what happens to the element the gesture started on, timers run
// normally, and the payload is a variable in this module.

import { get, writable } from "svelte/store";
import {
  collectTabPanes,
  draggedGroupKey,
  draggedPaneId,
  draggedTabId,
  groupKeyOf,
  groupKeys,
  movePane,
  movePaneToGroup,
  movePaneToNewTab,
  movePaneToTab,
  reorderGroup,
  reorderTab,
  splitPaneAt,
  switchGroup,
  switchTab,
  activeTabId,
  tabs,
} from "./stores";

export type DropZone = "top" | "bottom" | "left" | "right" | "center";

/** Where the thing in hand would land if the pointer were released now. */
export type DropTarget =
  | { kind: "pane"; paneId: string; zone: DropZone }
  /** Onto a subtab: a pane moves into it, a subtab reorders before/after.
   *  `slot` is an index within that tab's own group, which is the row being
   *  dragged along. */
  | { kind: "tab"; tabId: string; slot: number }
  /** Onto a worktree tab in the top row: a pane moves into that tree's current
   *  subtab, a worktree tab reorders before/after. */
  | { kind: "group"; key: string; slot: number }
  /** Onto the "+" button: tear the pane off, or move the tab to the end. */
  | { kind: "newTab" }
  | null;

export const dropTarget = writable<DropTarget>(null);

/** Pointer travel before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** Hover this long over a tab with a pane in hand and it opens, so the pane can
 *  be dropped at an exact spot inside that tab's grid. */
const SPRING_DELAY = 550;

/** Pointer events are captured here for the length of a gesture. Capturing on a
 *  node that outlives everything matters twice over: the source header is torn
 *  out by a spring-loaded tab switch, and an editor pane's preview `<iframe>`
 *  would otherwise swallow the pointer — including the `pointerup` that ends the
 *  drag — the moment the cursor crossed it. */
const captureHost = () => document.documentElement;

type Gesture = {
  kind: "pane" | "tab" | "group";
  id: string;
  /** Shown in the ghost that follows the cursor. */
  label: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** False until the pointer has moved past the threshold. */
  active: boolean;
  /** Label floating under the cursor; created when the drag turns active. */
  ghost: HTMLElement | null;
  springTimer: ReturnType<typeof setTimeout> | undefined;
  /** Tab the spring timer is currently counting down for. */
  springTabId: string | null;
};

let gesture: Gesture | null = null;

/** Begin a possible pane drag. Safe to call on any press: nothing happens until
 *  the pointer actually travels, so clicks and focus behave as before. */
export function startPaneDrag(e: PointerEvent, paneId: string, label: string) {
  begin(e, "pane", paneId, label);
}

/** Begin a possible subtab drag. */
export function startTabDrag(e: PointerEvent, tabId: string, label: string) {
  begin(e, "tab", tabId, label);
}

/** Begin a possible worktree-tab drag along the top row. */
export function startGroupDrag(e: PointerEvent, key: string, label: string) {
  begin(e, "group", key, label);
}

function begin(e: PointerEvent, kind: "pane" | "tab" | "group", id: string, label: string) {
  if (e.button !== 0) return;
  // The header strips carry buttons (close, split, bell). A press that lands on
  // one is aiming at the button, not at the pane.
  if ((e.target as HTMLElement | null)?.closest("button, input")) return;
  cancel();
  gesture = {
    kind,
    id,
    label,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    ghost: null,
    springTimer: undefined,
    springTabId: null,
  };
  const host = captureHost();
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerup", onUp);
  host.addEventListener("pointercancel", onCancel);
  host.addEventListener("lostpointercapture", onCancel);
  window.addEventListener("keydown", onKey, true);
  // Losing the window mid-drag (an OS switcher, a native dialog) means no
  // pointerup is ever delivered; treat it as a cancel rather than leaking the
  // listeners and the ghost.
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
    // Captured only now, never on the initial press: capture retargets the
    // compat mouse events, so claiming the pointer up front swallowed the
    // `click` on a tab chip and made tabs unswitchable.
    try {
      captureHost().setPointerCapture(g.pointerId);
    } catch {
      // No capture for this pointer: everything still works except a cursor
      // crossing an iframe, which would take the pointer with it.
    }
    g.ghost = makeGhost(g.label);
    document.body.style.cursor = "grabbing";
    // Published only now, so a plain click never flickers the drag-only UI.
    if (g.kind === "pane") draggedPaneId.set(g.id);
    else if (g.kind === "group") draggedGroupKey.set(g.id);
    else draggedTabId.set(g.id);
  }

  if (g.ghost) {
    g.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
  }
  dropTarget.set(hitTest(e.clientX, e.clientY, g));
}

function onUp(e: PointerEvent) {
  const g = gesture;
  if (!g) return;
  const active = g.active;
  // Re-test at the release point: the pointer may have moved since the last
  // move event, and on a fast flick there may have been only one.
  const target = active ? hitTest(e.clientX, e.clientY, g) : null;
  const kind = g.kind;
  const id = g.id;
  cancel();
  if (active && target) apply(kind, id, target);
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

/** Tear down the gesture without applying anything. */
function cancel() {
  const g = gesture;
  gesture = null;
  const host = captureHost();
  // Detach before releasing capture, or the release fires `lostpointercapture`
  // straight back into this function.
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
  clearTimeout(g.springTimer);
  g.ghost?.remove();
  if (g.active) {
    document.body.style.cursor = "";
    swallowNextClick();
  }
  draggedPaneId.set(null);
  draggedTabId.set(null);
  draggedGroupKey.set(null);
  dropTarget.set(null);
}

/** Eat the click the browser synthesises after the release that ended a drag —
 *  letting it through would, for instance, switch to a tab the user was only
 *  dragging somewhere else. A press that never became a drag is untouched, so
 *  ordinary clicking still works. */
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
    "font-size: 11px",
    "box-shadow: 0 8px 24px rgb(0 0 0 / 0.5)",
  ].join(";");
  document.body.appendChild(el);
  return el;
}

/** Which pane is alone in its tab — tearing it off would be a no-op, so the
 *  "+" button must not pretend to accept it. */
function isLonePane(paneId: string): boolean {
  const owner = get(tabs).find((t) => collectTabPanes(t).includes(paneId));
  return !!owner && collectTabPanes(owner).length === 1;
}

function hitTest(x: number, y: number, g: Gesture): DropTarget {
  const el = document.elementFromPoint(x, y);

  const groupEl = el?.closest<HTMLElement>("[data-group-key]");
  const groupKey = groupEl?.dataset.groupKey;
  if (groupEl && groupKey) {
    if (g.kind === "group") {
      stopSpring(g);
      const rect = groupEl.getBoundingClientRect();
      const i = get(groupKeys).indexOf(groupKey);
      if (i < 0) return null;
      return { kind: "group", key: groupKey, slot: x > rect.left + rect.width / 2 ? i + 1 : i };
    }
    // A subtab belongs to its tree and cannot be dropped into another one: the
    // panes inside it are already running in the old tree's directory, so the
    // move would relabel them rather than move them.
    if (g.kind === "tab") {
      stopSpring(g);
      return null;
    }
    springGroup(g, groupKey);
    return { kind: "group", key: groupKey, slot: 0 };
  }

  // The worktree row's "+" makes a new tree rather than accepting a drop, but a
  // worktree tab dragged onto it lands at the end of the row — the same gesture
  // the subtab row's "+" offers.
  const newTree = el?.closest<HTMLElement>("[data-new-worktree]");
  if (newTree) {
    stopSpring(g);
    if (g.kind !== "group") return null;
    return { kind: "group", key: g.id, slot: get(groupKeys).length };
  }

  const plus = el?.closest<HTMLElement>("[data-new-tab]");
  if (plus) {
    stopSpring(g);
    if (g.kind === "group") return null;
    if (g.kind === "pane" && isLonePane(g.id)) return null;
    return { kind: "newTab" };
  }

  const tabEl = el?.closest<HTMLElement>("[data-tab-id]");
  const tabId = tabEl?.dataset.tabId;
  if (tabEl && tabId) {
    if (g.kind === "group") {
      stopSpring(g);
      return null;
    }
    if (g.kind === "tab") {
      stopSpring(g);
      const rect = tabEl.getBoundingClientRect();
      // Group-local: the row only ever shows one tree's subtabs, so the slot the
      // user is aiming at is an index within that tree.
      const list = get(tabs);
      const dragged = list.find((t) => t.id === g.id);
      const target = list.find((t) => t.id === tabId);
      if (!dragged || !target || groupKeyOf(dragged) !== groupKeyOf(target)) return null;
      const members = list.filter((t) => groupKeyOf(t) === groupKeyOf(target));
      const i = members.findIndex((t) => t.id === tabId);
      if (i < 0) return null;
      return { kind: "tab", tabId, slot: x > rect.left + rect.width / 2 ? i + 1 : i };
    }
    springLoad(g, tabId);
    return { kind: "tab", tabId, slot: 0 };
  }

  stopSpring(g);
  if (g.kind === "tab" || g.kind === "group") return null;

  const paneEl = el?.closest<HTMLElement>("[data-pane-id]");
  const paneId = paneEl?.dataset.paneId;
  if (!paneEl || !paneId) return null;
  // Every drop onto the dragged pane itself is a no-op (`movePane` and
  // `splitPaneAt` both bail on from === target), so offer no target rather than
  // highlighting a landing spot that would do nothing.
  if (paneId === g.id) return null;
  return { kind: "pane", paneId, zone: zoneAt(paneEl, x, y) };
}

function zoneAt(el: HTMLElement, x: number, y: number): DropZone {
  const rect = el.getBoundingClientRect();
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const edge = 0.25;
  if (fy < edge) return "top";
  if (fy > 1 - edge) return "bottom";
  if (fx < edge) return "left";
  if (fx > 1 - edge) return "right";
  return "center";
}

function springLoad(g: Gesture, tabId: string) {
  if (g.springTabId === tabId) return;
  stopSpring(g);
  if (tabId === get(activeTabId)) return;
  g.springTabId = tabId;
  g.springTimer = setTimeout(() => switchTab(tabId), SPRING_DELAY);
}

/** Spring-load a worktree tab, so hovering it with a pane in hand opens that
 *  tree and the pane can be dropped at an exact spot inside its grid. */
function springGroup(g: Gesture, key: string) {
  if (g.springTabId === key) return;
  stopSpring(g);
  const active = get(tabs).find((t) => t.id === get(activeTabId));
  if (active && groupKeyOf(active) === key) return;
  g.springTabId = key;
  g.springTimer = setTimeout(() => switchGroup(key), SPRING_DELAY);
}

function stopSpring(g: Gesture) {
  clearTimeout(g.springTimer);
  g.springTimer = undefined;
  g.springTabId = null;
}

function apply(kind: "pane" | "tab" | "group", id: string, target: DropTarget) {
  if (!target) return;
  if (kind === "group") {
    if (target.kind === "group") reorderGroup(id, target.slot);
    return;
  }
  if (kind === "tab") {
    if (target.kind === "tab") reorderTab(id, target.slot);
    else if (target.kind === "newTab") {
      const list = get(tabs);
      const dragged = list.find((t) => t.id === id);
      if (dragged) reorderTab(id, list.filter((t) => groupKeyOf(t) === groupKeyOf(dragged)).length);
    }
    return;
  }
  if (target.kind === "newTab") {
    movePaneToNewTab(id);
  } else if (target.kind === "group") {
    movePaneToGroup(id, target.key);
  } else if (target.kind === "tab") {
    movePaneToTab(id, target.tabId);
  } else if (target.kind === "pane") {
    const to = target.paneId;
    if (target.zone === "center") movePane(id, to);
    else if (target.zone === "left") splitPaneAt(id, to, "row", true);
    else if (target.zone === "right") splitPaneAt(id, to, "row", false);
    else if (target.zone === "top") splitPaneAt(id, to, "col", true);
    else if (target.zone === "bottom") splitPaneAt(id, to, "col", false);
  }
}
