import { get, writable } from "svelte/store";
import type { ChangeEntry, TreeEntry } from "./types";
import { ipc } from "./ipc";

/** Fetched children per directory path ("" = project root). */
export const treeChildren = writable<Map<string, TreeEntry[]>>(new Map());
/** Directory paths currently expanded. */
export const expandedDirs = writable<Set<string>>(new Set());

export function resetTree() {
  treeChildren.set(new Map());
  expandedDirs.set(new Set());
}

/** Root the tree is currently showing.
 *
 *  Held here rather than imported from stores.ts, which imports *this* module —
 *  taking it as state set by the owner keeps the dependency one-directional. The
 *  tree only ever shows the active tab's root, so there is one value, not a map. */
let treeRoot: string | undefined;

/** Point the tree at a root, clearing anything cached from the previous one.
 *  A no-op when the root is unchanged, so it is safe to call on every update. */
export function setTreeRoot(root: string | null) {
  const next = root ?? undefined;
  if (next === treeRoot) return;
  treeRoot = next;
  resetTree();
}

export async function loadDir(path: string) {
  try {
    const entries = await ipc.listDir(path, treeRoot);
    treeChildren.update((m) => {
      const next = new Map(m);
      next.set(path, entries);
      return next;
    });
  } catch {
    // directory vanished; drop stale children
    treeChildren.update((m) => {
      const next = new Map(m);
      next.delete(path);
      return next;
    });
  }
}

export async function toggleDir(path: string) {
  const expanded = get(expandedDirs);
  if (expanded.has(path)) {
    expandedDirs.update((s) => {
      const next = new Set(s);
      next.delete(path);
      return next;
    });
  } else {
    expandedDirs.update((s) => new Set(s).add(path));
    if (!get(treeChildren).has(path)) await loadDir(path);
  }
}

export function collapseAllUnder(path: string) {
  const prefix = path + "/";
  expandedDirs.update((s) => {
    const next = new Set<string>();
    for (const p of s) {
      if (p !== path && !p.startsWith(prefix)) next.add(p);
    }
    return next;
  });
}

/** Re-fetch the root and every expanded directory (filesystem changed). */
export async function refreshTree() {
  const dirs = ["", ...get(expandedDirs)];
  // Wrapped rather than passed directly to `map`: `map` supplies the index as a
  // second argument, which loadDir would otherwise take as a root.
  await Promise.all(dirs.map((dir) => loadDir(dir)));
}

export type TreeBadge = { char: string; color: string };

const BADGE_COLOR: Record<string, string> = {
  M: "text-amber-400",
  S: "text-emerald-400",
  A: "text-blue-400",
  D: "text-red-400",
  C: "text-purple-400",
};

/** Collapse a file's change entries into one tree badge letter. */
function fileBadge(entries: ChangeEntry[]): string {
  let best = "";
  const rank: Record<string, number> = { C: 5, D: 4, M: 3, A: 2, S: 1 };
  const snapshotChar: Record<string, string> = { created: "A", modified: "M", deleted: "D" };
  for (const e of entries) {
    let char: string;
    if (e.area === "untracked") char = "A";
    else if (e.area === "staged") char = "S";
    else if (e.area === "unstaged") {
      char = e.status === "C" || e.status === "D" || e.status === "A" ? e.status : "M";
    } else char = snapshotChar[e.status] ?? "M";
    if ((rank[char] ?? 0) > (rank[best] ?? 0)) best = char;
  }
  return best;
}

/**
 * Badge lookup from the changes list: files map to a letter badge, directories
 * to a rolled-up count of changed files beneath them.
 */
export function buildBadges(changes: ChangeEntry[]): {
  files: Map<string, TreeBadge>;
  dirCounts: Map<string, number>;
} {
  const byPath = new Map<string, ChangeEntry[]>();
  for (const c of changes) {
    const list = byPath.get(c.path) ?? [];
    list.push(c);
    byPath.set(c.path, list);
  }

  const files = new Map<string, TreeBadge>();
  const dirCounts = new Map<string, number>();
  for (const [path, entries] of byPath) {
    const char = fileBadge(entries);
    files.set(path, { char, color: BADGE_COLOR[char] ?? "text-amber-400" });
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
  }
  return { files, dirCounts };
}
