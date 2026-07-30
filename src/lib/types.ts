export interface VaultCommand {
  id: string;
  name: string;
  command: string;
  /** Launcher id the command runs in (see settings.ts). */
  terminalType: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  commands: VaultCommand[];
  /** Persisted workspace. Newer projects store a {@link Workspace}; older ones
   *  store a bare {@link LayoutNode} (single-tab, auto-migrated on open). */
  layout: Workspace | LayoutNode | null;
}

/** A git worktree this project's tabs can run in.
 *
 *  Only the id and the path are persisted. Branch and pull-request number are
 *  deliberately *not*: both go stale the moment someone runs `git switch` or the
 *  PR merges, and git can always be asked. Persist what git cannot tell you.
 *
 *  `path` is machine-specific, exactly like `Project.path` — any future sync must
 *  redact it (see SYNC-PLAN.md on absolute paths). */
export interface Worktree {
  id: string;
  /** Absolute path on this machine. */
  path: string;
}

/** One tab: a full terminal/editor grid plus its focused pane. */
export interface Tab {
  id: string;
  title: string;
  layout: LayoutNode | null;
  focusedPaneId: string | null;
  /** Worktree this tab's panes run in; absent means the project root. Two tabs
   *  may share one worktree (an agent tab plus a "run the tests" tab), which is
   *  why the session for it is reference-counted. */
  worktreeId?: string;
}

/** Persisted per-project tab set. Distinguished from a bare LayoutNode by `tabs`. */
export interface Workspace {
  tabs: Tab[];
  activeTabId: string;
  /** Worktrees referenced by `tabs`. Absent in workspaces saved before worktree
   *  support, which is the whole migration: no worktrees means every tab uses the
   *  project root, which is what they already did. */
  worktrees?: Worktree[];
}

export interface PaneNode {
  type: "pane";
  id: string;
  title: string;
  /** Command launched in this pane; null means plain shell. */
  launch: string | null;
  /** Pane content; absent means "terminal" (backward compat with saved layouts). */
  kind?: "terminal" | "editor";
  /** Project-relative path of the file shown; editor panes only. */
  file?: string;
  /** Editor panes: open showing the diff (changes) view instead of plain content. */
  diff?: boolean;
  /** Editor panes: raw text or rendered preview. Absent means "edit".
   *  (The scroll position within that view lives in paneScroll.ts.) */
  view?: "edit" | "preview";
  /** Terminal panes: chime + pulse when the command finishes or wants input. */
  bell?: boolean;
}

export interface SplitNode {
  type: "split";
  id: string;
  dir: "row" | "col";
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export type ChangeArea = "staged" | "unstaged" | "untracked";

export interface ChangeEntry {
  path: string;
  /** Snapshot mode: "created" | "modified" | "deleted". Git mode: single letter (A/M/D/R/C/U). */
  status: string;
  added: number;
  removed: number;
  /** Present only in git mode. */
  area?: ChangeArea;
}

export interface GitStatus {
  branch: string;
  detached: boolean;
  hasUpstream: boolean;
  /** Tracking ref, e.g. "origin/main"; null when no upstream is set. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Browser URL for the remote, e.g. "https://github.com/owner/repo"; null when there's no remote. */
  remoteUrl: string | null;
}

export interface SessionInfo {
  git: boolean;
  fileCount: number;
  /** True when the folder was opened untrusted: git disabled, snapshot only. */
  restricted: boolean;
  /** Canonicalized root this session is keyed by. Always store this rather than
   *  the path that was sent — on platforms that rewrite paths (macOS
   *  /var → /private/var) the two differ, and the backend keys by the canonical
   *  form. */
  root: string;
}

/** One entry of `git worktree list`. */
export interface WorktreeEntry {
  /** Absolute path, as git reports it. */
  path: string;
  /** Short branch name; null when detached. */
  branch: string | null;
  head: string;
  detached: boolean;
  /** `git worktree lock`ed — removal refuses without force. */
  locked: boolean;
  /** The main working tree (the one holding the real .git directory). */
  isMain: boolean;
}

export interface GhProbe {
  installed: boolean;
  /** First line of `gh --version`; null when gh is missing. */
  version: string | null;
}

/** Why a PR list is unavailable. Classified in Rust (github.rs) so the UI
 *  switches on `kind` instead of matching gh's stderr prose. */
export interface GhProblem {
  kind: "notInstalled" | "notAuthenticated" | "notGitHub" | "noRemote" | "other";
  /** gh's stderr, shown verbatim for "other". */
  message: string;
}

export type PrState = "OPEN" | "CLOSED" | "MERGED";

/** "REVIEW_REQUIRED" | "APPROVED" | "CHANGES_REQUESTED"; null when the repo
 *  requires no review. */
export type ReviewDecision = string | null;

export interface PullRequest {
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  url: string;
  author: { login: string };
  updatedAt: string;
  reviewDecision: ReviewDecision;
  /** Head branch lives in a fork: not pushable from a plain worktree. */
  isCrossRepository: boolean;
  headRepositoryOwner: { login: string };
  labels: { name: string; color: string }[];
}

export interface PrListResult {
  prs: PullRequest[];
  /** null on success. A problem is a panel state, not a failed call. */
  problem: GhProblem | null;
}

export interface ChecksRollup {
  passed: number;
  failed: number;
  pending: number;
  /** Skipped/neutral/cancelled — must not read as failures. */
  skipped: number;
  failing: string[];
}

/** The fields too expensive to fetch for every PR in the list. */
export interface PrDetail {
  number: number;
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** Not `mergeable` — this is what catches branch protection. A PR can be
   *  MERGEABLE and BLOCKED at once. */
  mergeStateStatus:
    | "CLEAN"
    | "BLOCKED"
    | "BEHIND"
    | "DIRTY"
    | "DRAFT"
    | "HAS_HOOKS"
    | "UNSTABLE"
    | "UNKNOWN";
  reviewDecision: ReviewDecision;
  checks: ChecksRollup;
  body: string;
}

export interface FileDiff {
  original: string;
  modified: string;
  binary: boolean;
}

export interface TreeEntry {
  name: string;
  /** Path relative to the project root, forward slashes. */
  path: string;
  isDir: boolean;
  /** .gitignored (git mode) or in the built-in ignore list (snapshot mode). */
  ignored: boolean;
}

export interface FileContent {
  content: string;
  binary: boolean;
}
