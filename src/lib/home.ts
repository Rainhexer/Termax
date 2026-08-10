/** State and helpers for the home screen.
 *
 *  The home screen answers one question: *which project do I work in next, and
 *  what state did I leave it in?* Everything here exists to answer it without
 *  opening anything — git vitals per project, an activity grid, and a search
 *  that reaches into every project's files at once.
 *
 *  Kept out of `stores.ts` deliberately: none of this is live while a project is
 *  open, and `stores.ts` is already the app's largest module. */

import { get, writable } from "svelte/store";
import { ipc } from "./ipc";
import type { DayCount, Project, ProjectStats, SearchResult } from "./types";

/** Days shown in an activity grid. Four weeks fills seven rows exactly, which
 *  is what makes the shape readable at thumbnail size. */
export const ACTIVITY_DAYS = 28;

/** Stats by project id. Absent means "not asked yet" — the card shows skeleton
 *  markers rather than zeros, because zero is a real and different answer. */
export const projectStats = writable<Map<string, ProjectStats>>(new Map());

/** Ids with a request in flight, so a card can show it is refreshing without a
 *  global spinner covering the screen. */
export const statsPending = writable<Set<string>>(new Set());

export const searchQuery = writable("");
export const searchResult = writable<SearchResult | null>(null);
export const searching = writable(false);

/** Discards the answer to a query the user has already typed past. Without it,
 *  a slow project's results can land after a faster later query's and replace
 *  them. */
let searchGeneration = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounce before a search reaches the disk. Long enough that typing a word
 *  costs one search, short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 220;

/** Shorter than a full word: every project matches, and the answer is useless
 *  at any length. Mirrored in the Rust side, which refuses to walk for less. */
export const MIN_QUERY = 2;

function markPending(id: string, pending: boolean) {
  statsPending.update((set) => {
    const next = new Set(set);
    if (pending) next.add(id);
    else next.delete(id);
    return next;
  });
}

/** Load one project's stats.
 *
 *  Called once per project rather than once for all of them, so the cards paint
 *  as their answers land instead of the whole screen waiting on the slowest
 *  repository. Failures collapse into a `missing`-shaped record: the home screen
 *  must still render when a folder is on a disconnected drive, which is exactly
 *  when you most want to see that it is. */
export async function loadStats(id: string): Promise<void> {
  markPending(id, true);
  try {
    const stats = await ipc.projectStats(id);
    projectStats.update((map) => new Map(map).set(id, stats));
  } catch (err) {
    console.error("project_stats failed", id, err);
    projectStats.update((map) =>
      new Map(map).set(id, { ...EMPTY_STATS, id, missing: true }),
    );
  } finally {
    markPending(id, false);
  }
}

const EMPTY_STATS: ProjectStats = {
  id: "",
  missing: false,
  trusted: false,
  isRepo: false,
  branch: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicts: 0,
  recentCommits: [],
  remoteUrl: null,
  activity: [],
  worktrees: 0,
  stack: [],
  extensions: [],
  agentDocs: [],
};

/** Run a search, debounced, discarding stale answers. */
export function queueSearch(query: string): void {
  clearTimeout(searchTimer);
  searchQuery.set(query);
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY) {
    searchGeneration += 1; // cancel anything in flight
    searching.set(false);
    searchResult.set(null);
    return;
  }
  searching.set(true);
  searchTimer = setTimeout(() => void runSearch(trimmed), SEARCH_DEBOUNCE_MS);
}

async function runSearch(query: string): Promise<void> {
  const generation = ++searchGeneration;
  try {
    const result = await ipc.searchProjects(query);
    if (generation !== searchGeneration) return;
    searchResult.set(result);
  } catch (err) {
    if (generation !== searchGeneration) return;
    console.error("search_projects failed", err);
    searchResult.set({ files: [], text: [], truncated: false, skipped: [] });
  } finally {
    if (generation === searchGeneration) searching.set(false);
  }
}

export function clearSearch(): void {
  clearTimeout(searchTimer);
  searchGeneration += 1;
  searchQuery.set("");
  searchResult.set(null);
  searching.set(false);
}

// --- Derived reads ----------------------------------------------------------

/** Uncommitted paths: the number the card badges and the strip totals.
 *
 *  Conflicts are counted here *and* surfaced separately — they are uncommitted
 *  work, but they are also the one state that blocks everything else. */
export function dirtyCount(stats: ProjectStats | undefined): number {
  if (!stats) return 0;
  return stats.staged + stats.unstaged + stats.untracked + stats.conflicts;
}

/** Home-screen order: pinned first, then most recently opened, then by name.
 *
 *  Recency rather than insertion order because the screen does not scroll:
 *  what fits has to be what you actually use. */
export function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const at = a.lastOpened ?? 0;
    const bt = b.lastOpened ?? 0;
    if (at !== bt) return bt - at;
    return a.name.localeCompare(b.name);
  });
}

/** Match a project against the search box, so typing a project's name narrows
 *  the grid to it without waiting for the file search to come back. */
export function matchesProject(project: Project, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    project.name.toLowerCase().includes(q) || project.path.toLowerCase().includes(q)
  );
}

/** The last {@link ACTIVITY_DAYS} calendar days, oldest first, as `YYYY-MM-DD`
 *  in *local* time — the same basis git used when it formatted the commit
 *  dates, so the two line up. */
export function activityAxis(days = ACTIVITY_DAYS): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0); // midday: immune to DST shifting the date
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    const month = String(day.getMonth() + 1).padStart(2, "0");
    const date = String(day.getDate()).padStart(2, "0");
    out.push(`${day.getFullYear()}-${month}-${date}`);
  }
  return out;
}

/** Align sparse `DayCount`s onto a dense day axis. */
export function activitySeries(activity: DayCount[], days = ACTIVITY_DAYS): number[] {
  const counts = new Map(activity.map((d) => [d.date, d.count]));
  return activityAxis(days).map((date) => counts.get(date) ?? 0);
}

/** Sum activity across projects onto one axis, for the global grid. */
export function mergedActivity(all: ProjectStats[], days = ACTIVITY_DAYS): number[] {
  const total = new Array(days).fill(0);
  for (const stats of all) {
    const series = activitySeries(stats.activity, days);
    for (let i = 0; i < days; i++) total[i] += series[i];
  }
  return total;
}

/** Bucket a count into one of five heat levels (0 = none). Thresholds are
 *  absolute rather than relative to the busiest day: a quiet week should look
 *  quiet, not be rescaled into looking busy. */
export function heatLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 10) return 3;
  return 4;
}

/** Compact relative time: "3m", "5h", "2d", "6w", "1y". Rendered short because
 *  it sits on a chip; the full timestamp goes in the `title`. */
export function relativeTime(unixSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(days / 365)}y`;
}

export function fullTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

/** Shorten a path for display, keeping the tail (which identifies it) and
 *  collapsing the home directory to `~`. */
export function prettyPath(path: string, maxSegments = 3): string {
  const home = detectHome(path);
  const shown = home ? `~${path.slice(home.length)}` : path;
  const sep = shown.includes("\\") ? "\\" : "/";
  const parts = shown.split(sep).filter(Boolean);
  if (parts.length <= maxSegments) return shown;
  return `…${sep}${parts.slice(-maxSegments).join(sep)}`;
}

/** Best-effort home-directory prefix, inferred from the path itself: the
 *  frontend has no environment access, and this only affects display. */
function detectHome(path: string): string | null {
  const match = path.match(/^(\/(?:home|Users)\/[^/]+)/) ?? path.match(/^([A-Za-z]:\\Users\\[^\\]+)/);
  return match ? match[1] : null;
}

/** Identity tint for a project, stable across restarts.
 *
 *  Four hues, all of them theme tokens (see app.css), so a custom theme
 *  restyles the home screen along with everything else. Red is deliberately not
 *  in the set: on this screen red means "something is wrong". */
export const ACCENTS = ["emerald", "blue", "purple", "amber"] as const;
export type Accent = (typeof ACCENTS)[number];

export function accentFor(key: string): Accent {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return ACCENTS[hash % ACCENTS.length];
}

/** Per-accent class strings.
 *
 *  Spelled out in full rather than built by interpolation because Tailwind
 *  scans source text for class names: `bg-${accent}-400` is invisible to it and
 *  would ship as a missing style. Only shades that app.css remaps onto theme
 *  tokens are used, with alpha modifiers for the in-between steps — a custom
 *  theme therefore restyles all of this for free. */
export const ACCENT_CLASSES: Record<
  Accent,
  { text: string; border: string; fill: string; tab: string; glow: string; heat: string[] }
> = {
  emerald: {
    text: "text-emerald-400",
    border: "border-emerald-500/40",
    fill: "bg-emerald-500/15",
    tab: "bg-emerald-400/30",
    glow: "shadow-emerald-500/10",
    heat: [
      "bg-zinc-800",
      "bg-emerald-400/20",
      "bg-emerald-400/40",
      "bg-emerald-400/70",
      "bg-emerald-400",
    ],
  },
  blue: {
    text: "text-blue-400",
    border: "border-blue-400/40",
    fill: "bg-blue-400/15",
    tab: "bg-blue-400/30",
    glow: "shadow-blue-400/10",
    heat: ["bg-zinc-800", "bg-blue-400/20", "bg-blue-400/40", "bg-blue-400/70", "bg-blue-400"],
  },
  purple: {
    text: "text-purple-400",
    border: "border-purple-400/40",
    fill: "bg-purple-400/15",
    tab: "bg-purple-400/30",
    glow: "shadow-purple-400/10",
    heat: [
      "bg-zinc-800",
      "bg-purple-400/20",
      "bg-purple-400/40",
      "bg-purple-400/70",
      "bg-purple-400",
    ],
  },
  amber: {
    text: "text-amber-400",
    border: "border-amber-400/40",
    fill: "bg-amber-400/15",
    tab: "bg-amber-400/30",
    glow: "shadow-amber-400/10",
    heat: ["bg-zinc-800", "bg-amber-400/20", "bg-amber-400/40", "bg-amber-400/70", "bg-amber-400"],
  },
};

/** GitHub-style sub-pages of a remote. Returns null for a remote that isn't a
 *  forge we know the URL shape of, so the menu can hide the entry instead of
 *  opening a 404. */
export function repoSubPage(remoteUrl: string | null, page: "issues" | "pulls"): string | null {
  if (!remoteUrl) return null;
  const known = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org|[^/]*gitea[^/]*)\//.test(
    remoteUrl,
  );
  if (!known) return null;
  // GitLab spells the pull-request list "merge_requests"; everyone else agrees
  // with GitHub.
  if (remoteUrl.includes("gitlab.com")) {
    return `${remoteUrl}/-/${page === "pulls" ? "merge_requests" : "issues"}`;
  }
  return `${remoteUrl}/${page}`;
}

/** Copy text to the clipboard, falling back for webviews that refuse the async
 *  API. Returns whether it worked, so the caller can say so. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// --- Mutations --------------------------------------------------------------

export async function togglePin(project: Project): Promise<void> {
  await ipc.setProjectPinned(project.id, !project.pinned);
}

/** Record that a project is being opened, for the recency ordering. Best
 *  effort: failing to write a sort key must never block opening the project. */
export function markOpened(id: string): void {
  ipc.touchProject(id).catch((err) => console.error("touch_project failed", err));
}
