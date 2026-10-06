/**
 * Theming.
 *
 * Every colour the UI paints is a token in here. The UI itself keeps using
 * plain Tailwind classes (`bg-zinc-800`, `text-emerald-400`, …) — app.css
 * re-points Tailwind's zinc/emerald/amber/red ramps at `--tmx-*` custom
 * properties, so setting those properties on `<html>` re-themes the whole app
 * live with no per-component work.
 *
 * Groups map onto CSS variable prefixes:
 *   ui      → --tmx-ui-*     chrome, text, accent, status
 *   terminal→ --tmx-term-*   xterm palette (also fed to xterm directly)
 *   editor  → --tmx-ed-*     Monaco background + syntax
 *   preview → --tmx-pv-*     rendered Markdown / image / html preview
 */

export interface UiColors {
  /** App background (darkest surface). */
  bg: string;
  /** Panels: sidebar, modals, inputs. */
  surface: string;
  /** Buttons, hover fills, subtle borders. */
  elevated: string;
  /** Input borders, dividers, scrollbar thumb. */
  raised: string;

  textBright: string;
  text: string;
  textSoft: string;
  textDim: string;
  textMuted: string;
  textFaint: string;

  accentSoft: string;
  accent: string;
  accentStrong: string;
  accentDeep: string;
  accentDim: string;
  accentDarkest: string;
  /** Text/knob colour drawn on top of an accent fill. */
  onAccent: string;

  warnLight: string;
  warnSoft: string;
  warn: string;
  warnStrong: string;
  warnDeep: string;
  warnDarkest: string;

  dangerSoft: string;
  danger: string;
  dangerStrong: string;
  dangerDeep: string;
  dangerDim: string;
  dangerDarkest: string;

  info: string;
  special: string;
  /** Modal backdrop / shadow colour. */
  scrim: string;
}

export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface EditorColors {
  background: string;
  foreground: string;
  lineHighlight: string;
  selection: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  type: string;
  function: string;
  variable: string;
  constant: string;
  operator: string;
  tag: string;
  attribute: string;
  insertedBg: string;
  removedBg: string;
}

export interface PreviewColors {
  /** Background of the sandboxed page used for html/svg previews. */
  page: string;
  bg: string;
  text: string;
  heading: string;
  link: string;
  code: string;
  codeBg: string;
  border: string;
  quoteBar: string;
  quoteBg: string;
  muted: string;
}

/**
 * Font fields hold a plain family *name* ("JetBrains Mono"), not a CSS stack —
 * that's what the pickers list and preview. `fontStack` adds the quoting and
 * the generic fallback when the value reaches CSS/xterm/Monaco. Values loaded
 * from older settings may still be full stacks; those are passed through.
 */
export interface ThemeFonts {
  ui: string;
  /** Root font size in px; Tailwind sizes/spacing are rem, so this scales the UI. */
  uiSize: number;
  terminal: string;
  terminalSize: number;
  editor: string;
  editorSize: number;
  preview: string;
  previewCode: string;
  previewSize: number;
}

export interface Theme {
  id: string;
  name: string;
  /** Built-in presets cannot be edited in place or deleted. */
  builtin: boolean;
  ui: UiColors;
  terminal: TerminalColors;
  editor: EditorColors;
  preview: PreviewColors;
  fonts: ThemeFonts;
}

export type ColorGroup = "ui" | "terminal" | "editor" | "preview";

/* ---------------------------------------------------------------- colour math */

function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: [number, number, number]): string {
  return "#" + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("");
}

/** Linear blend of two hex colours; t=0 is `a`, t=1 is `b`. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

/** Rough perceptual lightness, 0–1. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function isLight(hex: string): boolean {
  return luminance(hex) > 0.5;
}

/** True when a hex string is well-formed enough to hand to CSS. */
export function isHex(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

/* ------------------------------------------------------------------- presets */

/**
 * Compact description of a theme. Shades the UI needs but that palettes don't
 * publish (hover tints, dimmed status backgrounds, …) are derived from these
 * by `expand`, so a new preset is ~25 colours rather than ~80.
 */
interface Spec {
  id: string;
  name: string;
  bg: string;
  surface: string;
  elevated: string;
  raised: string;
  text: string;
  textDim: string;
  textMuted: string;
  accent: string;
  onAccent: string;
  warn: string;
  danger: string;
  info: string;
  special: string;
  term: Omit<TerminalColors, "cursorAccent">;
  editorBg: string;
  syntax: Pick<
    EditorColors,
    "comment" | "keyword" | "string" | "number" | "type" | "function" | "variable" | "constant"
  >;
  previewBg?: string;
  /** Literal overrides applied last (used by Termax Dark to pin exact shades). */
  ui?: Partial<UiColors>;
  fonts?: Partial<ThemeFonts>;
}

const DEFAULT_FONTS: ThemeFonts = {
  ui: "system-ui",
  uiSize: 16,
  terminal: "JetBrainsMono Nerd Font",
  terminalSize: 13,
  editor: "JetBrainsMono Nerd Font",
  editorSize: 12,
  preview: "system-ui",
  previewCode: "monospace",
  previewSize: 14,
};

/** CSS generics that must not be quoted or given a fallback. */
export const GENERIC_FONTS = [
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
];

/** First family of a CSS stack, unquoted — for migrating old settings. */
export function familyName(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "");
}

/** Family name → a CSS font stack safe to hand to CSS, xterm or Monaco. */
export function fontStack(name: string, kind: "mono" | "sans" = "sans"): string {
  const n = (name ?? "").trim();
  const generic = kind === "mono" ? "monospace" : "sans-serif";
  if (!n) return generic;
  // Legacy settings stored whole stacks; leave those alone.
  if (n.includes(",")) return n;
  if (GENERIC_FONTS.includes(n)) return n;
  return `'${n.replace(/['"]/g, "")}', ${generic}`;
}

function expand(spec: Spec): Theme {
  const light = isLight(spec.bg);
  // Pole = the direction "brighter/more prominent" points on this background.
  const pole = light ? "#000000" : "#ffffff";
  const anti = light ? "#ffffff" : "#000000";

  const ui: UiColors = {
    bg: spec.bg,
    surface: spec.surface,
    elevated: spec.elevated,
    raised: spec.raised,

    textBright: mix(spec.text, pole, 0.35),
    text: spec.text,
    textSoft: mix(spec.text, spec.textDim, 0.5),
    textDim: spec.textDim,
    textMuted: spec.textMuted,
    textFaint: mix(spec.textMuted, spec.bg, 0.4),

    accentSoft: mix(spec.accent, pole, 0.6),
    accent: spec.accent,
    accentStrong: mix(spec.accent, anti, 0.16),
    accentDeep: mix(spec.accent, anti, 0.34),
    accentDim: mix(spec.accent, spec.bg, 0.78),
    accentDarkest: mix(spec.accent, spec.bg, 0.9),
    onAccent: spec.onAccent,

    warnLight: mix(spec.warn, pole, 0.55),
    warnSoft: mix(spec.warn, pole, 0.3),
    warn: spec.warn,
    warnStrong: mix(spec.warn, anti, 0.16),
    warnDeep: mix(spec.warn, spec.bg, 0.6),
    warnDarkest: mix(spec.warn, spec.bg, 0.86),

    dangerSoft: mix(spec.danger, pole, 0.4),
    danger: spec.danger,
    dangerStrong: mix(spec.danger, anti, 0.16),
    dangerDeep: mix(spec.danger, spec.bg, 0.5),
    dangerDim: mix(spec.danger, spec.bg, 0.66),
    dangerDarkest: mix(spec.danger, spec.bg, 0.86),

    info: spec.info,
    special: spec.special,
    scrim: light ? "#64748b" : "#000000",
    ...spec.ui,
  };

  const terminal: TerminalColors = { ...spec.term, cursorAccent: spec.term.background };

  const editor: EditorColors = {
    background: spec.editorBg,
    foreground: spec.text,
    lineHighlight: mix(spec.editorBg, pole, 0.06),
    selection: mix(spec.editorBg, spec.accent, 0.3),
    ...spec.syntax,
    operator: ui.textDim,
    tag: spec.syntax.keyword,
    attribute: spec.syntax.function,
    insertedBg: mix(spec.editorBg, spec.term.green, 0.22),
    removedBg: mix(spec.editorBg, spec.term.red, 0.22),
  };

  const pvBg = spec.previewBg ?? mix(spec.editorBg, pole, 0.02);
  const preview: PreviewColors = {
    // Rendered html/svg is author-styled and usually assumes a white page.
    page: "#ffffff",
    bg: pvBg,
    text: spec.text,
    heading: mix(spec.text, pole, 0.35),
    link: spec.info,
    code: spec.text,
    codeBg: mix(pvBg, pole, 0.09),
    border: mix(pvBg, pole, 0.16),
    quoteBar: spec.accent,
    quoteBg: mix(pvBg, pole, 0.05),
    muted: spec.textMuted,
  };

  return {
    id: spec.id,
    name: spec.name,
    builtin: true,
    ui,
    terminal,
    editor,
    preview,
    fonts: { ...DEFAULT_FONTS, ...spec.fonts },
  };
}

const SPECS: Spec[] = [
  {
    // Termax's original look: Tailwind zinc + emerald. The `ui` block pins the
    // exact Tailwind shades the app shipped with rather than derived ones.
    id: "termax-dark",
    name: "Termax Dark",
    bg: "#09090b",
    surface: "#18181b",
    elevated: "#27272a",
    raised: "#3f3f46",
    text: "#e4e4e7",
    textDim: "#a1a1aa",
    textMuted: "#71717a",
    accent: "#34d399",
    onAccent: "#ffffff",
    warn: "#fbbf24",
    danger: "#f87171",
    info: "#60a5fa",
    special: "#c084fc",
    editorBg: "#1e1e1e",
    previewBg: "#1a1a1a",
    term: {
      background: "#131316",
      foreground: "#e4e4e7",
      cursor: "#34d399",
      selection: "#3f3f46",
      black: "#18181b",
      red: "#f87171",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#e4e4e7",
      brightBlack: "#52525b",
      brightRed: "#fca5a5",
      brightGreen: "#6ee7b7",
      brightYellow: "#fcd34d",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#67e8f9",
      brightWhite: "#fafafa",
    },
    syntax: {
      comment: "#6a9955",
      keyword: "#569cd6",
      string: "#ce9178",
      number: "#b5cea8",
      type: "#4ec9b0",
      function: "#dcdcaa",
      variable: "#9cdcfe",
      constant: "#4fc1ff",
    },
    ui: {
      textBright: "#f4f4f5",
      textSoft: "#d4d4d8",
      textFaint: "#52525b",
      accentSoft: "#d1fae5",
      accentStrong: "#10b981",
      accentDeep: "#059669",
      accentDim: "#064e3b",
      accentDarkest: "#022c22",
      warnLight: "#fde68a",
      warnSoft: "#fcd34d",
      warnStrong: "#f59e0b",
      warnDeep: "#92400e",
      warnDarkest: "#451a03",
      dangerSoft: "#fca5a5",
      dangerStrong: "#ef4444",
      dangerDeep: "#991b1b",
      dangerDim: "#7f1d1d",
      dangerDarkest: "#450a0a",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    bg: "#16161e",
    surface: "#1a1b26",
    elevated: "#292e42",
    raised: "#3b4261",
    text: "#c0caf5",
    textDim: "#a9b1d6",
    textMuted: "#565f89",
    accent: "#7aa2f7",
    onAccent: "#16161e",
    warn: "#e0af68",
    danger: "#f7768e",
    info: "#7dcfff",
    special: "#bb9af7",
    editorBg: "#1a1b26",
    term: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#7aa2f7",
      selection: "#33467c",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#ff7a93",
      brightGreen: "#b9f27c",
      brightYellow: "#ff9e64",
      brightBlue: "#7da6ff",
      brightMagenta: "#d3a4ff",
      brightCyan: "#0db9d7",
      brightWhite: "#c0caf5",
    },
    syntax: {
      comment: "#565f89",
      keyword: "#bb9af7",
      string: "#9ece6a",
      number: "#ff9e64",
      type: "#2ac3de",
      function: "#7aa2f7",
      variable: "#c0caf5",
      constant: "#ff9e64",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    bg: "#1e1f29",
    surface: "#282a36",
    elevated: "#343746",
    raised: "#44475a",
    text: "#f8f8f2",
    textDim: "#c8c8d0",
    textMuted: "#6272a4",
    accent: "#bd93f9",
    onAccent: "#282a36",
    warn: "#ffb86c",
    danger: "#ff5555",
    info: "#8be9fd",
    special: "#ff79c6",
    editorBg: "#282a36",
    term: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selection: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
    syntax: {
      comment: "#6272a4",
      keyword: "#ff79c6",
      string: "#f1fa8c",
      number: "#bd93f9",
      type: "#8be9fd",
      function: "#50fa7b",
      variable: "#f8f8f2",
      constant: "#bd93f9",
    },
  },
  {
    id: "nord",
    name: "Nord",
    bg: "#2e3440",
    surface: "#3b4252",
    elevated: "#434c5e",
    raised: "#4c566a",
    text: "#eceff4",
    textDim: "#d8dee9",
    textMuted: "#7b88a1",
    accent: "#88c0d0",
    onAccent: "#2e3440",
    warn: "#ebcb8b",
    danger: "#bf616a",
    info: "#81a1c1",
    special: "#b48ead",
    editorBg: "#2e3440",
    term: {
      background: "#2e3440",
      foreground: "#eceff4",
      cursor: "#88c0d0",
      selection: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
    syntax: {
      comment: "#616e88",
      keyword: "#81a1c1",
      string: "#a3be8c",
      number: "#b48ead",
      type: "#8fbcbb",
      function: "#88c0d0",
      variable: "#d8dee9",
      constant: "#b48ead",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    bg: "#1d2021",
    surface: "#282828",
    elevated: "#3c3836",
    raised: "#504945",
    text: "#ebdbb2",
    textDim: "#d5c4a1",
    textMuted: "#928374",
    accent: "#b8bb26",
    onAccent: "#1d2021",
    warn: "#fabd2f",
    danger: "#fb4934",
    info: "#83a598",
    special: "#d3869b",
    editorBg: "#282828",
    term: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      selection: "#504945",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
    syntax: {
      comment: "#928374",
      keyword: "#fb4934",
      string: "#b8bb26",
      number: "#d3869b",
      type: "#fabd2f",
      function: "#8ec07c",
      variable: "#ebdbb2",
      constant: "#d3869b",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    bg: "#11111b",
    surface: "#1e1e2e",
    elevated: "#313244",
    raised: "#45475a",
    text: "#cdd6f4",
    textDim: "#bac2de",
    textMuted: "#7f849c",
    accent: "#cba6f7",
    onAccent: "#11111b",
    warn: "#f9e2af",
    danger: "#f38ba8",
    info: "#89b4fa",
    special: "#f5c2e7",
    editorBg: "#1e1e2e",
    term: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selection: "#45475a",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
    syntax: {
      comment: "#6c7086",
      keyword: "#cba6f7",
      string: "#a6e3a1",
      number: "#fab387",
      type: "#f9e2af",
      function: "#89b4fa",
      variable: "#cdd6f4",
      constant: "#fab387",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    bg: "#002b36",
    surface: "#073642",
    elevated: "#0c4553",
    raised: "#586e75",
    text: "#eee8d5",
    textDim: "#93a1a1",
    textMuted: "#657b83",
    accent: "#2aa198",
    onAccent: "#002b36",
    warn: "#b58900",
    danger: "#dc322f",
    info: "#268bd2",
    special: "#d33682",
    editorBg: "#002b36",
    term: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      selection: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#93a1a1",
      brightYellow: "#839496",
      brightBlue: "#6c71c4",
      brightMagenta: "#d33682",
      brightCyan: "#94e2d5",
      brightWhite: "#fdf6e3",
    },
    syntax: {
      comment: "#586e75",
      keyword: "#859900",
      string: "#2aa198",
      number: "#d33682",
      type: "#b58900",
      function: "#268bd2",
      variable: "#839496",
      constant: "#cb4b16",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    bg: "#ffffff",
    surface: "#f6f8fa",
    elevated: "#eaeef2",
    raised: "#d0d7de",
    text: "#1f2328",
    textDim: "#57606a",
    textMuted: "#6e7781",
    accent: "#0969da",
    onAccent: "#ffffff",
    warn: "#9a6700",
    danger: "#cf222e",
    info: "#0550ae",
    special: "#8250df",
    editorBg: "#ffffff",
    previewBg: "#ffffff",
    term: {
      background: "#ffffff",
      foreground: "#24292f",
      cursor: "#0969da",
      selection: "#b6e3ff",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#633c01",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    },
    syntax: {
      comment: "#6e7781",
      keyword: "#cf222e",
      string: "#0a3069",
      number: "#0550ae",
      type: "#953800",
      function: "#8250df",
      variable: "#24292f",
      constant: "#0550ae",
    },
  },
];

export const PRESET_THEMES: Theme[] = SPECS.map(expand);
export const DEFAULT_THEME: Theme = PRESET_THEMES[0];

export function presetById(id: string): Theme | undefined {
  return PRESET_THEMES.find((t) => t.id === id);
}

/* ------------------------------------------------------------ normalisation */

function mergeGroup<T extends object>(base: T, raw: unknown): T {
  const out = { ...base };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(base) as (keyof T)[]) {
      const value = (raw as Record<string, unknown>)[key as string];
      if (typeof value === "string" && value.trim()) out[key] = value.trim() as T[keyof T];
    }
  }
  return out;
}

function mergeFonts(base: ThemeFonts, raw: unknown): ThemeFonts {
  const out = { ...base };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(base) as (keyof ThemeFonts)[]) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof out[key] === "number") {
        if (typeof value === "number" && Number.isFinite(value)) (out[key] as number) = value;
      } else if (typeof value === "string" && value.trim()) {
        (out[key] as string) = value.trim();
      }
    }
  }
  return out;
}

/**
 * Coerce anything loaded from disk (or pasted by a user) into a complete theme,
 * filling gaps from `fallback`. Missing/garbage keys never break the app.
 */
export function normalizeTheme(raw: unknown, fallback: Theme = DEFAULT_THEME): Theme {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : fallback.id;
  return {
    id,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : fallback.name,
    builtin: PRESET_THEMES.some((p) => p.id === id),
    ui: mergeGroup(fallback.ui, r.ui),
    terminal: mergeGroup(fallback.terminal, r.terminal),
    editor: mergeGroup(fallback.editor, r.editor),
    preview: mergeGroup(fallback.preview, r.preview),
    fonts: mergeFonts(fallback.fonts, r.fonts),
  };
}

export function cloneTheme(theme: Theme, patch: Partial<Theme> = {}): Theme {
  return {
    ...theme,
    ui: { ...theme.ui },
    terminal: { ...theme.terminal },
    editor: { ...theme.editor },
    preview: { ...theme.preview },
    fonts: { ...theme.fonts },
    ...patch,
  };
}

/* ------------------------------------------------------------------ applying */

const PREFIX: Record<ColorGroup, string> = {
  ui: "--tmx-ui-",
  terminal: "--tmx-term-",
  editor: "--tmx-ed-",
  preview: "--tmx-pv-",
};

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

export function cssVar(group: ColorGroup, key: string): string {
  return PREFIX[group] + kebab(key);
}

/** Push a theme onto `<html>`; every UI colour/font follows from these vars. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  for (const group of ["ui", "terminal", "editor", "preview"] as ColorGroup[]) {
    const colors = theme[group] as unknown as Record<string, string>;
    for (const [key, value] of Object.entries(colors)) {
      root.style.setProperty(cssVar(group, key), value);
    }
  }
  const f = theme.fonts;
  root.style.setProperty("--tmx-font-ui", fontStack(f.ui));
  root.style.setProperty("--tmx-font-preview", fontStack(f.preview));
  root.style.setProperty("--tmx-font-preview-code", fontStack(f.previewCode, "mono"));
  root.style.setProperty("--tmx-font-preview-size", `${f.previewSize}px`);
  // Tailwind sizes and spacing are rem-based, so the root size scales the chrome.
  root.style.fontSize = `${f.uiSize}px`;
  // Native widgets (select popups, scrollbars, date pickers) follow this rather
  // than our CSS, so a light theme must say so or they render white-on-white.
  root.style.colorScheme = isLight(theme.ui.bg) ? "light" : "dark";
}

/** xterm.js ITheme for the current theme. */
export function xtermTheme(theme: Theme) {
  const t = theme.terminal;
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selection,
    black: t.black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.white,
    brightBlack: t.brightBlack,
    brightRed: t.brightRed,
    brightGreen: t.brightGreen,
    brightYellow: t.brightYellow,
    brightBlue: t.brightBlue,
    brightMagenta: t.brightMagenta,
    brightCyan: t.brightCyan,
    brightWhite: t.brightWhite,
  };
}

/** Monaco needs colours without the leading `#` in rules, and 6-digit hex. */
function bare(hex: string): string {
  const h = hex.trim().replace(/^#/, "");
  return h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h.slice(0, 6);
}

/** Monaco IStandaloneThemeData derived from the theme's editor colours. */
export function monacoThemeData(theme: Theme) {
  const e = theme.editor;
  const rule = (token: string, color: string, fontStyle?: string) => ({
    token,
    foreground: bare(color),
    ...(fontStyle ? { fontStyle } : {}),
  });
  return {
    base: (isLight(e.background) ? "vs" : "vs-dark") as "vs" | "vs-dark",
    inherit: true,
    rules: [
      rule("", e.foreground),
      rule("comment", e.comment, "italic"),
      rule("keyword", e.keyword),
      rule("keyword.control", e.keyword),
      rule("string", e.string),
      rule("string.escape", e.constant),
      rule("number", e.number),
      rule("regexp", e.string),
      rule("type", e.type),
      rule("type.identifier", e.type),
      rule("entity.name.type", e.type),
      rule("entity.name.function", e.function),
      rule("support.function", e.function),
      rule("function", e.function),
      rule("identifier", e.variable),
      rule("variable", e.variable),
      rule("variable.predefined", e.constant),
      rule("constant", e.constant),
      rule("operator", e.operator),
      rule("delimiter", e.operator),
      rule("tag", e.tag),
      rule("metatag", e.tag),
      rule("attribute.name", e.attribute),
      rule("attribute.value", e.string),
      rule("key", e.attribute),
    ],
    colors: {
      "editor.background": e.background,
      "editor.foreground": e.foreground,
      "editor.lineHighlightBackground": e.lineHighlight,
      "editor.selectionBackground": e.selection,
      "editorCursor.foreground": theme.ui.accent,
      "editorLineNumber.foreground": theme.ui.textFaint,
      "editorLineNumber.activeForeground": theme.ui.textDim,
      "editorWidget.background": theme.ui.surface,
      "editorWidget.border": theme.ui.raised,
      "editorGutter.background": e.background,
      "editorIndentGuide.background1": mix(e.background, e.foreground, 0.15),
      "diffEditor.insertedTextBackground": e.insertedBg + "66",
      "diffEditor.removedTextBackground": e.removedBg + "66",
      "scrollbarSlider.background": theme.ui.raised + "80",
      "scrollbarSlider.hoverBackground": theme.ui.raised + "b0",
    },
  };
}

/* --------------------------------------------------------------- import/export */

export function themeToJson(theme: Theme): string {
  const { builtin: _builtin, ...rest } = theme;
  return JSON.stringify(rest, null, 2);
}

/** Parse an exported theme; throws with a readable message on bad input. */
export function themeFromJson(text: string): Theme {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON");
  }
  if (!raw || typeof raw !== "object") throw new Error("Not a theme object");
  const r = raw as Record<string, unknown>;
  if (!r.ui && !r.terminal && !r.editor && !r.preview && !r.fonts) {
    throw new Error("No theme data found (expected ui/terminal/editor/preview keys)");
  }
  const theme = normalizeTheme(raw);
  // An import is always a user theme, even when it names a preset id.
  return cloneTheme(theme, { id: newThemeId(), builtin: false });
}

export function newThemeId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
