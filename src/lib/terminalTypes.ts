export interface TerminalType {
  /** Stable id stored on vault commands and layout panes. */
  title: string;
  /** Program to launch; null spawns a plain shell. */
  command: string | null;
  label: string;
  icon: "shell" | "claude" | "opencode";
}

export const TERMINAL_TYPES: TerminalType[] = [
  { title: "shell", command: null, label: "Shell", icon: "shell" },
  { title: "claude", command: "claude", label: "Claude Code", icon: "claude" },
  { title: "opencode", command: "opencode", label: "OpenCode", icon: "opencode" },
];

export function terminalType(title: string): TerminalType {
  return TERMINAL_TYPES.find((t) => t.title === title) ?? TERMINAL_TYPES[0];
}

/** Launch program for a terminal-type title; null for a plain shell. */
export function launchFor(title: string): string | null {
  return terminalType(title).command;
}
