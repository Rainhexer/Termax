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

/** One tab: a full terminal/editor grid plus its focused pane. */
export interface Tab {
  id: string;
  title: string;
  layout: LayoutNode | null;
  focusedPaneId: string | null;
}

/** Persisted per-project tab set. Distinguished from a bare LayoutNode by `tabs`. */
export interface Workspace {
  tabs: Tab[];
  activeTabId: string;
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
