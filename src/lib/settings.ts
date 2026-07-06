import { get, writable } from "svelte/store";
import { ipc } from "./ipc";

export interface Launcher {
  id: string;
  name: string;
  /** Program to launch; null is the built-in Shell. */
  command: string | null;
  /** Built-in icon name, or raw `<svg …>` markup for custom icons. */
  icon: string;
  enabled: boolean;
}

export interface Appearance {
  fontFamily: string;
  fontSize: number;
  editorFontSize: number;
  theme: string;
  sidebarWidth: number;
}

export interface TerminalSettings {
  /** Empty string = auto-detect ($SHELL). */
  defaultShell: string;
  scrollback: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  cursorColor: string;
  oversizedLimitKb: number;
}

export interface AppSettings {
  launchers: Launcher[];
  appearance: Appearance;
  terminal: TerminalSettings;
}

export interface DetectedAgent {
  binary: string;
  label: string;
  path: string;
  version: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  launchers: [
    { id: "shell", name: "Shell", command: null, icon: "shell", enabled: true },
    { id: "claude", name: "Claude Code", command: "claude", icon: "claude", enabled: true },
    { id: "opencode", name: "OpenCode", command: "opencode", icon: "opencode", enabled: true },
  ],
  appearance: {
    fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace",
    fontSize: 13,
    editorFontSize: 12,
    theme: "dark",
    sidebarWidth: 256,
  },
  terminal: {
    defaultShell: "",
    scrollback: 10000,
    cursorStyle: "underline",
    cursorBlink: true,
    cursorColor: "#34d399",
    oversizedLimitKb: 1024,
  },
};

export const settings = writable<AppSettings>(DEFAULT_SETTINGS);
export const settingsOpen = writable(false);
export const detectedAgents = writable<DetectedAgent[]>([]);
/** Launcher id → detected version string; runtime-only, not persisted. */
export const launcherVersions = writable<Record<string, string>>({});

const KNOWN_ICONS: Record<string, string> = { claude: "claude", opencode: "opencode" };

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    ipc.saveSettings(get(settings)).catch((err) => console.error("save_settings failed", err));
  }, 300);
}

/** Mutate settings and persist (debounced). */
export function updateSettings(fn: (s: AppSettings) => AppSettings) {
  settings.update(fn);
  persist();
}

export async function loadSettings() {
  try {
    settings.set(await ipc.getSettings());
  } catch (err) {
    console.error("get_settings failed", err);
  }
  await syncDetected();
}

/**
 * Probe $PATH for known agents; newly found ones are appended to the
 * launcher list (enabled) so they show up in the sidebar automatically.
 */
export async function syncDetected() {
  let found: DetectedAgent[];
  try {
    found = await ipc.detectAgents();
  } catch (err) {
    console.error("detect_agents failed", err);
    return;
  }
  detectedAgents.set(found);
  launcherVersions.set(
    Object.fromEntries(found.filter((f) => f.version).map((f) => [f.binary, f.version!])),
  );

  const current = get(settings);
  const missing = found.filter((f) => !current.launchers.some((l) => l.id === f.binary));
  if (missing.length === 0) return;
  updateSettings((s) => ({
    ...s,
    launchers: [
      ...s.launchers,
      ...missing.map((f) => ({
        id: f.binary,
        name: f.label,
        command: f.binary,
        icon: KNOWN_ICONS[f.binary] ?? "robot",
        enabled: true,
      })),
    ],
  }));
}

/** Launchers shown in the sidebar Launch section, in configured order. */
export function enabledLaunchers(s: AppSettings): Launcher[] {
  return s.launchers.filter((l) => l.enabled || l.command === null);
}

const SHELL_LAUNCHER: Launcher = DEFAULT_SETTINGS.launchers[0];

/** Look up a launcher by id; falls back to Shell for stale references. */
export function launcherById(id: string): Launcher {
  return get(settings).launchers.find((l) => l.id === id) ?? SHELL_LAUNCHER;
}

/** Launch program for a launcher id; null for a plain shell. */
export function launchFor(id: string): string | null {
  return launcherById(id).command;
}
