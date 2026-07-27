import { derived, writable } from "svelte/store";
import { attentionPanes } from "./bell";
import { paneInstances } from "./stores";
import { paneRuns, paneTitles, readPaneTail } from "./terminals";

/**
 * Best-effort "what is this coding CLI doing" readout.
 *
 * A terminal only ever sees bytes, so there is no API to ask claude/opencode
 * what they are up to. Two signals are available and both are used here:
 *
 *  - the OSC title the program sets (coding CLIs put the current task there),
 *    captured by the terminal layer into {@link paneTitles};
 *  - the text of the live screen. For a full-screen TUI the alternate buffer
 *    holds exactly what is drawn right now, so scanning its last rows finds the
 *    footer (model name) and the spinner / permission prompt (activity).
 *
 * Everything below is therefore a heuristic over UI text: it degrades to
 * "idle/unknown" rather than lying when a CLI's rendering changes.
 */

export type CliActivity = "working" | "awaiting" | "idle" | "failed";

export interface CliStatus {
  activity: CliActivity;
  /** Model the CLI reports in its status line; null when never seen. */
  model: string | null;
  /** Current task: the OSC title, else the spinner's phrase. */
  task: string | null;
}

/** Rows of the live screen to scan. Enough for a permission prompt box plus
 *  the input box and footer beneath it. */
const SCAN_ROWS = 24;
/** Footer rows: where the model name sits, scanned first to cut false hits. */
const FOOTER_ROWS = 8;
const POLL_MS = 1000;

// A command is in flight: claude/opencode both print an interrupt hint next to
// their spinner for as long as they are generating or running a tool.
const WORKING = [
  /\besc(?:ape)? to interrupt\b/i,
  /\bctrl\+c to (?:stop|interrupt|cancel|abort)\b/i,
  /\bpress esc to (?:stop|cancel)\b/i,
];

// The CLI stopped and wants an answer: a permission prompt, a select menu, or
// a plain y/n question.
const AWAITING = [
  /\b(?:do|would) you (?:want|like) to\b/i,
  /❯\s*1\.\s/,
  /\(\s*y\s*\/\s*n\s*\)/i,
  /\[\s*y\s*\/\s*n\s*\]/i,
  /\bpress enter to continue\b/i,
];

// Model names, most specific first. Matched against the footer, where every
// CLI puts the active model.
const MODEL = [
  // opencode-style provider-qualified ids: anthropic/claude-sonnet-4-5
  /\b([a-z][\w.-]*\/[\w.-]*(?:claude|gpt|gemini|grok|llama|qwen|deepseek|mistral|kimi|glm)[\w.-]*)/i,
  /\b(claude-[\w.-]+)/i,
  /\b((?:opus|sonnet|haiku|fable)(?:\s+[\d.]+)?)\b/i,
  /\b(gpt-[\w.-]+)\b/i,
  /\b(gemini[- ][\w.-]+)/i,
  /\b(grok[- ][\w.-]+)/i,
];

/** Explicitly labelled model line, e.g. "Model: Opus 4.5". */
const MODEL_LABELLED = /\bmodel:?\s+([\w.\-/]+(?:\s+[\d.]+)?)/i;

/** The spinner line: "✽ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)". */
const SPINNER = /^[^\w\n]*([A-Za-z][A-Za-z '-]{2,30}[….]{1,3})/;

/** Titles that say nothing about a task (the program's own name, or a path). */
function isGenericTitle(title: string, launch: string | null): boolean {
  const t = title.trim();
  if (!t) return true;
  if (launch && t.toLowerCase() === launch.toLowerCase()) return true;
  return /^[~/]/.test(t) || /^[\w.-]+@[\w.-]+/.test(t);
}

/** Drop the decorative glyph coding CLIs prefix their title with ("✳ "). */
function cleanTitle(title: string): string {
  return title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function lastMatch(text: string, re: RegExp): string | null {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let found: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = global.exec(text)) !== null) found = m[1] ?? m[0];
  return found?.trim() || null;
}

function findModel(tail: string): string | null {
  const footer = tail.split("\n").slice(-FOOTER_ROWS).join("\n");
  for (const re of MODEL) {
    const hit = lastMatch(footer, re);
    if (hit) return hit;
  }
  return lastMatch(tail, MODEL_LABELLED);
}

/** The phrase next to the spinner, as a fallback task description. */
function findSpinnerTask(tail: string): string | null {
  for (const line of tail.split("\n").reverse()) {
    if (!WORKING.some((re) => re.test(line))) continue;
    const head = line.split("(")[0];
    const m = SPINNER.exec(head.trim());
    if (m) return m[1].trim();
  }
  return null;
}

interface Scan {
  working: boolean;
  awaiting: boolean;
  model: string | null;
  spinnerTask: string | null;
}

/** Scans, keyed by pane. The model is sticky: the footer can be covered by a
 *  dialog or scrolled off, and the model has not changed just because this
 *  frame doesn't show it. */
const scans = writable<Map<string, Scan>>(new Map());

function scanPane(paneId: string, previous: Scan | undefined): Scan {
  const tail = readPaneTail(paneId, SCAN_ROWS);
  return {
    working: WORKING.some((re) => re.test(tail)),
    awaiting: AWAITING.some((re) => re.test(tail)),
    model: findModel(tail) ?? previous?.model ?? null,
    spinnerTask: findSpinnerTask(tail) ?? null,
  };
}

/** Re-scan every launched pane. Cheap: a few dozen lines per pane. */
function scanAll(paneIds: string[]) {
  scans.update((prev) => {
    const next = new Map<string, Scan>();
    for (const id of paneIds) next.set(id, scanPane(id, prev.get(id)));
    return next;
  });
}

// Poll only while at least one launched pane exists; a plain shell has no CLI
// UI to read, so it never gets scanned.
let timer: ReturnType<typeof setInterval> | undefined;
let watched = "";

paneInstances.subscribe((panes) => {
  const ids = panes.filter((p) => p.launch !== null).map((p) => p.paneId);
  // Any layout edit (a split drag, a focus change) re-emits the instance list;
  // only a change to *which* panes exist should restart the polling.
  const key = ids.join(",");
  if (key === watched) return;
  watched = key;
  clearInterval(timer);
  timer = undefined;
  if (!ids.length) {
    scans.set(new Map());
    return;
  }
  scanAll(ids);
  timer = setInterval(() => scanAll(ids), POLL_MS);
});

/**
 * Merged status per pane. The screen scan wins when it says something definite,
 * because it reflects the CLI's own UI; otherwise the terminal layer's run
 * state (typed line → quiet settle, or an OSC 133 exit code) decides.
 */
export const cliStatus = derived(
  [scans, paneRuns, paneTitles, attentionPanes, paneInstances],
  ([$scans, $runs, $titles, $attention, $panes]) => {
    const out = new Map<string, CliStatus>();
    for (const pane of $panes) {
      const scan = $scans.get(pane.paneId);
      const run = $runs.get(pane.paneId);
      const title = $titles.get(pane.paneId);

      let activity: CliActivity = "idle";
      if (scan?.awaiting) activity = "awaiting";
      else if (scan?.working) activity = "working";
      else if (run?.state === "starting" || run?.state === "running") activity = "working";
      else if (run?.state === "failed") activity = "failed";
      else if ($attention.has(pane.paneId)) activity = "awaiting";

      const task =
        title && !isGenericTitle(title, pane.launch)
          ? cleanTitle(title)
          : (scan?.spinnerTask ?? null);

      out.set(pane.paneId, { activity, model: scan?.model ?? null, task: task || null });
    }
    return out;
  },
);

const IDLE_STATUS: CliStatus = { activity: "idle", model: null, task: null };

/** Status for one pane, with a safe default for panes not yet scanned. */
export function statusFor(map: Map<string, CliStatus>, paneId: string): CliStatus {
  return map.get(paneId) ?? IDLE_STATUS;
}

/** Rank used to pick the badge colour when a launcher has several panes. */
const RANK: Record<CliActivity, number> = { awaiting: 3, failed: 2, working: 1, idle: 0 };

export function loudest(activities: CliActivity[]): CliActivity {
  return activities.reduce<CliActivity>((a, b) => (RANK[b] > RANK[a] ? b : a), "idle");
}

export function activityLabel(activity: CliActivity): string {
  switch (activity) {
    case "working":
      return "working";
    case "awaiting":
      return "needs input";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

export function activityTitle(activity: CliActivity): string {
  switch (activity) {
    case "working":
      return "Running — the CLI is generating or executing a tool";
    case "awaiting":
      return "Waiting for you: a prompt is open in this pane";
    case "failed":
      return "The last command finished with a non-zero exit code";
    default:
      return "Idle — no command in flight";
  }
}
