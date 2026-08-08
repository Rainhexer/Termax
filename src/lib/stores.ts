import { derived, get, writable } from "svelte/store";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ChangeEntry, GitStatus, LayoutNode, PaneNode, Project, Tab, VaultCommand, Workspace, Worktree } from "./types";
import { ipc } from "./ipc";
import { launchFor, launcherById, settings as appSettings } from "./settings";
import * as layoutOps from "./layout";
import * as terminals from "./terminals";
import { loadDir, resetTree } from "./filetree";
import { attentionPanes, bellPanes, setFocusedPane } from "./bell";
import { clearPaneScroll } from "./paneScroll";

export const projects = writable<Project[]>([]);
export const activeProject = writable<Project | null>(null);
/** All tabs in the active project. */
export const tabs = writable<Tab[]>([]);
/** Id of the tab whose grid is currently shown. */
export const activeTabId = writable<string | null>(null);
/** Worktrees referenced by this project's tabs, persisted with the workspace.
 *
 *  Lives here rather than in worktrees.ts because `loadWorkspace` and
 *  `persistLayout` both need it; worktrees.ts re-exports it and owns all the
 *  behaviour. */
export const worktrees = writable<Worktree[]>([]);
/** Working grid of the active tab. Pane ops mutate this; tab switches swap it. */
export const layout = writable<LayoutNode | null>(null);
export const focusedPaneId = writable<string | null>(null);
export const sidebarCollapsed = writable(false);

/** Change tracking for one root. */
export interface RootGit {
  status: GitStatus | null;
  changes: ChangeEntry[];
}

const EMPTY_ROOT_GIT: RootGit = { status: null, changes: [] };

/** Change tracking per root: the project plus any open worktrees.
 *
 *  Several roots can be live at once (one per worktree-bound tab), and each has
 *  its own watcher and its own state. Keeping them in one map rather than in
 *  separate stores is what lets a background worktree stay up to date while you
 *  look at another one. */
export const gitByRoot = writable<Map<string, RootGit>>(new Map());

/** Canonical path of the project root, as the backend reported it.
 *
 *  Distinct from `activeProject.path`, which is the raw string the user picked.
 *  Every root that reaches `gitByRoot` must be canonical or lookups silently miss
 *  — on macOS `/var` and `/private/var` are the same directory but not the same
 *  key. Sessions are keyed canonically, so this is the form to compare against. */
export const primaryRoot = writable<string | null>(null);

/** Root the sidebar, file tree, and editor panes currently describe: the active
 *  tab's worktree, else the project root. Set by worktrees.ts, which owns the
 *  tab→worktree resolution; it lives here so `changes`/`gitStatus` can derive
 *  from it without stores.ts depending on that module. */
export const activeRoot = writable<string | null>(null);

/** Changes for the active root.
 *
 *  Derived rather than written, which is the move that keeps this refactor
 *  small: ChangesPanel, FileTree, and filetree.ts all read `$changes` and needed
 *  no edits at all when tracking became per-root. */
export const changes = derived([gitByRoot, activeRoot], ([byRoot, root]) =>
  root ? (byRoot.get(root) ?? EMPTY_ROOT_GIT).changes : [],
);

/** Git status for the active root; null = no git repo (snapshot mode). */
export const gitStatus = derived([gitByRoot, activeRoot], ([byRoot, root]) =>
  root ? (byRoot.get(root) ?? EMPTY_ROOT_GIT).status : null,
);

export const gitMode = writable(false);
/** True while a fetch or pull is running; disables the remote buttons. */
export const gitBusy = writable(false);
/** Last fetch/pull/checkout error message, shown in the Changes panel; null when
 *  clear. Cleared when the user dismisses it or the next action starts. */
export const gitError = writable<string | null>(null);
/** Error from reading the change list itself, as opposed to a git *action*
 *  failing. Kept separate because the two mean different things to the user:
 *  "your pull failed" is recoverable, "change tracking is broken" means every
 *  number on screen is untrustworthy. */
export const changesError = writable<string | null>(null);
/** Why the backend session failed to start, if it did. Non-null means the whole
 *  project view is inert — panes cannot read files — so the UI must say so
 *  instead of showing an eternal "Opening session…". */
export const sessionError = writable<string | null>(null);
/** Transient status line for the last git action ("Fetching…", "Up to date",
 *  "On main", …), shown in the Changes panel; auto-clears. null when idle. */
export const gitMessage = writable<string | null>(null);
export const showUntracked = writable(true);
export const showStaged = writable(true);
export const showUnstaged = writable(true);
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
const stagedKey = (projectId: string) => `termax.showStaged.${projectId}`;
const unstagedKey = (projectId: string) => `termax.showUnstaged.${projectId}`;

export function toggleUntracked() {
  const project = get(activeProject);
  showUntracked.update((v) => {
    const next = !v;
    if (project) localStorage.setItem(untrackedKey(project.id), String(next));
    return next;
  });
}

export function toggleStaged() {
  const project = get(activeProject);
  showStaged.update((v) => {
    const next = !v;
    if (project) localStorage.setItem(stagedKey(project.id), String(next));
    return next;
  });
}

export function toggleUnstaged() {
  const project = get(activeProject);
  showUnstaged.update((v) => {
    const next = !v;
    if (project) localStorage.setItem(unstagedKey(project.id), String(next));
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
  const workspace: Workspace = {
    tabs: get(tabs),
    activeTabId: get(activeTabId)!,
    worktrees: get(worktrees),
  };
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
    // A workspace saved before worktree support has no `worktrees` key, and no
    // tab carries a `worktreeId` — so every tab resolves to the project root,
    // exactly as it did before. That is the entire migration.
    return {
      tabs: raw.tabs,
      activeTabId: activeId,
      worktrees: Array.isArray(raw.worktrees) ? raw.worktrees : [],
    };
  }
  // Legacy: bare LayoutNode (or null) → wrap in a single tab.
  const tree = raw && "type" in raw ? (raw as LayoutNode) : layoutOps.newPane(null, "shell", get(appSettings).behavior.defaultBell);
  const tab: Tab = {
    id: crypto.randomUUID(),
    title: "Tab 1",
    layout: tree,
    focusedPaneId: layoutOps.collectPanes(tree)[0]?.id ?? null,
  };
  return { tabs: [tab], activeTabId: tab.id };
}

/** Pane ids in a tab, reading the live grid for the active one (its copy inside
 *  `tabs` is stale between syncs). */
export function collectTabPanes(tab: Tab): string[] {
  const tree = tab.id === get(activeTabId) ? get(layout) : tab.layout;
  return layoutOps.collectPanes(tree).map((p) => p.id);
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

/** Next unused "Tab N" name.
 *
 *  Counting existing tabs produced duplicates: close Tab 2 of 3 and the next new
 *  tab is also "Tab 3". Scan for the lowest free number instead. */
function nextTabTitle(list: Tab[]): string {
  const taken = new Set(list.map((t) => t.title));
  for (let n = 1; ; n++) {
    const candidate = `Tab ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Open a fresh tab and switch to it.
 *
 *  `worktreeId` binds the tab to a worktree so its panes spawn there instead of
 *  in the project root; pass `null` to force the project root. Omitting it
 *  *inherits the active tab's worktree*, because the alternative is worse: "+"
 *  while working on a PR would silently open a shell on a different branch's
 *  files than the tab you were just looking at.
 *
 *  `launch`/`title` seed the first pane, which is how "start work on this PR"
 *  opens an agent in a new worktree in one step. */
export function newTab(
  opts: {
    worktreeId?: string | null;
    launch?: string | null;
    title?: string;
    tabTitle?: string;
  } = {},
): Tab {
  syncActiveTab();
  const pane = layoutOps.newPane(
    opts.launch ?? null,
    opts.title ?? "shell",
    get(appSettings).behavior.defaultBell,
  );
  const inherited = get(tabs).find((t) => t.id === get(activeTabId))?.worktreeId;
  const worktreeId = opts.worktreeId === undefined ? inherited : (opts.worktreeId ?? undefined);
  const tab: Tab = {
    id: crypto.randomUUID(),
    title: opts.tabTitle ?? nextTabTitle(get(tabs)),
    layout: pane,
    focusedPaneId: pane.id,
    ...(worktreeId ? { worktreeId } : {}),
  };
  tabs.update((list) => [...list, tab]);
  activateTab(tab);
  persistLayout();
  return tab;
}

/** Close a tab, destroying its terminals. Never removes the last tab. */
export function closeTab(id: string) {
  const list = get(tabs);
  if (list.length <= 1) return;
  const tab = list.find((t) => t.id === id);
  if (!tab) return;
  for (const p of layoutOps.collectPanes(tab.layout)) {
    unlinkPane(p.id);
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
  gitByRoot.set(new Map());
  activeRoot.set(null);
  primaryRoot.set(null);

  const ws = loadWorkspace(project);
  // Worktrees before tabs: a tab with a `worktreeId` needs its record present, or
  // the reconciler in worktrees.ts sees a dangling reference and falls back to
  // the project root for a pane that should have spawned in a worktree.
  worktrees.set(ws.worktrees ?? []);
  tabs.set(ws.tabs);
  activateTab(ws.tabs.find((t) => t.id === ws.activeTabId)!);

  showUntracked.set(localStorage.getItem(untrackedKey(project.id)) !== "false");
  showStaged.set(localStorage.getItem(stagedKey(project.id)) !== "false");
  showUnstaged.set(localStorage.getItem(unstagedKey(project.id)) !== "false");

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
    // Store the root the backend reports, not `project.path`: it is
    // canonicalized, and it is the key every subsequent call must use.
    // Setting `primaryRoot` (not `activeRoot`) is what propagates it — activeRoot
    // is derived from the active tab, and writing it directly here would be
    // overwritten the next time that recomputes.
    primaryRoot.set(info.root);
    gitMode.set(info.git);
    restricted.set(info.restricted);
    sessionReady.set(true);
    if (info.git) await refreshChanges(info.root);
    await loadDir("");
  } catch (err) {
    // Previously swallowed, which left a fully-rendered UI wired to no session:
    // every editor pane sat on "Opening session…" forever with nothing said. A
    // deleted or unmounted project folder is the common cause.
    console.error("start_session failed", err);
    sessionError.set(String(err));
  }
}

/** Open a folder the desktop shell asked us to open (KDE task-manager recents,
 *  Windows jump lists, macOS Dock). Reuses the project when one already exists
 *  for the path; otherwise it is added exactly like a picker selection. */
export async function openFolderByPath(raw: string) {
  const path = raw.replace(/[\\/]+$/, "");
  if (!path) return;
  const existing = get(projects).find((p) => p.path.replace(/[\\/]+$/, "") === path);
  if (existing) {
    await openProject(existing);
    return;
  }
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  try {
    const project = await ipc.addProject(name, path);
    await loadProjects();
    await openProject(project);
  } catch (err) {
    // Usually a stale recent entry whose folder was deleted or unmounted: the
    // add fails with "not a directory" and there is nothing sensible to open.
    console.error("open_folder_by_path failed", err);
  }
}

/** Trust the currently open folder and re-open it so git activates. */
export async function trustCurrentFolder() {
  const project = get(activeProject);
  if (!project) return;
  try {
    await ipc.trustFolder(project.path);
  } catch (err) {
    // Swallowing this re-prompted the same dialog on the next open with no
    // explanation for why trusting appeared not to stick.
    sessionError.set(`Could not record trust for this folder: ${err}`);
    return;
  }
  await openProject(project);
}

/** Withdraw trust from the open folder and reopen it without git.
 *
 *  Trust is a standing grant to run git — and therefore to read an
 *  attacker-controlled `.git/config` — in a directory. The backend has always
 *  supported revoking it, but nothing in the UI could reach it, so the grant was
 *  effectively permanent. Worktrees widen its blast radius, which makes an exit
 *  worth having. */
export async function revokeCurrentFolderTrust() {
  const project = get(activeProject);
  if (!project) return;
  const ok = await ask(
    `Stop letting Termax run git in this folder?\n\n${project.path}\n\nThe project stays open and your files are untouched, but branches, diffs and pull requests will be unavailable until you trust it again.`,
    { title: "Withdraw trust?", kind: "warning", okLabel: "Withdraw trust", cancelLabel: "Cancel" },
  );
  if (!ok) return;
  try {
    await ipc.revokeTrust(project.path);
  } catch (err) {
    sessionError.set(`Could not withdraw trust: ${err}`);
    return;
  }
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
  vaultRuns.set(new Map());
  await ipc.stopSession().catch(() => {});
  sessionReady.set(false);
  activeProject.set(null);
  tabs.set([]);
  activeTabId.set(null);
  layout.set(null);
  focusedPaneId.set(null);
  gitByRoot.set(new Map());
  activeRoot.set(null);
  primaryRoot.set(null);
  // The backend drops every session when the project closes, so the worktree
  // records go with it rather than being closed one at a time.
  worktrees.set([]);
  gitMode.set(false);
  gitBusy.set(false);
  gitError.set(null);
  changesError.set(null);
  sessionError.set(null);
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
  const pane = layoutOps.newPane(launch, title, get(appSettings).behavior.defaultBell);
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

/** Execution state of a vault command's last run.
 *  Mirrors the pane's {@link terminals.PaneRunState}, plus `stopped` for a run
 *  whose pane was closed (or whose process died) mid-command, and `idle` for a
 *  finished run the user has already seen (no marker shown). */
export type VaultRunState = terminals.PaneRunState | "stopped" | "idle";

export interface VaultRun {
  /** Pane the command last ran in; null once that pane is gone. */
  paneId: string | null;
  state: VaultRunState;
  /** Exit code when the shell reported one (OSC 133); null when unknown. */
  exitCode: number | null;
}

/** Vault command id → its last run. Commands never run are absent.
 *  Also the command→pane link: while the pane lives, re-running reuses it. */
export const vaultRuns = writable<Map<string, VaultRun>>(new Map());

function updateRun(cmdId: string, patch: Partial<VaultRun>) {
  vaultRuns.update((m) => {
    const prev = m.get(cmdId) ?? { paneId: null, state: "done" as VaultRunState, exitCode: null };
    return new Map(m).set(cmdId, { ...prev, ...patch });
  });
}

/** Command ids whose run lives in `paneId`. */
function runsInPane(paneId: string): string[] {
  return [...get(vaultRuns)].filter(([, r]) => r.paneId === paneId).map(([id]) => id);
}

/** Drop the pane link. A run still going when its pane disappears is `stopped`;
 *  a finished one keeps its done/failed result. */
function unlinkPane(paneId: string) {
  for (const cmdId of runsInPane(paneId)) {
    const run = get(vaultRuns).get(cmdId)!;
    const ended = run.state === "done" || run.state === "failed" || run.state === "idle";
    updateRun(cmdId, { paneId: null, state: ended ? run.state : "stopped" });
  }
}

// Mirror pane run state onto the commands running there.
terminals.paneRuns.subscribe((runs) => {
  for (const [cmdId, run] of get(vaultRuns)) {
    if (!run.paneId) continue;
    const paneRun = runs.get(run.paneId);
    if (paneRun && (paneRun.state !== run.state || paneRun.exitCode !== run.exitCode)) {
      updateRun(cmdId, { state: paneRun.state, exitCode: paneRun.exitCode });
    }
  }
});

export function runVaultCommand(cmd: VaultCommand) {
  const linked = get(vaultRuns).get(cmd.id)?.paneId;
  if (linked && terminals.isAlive(linked)) {
    focusedPaneId.set(linked);
    terminals.runInPane(linked, cmd.command);
    return;
  }
  const paneId = addPane(launchFor(cmd.terminalType), launcherById(cmd.terminalType).name);
  updateRun(cmd.id, { paneId, state: "starting", exitCode: null });
  terminals.queueRun(paneId, cmd.command);
}

/** Reveal a pane: switch to its tab, un-maximize whatever covers it, focus it.
 *  Returns false when the pane no longer exists anywhere. */
export function revealPane(paneId: string): boolean {
  if (!layoutOps.findPane(get(layout), paneId)) {
    const owner = get(tabs).find((t) => layoutOps.findPane(t.layout, paneId));
    if (!owner) return false;
    switchTab(owner.id);
  }
  if (get(maximizedPaneId) && get(maximizedPaneId) !== paneId) maximizedPaneId.set(null);
  focusedPaneId.set(paneId);
  // The pane may have just been mounted by the tab switch; focus once it's up.
  requestAnimationFrame(() => terminals.focusTerminal(paneId));
  return true;
}

// Selecting a pane acknowledges a finished run there: the "done" marker clears
// (the pane link stays, so the jump button remains). Failures stay visible.
focusedPaneId.subscribe((id) => {
  if (!id) return;
  terminals.acknowledgeRun(id);
  for (const cmdId of runsInPane(id)) {
    if (get(vaultRuns).get(cmdId)!.state === "done") updateRun(cmdId, { state: "idle" });
  }
});

/** Jump to the terminal a vault command is running in. */
export function revealVaultCommand(cmdId: string): boolean {
  const paneId = get(vaultRuns).get(cmdId)?.paneId;
  if (!paneId) return false;
  if (revealPane(paneId)) return true;
  // Pane vanished without us seeing it close: drop the stale link.
  unlinkPane(paneId);
  return false;
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

/** Persist an editor pane's edit/preview mode so it survives reloads/restarts. */
export function setPaneView(paneId: string, view: "edit" | "preview") {
  const tree = get(layout);
  if (!tree) return;
  setLayout(layoutOps.setPaneView(tree, paneId, view));
}

export function closePane(paneId: string) {
  clearPaneScroll(paneId);
  unlinkPane(paneId);
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

/** Replace one root's tracked state, leaving every other root untouched. */
function setRootGit(root: string, next: RootGit) {
  gitByRoot.update((map) => {
    const copy = new Map(map);
    copy.set(root, next);
    return copy;
  });
}

/** Merge a partial update into one root's state. */
function patchRootGit(root: string, patch: Partial<RootGit>) {
  gitByRoot.update((map) => {
    const copy = new Map(map);
    copy.set(root, { ...(copy.get(root) ?? EMPTY_ROOT_GIT), ...patch });
    return copy;
  });
}

/** Re-read changes and status for `root` (the active root when omitted).
 *
 *  Errors used to be swallowed here, which rendered a broken git as a clean
 *  working tree with the whole git toolbar missing — the most misleading state in
 *  the app, and worse with several roots since the panel could be describing a
 *  root that failed. A failure now clears the entries *and* sets `gitError`. */
/** Roots with a refresh in flight, so a burst of filesystem events cannot pile
 *  up several `git status` runs over the same tree. A root flagged while one is
 *  running is refreshed once more when it lands, which is all any number of
 *  events in that window can ask for. */
const refreshing = new Map<string, { again: boolean }>();

export async function refreshChanges(root?: string) {
  const target = root ?? get(activeRoot);
  if (!target) return;
  const inFlight = refreshing.get(target);
  if (inFlight) {
    inFlight.again = true;
    return;
  }
  const state = { again: false };
  refreshing.set(target, state);
  try {
    const { changes, status } = await ipc.getRootGit(target);
    setRootGit(target, { changes, status });
    // Only clear an error we could have raised here; a fetch/pull error stays
    // visible until its own next attempt.
    if (get(changesError)) changesError.set(null);
  } catch (err) {
    setRootGit(target, EMPTY_ROOT_GIT);
    changesError.set(String(err));
  } finally {
    refreshing.delete(target);
  }
  if (state.again) await refreshChanges(target);
}

/** Show a transient status line, auto-clearing after a delay unless another
 *  message replaces it first (guarded by a monotonic token). */
let gitMsgToken = 0;
export function flashGitMessage(msg: string, ms = 4000) {
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
  const root = get(activeRoot);
  try {
    const after = await ipc.gitFetch(root ?? undefined);
    if (root) patchRootGit(root, { status: after });
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
    const out = await ipc.gitPull(get(activeRoot) ?? undefined);
    await refreshChanges();
    flashGitMessage(/already up to date/i.test(out) ? "Already up to date" : "Pulled — fast-forwarded");
  } catch (err) {
    gitMessage.set(null);
    gitError.set(String(err));
  } finally {
    gitBusy.set(false);
  }
}

/** Local branch names for the switcher.
 *
 *  Throws on failure rather than returning `[]`: an empty array made a git
 *  failure render as "No matching branches", so a broken repo looked like a repo
 *  with no branches. The caller distinguishes the two. */
export async function loadBranches(): Promise<string[]> {
  if (!get(gitMode)) return [];
  return await ipc.gitBranches(get(activeRoot) ?? undefined);
}

/** Switch branches, then refresh the panel. Git's error (e.g. dirty worktree)
 *  is surfaced verbatim on failure.
 *
 *  Returns that error as well as showing it, because one caller can do better
 *  than the message: `switchToBranch` turns "already used by worktree at …" into
 *  a jump to the tree that holds the branch. Everything else can ignore the
 *  return value — the error is already on screen. */
export async function checkoutBranch(branch: string): Promise<string | null> {
  if (!get(gitMode) || get(gitBusy)) return null;
  if (get(gitStatus)?.branch === branch) return null;
  // Switching branches rewrites the working tree and invalidates every open
  // editor pane. That is fine on a clean tree and worth a warning on a dirty one,
  // where git may refuse or carry changes across.
  const dirty = get(changes).filter((c) => c.area !== "untracked").length;
  if (dirty > 0) {
    const ok = await ask(
      `Switch to ${branch} with ${dirty} uncommitted change${dirty === 1 ? "" : "s"}?\n\nGit will refuse if the switch would overwrite them, and any it can carry across will follow you to the new branch.`,
      { title: "Switch branch?", kind: "warning", okLabel: "Switch", cancelLabel: "Cancel" },
    );
    if (!ok) return null;
  }
  gitBusy.set(true);
  gitError.set(null);
  gitMessage.set(`Switching to ${branch}…`);
  gitMsgToken++;
  const root = get(activeRoot);
  try {
    const after = await ipc.gitCheckout(branch, root ?? undefined);
    if (root) patchRootGit(root, { status: after });
    await refreshChanges();
    flashGitMessage(`On ${branch}`);
    return null;
  } catch (err) {
    gitMessage.set(null);
    const message = String(err);
    gitError.set(message);
    return message;
  } finally {
    gitBusy.set(false);
  }
}

/** Create a branch at HEAD and switch to it. Uncommitted work follows along. */
export async function createBranch(branch: string) {
  const root = get(activeRoot);
  const after = await ipc.gitCreateBranch(branch, root ?? undefined);
  if (root) patchRootGit(root, { status: after });
  await refreshChanges();
  flashGitMessage(`On ${branch}`);
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

/** Put a command on a terminal prompt without running it.
 *
 *  The escape hatch behind every destructive git/gh action: the user sees the
 *  exact invocation, can edit it, and presses Enter themselves. Reuses the
 *  focused pane when there is one; otherwise opens a shell and queues the text
 *  until its program is ready to accept input. */
export function sendToPane(command: string) {
  const focused = get(focusedPaneId);
  if (focused && terminals.isAlive(focused)) {
    terminals.typeInPane(focused, command);
    return;
  }
  const paneId = addPane(null, "Shell");
  terminals.queueType(paneId, command);
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

/** One open terminal pane, wherever in the workspace it lives. */
export interface PaneInstance {
  paneId: string;
  /** Pane title (the launcher name it was opened with, or a rename). */
  title: string;
  /** Program the pane was launched with; null for a plain shell. */
  launch: string | null;
  tabId: string;
  tabTitle: string;
  /** Directory this pane's process is really running in, or null before it has
   *  spawned. Deliberately taken from `paneRoots` and not from the tab: a pane
   *  dragged into another tab keeps the shell it already has, so a label derived
   *  from the tab would claim the agent moved branches when it did not. */
  root: string | null;
}

/** Every terminal pane across all tabs, in tab order. Drives the sidebar's
 *  per-launcher instance lists. Editor panes are not terminals, so they're out. */
export const paneInstances = derived(
  [tabs, layout, activeTabId, terminals.paneRoots],
  ([$tabs, $layout, $activeTabId, $paneRoots]) => {
    const out: PaneInstance[] = [];
    for (const t of $tabs) {
      // The active tab's copy in `tabs` is stale between syncs — read the live grid.
      const tree = t.id === $activeTabId ? $layout : t.layout;
      for (const p of layoutOps.collectPanes(tree)) {
        if (p.kind === "editor") continue;
        out.push({
          paneId: p.id,
          title: p.title,
          launch: p.launch,
          tabId: t.id,
          tabTitle: t.title,
          root: $paneRoots.get(p.id) ?? null,
        });
      }
    }
    return out;
  },
);

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
