import { get, writable } from "svelte/store";
import { ipc } from "./ipc";
import {
  DEFAULT_THEME,
  PRESET_THEMES,
  applyTheme,
  cloneTheme,
  familyName,
  newThemeId,
  normalizeTheme,
  type Theme,
} from "./theme";

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
  sidebarWidth: number;
  /** Id of the active theme (a preset id, or a saved custom theme's id). */
  themeId: string;
  /** The live theme. May be an edited copy of a preset. */
  theme: Theme;
  /** User-saved themes, selectable alongside the presets. */
  customThemes: Theme[];
}

export interface Behavior {
  /** Enable bell notification on command done for new panes. */
  defaultBell: boolean;
  /** Launcher id opened in a new pull-request tab; "" = first enabled non-shell
   *  launcher. Deliberately a setting rather than "whatever pane is focused":
   *  predictable beats clever when one click spawns an agent. */
  prLauncherId: string;
  /** Command offered (never run automatically) to set a fresh worktree up,
   *  typically `npm ci`. Worktrees share git objects but not build output, so a
   *  new tree of a JS project is broken until something like this runs. */
  worktreeSetupCommand: string;
  /** Launcher id opened when handing an issue to an agent; "" falls back to
   *  {@link Behavior.prLauncherId}, since wanting different agents for issues
   *  and pull requests is unusual enough to be opt-in. */
  issueLauncherId: string;
  /** Prompt typed into the agent when an issue is handed to it. `{number}`,
   *  `{title}`, `{url}` and `{body}` are substituted; "" uses
   *  {@link DEFAULT_ISSUE_PROMPT}. */
  issuePromptTemplate: string;
  /** What happens in the UI when a vault command runs: `"stay"` keeps the
   *  current view (reuses the linked terminal without revealing it), `"jump"`
   *  switches to the command's terminal. Defaults to `"stay"`. */
  vaultRunBehavior: "stay" | "jump";
}

/** The prompt an agent receives when an issue is handed to it.
 *
 *  Deliberately short. A long template is a worse version of the issue itself,
 *  and the agent can read the repository — what it cannot do is know *which*
 *  issue it was opened for, so that is the part worth stating. The body is
 *  included because an agent that has to run `gh issue view` first has already
 *  spent a turn on something the caller knew. */
export const DEFAULT_ISSUE_PROMPT = `Work on GitHub issue #{number}: {title}

{url}

{body}

You're on a fresh worktree branched for this issue. Investigate first, then implement.`;

export interface TerminalSettings {
  /** Empty string = auto-detect ($SHELL). */
  defaultShell: string;
  scrollback: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  oversizedLimitKb: number;
  /** How panes draw. "auto" gives WebGL to the panes on screen and canvas to
   *  the rest; the explicit values exist for machines where GL is broken or
   *  slower than software drawing. See renderers.ts. */
  renderer: "auto" | "webgl" | "canvas" | "dom";
}

export interface AppSettings {
  launchers: Launcher[];
  appearance: Appearance;
  terminal: TerminalSettings;
  behavior: Behavior;
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
    sidebarWidth: 256,
    themeId: DEFAULT_THEME.id,
    theme: DEFAULT_THEME,
    customThemes: [],
  },
  terminal: {
    defaultShell: "",
    scrollback: 2000,
    cursorStyle: "underline",
    cursorBlink: true,
    oversizedLimitKb: 1024,
    renderer: "auto",
  },
  behavior: {
    defaultBell: false,
    prLauncherId: "",
    worktreeSetupCommand: "",
    issueLauncherId: "",
    issuePromptTemplate: "",
    vaultRunBehavior: "stay",
  },
};

export const settings = writable<AppSettings>(DEFAULT_SETTINGS);
export const settingsOpen = writable(false);
export const detectedAgents = writable<DetectedAgent[]>([]);
/** Launcher id → detected version string; runtime-only, not persisted. */
export const launcherVersions = writable<Record<string, string>>({});

const KNOWN_ICONS: Record<string, string> = { claude: "claude", opencode: "opencode", pi: "pi" };

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

/**
 * Fill in an appearance block loaded from disk. Settings written before the
 * theming system carried `fontFamily`/`fontSize`/`editorFontSize` and a theme
 * *name*; those font choices are carried over into the new theme so upgrading
 * doesn't silently reset anyone's fonts.
 */
function normalizeAppearance(raw: unknown): Appearance {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const width = typeof a.sidebarWidth === "number" ? a.sidebarWidth : 256;

  const customThemes = Array.isArray(a.customThemes)
    ? a.customThemes.map((t) => ({ ...normalizeTheme(t), builtin: false }))
    : [];

  // Legacy shape: `theme` was the string id of a built-in look.
  if (!a.theme || typeof a.theme !== "object") {
    const legacy = cloneTheme(DEFAULT_THEME, { builtin: true });
    // Old settings held a whole CSS stack; the pickers work in family names.
    const family = typeof a.fontFamily === "string" ? familyName(a.fontFamily) : "";
    if (family) {
      legacy.fonts.terminal = family;
      legacy.fonts.editor = family;
    }
    if (typeof a.fontSize === "number") legacy.fonts.terminalSize = a.fontSize;
    if (typeof a.editorFontSize === "number") legacy.fonts.editorSize = a.editorFontSize;
    return { sidebarWidth: width, themeId: legacy.id, theme: legacy, customThemes };
  }

  const theme = normalizeTheme(a.theme);
  const themeId = typeof a.themeId === "string" && a.themeId ? a.themeId : theme.id;
  return { sidebarWidth: width, themeId, theme, customThemes };
}

/** Fill in defaults for behavior fields added after a settings file was
 *  written (e.g. `vaultRunBehavior`). Old files simply lack the key, so
 *  merge over the defaults and coerce unknown values back to `"stay"`. */
function normalizeBehavior(raw: unknown): Behavior {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    ...DEFAULT_SETTINGS.behavior,
    ...b,
    vaultRunBehavior: b.vaultRunBehavior === "jump" ? "jump" : "stay",
  };
}

export async function loadSettings() {
  try {
    const loaded = await ipc.getSettings();
    settings.set({
      ...DEFAULT_SETTINGS,
      ...loaded,
      appearance: normalizeAppearance((loaded as { appearance?: unknown }).appearance),
      behavior: normalizeBehavior((loaded as { behavior?: unknown }).behavior),
    });
  } catch (err) {
    console.error("get_settings failed", err);
  }
  await syncDetected();
}

/* ------------------------------------------------------------------- themes */

/** Presets plus the user's saved themes, in pick-list order. */
export function allThemes(s: AppSettings): Theme[] {
  return [...PRESET_THEMES, ...s.appearance.customThemes];
}

/** Switch to a saved/preset theme by id, discarding unsaved tweaks. */
export function selectTheme(id: string) {
  updateSettings((s) => {
    const found = allThemes(s).find((t) => t.id === id);
    if (!found) return s;
    return { ...s, appearance: { ...s.appearance, themeId: id, theme: cloneTheme(found) } };
  });
}

/** Edit the live theme. Presets stay untouched — edits live in `theme`. */
export function patchTheme(fn: (t: Theme) => Theme) {
  updateSettings((s) => ({ ...s, appearance: { ...s.appearance, theme: fn(cloneTheme(s.appearance.theme)) } }));
}

/** Persist the live theme as a new user theme and make it active. */
export function saveThemeAs(name: string): Theme {
  const saved = cloneTheme(get(settings).appearance.theme, {
    id: newThemeId(),
    name: name.trim() || "My theme",
    builtin: false,
  });
  updateSettings((s) => ({
    ...s,
    appearance: {
      ...s.appearance,
      themeId: saved.id,
      theme: cloneTheme(saved),
      customThemes: [...s.appearance.customThemes, saved],
    },
  }));
  return saved;
}

/** Overwrite an existing user theme with the live theme. */
export function updateSavedTheme(id: string) {
  updateSettings((s) => {
    const current = cloneTheme(s.appearance.theme, { id, builtin: false });
    return {
      ...s,
      appearance: {
        ...s.appearance,
        customThemes: s.appearance.customThemes.map((t) => (t.id === id ? current : t)),
      },
    };
  });
}

export function deleteTheme(id: string) {
  updateSettings((s) => {
    const customThemes = s.appearance.customThemes.filter((t) => t.id !== id);
    if (s.appearance.themeId !== id) return { ...s, appearance: { ...s.appearance, customThemes } };
    return {
      ...s,
      appearance: {
        ...s.appearance,
        customThemes,
        themeId: DEFAULT_THEME.id,
        theme: cloneTheme(DEFAULT_THEME),
      },
    };
  });
}

/** Drop unsaved edits, restoring the active preset/saved theme. */
export function revertTheme() {
  selectTheme(get(settings).appearance.themeId);
}

/** Add an imported theme to the user's list and activate it. */
export function addTheme(theme: Theme) {
  updateSettings((s) => ({
    ...s,
    appearance: {
      ...s.appearance,
      themeId: theme.id,
      theme: cloneTheme(theme),
      customThemes: [...s.appearance.customThemes, cloneTheme(theme)],
    },
  }));
}

/** True when the live theme differs from the saved/preset one it came from. */
export function themeIsDirty(s: AppSettings): boolean {
  const base = allThemes(s).find((t) => t.id === s.appearance.themeId);
  if (!base) return true;
  const strip = (t: Theme) => JSON.stringify({ ...t, id: "", name: "", builtin: false });
  return strip(base) !== strip(s.appearance.theme);
}

// Push every theme change to the document. Cheap (a few dozen setProperty
// calls) and covers loads, edits, preset switches and imports in one place.
let appliedTheme: Theme | undefined;
settings.subscribe((s) => {
  if (s.appearance.theme === appliedTheme) return;
  appliedTheme = s.appearance.theme;
  applyTheme(appliedTheme);
});

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
