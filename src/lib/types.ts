export interface VaultCommand {
  id: string;
  name: string;
  command: string;
  /** Terminal-type title the command runs in (see terminalTypes.ts). */
  terminalType: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  commands: VaultCommand[];
  layout: LayoutNode | null;
}

export interface PaneNode {
  type: "pane";
  id: string;
  title: string;
  /** Command launched in this pane; null means plain shell. */
  launch: string | null;
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
  ahead: number;
  behind: number;
}

export interface SessionInfo {
  git: boolean;
  fileCount: number;
}

export interface DiffTarget {
  path: string;
  area?: ChangeArea;
}

export interface FileDiff {
  original: string;
  modified: string;
  binary: boolean;
}
