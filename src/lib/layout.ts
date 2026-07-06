import type { LayoutNode, PaneNode, SplitNode } from "./types";

export function newPane(launch: string | null, title: string): PaneNode {
  return { type: "pane", id: crypto.randomUUID(), title, launch };
}

export function collectPanes(node: LayoutNode | null): PaneNode[] {
  if (!node) return [];
  if (node.type === "pane") return [node];
  return [...collectPanes(node.a), ...collectPanes(node.b)];
}

export function findPane(node: LayoutNode | null, id: string): PaneNode | null {
  return collectPanes(node).find((p) => p.id === id) ?? null;
}

/** Replace the pane `targetId` with a split of it and `pane`. Returns new tree. */
export function splitPane(
  node: LayoutNode,
  targetId: string,
  pane: PaneNode,
  dir: "row" | "col",
): LayoutNode {
  if (node.type === "pane") {
    if (node.id !== targetId) return node;
    const split: SplitNode = {
      type: "split",
      id: crypto.randomUUID(),
      dir,
      ratio: 0.5,
      a: node,
      b: pane,
    };
    return split;
  }
  return { ...node, a: splitPane(node.a, targetId, pane, dir), b: splitPane(node.b, targetId, pane, dir) };
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

export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === "pane") return node;
  if (node.id === splitId) return { ...node, ratio };
  return { ...node, a: setRatio(node.a, splitId, ratio), b: setRatio(node.b, splitId, ratio) };
}
