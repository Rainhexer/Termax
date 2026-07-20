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
  Workspace,
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

  // Change tracking
  startSession: (projectPath: string, trusted: boolean) =>
    invoke<SessionInfo>("start_session", { projectPath, trusted }),
  stopSession: () => invoke<void>("stop_session"),
  getChanges: () => invoke<ChangeEntry[]>("get_changes"),
  getGitStatus: () => invoke<GitStatus | null>("git_status"),
  gitFetch: () => invoke<GitStatus>("git_fetch"),
  gitPull: () => invoke<string>("git_pull"),
  gitBranches: () => invoke<string[]>("git_branches"),
  gitCheckout: (branch: string) => invoke<GitStatus>("git_checkout", { branch }),
  getDiff: (path: string, area?: ChangeArea) => invoke<FileDiff>("get_diff", { path, area }),

  // Settings
  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) => invoke<void>("save_settings", { settings }),
  detectAgents: () => invoke<DetectedAgent[]>("detect_agents"),
  validateCommand: (command: string) => invoke<boolean>("validate_command", { command }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),

  // Folder trust
  isTrusted: (path: string) => invoke<boolean>("is_trusted", { path }),
  trustFolder: (path: string) => invoke<void>("trust_folder", { path }),
  revokeTrust: (path: string) => invoke<void>("revoke_trust", { path }),

  // File tree
  listDir: (path: string) => invoke<TreeEntry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  readFileDataUrl: (path: string) => invoke<string>("read_file_data_url", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
  revealInFileManager: (path: string) => invoke<void>("reveal_in_file_manager", { path }),
  openInDefaultApp: (path: string) => invoke<void>("open_in_default_app", { path }),
};
