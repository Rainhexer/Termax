import { get, writable } from "svelte/store";
import type { ChangeEntry, TreeEntry, TreeSearch } from "./types";
import { ipc } from "./ipc";

/** Fetched children per directory path ("" = project root). */
export const treeChildren = writable<Map<string, TreeEntry[]>>(new Map());
/** Directory paths currently expanded. */
export const expandedDirs = writable<Set<string>>(new Set());

export function resetTree() {
  treeChildren.set(new Map());
  expandedDirs.set(new Set());
  clearTreeQuery();
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

/** Fold the whole tree back to its top level. */
export function collapseAll() {
  expandedDirs.set(new Set());
}

/** Expand every directory above `path`, fetching the ones not loaded yet.
 *
 *  What makes a search hit reachable: picking one has to leave the tree open at
 *  the file, not merely scrolled near it. */
export async function expandTo(path: string) {
  const parts = path.split("/").slice(0, -1);
  let dir = "";
  for (const part of parts) {
    dir = dir ? `${dir}/${part}` : part;
    if (!get(treeChildren).has(dir)) await loadDir(dir);
    expandedDirs.update((s) => new Set(s).add(dir));
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

/** One visible row: the entry and how deep it sits.
 *
 *  The tree is flattened before it is drawn rather than rendered recursively.
 *  Two things fall out of that and neither is cosmetic: a row can span the full
 *  width of the sidebar (a nested component indents its own hover highlight,
 *  which is why the old tree's selection stopped short of the left edge), and
 *  keyboard navigation becomes an index into an array instead of a walk. */
export interface TreeRow {
  entry: TreeEntry;
  depth: number;
}

/** The rows the tree currently shows, in display order. */
export function flattenTree(
  children: Map<string, TreeEntry[]>,
  expanded: Set<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of children.get(dir) ?? []) {
      rows.push({ entry, depth });
      if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

/* -------------------------------------------------------------- search */

/** What is in the explorer's search box. "" means the box is empty and the
 *  tree itself is showing. */
export const treeQuery = writable("");
/** Matches for the current query, or null when nothing has been searched. */
export const treeMatches = writable<TreeSearch | null>(null);
/** True while a search is in flight, so the box can say so rather than
 *  looking like it found nothing. */
export const treeSearching = writable(false);

/** Shortest query that is worth walking the tree for. One character matches
 *  most of a repository, which is a slow way to say nothing. */
export const MIN_TREE_QUERY = 2;

let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** Guards against an older, slower search overwriting a newer one's answer. */
let searchSeq = 0;

/** Type into the search box. Debounced: this walks the filesystem. */
export function setTreeQuery(query: string) {
  treeQuery.set(query);
  clearTimeout(searchTimer);
  const trimmed = query.trim();
  if (trimmed.length < MIN_TREE_QUERY) {
    searchSeq++;
    treeMatches.set(null);
    treeSearching.set(false);
    return;
  }
  treeSearching.set(true);
  searchTimer = setTimeout(() => void runTreeSearch(trimmed), 160);
}

async function runTreeSearch(query: string) {
  const seq = ++searchSeq;
  try {
    const found = await ipc.searchTree(query, treeRoot);
    if (seq !== searchSeq) return;
    treeMatches.set(found);
  } catch {
    if (seq !== searchSeq) return;
    treeMatches.set({ entries: [], truncated: false });
  } finally {
    if (seq === searchSeq) treeSearching.set(false);
  }
}

/** Create, rename and delete, against the root the tree is actually showing.
 *
 *  These live here rather than in the component for the same reason `loadDir`
 *  and `runTreeSearch` do: `treeRoot` is private to this module, and a caller
 *  that reaches for `ipc` directly gets the *project* root by default. With a
 *  worktree-bound tab that is a different checkout with the same relative
 *  paths — so a delete would land on a file of the same name in the main tree.
 *  Keeping the root out of reach makes that unspellable rather than merely
 *  unlikely. */
export function createEntry(dir: string, name: string, isDir: boolean): Promise<string> {
  return ipc.createEntry(dir, name, isDir, treeRoot);
}

export function renameEntry(path: string, name: string): Promise<string> {
  return ipc.renameEntry(path, name, treeRoot);
}

export function deleteEntry(path: string): Promise<void> {
  return ipc.deleteEntry(path, treeRoot);
}

/** Move an entry into `dir` ("" = the root), keeping its name. */
export function moveEntry(from: string, dir: string): Promise<string> {
  return ipc.moveEntry(from, dir, treeRoot);
}

/** Copy an entry into `dir`, suffixing the name if it is already taken. */
export function copyEntry(from: string, dir: string): Promise<string> {
  return ipc.copyEntry(from, dir, treeRoot);
}

/** The folder half of a path; "" for something at the top level. */
export function parentDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

/** True when `dir` is `path` itself or sits under it. Both a move and a copy
 *  into your own subtree are nonsense, and the backend refuses them — this is
 *  the same question asked early, so the drop target can decline to light up
 *  rather than erroring after the release. */
export function isSelfOrDescendant(dir: string, path: string): boolean {
  return dir === path || dir.startsWith(`${path}/`);
}

/* ----------------------------------------------------------- clipboard */

/** What Ctrl+C / Ctrl+X put down, waiting for a Ctrl+V.
 *
 *  Deliberately *not* the system clipboard. What the tree copies is a set of
 *  project-relative paths against the root the tree is showing, which is
 *  meaningless to any other application and, worse, would resolve to a
 *  different checkout's files if pasted into a tab bound to another worktree.
 *  A cut is also not a cut until it is pasted, so it has to survive as
 *  intent rather than as text. */
export type TreeClipboard = { paths: string[]; mode: "copy" | "cut" };

export const treeClipboard = writable<TreeClipboard | null>(null);

/** What a paste did: where each entry came from and where it landed. Both
 *  halves are needed to undo it — a copy is undone by removing what it made,
 *  a cut by moving each entry back to the folder it names. */
export interface PasteResult {
  mode: "copy" | "cut";
  pairs: { from: string; to: string }[];
}

/** Paste the clipboard into `dir`.
 *
 *  A cut empties the clipboard, a copy does not: pasting a copy again is the
 *  normal way to put a file in three places, while pasting a cut again would
 *  be moving files that are no longer where the clipboard says they are. */
export async function pasteInto(dir: string): Promise<PasteResult> {
  const board = get(treeClipboard);
  if (!board) return { mode: "copy", pairs: [] };
  const pairs: { from: string; to: string }[] = [];
  const failures: string[] = [];
  for (const from of board.paths) {
    // Skipped rather than failed: dragging a selection onto one of its own
    // folders is a normal slip, and the other entries should still land.
    if (isSelfOrDescendant(dir, from)) continue;
    try {
      const to = board.mode === "cut" ? await moveEntry(from, dir) : await copyEntry(from, dir);
      // A cut pasted into the folder it is already in moves nothing, so there
      // is nothing to undo either.
      if (to !== from) pairs.push({ from, to });
    } catch (err) {
      failures.push(String(err));
    }
  }
  if (board.mode === "cut") treeClipboard.set(null);
  const result: PasteResult = { mode: board.mode, pairs };
  if (failures.length) {
    // Thrown with what did land attached, so a partial paste is still undoable.
    throw Object.assign(new Error(failures.join("; ")), { result });
  }
  return result;
}

export function clearTreeQuery() {
  setTreeQuery("");
}

/** Re-run whatever is in the box (after a create, rename or delete). */
export function refreshTreeSearch() {
  const query = get(treeQuery).trim();
  if (query.length >= MIN_TREE_QUERY) void runTreeSearch(query);
}
