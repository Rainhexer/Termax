import { get, writable } from "svelte/store";
import type { ChangeEntry, DiffTarget, GitStatus, LayoutNode, PaneNode, Project, Tab, VaultCommand, Workspace } from "./types";
import { ipc } from "./ipc";
import { launchFor, launcherById } from "./settings";
import * as layoutOps from "./layout";
import * as terminals from "./terminals";
import { loadDir, resetTree } from "./filetree";

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
export const diffTarget = writable<DiffTarget | null>(null);
export const sidebarCollapsed = writable(false);
/** null = no git repo (snapshot mode). */
export const gitStatus = writable<GitStatus | null>(null);
export const gitMode = writable(false);
export const showUntracked = writable(true);
/** Bumped (debounced) on every fs-changed event; drives file-tree refresh. */
export const fsTick = writable(0);
/** Change-entry path to scroll to / flash in the Changes panel. */
export const highlightedChange = writable<string | null>(null);
/** When true (default), editor panes are read-only. Toggled by the Explorer lock. */
export const explorerLocked = writable(true);
/** Bumped on every attempted edit while locked, to drive the lock icon flash. */
export const lockFlash = writable(0);

const untrackedKey = (projectId: string) => `termix.showUntracked.${projectId}`;

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
  activeProject.set(project);
  changes.set([]);

  const ws = loadWorkspace(project);
  tabs.set(ws.tabs);
  activateTab(ws.tabs.find((t) => t.id === ws.activeTabId)!);

  showUntracked.set(localStorage.getItem(untrackedKey(project.id)) !== "false");

  resetTree();
  try {
    const info = await ipc.startSession(project.path);
    gitMode.set(info.git);
    if (info.git) await refreshChanges();
    await loadDir("");
  } catch (err) {
    console.error("start_session failed", err);
  }
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
  activeProject.set(null);
  tabs.set([]);
  activeTabId.set(null);
  layout.set(null);
  focusedPaneId.set(null);
  changes.set([]);
  diffTarget.set(null);
  gitStatus.set(null);
  gitMode.set(false);
  highlightedChange.set(null);
  resetTree();
}

/** Open a new pane: split the focused pane, or become the root if layout is empty. */
export function addPane(launch: string | null, title: string, dir: "row" | "col" = "row"): string {
  const pane = layoutOps.newPane(launch, title);
  const tree = get(layout);
  if (!tree) {
    setLayout(pane);
  } else {
    const target = get(focusedPaneId) ?? layoutOps.collectPanes(tree).at(-1)!.id;
    setLayout(layoutOps.splitPane(tree, target, pane, dir));
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

/** Open a file in an editor pane; focuses the existing pane if already open. */
export function openFile(path: string) {
  const tree = get(layout);
  const existing = layoutOps
    .collectPanes(tree)
    .find((p) => p.kind === "editor" && p.file === path);
  if (existing) {
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
  };
  if (!tree) {
    setLayout(pane);
  } else {
    const target = get(focusedPaneId) ?? layoutOps.collectPanes(tree).at(-1)!.id;
    setLayout(layoutOps.splitPane(tree, target, pane, "row"));
  }
  focusedPaneId.set(pane.id);
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
  setLayout(layoutOps.swapPanes(tree, fromId, toId));
}

export function splitPaneAt(fromId: string, targetId: string, dir: "row" | "col", before = false) {
  if (fromId === targetId) return;
  const tree = get(layout);
  if (!tree) return;
  const result = layoutOps.movePaneToSplit(tree, fromId, targetId, dir, before);
  if (result) setLayout(result);
  focusedPaneId.set(targetId);
}

export function resizeSplit(splitId: string, ratio: number) {
  const tree = get(layout);
  if (!tree) return;
  setLayout(layoutOps.setRatio(tree, splitId, ratio));
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

/** Wire global PTY listeners; pane auto-closes when its process exits. */
export function initListeners() {
  terminals.initPtyListeners((paneId) => closePane(paneId));
  terminals.initFileDrop();
}
