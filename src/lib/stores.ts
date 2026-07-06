import { get, writable } from "svelte/store";
import type { ChangeEntry, DiffTarget, GitStatus, LayoutNode, PaneNode, Project, VaultCommand } from "./types";
import { ipc } from "./ipc";
import { launchFor, launcherById } from "./settings";
import * as layoutOps from "./layout";
import * as terminals from "./terminals";
import { loadDir, resetTree } from "./filetree";

export const projects = writable<Project[]>([]);
export const activeProject = writable<Project | null>(null);
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

function persistLayout() {
  const project = get(activeProject);
  if (!project) return;
  const tree = get(layout);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    ipc.saveLayout(project.id, tree).catch(() => {});
    projects.update((list) =>
      list.map((p) => (p.id === project.id ? { ...p, layout: tree } : p)),
    );
  }, 500);
}

function setLayout(tree: LayoutNode | null) {
  layout.set(tree);
  persistLayout();
}

export async function loadProjects() {
  projects.set(await ipc.listProjects());
}

export async function openProject(project: Project) {
  await closeProject();
  activeProject.set(project);
  changes.set([]);

  let tree = project.layout;
  if (!tree) {
    tree = layoutOps.newPane(null, "shell");
  }
  layout.set(tree);
  focusedPaneId.set(layoutOps.collectPanes(tree)[0]?.id ?? null);

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
  await ipc.saveLayout(current.id, get(layout)).catch(() => {});
  terminals.destroyAll();
  await ipc.stopSession().catch(() => {});
  activeProject.set(null);
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
}
