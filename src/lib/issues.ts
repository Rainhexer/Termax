/** Issue state for the active project.
 *
 *  One cache per project, like `pr.ts`, and for the same reason: every worktree
 *  of a repo shares a remote, so they share an issue list.
 *
 *  ## Network posture
 *
 *  Identical to pull requests — see the long note in `pr.ts`. Fetching is gated
 *  on the panel being open, which is the user's explicit statement that they
 *  want this data; with the panel closed, the default, Termax makes no issue
 *  calls at all.
 *
 *  Two things differ, both because of what an issue list *is*:
 *
 *  1. **Filters are part of the request.** A repo can have tens of thousands of
 *     issues, so unlike `gh pr list` there is no useful "just show me them all".
 *     Changing a filter is a deliberate act and refetches immediately, bypassing
 *     the rate limit the way the manual refresh button does — a filter that
 *     silently showed the previous filter's results would be a bug, not a saving.
 *
 *  2. **No git-state trigger.** A branch moving says something about pull
 *     requests; it says nothing about issues. The one exception is the session
 *     starting, which is not a git state but the gate that makes querying
 *     possible: the panel-open and gh-probe triggers can both land before the
 *     project session exists, so a single once-per-session refresh on git mode
 *     coming up is what stops an open panel waiting out the safety net.
 *
 *  Repository metadata (labels, assignees, milestones, the signed-in login)
 *  is fetched once per project on first panel open and then cached, because it
 *  changes on a scale of weeks and is needed by every picker.
 */
import { derived, get, writable } from "svelte/store";
import { ipc } from "./ipc";
import type {
  GhProblem,
  Issue,
  IssueDetail,
  IssueFilter,
  Milestone,
  RepoLabel,
} from "./types";
import { activeProject, gitMode } from "./stores";
import { ghProbe } from "./pr";

/** Minimum gap between automatic refreshes. Manual refresh and filter changes
 *  ignore this. */
const MIN_REFRESH_MS = 30_000;
/** Safety-net interval; only runs while the panel is open and the window has focus. */
const NET_MS = 180_000;

const PANEL_KEY = "termax.issuePanelOpen";

export interface IssueCache {
  issues: Issue[];
  /** null on success; a classified panel state otherwise (see github.rs). */
  problem: GhProblem | null;
  /** More issues matched than were returned. */
  truncated: boolean;
  /** `performance.now()` of the last completed fetch; 0 means never. */
  fetchedAt: number;
  loading: boolean;
}

const EMPTY: IssueCache = {
  issues: [],
  problem: null,
  truncated: false,
  fetchedAt: 0,
  loading: false,
};

export const issueCache = writable<IssueCache>(EMPTY);

/** Repository metadata backing the pickers. Absent lists degrade to free-text
 *  inputs rather than blocking the form, so a failure here is not an error. */
export interface RepoMeta {
  labels: RepoLabel[];
  assignees: { login: string }[];
  milestones: Milestone[];
  /** The signed-in login, for "assigned to me" and for marking your own
   *  comments. null when gh cannot say. */
  me: string | null;
  loaded: boolean;
}

const NO_META: RepoMeta = {
  labels: [],
  assignees: [],
  milestones: [],
  me: null,
  loaded: false,
};

export const repoMeta = writable<RepoMeta>(NO_META);

/** The active filter. Its identity is the query — changing it refetches. */
export const issueFilter = writable<IssueFilter>({ state: "open" });

/** Panel open state. Lives here rather than in the component for the same
 *  reason `prPanelOpen` does: it gates network access, so a component that
 *  unmounts must not silently re-enable fetching, and the choice should survive
 *  a restart. */
export const issuePanelOpen = writable(readPanelOpen());

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === "1";
  } catch {
    return false;
  }
}

issuePanelOpen.subscribe((open) => {
  try {
    localStorage.setItem(PANEL_KEY, open ? "1" : "0");
  } catch {
    // A private-mode/quota failure must not break the panel.
  }
});

/** Number → issue, for anything that needs to resolve a reference cheaply. */
export const issueByNumber = derived(issueCache, (cache) => {
  const map = new Map<number, Issue>();
  for (const issue of cache.issues) map.set(issue.number, issue);
  return map;
});

/** True when the filter is anything other than the default "open issues".
 *  Drives the "clear filters" affordance, so an empty list is never mistaken
 *  for an empty repository. */
export const filterActive = derived(issueFilter, (filter) => {
  return !!(
    (filter.state && filter.state !== "open") ||
    filter.labels?.length ||
    filter.assignee ||
    filter.author ||
    filter.milestone ||
    filter.search?.trim()
  );
});

/** True when asking gh for anything is pointless: no git-mode session, or gh is
 *  missing. Callers check this instead of discovering it via a failed spawn. */
function canQuery(): boolean {
  return get(gitMode) && get(ghProbe).installed;
}

/** Fetch the issue list for the current filter.
 *
 *  `force` bypasses the rate limit and is for the manual refresh button and
 *  filter changes only — every automatic caller must respect it. Concurrent
 *  calls are collapsed so toggling the panel mid-fetch does not double-spend. */
export async function refreshIssues(force = false): Promise<void> {
  if (!canQuery()) return;
  const cache = get(issueCache);
  if (cache.loading) return;
  if (!force && cache.fetchedAt > 0 && performance.now() - cache.fetchedAt < MIN_REFRESH_MS) {
    return;
  }
  // A non-GitHub remote is a permanent fact about this project, not a transient
  // failure. Retrying it forever would spawn a process to be told the same
  // thing, so the state is sticky until the project is reopened.
  if (cache.problem?.kind === "notGitHub") return;

  issueCache.update((c) => ({ ...c, loading: true }));
  try {
    const result = await ipc.ghIssueList(get(issueFilter));
    issueCache.set({
      issues: result.issues,
      problem: result.problem,
      truncated: result.truncated,
      fetchedAt: performance.now(),
      loading: false,
    });
  } catch (err) {
    // An Err from gh_issue_list means the *call* was wrong (no session), not
    // that gh failed — expected gh failures arrive as `problem`. Surface it
    // rather than rendering an empty list as "no issues".
    issueCache.set({
      issues: [],
      problem: { kind: "other", message: String(err) },
      truncated: false,
      fetchedAt: performance.now(),
      loading: false,
    });
  }
}

/** A filter's identity as a string, for deciding whether it actually changed.
 *
 *  Normalised rather than `JSON.stringify`d directly: `undefined`, `""` and an
 *  empty array all mean "unset", and key order varies with how the patch was
 *  built. Without this, re-committing an unchanged search box — which happens on
 *  every blur — would look like a new query and spend a network call. */
function filterKey(filter: IssueFilter): string {
  return JSON.stringify([
    filter.state ?? "open",
    [...(filter.labels ?? [])].sort(),
    filter.assignee ?? "",
    filter.author ?? "",
    filter.milestone ?? "",
    filter.search?.trim() ?? "",
    filter.limit ?? 0,
  ]);
}

/** Replace the filter and refetch.
 *
 *  Every filter change goes through here rather than writing the store
 *  directly, so there is exactly one place where "the query changed" and "ask
 *  again" are tied together — and one place that can tell when it did *not*
 *  change and skip the call. Forcing a refetch regardless is what the manual
 *  refresh button is for. */
export function setFilter(next: IssueFilter): void {
  if (filterKey(next) === filterKey(get(issueFilter))) return;
  issueFilter.set(next);
  void refreshIssues(true);
}

/** Merge a partial change into the filter. */
export function patchFilter(patch: Partial<IssueFilter>): void {
  setFilter({ ...get(issueFilter), ...patch });
}

/** Add or remove one label from the filter. */
export function toggleFilterLabel(name: string): void {
  const current = get(issueFilter).labels ?? [];
  const next = current.includes(name)
    ? current.filter((l) => l !== name)
    : [...current, name];
  patchFilter({ labels: next });
}

export function clearFilter(): void {
  setFilter({ state: "open" });
}

/** Load the repository metadata the pickers need. Once per project. */
export async function loadRepoMeta(force = false): Promise<void> {
  if (!canQuery()) return;
  if (!force && get(repoMeta).loaded) return;
  // Marked loaded up front so two panel opens in quick succession do not each
  // spend four calls; a failure below still leaves usable empty lists.
  repoMeta.update((m) => ({ ...m, loaded: true }));
  const [labels, assignees, milestones, me] = await Promise.all([
    ipc.ghRepoLabels().catch(() => []),
    ipc.ghRepoAssignees().catch(() => []),
    ipc.ghRepoMilestones().catch(() => []),
    ipc.ghMe().catch(() => null),
  ]);
  repoMeta.set({ labels, assignees, milestones, me, loaded: true });
}

/** Full detail for one issue: body and comments. Fetched on open, never listed. */
export async function loadIssueDetail(number: number): Promise<IssueDetail | null> {
  if (!canQuery()) return null;
  try {
    return await ipc.ghIssueView(number);
  } catch (err) {
    console.error(`gh_issue_view ${number} failed`, err);
    return null;
  }
}

/** Branches already linked to an issue via `gh issue develop`. */
export async function linkedBranches(number: number): Promise<string[]> {
  if (!canQuery()) return [];
  return ipc.ghIssueDevelopList(number).catch(() => []);
}

/** "3d ago" from an ISO timestamp.
 *
 *  Issue lists are read by recency far more than by date, and a relative age
 *  fits a sidebar column where "2026-07-14T09:31:02Z" does not. Returns "" for
 *  anything unparseable rather than "NaN ago". */
export function ago(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d ago`;
  if (seconds < 31_536_000) return `${Math.floor(seconds / 2_592_000)}mo ago`;
  return `${Math.floor(seconds / 31_536_000)}y ago`;
}

export function resetIssues(): void {
  issueCache.set(EMPTY);
  repoMeta.set(NO_META);
  // The filter is repo-specific: labels and milestones from the old project do
  // not exist in the new one, and a stale label filter would silently return
  // nothing at all.
  issueFilter.set({ state: "open" });
}

/** Wire the automatic refresh triggers. Called once at startup.
 *
 *  Deliberately fewer triggers than `initPrListeners` has: there is no
 *  git-state signal that implies anything about issues, and no equivalent of
 *  "an agent just created one in a pane" that Termax can observe for free. */
export function initIssueListeners(): void {
  // Project switch: the cache and the metadata belong to the old repo.
  let lastProjectId: string | null = null;
  activeProject.subscribe((project) => {
    const id = project?.id ?? null;
    if (id === lastProjectId) return;
    lastProjectId = id;
    resetIssues();
  });

  // Trigger 1: opening the panel.
  issuePanelOpen.subscribe((open) => {
    if (!open) return;
    void refreshIssues();
    void loadRepoMeta();
  });

  // The gh probe is async and races project open, exactly as it does for pull
  // requests: if a project finished opening while the binary was still being
  // looked for, trigger 1 already fired and bailed out of `canQuery`. Reacting
  // to the probe landing is what stops an open panel sitting empty until the
  // safety net. Subscribing to `ghProbe` rather than having `probeGh` call in
  // here keeps the dependency pointing one way — pr.ts knows nothing of issues.
  let wasInstalled = false;
  ghProbe.subscribe((probe) => {
    if (probe.installed === wasInstalled) return;
    wasInstalled = probe.installed;
    if (!probe.installed || !get(issuePanelOpen)) return;
    void refreshIssues();
    void loadRepoMeta();
  });

  // Trigger 2: git mode coming up. The panel-open and probe triggers above can
  // both land before the project session exists — `gh --version` runs much
  // faster than `start_session`, which may wait on the trust dialog — so each
  // bails out of `canQuery` and nothing re-asks. Unlike the PR panel there is
  // deliberately no git-state trigger, so this once-per-session transition is
  // the only thing that can close that gap: it fires on project open, never on
  // branch moves, keeping issue traffic below the PR panel's.
  let wasGit = false;
  gitMode.subscribe((git) => {
    if (git === wasGit) return;
    wasGit = git;
    if (!git || !get(issuePanelOpen)) return;
    void refreshIssues();
    void loadRepoMeta();
  });

  // Trigger 3: the safety net, skipped when the window is unfocused so a Termax
  // left open overnight makes no calls. Slower than the PR panel's because an
  // issue list goes stale on the scale of hours, not minutes.
  setInterval(() => {
    if (get(issuePanelOpen) && document.hasFocus()) void refreshIssues();
  }, NET_MS);
}
