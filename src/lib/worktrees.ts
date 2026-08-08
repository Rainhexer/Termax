/** Worktree-backed tabs.
 *
 *  A tab may bind to a git worktree; its panes then run in that directory instead
 *  of the project root. That is what lets two coding agents work on two branches
 *  at the same time — with one checkout they would overwrite each other's files.
 *
 *  ## Why the tab is the unit
 *
 *  A pane is too fine: an agent, the shell running its tests, and an editor pane
 *  all have to see the same files. A window is too coarse. The tab is already the
 *  thing users group work in, and because `PaneInstance` carries `tabId`, binding
 *  the tab is also what gives every agent row in the sidebar its PR label —
 *  one model, two surfaces.
 *
 *  ## Sessions are reconciled, not managed by hand
 *
 *  Rather than making every caller that creates or destroys a tab remember to
 *  open/close a backend session, this module watches `tabs` and makes the set of
 *  live sessions match the set of referenced worktrees. `closeTab`,
 *  `movePaneToNewTab`, a project switch, and a restored layout all converge for
 *  free, and a refcount can never leak because it is recomputed rather than
 *  incremented.
 */
import { derived, get, writable } from "svelte/store";
import { ipc } from "./ipc";
import type { Tab, Worktree, WorktreeEntry } from "./types";
// The `worktrees` list itself lives in stores.ts, because `loadWorkspace` and
// `persistLayout` have to read and write it. Keeping it there means the import
// arrow only ever points this way and the module graph stays acyclic.
import {
  activeRoot,
  activeTabId,
  addPane,
  checkoutBranch,
  collectTabPanes,
  flashGitMessage,
  gitError,
  newTab,
  primaryRoot,
  refreshChanges,
  sessionReady,
  switchTab,
  tabs,
  worktrees,
} from "./stores";
import { setTreeRoot } from "./filetree";
import { isAlive, queueType } from "./terminals";
import { settings as appSettings } from "./settings";

export { worktrees };

/** What `git worktree list` currently reports. The authority on what exists. */
export const gitWorktrees = writable<WorktreeEntry[]>([]);

/** Paths whose directory git no longer lists. A bound tab stays open and keeps
 *  its panes — it just cannot track files until the tree is recreated. */
export const missingWorktrees = writable<Set<string>>(new Set());

export function worktreeById(list: Worktree[], id: string | undefined): Worktree | null {
  if (!id) return null;
  return list.find((w) => w.id === id) ?? null;
}

/** Root a tab's panes and file views resolve against. */
export function rootForTab(
  tab: Tab | null | undefined,
  list: Worktree[],
  fallback: string | null,
): string | null {
  if (!tab) return fallback;
  return worktreeById(list, tab.worktreeId)?.path ?? fallback;
}

/** Root of the tab currently on screen. Drives the sidebar, the file tree, and
 *  the Changes panel, all of which describe one root at a time.
 *
 *  Falls back to `primaryRoot` (canonical) rather than `activeProject.path` (raw)
 *  so that every value flowing out of here is comparable to a session key. */
export const activeTabRoot = derived(
  [tabs, activeTabId, worktrees, primaryRoot],
  ([tabList, currentId, list, primary]) => {
    const tab = tabList.find((t) => t.id === currentId) ?? null;
    return rootForTab(tab, list, primary);
  },
);

/** Branch currently checked out in each worktree path, from git. */
export const branchByRoot = derived(gitWorktrees, (entries) => {
  const map = new Map<string, string | null>();
  for (const entry of entries) map.set(entry.path, entry.branch);
  return map;
});

/** Re-read `git worktree list` and recompute which bound paths have vanished. */
export async function refreshGitWorktrees(): Promise<void> {
  try {
    const entries = await ipc.listWorktrees();
    gitWorktrees.set(entries);
    const known = new Set(entries.map((e) => e.path));
    missingWorktrees.set(new Set(get(worktrees).map((w) => w.path).filter((p) => !known.has(p))));
  } catch (err) {
    // Not a git repo, or git failed. Neither is worth an error banner here: the
    // Changes panel already reports repo-level problems, and with no worktrees
    // the feature is simply absent.
    gitWorktrees.set([]);
    missingWorktrees.set(new Set());
    console.debug("list_worktrees unavailable", err);
  }
}

/** Distinct worktree paths referenced by at least one tab. */
function referencedPaths(tabList: Tab[], list: Worktree[]): Set<string> {
  const paths = new Set<string>();
  for (const tab of tabList) {
    const wt = worktreeById(list, tab.worktreeId);
    if (wt) paths.add(wt.path);
  }
  return paths;
}

/** Paths with a live backend session, and the canonical root each resolved to.
 *  Keyed by the path we asked for; valued by the canonical path the backend
 *  returned, which is what every later call must use. */
const openSessions = new Map<string, string>();

/** Canonical root for a worktree path, once its session is open. */
export function canonicalRoot(path: string | null): string | null {
  if (!path) return null;
  return openSessions.get(path) ?? path;
}

/** Open/close backend sessions so they match the worktrees the tabs reference. */
async function reconcileSessions(): Promise<void> {
  const wanted = referencedPaths(get(tabs), get(worktrees));

  for (const path of wanted) {
    if (openSessions.has(path)) continue;
    // Claim the slot before awaiting: two reconciles racing on the same new tab
    // would otherwise both open a session, and the second reference would never
    // be released.
    openSessions.set(path, path);
    try {
      const info = await ipc.openWorktreeSession(path);
      openSessions.set(path, info.root);
      await refreshChanges(info.root);
    } catch (err) {
      openSessions.delete(path);
      console.error(`could not open a session for ${path}`, err);
      missingWorktrees.update((set) => new Set(set).add(path));
    }
  }

  for (const [path, canonical] of [...openSessions]) {
    if (wanted.has(path)) continue;
    openSessions.delete(path);
    // Closing only drops the watcher and the tracked state. The directory itself
    // is never touched: it can hold the only copy of uncommitted work.
    await ipc.closeWorktreeSession(canonical).catch((err) => {
      console.error(`could not close the session for ${path}`, err);
    });
  }
}

/** Register a worktree with the workspace, returning its id. Idempotent by path,
 *  so adopting a tree that already exists reuses the same record. */
export function registerWorktree(path: string): string {
  const existing = get(worktrees).find((w) => w.path === path);
  if (existing) return existing.id;
  const record: Worktree = { id: crypto.randomUUID(), path };
  worktrees.update((list) => [...list, record]);
  return record.id;
}

/** Drop worktree records no tab references any more, so the persisted workspace
 *  does not accumulate them. The directories are left alone. */
export function pruneUnreferencedWorktrees(): void {
  const referenced = new Set(get(tabs).map((t) => t.worktreeId).filter(Boolean));
  worktrees.update((list) => list.filter((w) => referenced.has(w.id)));
}

/** Turn a branch name into a directory name. */
function slugify(branch: string): string {
  const slug = branch
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "work";
}

/** Where a worktree for `branch` should live.
 *
 *  A sibling directory, `<parent>/<project>-worktrees/<slug>`. Rejected
 *  alternatives: inside the repo, where the recursive watcher would walk it and
 *  `git status` would report it untracked; and the app data directory, which
 *  contains it neatly but makes "where is my code?" unanswerable to every other
 *  tool the user owns. A sibling needs no gitignore entry at all and is what
 *  people already do by hand. */
export function worktreePathFor(projectPath: string, branch: string): string {
  const sep = projectPath.includes("\\") && !projectPath.includes("/") ? "\\" : "/";
  const trimmed = projectPath.replace(/[\/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = cut > 0 ? trimmed.slice(0, cut) : trimmed;
  const name = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  return `${parent}${sep}${name}-worktrees${sep}${slugify(branch)}`;
}

/** git's message when a branch is already checked out in another worktree. */
const ALREADY_CHECKED_OUT = /already (?:used by|checked out at) worktree|is already used by worktree/i;

export function isAlreadyCheckedOut(message: string): boolean {
  return ALREADY_CHECKED_OUT.test(message);
}

/** Find a tab already bound to the worktree holding `branch`, if any. */
export function tabForBranch(branch: string): { tabId: string; path: string } | null {
  const entry = get(gitWorktrees).find((w) => w.branch === branch);
  if (!entry) return null;
  const record = get(worktrees).find((w) => w.path === entry.path);
  if (!record) return null;
  const tab = get(tabs).find((t) => t.worktreeId === record.id);
  return tab ? { tabId: tab.id, path: entry.path } : null;
}

/** Compare two roots as paths, not as strings.
 *
 *  The same tree reaches us spelled two ways: git prints resolved paths, while a
 *  path that came from the picker or the persisted workspace may carry a trailing
 *  separator or predate the backend canonicalizing it. Both spellings are
 *  compared so a stale one cannot make a tree look like a different one. */
function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/[\/\\]+$/, "");
  if (norm(a) === norm(b)) return true;
  return norm(canonicalRoot(a) ?? a) === norm(canonicalRoot(b) ?? b);
}

/** Branches checked out in a tree *other* than the one on screen, branch → path.
 *
 *  Git allows a branch in exactly one worktree, so these are precisely the
 *  branches `git checkout` will refuse here. The switcher reads it to mark them
 *  before the click, and `switchToBranch` reads it to navigate instead. */
export const branchesElsewhere = derived(
  [gitWorktrees, activeTabRoot],
  ([entries, here]) => {
    const map = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.branch || samePath(entry.path, here)) continue;
      map.set(entry.branch, entry.path);
    }
    return map;
  },
);

/** Find a tab working on an issue, by the shape of its branch name.
 *
 *  `gh issue develop` names branches `<number>-<slug>`, so a worktree branch
 *  starting with the issue number and a dash belongs to that issue. Matching on
 *  the name rather than storing the number against the tab is the same choice
 *  `prByBranch` makes and for the same reason: a stored number goes stale the
 *  moment the branch is renamed, and git can always be asked.
 *
 *  The trade-off is a branch named `12-something` for unrelated reasons would
 *  match issue 12. That costs a wrong "already working on this" hint, which the
 *  user can see is wrong, and is worth not persisting a mapping that rots. */
export function tabForIssue(number: number): { tabId: string; path: string } | null {
  const prefix = `${number}-`;
  const entry = get(gitWorktrees).find(
    (w) => w.branch === String(number) || w.branch?.startsWith(prefix),
  );
  if (!entry) return null;
  const record = get(worktrees).find((w) => w.path === entry.path);
  if (!record) return null;
  const tab = get(tabs).find((t) => t.worktreeId === record.id);
  return tab ? { tabId: tab.id, path: entry.path } : null;
}

/** Last path segment, for messages that name a tree without a wall of path. */
function dirName(path: string): string {
  const trimmed = path.replace(/[\/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/** Put `path` on screen: its bound tab if it has one, the project-root tab when
 *  the tree *is* the project, otherwise a new tab bound to it. */
async function goToWorktree(branch: string, path: string): Promise<void> {
  const record = get(worktrees).find((w) => samePath(w.path, path));
  const bound = record ? get(tabs).find((t) => t.worktreeId === record.id) : undefined;
  if (bound) {
    switchTab(bound.id);
    // The cached status for that root can be minutes old; the panel is about to
    // show it as the answer to "switch to this branch", so re-read it.
    await refreshChanges();
  } else if (samePath(path, get(primaryRoot))) {
    // The project root is not a worktree record — tabs reach it by having no
    // `worktreeId` at all — so it needs its own case rather than a registration.
    const rootTab = get(tabs).find((t) => !t.worktreeId);
    if (rootTab) {
      switchTab(rootTab.id);
      await refreshChanges();
    } else {
      newTab({ worktreeId: null, tabTitle: branch });
    }
  } else {
    // Register and create the tab in one synchronous block: an await between the
    // two would let the reconciler observe a worktree nothing references yet.
    const id = registerWorktree(path);
    newTab({ worktreeId: id, tabTitle: branch });
  }
  flashGitMessage(`On ${branch} in ${dirName(path)}`);
}

/** Switch the view to `branch`, wherever it is checked out.
 *
 *  Git allows a branch in one worktree only, so `git checkout master` from a
 *  second tree fails with "fatal: 'master' is already used by worktree at …".
 *  The switcher used to show that verbatim and stop, which reads as a broken
 *  branch list — the branch is right there and cannot be selected. But the
 *  branch *is* checked out somewhere, so the useful move is to go to that tree
 *  instead of trying to steal the branch from it. Only a branch no tree holds is
 *  checked out here, exactly as before. */
export async function switchToBranch(branch: string): Promise<void> {
  const holder = get(branchesElsewhere).get(branch);
  if (holder) {
    await goToWorktree(branch, holder);
    return;
  }
  const failure = await checkoutBranch(branch);
  if (!failure || !isAlreadyCheckedOut(failure)) return;
  // Our list was stale — a worktree added from a terminal, say. Ask git again
  // rather than leaving its wording as the final answer.
  await refreshGitWorktrees();
  const late = get(branchesElsewhere).get(branch);
  if (!late) return;
  gitError.set(null);
  await goToWorktree(branch, late);
}

/** Ensure a worktree exists for `branch` and return its path.
 *
 *  `prNumber` with `fromFork` fetches `refs/pull/N/head` into a detached tree
 *  instead, because a fork's head branch does not exist in this repository.
 *  Adopts an existing tree at the same path rather than failing. */
export async function ensureWorktree(
  projectPath: string,
  branch: string,
  opts: { prNumber?: number; fromFork?: boolean } = {},
): Promise<string> {
  const path = worktreePathFor(projectPath, branch);

  const existing = get(gitWorktrees).find((w) => w.path === path);
  if (existing) return path;

  if (opts.fromFork && opts.prNumber !== undefined) {
    const ref = await ipc.gitFetchPrHead(opts.prNumber);
    await ipc.worktreeAdd(path, branch, ref);
  } else {
    // Fetch first so the new tree can track the real remote tip rather than a
    // stale local copy.
    await ipc.gitFetchBranch(branch).catch(() => {
      // A branch that only exists locally is still worth a worktree.
    });
    await ipc.worktreeAdd(path, branch);
  }
  await refreshGitWorktrees();
  return path;
}

/** Open a pull request in its own tab, in its own worktree, with an agent running.
 *
 *  Collapses fetch → worktree add → session open → tab create → agent launch into
 *  one click. Idempotent: a PR that already has a tab just gets focused, with no
 *  network call at all.
 *
 *  Returns a human-readable problem, or null on success. */
export async function startWorkOnPr(opts: {
  projectPath: string;
  branch: string;
  prNumber: number;
  title: string;
  isCrossRepository: boolean;
  launch: string | null;
  launcherName: string;
}): Promise<string | null> {
  const existingTab = tabForBranch(opts.branch);
  if (existingTab) {
    switchTab(existingTab.tabId);
    return null;
  }

  let path: string;
  try {
    path = await ensureWorktree(opts.projectPath, opts.branch, {
      prNumber: opts.prNumber,
      fromFork: opts.isCrossRepository,
    });
  } catch (err) {
    const message = String(err);
    if (isAlreadyCheckedOut(message)) {
      // Turn the error into the intent: the branch is somewhere already, so go
      // there instead of showing git's wording.
      const holder = get(gitWorktrees).find((w) => w.branch === opts.branch);
      if (holder) {
        const id = registerWorktree(holder.path);
        openTabForWorktree(id, opts);
        return null;
      }
      return `${opts.branch} is already checked out in another worktree.`;
    }
    return message;
  }

  // Register and create the tab in one synchronous block: an await between the
  // two would let the reconciler observe a worktree nothing references yet.
  const id = registerWorktree(path);
  openTabForWorktree(id, opts);
  offerSetupCommand();
  return null;
}

/** Offer the configured setup command in a fresh shell pane, typed but not run.
 *
 *  A worktree shares git objects but *not* build output, so a new tree of a JS
 *  project is broken until dependencies are installed — the single biggest
 *  practical obstacle to this feature. Symlinking `node_modules` breaks native
 *  modules and pnpm; copying is slow and huge. So the honest answer is to hand
 *  the user the command.
 *
 *  Typed rather than executed, because Termax auto-runs nothing: an install
 *  command is arbitrary code, and a per-project setting that silently executed on
 *  worktree creation would be a much larger promise than it looks. */
function offerSetupCommand() {
  const command = get(appSettings).behavior.worktreeSetupCommand.trim();
  if (!command) return;
  const paneId = addPane(null, "Setup", "col");
  queueType(paneId, command);
}

function openTabForWorktree(
  worktreeId: string,
  opts: { prNumber: number; title: string; launch: string | null; launcherName: string },
) {
  const short = opts.title.length > 24 ? `${opts.title.slice(0, 24)}…` : opts.title;
  newTab({
    worktreeId,
    launch: opts.launch,
    title: opts.launcherName,
    tabTitle: `#${opts.prNumber} ${short}`,
  });
}

/** Branch name for an issue, in GitHub's own `<number>-<slug>` shape.
 *
 *  Matching what `gh issue develop` would pick on its own matters: if the
 *  branch already exists from a previous attempt, an identical name means we
 *  adopt it instead of GitHub minting `12-fix-thing-1` beside it. */
export function branchNameForIssue(number: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return slug ? `${number}-${slug}` : `${number}`;
}

/** Fill the issue prompt template. */
export function renderIssuePrompt(
  template: string,
  issue: { number: number; title: string; url: string; body?: string },
): string {
  return template
    .replaceAll("{number}", String(issue.number))
    .replaceAll("{title}", issue.title)
    .replaceAll("{url}", issue.url)
    .replaceAll("{body}", issue.body?.trim() ?? "")
    .trim();
}

/** Hand an issue to a coding agent: linked branch, worktree, tab, prompt.
 *
 *  The one-click path from "this should be fixed" to "an agent is working on
 *  it", and the reason the issue panel exists rather than deferring to the
 *  website. Four things happen, in this order:
 *
 *    1. `gh issue develop` creates a branch **on the remote** and links it to
 *       the issue. The link is the point: GitHub then closes the issue when the
 *       eventual pull request merges, with no "fixes #12" convention to
 *       remember. A plain local branch would be one network call cheaper and
 *       would lose exactly the thing this feature is for.
 *    2. A worktree is built from it, so this agent cannot collide with whatever
 *       is running in the project root or in another issue's tree.
 *    3. A tab opens with the chosen agent in it.
 *    4. The prompt is *typed* into that agent, not executed. Termax auto-runs
 *       nothing — see `offerSetupCommand` for the same reasoning. The user
 *       presses Enter, having read what their agent is about to be told.
 *
 *  Idempotent: an issue whose branch already has a tab just gets focused, with
 *  no network call at all.
 *
 *  Returns a human-readable problem, or null on success. */
export async function startWorkOnIssue(opts: {
  projectPath: string;
  number: number;
  title: string;
  url: string;
  body?: string;
  /** Branch to create; defaults to GitHub's `<number>-<slug>` shape. */
  branch?: string;
  /** Base branch for the new branch. Omitted means the repository default. */
  base?: string;
  launch: string | null;
  launcherName: string;
  /** Rendered prompt. Omitted means no prompt is typed — a plain shell, say. */
  prompt?: string;
}): Promise<string | null> {
  const wanted = opts.branch?.trim() || branchNameForIssue(opts.number, opts.title);

  // Already working on it? Check before touching the network, so pressing the
  // button twice costs nothing. Both spellings are checked: the exact branch the
  // caller asked for, and any branch belonging to this issue — the second
  // catches the case where GitHub suffixed the name on a previous attempt.
  const existingTab = tabForBranch(wanted) ?? tabForIssue(opts.number);
  if (existingTab) {
    switchTab(existingTab.tabId);
    return null;
  }

  // GitHub decides the final name: it suffixes when the branch already exists,
  // so the returned name is used from here on rather than the requested one.
  let branch: string;
  try {
    branch = await ipc.ghIssueDevelop(opts.number, wanted, opts.base);
  } catch (err) {
    return String(err);
  }
  if (!branch) return "GitHub didn't say which branch it created.";

  // The name may have changed under us, so re-check for a tab before building
  // anything: `gh issue develop` is idempotent and hands back the existing
  // branch when one is already linked, which is exactly the second-press case.
  const onFinalName = tabForBranch(branch);
  if (onFinalName) {
    switchTab(onFinalName.tabId);
    return null;
  }

  let path: string;
  try {
    path = await ensureWorktree(opts.projectPath, branch);
  } catch (err) {
    const message = String(err);
    if (isAlreadyCheckedOut(message)) {
      const holder = get(gitWorktrees).find((w) => w.branch === branch);
      if (holder) {
        const id = registerWorktree(holder.path);
        openTabForIssue(id, {
          number: opts.number,
          title: opts.title,
          launch: opts.launch,
          launcherName: opts.launcherName,
        });
        return null;
      }
      return `${branch} is already checked out in another worktree.`;
    }
    return message;
  }

  // Register and create the tab in one synchronous block: an await between the
  // two would let the reconciler observe a worktree nothing references yet.
  const id = registerWorktree(path);
  const paneId = openTabForIssue(id, {
    number: opts.number,
    title: opts.title,
    launch: opts.launch,
    launcherName: opts.launcherName,
  });
  if (opts.prompt?.trim() && paneId) queueType(paneId, opts.prompt.trim());
  offerSetupCommand();
  return null;
}

/** Open the tab for an issue, returning the agent pane's id. */
function openTabForIssue(
  worktreeId: string,
  opts: { number: number; title: string; launch: string | null; launcherName: string },
): string | null {
  const short = opts.title.length > 24 ? `${opts.title.slice(0, 24)}…` : opts.title;
  const tab = newTab({
    worktreeId,
    launch: opts.launch,
    title: opts.launcherName,
    tabTitle: `#${opts.number} ${short}`,
  });
  return tab.focusedPaneId;
}

/** Remove a worktree from disk after checking nothing is using it.
 *
 *  Returns a problem string rather than throwing for the cases the user can act
 *  on. Never passes `--force` unless they explicitly chose to discard changes. */
export async function removeWorktree(
  path: string,
  opts: { discardChanges?: boolean } = {},
): Promise<string | null> {
  const record = get(worktrees).find((w) => w.path === path);
  if (record) {
    const boundTabs = get(tabs).filter((t) => t.worktreeId === record.id);
    // A running agent in a tree being deleted would lose its work with no
    // warning, so this blocks rather than asking git to sort it out.
    const livePanes = boundTabs
      .flatMap((t) => collectTabPanes(t))
      .filter((paneId) => isAlive(paneId));
    if (livePanes.length) {
      const n = livePanes.length;
      return `${n} pane${n === 1 ? " is" : "s are"} still running in this worktree. Close its tab first.`;
    }
  }
  try {
    await ipc.worktreeRemove(path, opts.discardChanges === true);
  } catch (err) {
    return String(err);
  }
  await refreshGitWorktrees();
  return null;
}

/** Wire the reconciler and keep `activeRoot` pointed at the active tab.
 *  Called once at startup. */
export function initWorktreeListeners(): void {
  // A project open/close is the only thing that invalidates the git worktree
  // list wholesale. `openProject` sets `worktrees` from the persisted workspace;
  // this reacts to the session coming up, when git can actually be asked.
  let lastReady = false;
  sessionReady.subscribe((ready) => {
    if (ready === lastReady) return;
    lastReady = ready;
    if (ready) {
      void refreshGitWorktrees().then(() => {
        // Drop records whose tabs are gone, so the persisted workspace does not
        // accumulate them across restarts. Done only here, on open, rather than
        // continuously: "start work on a PR" registers a worktree moments before
        // it creates the tab, and a prune landing between the two would delete
        // the record it is about to reference.
        pruneUnreferencedWorktrees();
      });
    } else {
      gitWorktrees.set([]);
      missingWorktrees.set(new Set());
      // The backend drops every session on project close, so local bookkeeping is
      // cleared rather than closed one at a time.
      openSessions.clear();
    }
  });

  // `activeRoot` lives in stores.ts so that `changes`/`gitStatus` can derive from
  // it without stores.ts importing this module — keeping the dependency
  // one-directional and the import graph acyclic.
  activeTabRoot.subscribe((root) => {
    const canonical = canonicalRoot(root);
    activeRoot.set(canonical);
    // Switching to a tab on another worktree makes every cached directory listing
    // wrong — same relative paths, different files.
    setTreeRoot(canonical);
  });

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    // Coalesce: a single tab operation touches `tabs` and `worktrees` in
    // sequence, and reconciling between the two writes would close a session
    // that is about to be referenced again.
    queueMicrotask(() => {
      scheduled = false;
      void reconcileSessions();
    });
  };
  tabs.subscribe(schedule);
  worktrees.subscribe(schedule);
}
