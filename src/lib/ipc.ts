import { invoke } from "@tauri-apps/api/core";
import type {
  ChangeArea,
  ChangeEntry,
  FileContent,
  FileDiff,
  GitStatus,
  LayoutNode,
  Project,
  SessionInfo,
  TreeEntry,
  VaultCommand,
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

  // Projects
  listProjects: () => invoke<Project[]>("list_projects"),
  addProject: (name: string, path: string) => invoke<Project>("add_project", { name, path }),
  removeProject: (id: string) => invoke<void>("remove_project", { id }),
  saveLayout: (id: string, layout: LayoutNode | null) =>
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

  // Change tracking
  startSession: (projectPath: string) => invoke<SessionInfo>("start_session", { projectPath }),
  stopSession: () => invoke<void>("stop_session"),
  getChanges: () => invoke<ChangeEntry[]>("get_changes"),
  getGitStatus: () => invoke<GitStatus | null>("git_status"),
  gitFetch: () => invoke<GitStatus>("git_fetch"),
  gitPull: () => invoke<string>("git_pull"),
  getDiff: (path: string, area?: ChangeArea) => invoke<FileDiff>("get_diff", { path, area }),

  // Settings
  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) => invoke<void>("save_settings", { settings }),
  detectAgents: () => invoke<DetectedAgent[]>("detect_agents"),
  validateCommand: (command: string) => invoke<boolean>("validate_command", { command }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),

  // File tree
  listDir: (path: string) => invoke<TreeEntry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
  revealInFileManager: (path: string) => invoke<void>("reveal_in_file_manager", { path }),
};
