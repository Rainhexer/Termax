import { invoke } from "@tauri-apps/api/core";
import type {
  ChangeArea,
  ChangeEntry,
  FileDiff,
  GitStatus,
  LayoutNode,
  Project,
  SessionInfo,
  VaultCommand,
} from "./types";

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
  getDiff: (path: string, area?: ChangeArea) => invoke<FileDiff>("get_diff", { path, area }),
};
