import { invoke } from "@tauri-apps/api/core";
import type {
  ChangeArea,
  ChangeEntry,
  CloseReason,
  FileContent,
  FileDiff,
  GhProbe,
  GitStatus,
  IssueDetail,
  IssueEdit,
  IssueFilter,
  IssueListResult,
  LayoutNode,
  LockReason,
  Milestone,
  PrDetail,
  PrListResult,
  Project,
  ProjectStats,
  PullRequest,
  RepoLabel,
  SearchResult,
  SessionInfo,
  TreeEntry,
  VaultCommand,
  Workspace,
  WorktreeEntry,
} from "./types";
import type { AppSettings, DetectedAgent } from "./settings";

export const ipc = {
  // PTY
  spawnPty: (paneId: string, cwd: string, command: string | null, rows: number, cols: number) =>
    invoke<void>("spawn_pty", { paneId, cwd, command, rows, cols }),
  writePty: (paneId: string, data: string) => invoke<void>("write_pty", { paneId, data }),
  resizePty: (paneId: string, rows: number, cols: number) =>
    invoke<void>("resize_pty", { paneId, rows, cols }),
  killPty: (paneId: string) => invoke<void>("kill_pty", { paneId }),
  /** True/false when the pane's tty reports whether a foreground command is
   *  running; null when the platform cannot tell. */
  ptyForegroundBusy: (paneId: string) => invoke<boolean | null>("pty_foreground_busy", { paneId }),

  // Projects
  listProjects: () => invoke<Project[]>("list_projects"),
  addProject: (name: string, path: string) => invoke<Project>("add_project", { name, path }),
  removeProject: (id: string) => invoke<void>("remove_project", { id }),
  /** Rename the *label*, not the folder. */
  renameProject: (id: string, name: string) => invoke<void>("rename_project", { id, name }),
  setProjectPinned: (id: string, pinned: boolean) =>
    invoke<void>("set_project_pinned", { id, pinned }),
  touchProject: (id: string) => invoke<void>("touch_project", { id }),
  saveLayout: (id: string, layout: Workspace | LayoutNode | null) =>
    invoke<void>("save_layout", { id, layout }),
  addVaultCommand: (projectId: string, name: string, command: string, terminalType: string) =>
    invoke<VaultCommand>("add_vault_command", { projectId, name, command, terminalType }),
  updateVaultCommand: (
    projectId: string,
    commandId: string,
    name: string,
    command: string,
    terminalType: string,
  ) =>
    invoke<VaultCommand>("update_vault_command", {
      projectId,
      commandId,
      name,
      command,
      terminalType,
    }),
  removeVaultCommand: (projectId: string, commandId: string) =>
    invoke<void>("remove_vault_command", { projectId, commandId }),

  // Home screen. These run with no session open, so they take a project *id*
  // and the backend resolves the path from its own store — the frontend never
  // names a directory. Git only runs on trusted folders (see home.rs).
  projectStats: (id: string) => invoke<ProjectStats>("project_stats", { id }),
  searchProjects: (query: string) => invoke<SearchResult>("search_projects", { query }),
  openProjectFolder: (id: string) => invoke<void>("open_project_folder", { id }),
  openProjectTerminal: (id: string) => invoke<void>("open_project_terminal", { id }),

  // Change tracking.
  //
  // Every call takes an optional `root`, which selects one of several concurrent
  // sessions (the project plus any open worktrees). Omitting it means the project
  // root, so pre-worktree call sites keep working untouched: Tauri serializes
  // args with JSON.stringify, which drops undefined keys, and the Rust side sees
  // `None`.
  startSession: (projectPath: string, trusted: boolean) =>
    invoke<SessionInfo>("start_session", { projectPath, trusted }),
  stopSession: () => invoke<void>("stop_session"),
  openWorktreeSession: (path: string) => invoke<SessionInfo>("open_worktree_session", { path }),
  closeWorktreeSession: (path: string) => invoke<void>("close_worktree_session", { path }),
  /** Change list and branch state for a root, in one call: they come from the
   *  same `git status`, and this is the app's most repeated backend work. */
  getRootGit: (root?: string) => invoke<{ changes: ChangeEntry[]; status: GitStatus | null }>("get_root_git", { root }),
  gitFetch: (root?: string) => invoke<GitStatus>("git_fetch", { root }),
  gitPull: (root?: string) => invoke<string>("git_pull", { root }),
  gitBranches: (root?: string) => invoke<string[]>("git_branches", { root }),
  gitCheckout: (branch: string, root?: string) =>
    invoke<GitStatus>("git_checkout", { branch, root }),
  getDiff: (path: string, area?: ChangeArea, root?: string) =>
    invoke<FileDiff>("get_diff", { path, area, root }),
  gitDefaultBranch: () => invoke<string | null>("git_default_branch"),

  // Worktrees. All of these act on the project's main tree, which is where git
  // keeps the administrative records.
  listWorktrees: () => invoke<WorktreeEntry[]>("list_worktrees"),
  /** Create a worktree. With `committish`, the tree is detached at that commit
   *  (the fork-PR case, where the head branch is not in this repository). */
  worktreeAdd: (path: string, branch: string, committish?: string) =>
    invoke<WorktreeEntry[]>("worktree_add", { path, branch, committish }),
  worktreeRemove: (path: string, force: boolean) =>
    invoke<WorktreeEntry[]>("worktree_remove", { path, force }),
  worktreePrune: () => invoke<WorktreeEntry[]>("worktree_prune"),

  // GitHub (gh CLI). Every call but ghProbe reaches the network, so callers must
  // be driven by explicit user action — see the network posture in github.rs.
  ghProbe: () => invoke<GhProbe>("gh_probe"),
  ghPrList: () => invoke<PrListResult>("gh_pr_list"),
  ghPrForBranch: (branch: string) => invoke<PullRequest | null>("gh_pr_for_branch", { branch }),
  ghPrView: (number: number) => invoke<PrDetail>("gh_pr_view", { number }),
  /** Creates the PR and returns its URL. Note this *pushes* the branch when it
   *  has no upstream — the caller must have said so first. */
  ghPrCreate: (title: string, body: string, base: string, draft: boolean, root?: string) =>
    invoke<string>("gh_pr_create", { title, body, base, draft, root }),
  ghPrReady: (number: number, root?: string) => invoke<void>("gh_pr_ready", { number, root }),
  ghPrMerge: (number: number, method: string, deleteBranch: boolean, root?: string) =>
    invoke<string>("gh_pr_merge", { number, method, deleteBranch, root }),
  ghPrClose: (number: number, root?: string) => invoke<void>("gh_pr_close", { number, root }),

  // Issues. Same posture as the pull-request calls: every one reaches the
  // network, so nothing here runs without the panel being open or the user
  // pressing something. `filter` and `edit` are whole objects rather than long
  // argument lists — both grow, and Tauri drops undefined keys, so an omitted
  // field arrives as Rust's None and means "unset" rather than "empty".
  ghIssueList: (filter: IssueFilter) => invoke<IssueListResult>("gh_issue_list", { filter }),
  ghIssueView: (number: number) => invoke<IssueDetail>("gh_issue_view", { number }),
  /** Creates the issue and returns its URL. */
  ghIssueCreate: (
    title: string,
    body: string,
    labels: string[],
    assignees: string[],
    milestone?: string,
    root?: string,
  ) => invoke<string>("gh_issue_create", { title, body, labels, assignees, milestone, root }),
  ghIssueEdit: (number: number, edit: IssueEdit, root?: string) =>
    invoke<void>("gh_issue_edit", { number, edit, root }),
  ghIssueClose: (
    number: number,
    reason?: CloseReason,
    comment?: string,
    duplicateOf?: string,
    root?: string,
  ) => invoke<void>("gh_issue_close", { number, reason, comment, duplicateOf, root }),
  ghIssueReopen: (number: number, comment?: string, root?: string) =>
    invoke<void>("gh_issue_reopen", { number, comment, root }),
  /** Comments and returns the new comment's URL. */
  ghIssueComment: (number: number, body: string, root?: string) =>
    invoke<string>("gh_issue_comment", { number, body, root }),
  /** Creates a branch on the *remote*, linked to the issue so merging its pull
   *  request closes the issue. Returns the branch's real name, which GitHub may
   *  have suffixed if the requested one was taken. */
  ghIssueDevelop: (number: number, name: string, base?: string, root?: string) =>
    invoke<string>("gh_issue_develop", { number, name, base, root }),
  /** Branches already linked to an issue: "is someone on this already?" */
  ghIssueDevelopList: (number: number) => invoke<string[]>("gh_issue_develop_list", { number }),
  ghIssuePin: (number: number, pinned: boolean, root?: string) =>
    invoke<void>("gh_issue_pin", { number, pinned, root }),
  ghIssueLock: (number: number, locked: boolean, reason?: LockReason, root?: string) =>
    invoke<void>("gh_issue_lock", { number, locked, reason, root }),
  ghIssueTransfer: (number: number, destination: string, root?: string) =>
    invoke<string>("gh_issue_transfer", { number, destination, root }),
  /** Irreversible, and needs admin rights on the repository. */
  ghIssueDelete: (number: number, root?: string) => invoke<void>("gh_issue_delete", { number, root }),

  // Repository metadata for the pickers. Each degrades to an empty list rather
  // than an error: a missing label list means a free-text field, not a failure.
  ghRepoLabels: () => invoke<RepoLabel[]>("gh_repo_labels"),
  ghRepoAssignees: () => invoke<{ login: string }[]>("gh_repo_assignees"),
  ghRepoMilestones: () => invoke<Milestone[]>("gh_repo_milestones"),
  /** The signed-in login, for "assigned to me" and for marking your own
   *  comments. null when gh cannot say. */
  ghMe: () => invoke<string | null>("gh_me"),

  // Git mutations used by the pull-request flows. All hardened the same way as
  // the read paths — gh shells out to plain git, so ref changes stay on our side.
  gitCreateBranch: (branch: string, root?: string) =>
    invoke<GitStatus>("git_create_branch", { branch, root }),
  gitFetchBranch: (branch: string) => invoke<void>("git_fetch_branch", { branch }),
  gitFetchPrHead: (number: number) => invoke<string>("git_fetch_pr_head", { number }),
  gitPush: (branch: string, forceWithLease: boolean, root?: string) =>
    invoke<string>("git_push", { branch, forceWithLease, root }),
  gitDeleteBranch: (branch: string, local: boolean, remote: boolean) =>
    invoke<void>("git_delete_branch", { branch, local, remote }),
  gitCommitSubjects: (base: string, limit: number, root?: string) =>
    invoke<string[]>("git_commit_subjects", { base, limit, root }),

  // Settings
  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) => invoke<void>("save_settings", { settings }),
  detectAgents: () => invoke<DetectedAgent[]>("detect_agents"),
  validateCommand: (command: string) => invoke<boolean>("validate_command", { command }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  writeThemeFile: (path: string, contents: string) =>
    invoke<void>("write_theme_file", { path, contents }),
  readThemeFile: (path: string) => invoke<string>("read_theme_file", { path }),
  listFonts: () => invoke<string[]>("list_fonts"),

  // Folder trust
  isTrusted: (path: string) => invoke<boolean>("is_trusted", { path }),
  trustFolder: (path: string) => invoke<void>("trust_folder", { path }),
  revokeTrust: (path: string) => invoke<void>("revoke_trust", { path }),

  // File tree. `path` stays relative to whichever root is selected, so the same
  // relative path resolves inside a worktree without any caller rewriting it.
  listDir: (path: string, root?: string) => invoke<TreeEntry[]>("list_dir", { path, root }),
  readFile: (path: string, root?: string) => invoke<FileContent>("read_file", { path, root }),
  readFileDataUrl: (path: string, root?: string) =>
    invoke<string>("read_file_data_url", { path, root }),
  writeFile: (path: string, content: string, root?: string) =>
    invoke<void>("write_file", { path, content, root }),
  revealInFileManager: (path: string, root?: string) =>
    invoke<void>("reveal_in_file_manager", { path, root }),
  openInDefaultApp: (path: string, root?: string) =>
    invoke<void>("open_in_default_app", { path, root }),
};
