/** Pull-request state for the active project.
 *
 *  One cache per project, not per worktree: every worktree of a repo shares the
 *  same remote, so they share the same PR list.
 *
 *  ## Network posture
 *
 *  A `gh pr list` is a process spawn plus a GraphQL round trip (~300-900ms).
 *  That is nothing like the free in-memory buffer read `cliStatus.ts` polls at
 *  1000ms, so it must not be polled on a similar cadence. Fetching is therefore
 *  gated on the panel being open, which is the user's explicit statement that
 *  they want this data. With the panel closed — the default — Termax makes no
 *  network calls at all.
 *
 *  Refresh triggers, cheapest first:
 *    1. Opening the panel (first open per project fetches).
 *    2. The manual refresh button.
 *    3. A change to the branch/ahead/behind/upstream signature, rate-limited.
 *       This is the one that makes an agent's own `gh pr create` show up: it
 *       pushes, which moves `ahead` to 0, which we already learn from the
 *       existing file watcher for free. Deliberately *not* wired to raw
 *       `fs-changed` — that fires on every keystroke-triggered save and would
 *       spend a network call per rate-limit window while merely typing.
 *    4. A slow safety net, only while the panel is open and the window focused.
 *       Catches the case signal 3 misses: `gh pr create` on a branch that was
 *       already pushed, where no git state changes at all.
 */
import { derived, get, writable } from "svelte/store";
import { ipc } from "./ipc";
import type { GhProbe, GhProblem, PrDetail, PullRequest } from "./types";
import { activeProject, gitMode, gitStatus } from "./stores";

/** Minimum gap between automatic refreshes. Manual refresh ignores this. */
const MIN_REFRESH_MS = 30_000;
/** Safety-net interval; only runs while the panel is open and the window has focus. */
const NET_MS = 120_000;

const PANEL_KEY = "termax.prPanelOpen";

export interface PrCache {
  prs: PullRequest[];
  /** null on success; a classified panel state otherwise (see github.rs). */
  problem: GhProblem | null;
  /** `performance.now()` of the last completed fetch; 0 means never. */
  fetchedAt: number;
  loading: boolean;
}

const EMPTY: PrCache = { prs: [], problem: null, fetchedAt: 0, loading: false };

export const prCache = writable<PrCache>(EMPTY);

/** Whether gh is installed. Probed once; involves no network and no repo. */
export const ghProbe = writable<GhProbe>({ installed: false, version: null });

/** Panel open state. Lives here rather than in the component because it gates
 *  network access — a component that unmounts must not silently re-enable
 *  fetching, and the user's choice should survive a restart. */
export const prPanelOpen = writable(readPanelOpen());

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === "1";
  } catch {
    return false;
  }
}

prPanelOpen.subscribe((open) => {
  try {
    localStorage.setItem(PANEL_KEY, open ? "1" : "0");
  } catch {
    // A private-mode/quota failure must not break the panel.
  }
});

/** Head branch → PR. The single source for every PR chip in the UI.
 *
 *  Nothing about this mapping is persisted, and that is the point: a PR number
 *  stored against a tab or branch goes stale the moment the branch is renamed or
 *  the PR merges. Deriving it also means a PR the *user's agent* created by
 *  typing `gh pr create` in a pane needs no plumbing whatsoever — the branch did
 *  not change, so the next refresh simply contains it. */
export const prByBranch = derived(prCache, (cache) => {
  const map = new Map<string, PullRequest>();
  for (const pr of cache.prs) map.set(pr.headRefName, pr);
  return map;
});

/** The PR for the checked-out branch of the primary root, if any. */
export const currentPr = derived([prByBranch, gitStatus], ([byBranch, status]) => {
  if (!status || status.detached) return null;
  return byBranch.get(status.branch) ?? null;
});

/** True when asking gh for anything is pointless: no git-mode session, or gh is
 *  missing. Callers check this instead of discovering it via a failed spawn. */
function canQuery(): boolean {
  return get(gitMode) && get(ghProbe).installed;
}

export async function probeGh(): Promise<void> {
  try {
    ghProbe.set(await ipc.ghProbe());
  } catch (err) {
    console.error("gh_probe failed", err);
    ghProbe.set({ installed: false, version: null });
  }
  // The probe is async and races project open: if a project finished opening
  // while we were still looking for the binary, every refresh trigger already
  // fired and bailed out of `canQuery`. Re-check once the answer is known,
  // otherwise an open panel sits empty until the two-minute safety net.
  if (get(prPanelOpen)) void refreshPrs();
}

/** Fetch the open PR list.
 *
 *  `force` bypasses the rate limit and is for the manual refresh button only —
 *  every automatic caller must respect it. Concurrent calls are collapsed:
 *  toggling the panel while a fetch is in flight must not double-spend. */
export async function refreshPrs(force = false): Promise<void> {
  if (!canQuery()) return;
  const cache = get(prCache);
  if (cache.loading) return;
  if (!force && cache.fetchedAt > 0 && performance.now() - cache.fetchedAt < MIN_REFRESH_MS) {
    return;
  }
  // A non-GitHub remote is a permanent fact about this project, not a transient
  // failure. Retrying it every 30s would spawn a process forever to be told the
  // same thing, so the state is sticky until the project is reopened.
  if (cache.problem?.kind === "notGitHub") return;

  prCache.update((c) => ({ ...c, loading: true }));
  try {
    const result = await ipc.ghPrList();
    prCache.set({
      prs: result.prs,
      problem: result.problem,
      fetchedAt: performance.now(),
      loading: false,
    });
  } catch (err) {
    // An Err from gh_pr_list means the *call* was wrong (no session), not that
    // gh failed — expected gh failures arrive as `problem`. Surface it rather
    // than rendering an empty list as "no pull requests".
    prCache.set({
      prs: [],
      problem: { kind: "other", message: String(err) },
      fetchedAt: performance.now(),
      loading: false,
    });
  }
}

/** Merge-readiness detail for one PR. Fetched on row expansion, never listed. */
export async function loadPrDetail(number: number): Promise<PrDetail | null> {
  if (!canQuery()) return null;
  try {
    return await ipc.ghPrView(number);
  } catch (err) {
    console.error(`gh_pr_view ${number} failed`, err);
    return null;
  }
}

export function resetPrs(): void {
  prCache.set(EMPTY);
}

/** Wire the automatic refresh triggers. Called once at startup. */
export function initPrListeners(): void {
  void probeGh();

  // Declared before the subscribers that close over it: Svelte stores invoke a
  // new subscriber synchronously, so a `let` declared below would be in its
  // temporal dead zone during that first call.
  let lastSignature = "";

  // Project switch: the cache belongs to the old repo.
  let lastProjectId: string | null = null;
  activeProject.subscribe((project) => {
    const id = project?.id ?? null;
    if (id === lastProjectId) return;
    lastProjectId = id;
    resetPrs();
    // Clear the signature too. Two projects can sit on identically-named
    // branches ("main", ahead 0, behind 0), in which case trigger 3 would see no
    // change and an already-open panel would keep showing the previous repo's
    // emptiness.
    lastSignature = "";
  });

  // Trigger 3: a git-state change worth re-asking about. Comparing a signature
  // rather than the object identity matters — `refreshChanges` replaces
  // `gitStatus` on every file save, and only these four fields imply anything
  // about pull requests.
  gitStatus.subscribe((status) => {
    const signature = status
      ? `${status.branch}|${status.ahead}|${status.behind}|${status.hasUpstream}`
      : "";
    if (signature === lastSignature) return;
    lastSignature = signature;
    if (signature && get(prPanelOpen)) void refreshPrs();
  });

  // Trigger 1: opening the panel.
  prPanelOpen.subscribe((open) => {
    if (open) void refreshPrs();
  });

  // Trigger 4: the safety net. Skipped when the window is unfocused so a
  // Termax left open in the background overnight makes no calls.
  setInterval(() => {
    if (get(prPanelOpen) && document.hasFocus()) void refreshPrs();
  }, NET_MS);
}
