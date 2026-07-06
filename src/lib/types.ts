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

export interface ChangeEntry {
  path: string;
  status: "created" | "modified" | "deleted";
  added: number;
  removed: number;
}

export interface FileDiff {
  original: string;
  modified: string;
  binary: boolean;
}
