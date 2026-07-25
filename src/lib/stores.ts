import { derived, get, writable } from "svelte/store";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ChangeEntry, GitStatus, LayoutNode, PaneNode, Project, Tab, VaultCommand, Workspace } from "./types";
import { ipc } from "./ipc";
import { launchFor, launcherById } from "./settings";
import * as layoutOps from "./layout";
import * as terminals from "./terminals";
import { loadDir, resetTree } from "./filetree";
import { attentionPanes, bellPanes, setFocusedPane } from "./bell";

export const projects = writable<Project[]>([]);
export const activeProject = writable<Project | null>(null);
/** All tabs in the active project. */
export const tabs = writable<Tab[]>([]);
/** Id of the tab whose grid is currently shown. */
export const activeTabId = writable<string | null>(null);
/** Working grid of the active tab. Pane ops mutate this; tab switches swap it. */
export const layout = writable<LayoutNode | null>(null);
export const focusedPaneId = writable<string | null>(null);
export const changes = writable<ChangeEntry[]>([]);
export const sidebarCollapsed = writable(false);
/** null = no git repo (snapshot mode). */
export const gitStatus = writable<GitStatus | null>(null);
export const gitMode = writable(false);
/** True while a fetch or pull is running; disables the remote buttons. */
export const gitBusy = writable(false);
/** Last fetch/pull error message, shown in the Changes panel; null when clear. */
export const gitError = writable<string | null>(null);
/** Transient status line for the last git action ("Fetching…", "Up to date",
 *  "On main", …), shown in the Changes panel; auto-clears. null when idle. */
export const gitMessage = writable<string | null>(null);
export const showUntracked = writable(true);
/** True when the active folder was opened untrusted: git is disabled until the
 *  user trusts it. Drives the "trust folder" banner in the Changes panel. */
export const restricted = writable(false);
/** True once the backend session for the active project is up. Editor panes and
 *  other fs-reading views wait for this: a restored layout mounts before
 *  `start_session` resolves, and reading a file too early fails with
 *  "no active session". */
export const sessionReady = writable(false);
/** Bumped (debounced) on every fs-changed event; drives file-tree refresh. */
export const fsTick = writable(0);
/** Change-entry path to scroll to / flash in the Changes panel. */
export const highlightedChange = writable<string | null>(null);
/** When true (default), editor panes are read-only. Toggled by the Explorer lock. */
export const explorerLocked = writable(true);
/** Bumped on every attempted edit while locked, to drive the lock icon flash. */
export const lockFlash = writable(0);
/** Pixel size of the tiling area, kept current by App.svelte. Drives automatic
 *  placement of new panes; the zeros are replaced on first layout. */
export const paneAreaSize = writable<layoutOps.Size>({ w: 0, h: 0 });

/** Id of the pane currently maximized (fills the entire tiling area). */
export const maximizedPaneId = writable<string | null>(null);

/** Toggle a pane between maximized and normal. */
export function toggleMaximizedPane(paneId: string) {
  maximizedPaneId.update((current) => (current === paneId ? null : paneId));
}

/** Tracks the pane being dragged (WKWebView workaround: dataTransfer.getData
 *  returns empty in drop events on macOS). */
export const draggedPaneId = writable<string | null>(null);
/** Tracks the tab being dragged along the tab bar (same WKWebView workaround). */
export const draggedTabId = writable<string | null>(null);

const untrackedKey = (projectId: string) => `termax.showUntracked.${projectId}`;

export function toggleUntracked() {
  const project = get(activeProject);
  showUntracked.update((v) => {
    const next = !v;
    if (project) localStorage.setItem(untrackedKey(project.id), String(next));
    return next;
  });
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Fold the live grid (`layout`/`focusedPaneId`) back into the active tab. */
function syncActiveTab() {
  const id = get(activeTabId);
  tabs.update((list) =>
    list.map((t) =>
      t.id === id ? { ...t, layout: get(layout), focusedPaneId: get(focusedPaneId) } : t,
    ),
  );
}

function persistLayout() {
  const project = get(activeProject);
  if (!project) return;
  syncActiveTab();
  const workspace: Workspace = { tabs: get(tabs), activeTabId: get(activeTabId)! };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    ipc.saveLayout(project.id, workspace).catch(() => {});
    projects.update((list) =>
      list.map((p) => (p.id === project.id ? { ...p, layout: workspace } : p)),
    );
  }, 500);
}

function setLayout(tree: LayoutNode | null) {
  layout.set(tree);
  persistLayout();
}

/** Build the tab set for a project, migrating legacy single-layout saves. */
function loadWorkspace(project: Project): Workspace {
  const raw = project.layout as Workspace | LayoutNode | null;
  if (raw && "tabs" in raw && Array.isArray(raw.tabs) && raw.tabs.length) {
    const activeId = raw.tabs.some((t) => t.id === raw.activeTabId)
      ? raw.activeTabId
      : raw.tabs[0].id;
    return { tabs: raw.tabs, activeTabId: activeId };
  }
  // Legacy: bare LayoutNode (or null) → wrap in a single tab.
  const tree = raw && "type" in raw ? (raw as LayoutNode) : layoutOps.newPane(null, "shell");
  const tab: Tab = {
    id: crypto.randomUUID(),
    title: "Tab 1",
    layout: tree,
    focusedPaneId: layoutOps.collectPanes(tree)[0]?.id ?? null,
  };
  return { tabs: [tab], activeTabId: tab.id };
}

/** Load a tab's grid into the live stores (does not touch other tabs). */
function activateTab(tab: Tab) {
  activeTabId.set(tab.id);
  layout.set(tab.layout);
  focusedPaneId.set(tab.focusedPaneId ?? layoutOps.collectPanes(tab.layout)[0]?.id ?? null);
}

/** Switch to another tab, saving the current grid first. */
export function switchTab(id: string) {
  if (get(activeTabId) === id) return;
  syncActiveTab();
  const next = get(tabs).find((t) => t.id === id);
  if (!next) return;
  activateTab(next);
  persistLayout();
}

/** Open a fresh tab with one shell and switch to it. */
export function newTab() {
  syncActiveTab();
  const pane = layoutOps.newPane(null, "shell");
  const tab: Tab = {
    id: crypto.randomUUID(),
    title: `Tab ${get(tabs).length + 1}`,
    layout: pane,
    focusedPaneId: pane.id,
  };
  tabs.update((list) => [...list, tab]);
  activateTab(tab);
  persistLayout();
}

/** Close a tab, destroying its terminals. Never removes the last tab. */
export function closeTab(id: string) {
  const list = get(tabs);
  if (list.length <= 1) return;
  const tab = list.find((t) => t.id === id);
  if (!tab) return;
  for (const p of layoutOps.collectPanes(tab.layout)) {
    for (const [cmdId, linked] of commandPanes) {
      if (linked === p.id) commandPanes.delete(cmdId);
    }
    terminals.destroyPane(p.id);
  }
  const idx = list.findIndex((t) => t.id === id);
  const remaining = list.filter((t) => t.id !== id);
  const wasActive = get(activeTabId) === id;
  tabs.set(remaining);
  if (wasActive) activateTab(remaining[Math.min(idx, remaining.length - 1)]);
  persistLayout();
}

/** Switch to the tab `dir` steps from the active one, wrapping around. */
export function cycleTab(dir: 1 | -1) {
  const list = get(tabs);
  if (list.length <= 1) return;
  const idx = list.findIndex((t) => t.id === get(activeTabId));
  if (idx === -1) return;
  const next = list[(idx + dir + list.length) % list.length];
  switchTab(next.id);
}

/** Move the tab `id` to `toIndex` in the bar (index in the pre-move list). */
export function reorderTab(id: string, toIndex: number) {
  const list = get(tabs);
  const from = list.findIndex((t) => t.id === id);
  if (from === -1) return;
  const clamped = Math.max(0, Math.min(list.length, toIndex));
  // Dropping just before or just after itself is a no-op.
  if (clamped === from || clamped === from + 1) return;
  const next = [...list];
  const [tab] = next.splice(from, 1);
  next.splice(clamped > from ? clamped - 1 : clamped, 0, tab);
  tabs.set(next);
  persistLayout();
}

/** Shift the active tab one slot left (-1) or right (1). */
export function moveActiveTab(dir: 1 | -1) {
  const list = get(tabs);
  const idx = list.findIndex((t) => t.id === get(activeTabId));
  if (idx === -1) return;
  const target = idx + dir;
  if (target < 0 || target >= list.length) return;
  reorderTab(list[idx].id, dir === 1 ? target + 1 : target);
}

/** Cut `paneId` out of whichever non-active tab owns it, dropping that tab if it
 *  empties. Returns the detached node (terminal keeps running — the terminal
 *  registry is keyed by pane id and lives outside the component tree). */
function cutPaneFromOtherTab(paneId: string): PaneNode | null {
  const activeId = get(activeTabId);
  const list = get(tabs);
  const owner = list.find((t) => t.id !== activeId && layoutOps.findPane(t.layout, paneId));
  if (!owner?.layout) return null;
  const pane = layoutOps.findPane(owner.layout, paneId)!;
  const rest = layoutOps.removePane(owner.layout, paneId);
  let next = list.map((t) =>
    t.id === owner.id
      ? {
          ...t,
          layout: rest,
          focusedPaneId:
            t.focusedPaneId === paneId ? (layoutOps.collectPanes(rest)[0]?.id ?? null) : t.focusedPaneId,
        }
      : t,
  );
  if (!rest && next.length > 1) next = next.filter((t) => t.id !== owner.id);
  tabs.set(next);
  return pane;
}

/** Move a pane into another tab, grafting it onto that tab's grid root.
 *  The pane's terminal is not destroyed — it re-attaches when the tab renders. */
export function movePaneToTab(paneId: string, toTabId: string) {
  if (get(activeTabId) === toTabId) return;
  syncActiveTab();
  const list = get(tabs);
  const from = list.find((t) => layoutOps.findPane(t.layout, paneId));
  const to = list.find((t) => t.id === toTabId);
  if (!from || !to || from.id === to.id || !from.layout) return;

  const pane = layoutOps.findPane(from.layout, paneId)!;
  const rest = layoutOps.removePane(from.layout, paneId);
  let next = list.map((t) => {
    if (t.id === from.id) {
      return {
        ...t,
        layout: rest,
        focusedPaneId:
          t.focusedPaneId === paneId ? (layoutOps.collectPanes(rest)[0]?.id ?? null) : t.focusedPaneId,
      };
    }
    if (t.id === to.id) {
      return { ...t, layout: layoutOps.appendPane(t.layout, pane), focusedPaneId: paneId };
    }
    return t;
  });
  // Source tab left empty: drop it and follow the pane to its new home.
  const dropSource = !rest && next.length > 1;
  if (dropSource) next = next.filter((t) => t.id !== from.id);
  tabs.set(next);

  const active = next.find((t) => t.id === get(activeTabId));
  if (!active) {
    activateTab(next.find((t) => t.id === toTabId)!);
  } else if (active.id === from.id || active.id === to.id) {
    layout.set(active.layout);
    focusedPaneId.set(active.focusedPaneId ?? layoutOps.collectPanes(active.layout)[0]?.id ?? null);
  }
  persistLayout();
}

/** Tear a pane out into a brand-new tab and switch to it. */
export function movePaneToNewTab(paneId: string) {
  syncActiveTab();
  const list = get(tabs);
  const from = list.find((t) => layoutOps.findPane(t.layout, paneId));
  if (!from?.layout) return;
  // A lone pane in its own tab is already a tab of its own.
  if (layoutOps.collectPanes(from.layout).length === 1) return;
  const pane = layoutOps.findPane(from.layout, paneId)!;
  const rest = layoutOps.removePane(from.layout, paneId);
  const tab: Tab = {
    id: crypto.randomUUID(),
    title: pane.title,
    layout: pane,
    focusedPaneId: pane.id,
  };
  tabs.set([
    ...list.map((t) =>
      t.id === from.id
        ? {
            ...t,
            layout: rest,
            focusedPaneId:
              t.focusedPaneId === paneId ? (layoutOps.collectPanes(rest)[0]?.id ?? null) : t.focusedPaneId,
          }
        : t,
    ),
    tab,
  ]);
  activateTab(tab);
  persistLayout();
}

export function renameTab(id: string, title: string) {
  const name = title.trim();
  if (!name) return;
  tabs.update((list) => list.map((t) => (t.id === id ? { ...t, title: name } : t)));
  persistLayout();
}

export async function loadProjects() {
  projects.set(await ipc.listProjects());
}

export async function openProject(project: Project) {
  await closeProject();
  sessionReady.set(false);
  activeProject.set(project);
  changes.set([]);

  const ws = loadWorkspace(project);
  tabs.set(ws.tabs);
  activateTab(ws.tabs.find((t) => t.id === ws.activeTabId)!);

  showUntracked.set(localStorage.getItem(untrackedKey(project.id)) !== "false");

  resetTree();

  // Folder trust: opening a project runs git, which reads .git/config — the
  // untrusted-repo code-execution vector. Prompt on first open; a declined or
  // not-yet-trusted folder opens in restricted (snapshot-only, no git) mode.
  let trusted = await ipc.isTrusted(project.path);
  if (!trusted) {
    trusted = await ask(
      `Termax runs git and can execute commands in this folder.\n\n${project.path}\n\nDo you trust the authors of the files here?`,
      { title: "Trust this folder?", kind: "warning", okLabel: "Trust folder", cancelLabel: "Open restricted" },
    );
    if (trusted) await ipc.trustFolder(project.path).catch(() => {});
  }

  try {
    const info = await ipc.startSession(project.path, trusted);
    gitMode.set(info.git);
    restricted.set(info.restricted);
    sessionReady.set(true);
    if (info.git) await refreshChanges();
    await loadDir("");
  } catch (err) {
    console.error("start_session failed", err);
  }
}

/** Trust the currently open folder and re-open it so git activates. */
export async function trustCurrentFolder() {
  const project = get(activeProject);
  if (!project) return;
  await ipc.trustFolder(project.path).catch(() => {});
  await openProject(project);
}

export async function closeProject() {
  const current = get(activeProject);
  if (!current) return;
  clearTimeout(saveTimer);
  syncActiveTab();
  const workspace: Workspace = { tabs: get(tabs), activeTabId: get(activeTabId)! };
  await ipc.saveLayout(current.id, workspace).catch(() => {});
  terminals.destroyAll();
  await ipc.stopSession().catch(() => {});
  sessionReady.set(false);
  activeProject.set(null);
  tabs.set([]);
  activeTabId.set(null);
  layout.set(null);
  focusedPaneId.set(null);
  changes.set([]);
  gitStatus.set(null);
  gitMode.set(false);
  gitBusy.set(false);
  gitError.set(null);
  gitMessage.set(null);
  restricted.set(false);
  highlightedChange.set(null);
  resetTree();
}

/** Open a new pane: split the focused pane, or become the root if layout is empty. */
/** Where an automatically placed pane should go, and how it should be split.
 *  Falls back to the focused pane when the tiling area has not been measured
 *  yet (first paint) or is degenerate. */
function autoPlacement(tree: LayoutNode): { target: string; dir: "row" | "col" } {
  const view = get(paneAreaSize);
  if (view.w > 0 && view.h > 0) {
    const placement = layoutOps.choosePlacement(tree, view);
    return { target: placement.targetId, dir: placement.dir };
  }
  const target = get(focusedPaneId) ?? layoutOps.collectPanes(tree).at(-1)!.id;
  return { target, dir: "row" };
}

/** Open a new pane. With no `dir`, the spot is chosen automatically (split the
 *  biggest pane that stays above the minimum size); passing `dir` forces a
 *  split of the focused pane along that axis. */
export function addPane(launch: string | null, title: string, dir?: "row" | "col"): string {
  const pane = layoutOps.newPane(launch, title);
  const tree = get(layout);
  if (!tree) {
    setLayout(pane);
  } else if (dir) {
    const target = get(focusedPaneId) ?? layoutOps.collectPanes(tree).at(-1)!.id;
    setLayout(layoutOps.splitPane(tree, target, pane, dir));
  } else {
    const { target, dir: autoDir } = autoPlacement(tree);
    setLayout(layoutOps.splitPane(tree, target, pane, autoDir));
  }
  focusedPaneId.set(pane.id);
  return pane.id;
}

// Links a vault command to the pane it last opened. Reuse that pane while it
// lives; once it closes, the next run opens a fresh terminal.
const commandPanes = new Map<string, string>();

export function runVaultCommand(cmd: VaultCommand) {
  const linked = commandPanes.get(cmd.id);
  if (linked && terminals.isAlive(linked)) {
    focusedPaneId.set(linked);
    terminals.runInPane(linked, cmd.command);
    return;
  }
  const paneId = addPane(launchFor(cmd.terminalType), launcherById(cmd.terminalType).name);
  commandPanes.set(cmd.id, paneId);
  terminals.queueRun(paneId, cmd.command);
}

export function splitFocused(dir: "row" | "col") {
  addPane(null, "shell", dir);
}

/** Open a file in an editor pane; focuses the existing pane if already open.
 *  `diff` opens (or flips an already-open pane) straight to the changes view. */
export function openFile(path: string, opts: { diff?: boolean } = {}) {
  const tree = get(layout);
  const existing = layoutOps
    .collectPanes(tree)
    .find((p) => p.kind === "editor" && p.file === path);
  if (existing) {
    if (opts.diff && !existing.diff) {
      setLayout(layoutOps.setPaneDiff(tree!, existing.id, true));
    }
    focusedPaneId.set(existing.id);
    return;
  }
  const name = path.split("/").pop() ?? path;
  const pane: PaneNode = {
    type: "pane",
    id: crypto.randomUUID(),
    title: name,
    launch: null,
    kind: "editor",
    file: path,
    diff: opts.diff,
  };
  if (!tree) {
    setLayout(pane);
  } else {
    const { target, dir } = autoPlacement(tree);
    setLayout(layoutOps.splitPane(tree, target, pane, dir));
  }
  focusedPaneId.set(pane.id);
}

/** Persist an editor pane's diff-view toggle so it survives reloads/restarts. */
export function setPaneDiff(paneId: string, diff: boolean) {
  const tree = get(layout);
  if (!tree) return;
  setLayout(layoutOps.setPaneDiff(tree, paneId, diff));
}

export function closePane(paneId: string) {
  for (const [cmdId, linked] of commandPanes) {
    if (linked === paneId) commandPanes.delete(cmdId);
  }
  terminals.destroyPane(paneId);
  const tree = get(layout);
  if (!tree) return;
  setLayout(layoutOps.removePane(tree, paneId));
  if (get(focusedPaneId) === paneId) {
    focusedPaneId.set(layoutOps.collectPanes(get(layout))[0]?.id ?? null);
  }
}

export function movePane(fromId: string, toId: string) {
  if (fromId === toId) return;
  const tree = get(layout);
  if (!tree) return;
  // Pane dragged in from another tab: no position to swap with, so graft it
  // next to the drop target instead.
  if (!layoutOps.findPane(tree, fromId)) {
    splitPaneAt(fromId, toId, "row");
    return;
  }
  setLayout(layoutOps.swapPanes(tree, fromId, toId));
}

export function splitPaneAt(fromId: string, targetId: string, dir: "row" | "col", before = false) {
  if (fromId === targetId) return;
  const tree = get(layout);
  if (!tree) return;
  if (!layoutOps.findPane(tree, fromId)) {
    const pane = cutPaneFromOtherTab(fromId);
    if (!pane) return;
    setLayout(layoutOps.splitPane(tree, targetId, pane, dir, before));
    focusedPaneId.set(pane.id);
    return;
  }
  const result = layoutOps.movePaneToSplit(tree, fromId, targetId, dir, before);
  if (result) setLayout(result);
  focusedPaneId.set(targetId);
}

export function resizeSplit(splitId: string, ratio: number) {
  const tree = get(layout);
  if (!tree) return;
  setLayout(layoutOps.setRatio(tree, splitId, ratio));
}

export function resizeCorners(rowSplitIds: string[], rowRatio: number, colSplitIds: string[], colRatio: number) {
  const tree = get(layout);
  if (!tree) return;
  let newTree = tree;
  for (const id of rowSplitIds) newTree = layoutOps.setRatio(newTree, id, rowRatio);
  for (const id of colSplitIds) newTree = layoutOps.setRatio(newTree, id, colRatio);
  setLayout(newTree);
}

export async function refreshChanges() {
  try {
    const [entries, status] = await Promise.all([
      ipc.getChanges(),
      get(gitMode) ? ipc.getGitStatus() : Promise.resolve(null),
    ]);
    changes.set(entries);
    gitStatus.set(status);
  } catch {
    changes.set([]);
    gitStatus.set(null);
  }
}

/** Show a transient status line, auto-clearing after a delay unless another
 *  message replaces it first (guarded by a monotonic token). */
let gitMsgToken = 0;
function flashGitMessage(msg: string, ms = 4000) {
  const token = ++gitMsgToken;
  gitMessage.set(msg);
  setTimeout(() => {
    if (gitMsgToken === token) gitMessage.set(null);
  }, ms);
}

/** Fetch from the remote to refresh ahead/behind against the real upstream,
 *  reporting the resulting state ("Up to date" / "N behind"). */
export async function fetchRemote() {
  if (!get(gitMode) || get(gitBusy)) return;
  gitBusy.set(true);
  gitError.set(null);
  gitMessage.set("Fetching…");
  gitMsgToken++;
  try {
    const after = await ipc.gitFetch();
    gitStatus.set(after);
    const target = after.upstream ?? "upstream";
    if (after.behind === 0) {
      flashGitMessage(`Up to date with ${target}`);
    } else {
      const n = after.behind;
      flashGitMessage(`${n} commit${n === 1 ? "" : "s"} behind ${target}`);
    }
  } catch (err) {
    gitMessage.set(null);
    gitError.set(String(err));
  } finally {
    gitBusy.set(false);
  }
}

/** Fast-forward pull, then refresh the panel. Surfaces git's error on failure. */
export async function pullRemote() {
  if (!get(gitMode) || get(gitBusy)) return;
  gitBusy.set(true);
  gitError.set(null);
  gitMessage.set("Pulling…");
  gitMsgToken++;
  try {
    const out = await ipc.gitPull();
    await refreshChanges();
    flashGitMessage(/already up to date/i.test(out) ? "Already up to date" : "Pulled — fast-forwarded");
  } catch (err) {
    gitMessage.set(null);
    gitError.set(String(err));
  } finally {
    gitBusy.set(false);
  }
}

/** Local branch names for the switcher; empty on failure. */
export async function loadBranches(): Promise<string[]> {
  if (!get(gitMode)) return [];
  try {
    return await ipc.gitBranches();
  } catch {
    return [];
  }
}

/** Switch branches, then refresh the panel. Git's error (e.g. dirty worktree)
 *  is surfaced verbatim on failure. */
export async function checkoutBranch(branch: string) {
  if (!get(gitMode) || get(gitBusy)) return;
  if (get(gitStatus)?.branch === branch) return;
  gitBusy.set(true);
  gitError.set(null);
  gitMessage.set(`Switching to ${branch}…`);
  gitMsgToken++;
  try {
    gitStatus.set(await ipc.gitCheckout(branch));
    await refreshChanges();
    flashGitMessage(`On ${branch}`);
  } catch (err) {
    gitMessage.set(null);
    gitError.set(String(err));
  } finally {
    gitBusy.set(false);
  }
}

/** Open the current branch on the remote host (GitHub-style /tree/ URL).
 *  Surfaces a message on success and the error on failure so the action is
 *  never silently a no-op. */
export async function openBranchOnRemote() {
  const status = get(gitStatus);
  if (!status?.remoteUrl) {
    flashGitMessage("No remote configured");
    return;
  }
  // Preserve slashes in branch names (feature/foo) while escaping each segment.
  const ref = status.branch.split("/").map(encodeURIComponent).join("/");
  const url = `${status.remoteUrl}/tree/${ref}`;
  try {
    await ipc.openUrl(url);
    flashGitMessage("Opened in browser");
  } catch (err) {
    gitError.set(String(err));
  }
}

/** Turn the bell watch on/off for a pane; persisted with the layout. */
export function togglePaneBell(paneId: string) {
  const tree = get(layout);
  if (!tree) return;
  const pane = layoutOps.findPane(tree, paneId);
  if (!pane) return;
  setLayout(layoutOps.setPaneBell(tree, paneId, !pane.bell));
}

/** Mirror the layout's bell flags into the terminal layer's lookup set. The
 *  active tab's copy in `tabs` is stale between syncs, so read it from `layout`. */
function syncBellPanes() {
  const ids = new Set<string>();
  const add = (tree: LayoutNode | null) => {
    for (const p of layoutOps.collectPanes(tree)) if (p.bell) ids.add(p.id);
  };
  const activeId = get(activeTabId);
  for (const t of get(tabs)) if (t.id !== activeId) add(t.layout);
  add(get(layout));
  bellPanes.set(ids);
}

tabs.subscribe(syncBellPanes);
layout.subscribe(syncBellPanes);

// Focusing a pane acknowledges its bell.
focusedPaneId.subscribe(setFocusedPane);

/** Tab ids holding at least one ringing pane; drives the tab bar pulse. */
export const tabsWithAttention = derived(
  [tabs, layout, activeTabId, attentionPanes],
  ([$tabs, $layout, $activeTabId, $attention]) => {
    const out = new Set<string>();
    if (!$attention.size) return out;
    for (const t of $tabs) {
      const tree = t.id === $activeTabId ? $layout : t.layout;
      if (layoutOps.collectPanes(tree).some((p) => $attention.has(p.id))) out.add(t.id);
    }
    return out;
  },
);

/** Wire global PTY listeners; pane auto-closes when its process exits. */
export function initListeners() {
  terminals.initPtyListeners((paneId) => closePane(paneId));
  terminals.initFileDrop();
}
