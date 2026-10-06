import type { LayoutNode, PaneNode, SplitNode } from "./types";

/** Thickness of the drag handle rendered between two children of a split (see TilingLayout). */
export const DIVIDER_PX = 6;

/** Hard floor: a pane smaller than this is considered unusable. */
export const MIN_PANE_W = 320;
export const MIN_PANE_H = 160;

/** Comfortable size; drives the preferred split direction, not validity. */
export const TARGET_PANE_W = 560;
export const TARGET_PANE_H = 340;
const TARGET_ASPECT = TARGET_PANE_W / TARGET_PANE_H;

export interface Size {
  w: number;
  h: number;
}

export function newPane(launch: string | null, title: string, bell?: boolean): PaneNode {
  return { type: "pane", id: crypto.randomUUID(), title, launch, bell };
}

export function collectPanes(node: LayoutNode | null): PaneNode[] {
  if (!node) return [];
  if (node.type === "pane") return [node];
  return [...collectPanes(node.a), ...collectPanes(node.b)];
}

export function findPane(node: LayoutNode | null, id: string): PaneNode | null {
  return collectPanes(node).find((p) => p.id === id) ?? null;
}

/** Replace the pane `targetId` with a split of it and `pane`. Returns new tree.
 *  When `before` is true, `pane` becomes the first child (`a`), otherwise the second (`b`). */
export function splitPane(
  node: LayoutNode,
  targetId: string,
  pane: PaneNode,
  dir: "row" | "col",
  before = false,
): LayoutNode {
  if (node.type === "pane") {
    if (node.id !== targetId) return node;
    const split: SplitNode = {
      type: "split",
      id: crypto.randomUUID(),
      dir,
      ratio: 0.5,
      a: before ? pane : node,
      b: before ? node : pane,
    };
    return split;
  }
  return { ...node, a: splitPane(node.a, targetId, pane, dir, before), b: splitPane(node.b, targetId, pane, dir, before) };
}

/** Graft `pane` onto the root of `node` as a new split. Used when a pane moves
 *  into another tab, where there is no meaningful drop target inside the tree. */
export function appendPane(
  node: LayoutNode | null,
  pane: PaneNode,
  dir: "row" | "col" = "row",
): LayoutNode {
  if (!node) return pane;
  return { type: "split", id: crypto.randomUUID(), dir, ratio: 0.5, a: node, b: pane };
}

/** Remove pane `targetId`; the sibling takes the split's place. Returns new tree or null if empty. */
export function removePane(node: LayoutNode, targetId: string): LayoutNode | null {
  if (node.type === "pane") {
    return node.id === targetId ? null : node;
  }
  const a = removePane(node.a, targetId);
  const b = removePane(node.b, targetId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

/** Swap the positions of two panes in the tree (each keeps its terminal + title). */
export function swapPanes(node: LayoutNode, idA: string, idB: string): LayoutNode {
  const a = findPane(node, idA);
  const b = findPane(node, idB);
  if (!a || !b) return node;
  const replace = (n: LayoutNode): LayoutNode => {
    if (n.type === "pane") return n.id === idA ? b : n.id === idB ? a : n;
    return { ...n, a: replace(n.a), b: replace(n.b) };
  };
  return replace(node);
}

/** Set the diff-view flag on an editor pane. Returns new tree. */
export function setPaneDiff(node: LayoutNode, paneId: string, diff: boolean): LayoutNode {
  if (node.type === "pane") return node.id === paneId ? { ...node, diff } : node;
  return { ...node, a: setPaneDiff(node.a, paneId, diff), b: setPaneDiff(node.b, paneId, diff) };
}

/** Set the edit/preview view mode on an editor pane. Returns new tree. */
export function setPaneView(node: LayoutNode, paneId: string, view: "edit" | "preview"): LayoutNode {
  if (node.type === "pane") return node.id === paneId ? { ...node, view } : node;
  return { ...node, a: setPaneView(node.a, paneId, view), b: setPaneView(node.b, paneId, view) };
}

/** Set the bell-watch flag on a terminal pane. Returns new tree. */
export function setPaneBell(node: LayoutNode, paneId: string, bell: boolean): LayoutNode {
  if (node.type === "pane") return node.id === paneId ? { ...node, bell } : node;
  return { ...node, a: setPaneBell(node.a, paneId, bell), b: setPaneBell(node.b, paneId, bell) };
}

/** Set the font-size offset on a pane. Returns new tree. */
export function setPaneFontDelta(node: LayoutNode, paneId: string, fontDelta: number): LayoutNode {
  if (node.type === "pane") return node.id === paneId ? { ...node, fontDelta } : node;
  return {
    ...node,
    a: setPaneFontDelta(node.a, paneId, fontDelta),
    b: setPaneFontDelta(node.b, paneId, fontDelta),
  };
}

export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === "pane") return node;
  if (node.id === splitId) return { ...node, ratio };
  return { ...node, a: setRatio(node.a, splitId, ratio), b: setRatio(node.b, splitId, ratio) };
}

/**
 * Move pane `fromId` out of the tree and insert it as a split neighbor of
 * `targetId` in direction `dir`.  The new split wraps `targetId` and the
 * moved pane; `fromId` is removed from its original position first.
 * When `before` is true, the moved pane becomes the first child (`a`).
 */
export function movePaneToSplit(
  node: LayoutNode,
  fromId: string,
  targetId: string,
  dir: "row" | "col",
  before = false,
): LayoutNode | null {
  if (fromId === targetId) return node;
  const fromPane = findPane(node, fromId);
  if (!fromPane) return node;

  const afterRemove = removePane(node, fromId);
  if (!afterRemove) return null;

  const targetStillExists = findPane(afterRemove, targetId);
  if (!targetStillExists) return node;

  return splitPane(afterRemove, targetId, fromPane, dir, before);
}

/** Measure every pane in the tree given the pixel size of the whole tiling area.
 *  Mirrors TilingLayout's flex math: children share the axis minus the divider. */
export function paneSizes(
  node: LayoutNode,
  view: Size,
  out: Map<string, Size> = new Map(),
): Map<string, Size> {
  if (node.type === "pane") {
    out.set(node.id, { w: view.w, h: view.h });
    return out;
  }
  if (node.dir === "row") {
    const avail = Math.max(0, view.w - DIVIDER_PX);
    paneSizes(node.a, { w: avail * node.ratio, h: view.h }, out);
    paneSizes(node.b, { w: avail * (1 - node.ratio), h: view.h }, out);
  } else {
    const avail = Math.max(0, view.h - DIVIDER_PX);
    paneSizes(node.a, { w: view.w, h: avail * node.ratio }, out);
    paneSizes(node.b, { w: view.w, h: avail * (1 - node.ratio) }, out);
  }
  return out;
}

/** Size each half gets when `size` is split down the middle along `dir`. */
function halfOf(size: Size, dir: "row" | "col"): Size {
  return dir === "row"
    ? { w: Math.max(0, size.w - DIVIDER_PX) / 2, h: size.h }
    : { w: size.w, h: Math.max(0, size.h - DIVIDER_PX) / 2 };
}

/** How comfortably a size clears the minimums. >= 1 means it fits. */
function slack(size: Size): number {
  return Math.min(size.w / MIN_PANE_W, size.h / MIN_PANE_H);
}

export interface Placement {
  targetId: string;
  dir: "row" | "col";
  /** False when no pane could be split without going under the minimums;
   *  the placement is still the least-bad one. */
  fits: boolean;
}

/**
 * Pick where a new pane should go: split the largest pane whose halves stay
 * above the minimum size, along the axis that keeps panes closest to the
 * target aspect ratio. Falls back to the largest pane overall when nothing
 * fits, so a pane is always placed somewhere.
 */
export function choosePlacement(node: LayoutNode, view: Size): Placement {
  const sizes = paneSizes(node, view);
  let best: (Placement & { area: number; slack: number }) | null = null;

  for (const [id, size] of sizes) {
    const preferred: "row" | "col" = size.w / size.h >= TARGET_ASPECT ? "row" : "col";
    const other: "row" | "col" = preferred === "row" ? "col" : "row";

    const options = [preferred, other].map((dir) => ({ dir, slack: slack(halfOf(size, dir)) }));
    // Preferred direction wins ties; `options[0]` is already the preferred one.
    const chosen = options[0].slack >= 1 ? options[0] : options[1].slack > options[0].slack ? options[1] : options[0];

    const candidate = {
      targetId: id,
      dir: chosen.dir,
      fits: chosen.slack >= 1,
      area: size.w * size.h,
      slack: chosen.slack,
    };
    if (!best) {
      best = candidate;
      continue;
    }
    // Fitting candidates always beat non-fitting ones; then biggest pane wins.
    // Among non-fitting candidates, pick the one closest to fitting.
    if (candidate.fits !== best.fits) {
      if (candidate.fits) best = candidate;
    } else if (candidate.fits ? candidate.area > best.area : candidate.slack > best.slack) {
      best = candidate;
    }
  }

  if (best) return { targetId: best.targetId, dir: best.dir, fits: best.fits };
  const fallback = collectPanes(node).at(-1)!;
  return { targetId: fallback.id, dir: "row", fits: false };
}
