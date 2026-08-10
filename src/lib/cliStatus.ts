import { derived, get, writable } from "svelte/store";
import { attentionPanes } from "./bell";
import { paneInstances } from "./stores";
import {
  cliTurnEnded,
  isAlive,
  outputSeq,
  paneRuns,
  paneTitles,
  readPaneTail,
} from "./terminals";

/**
 * Best-effort "what is this coding CLI doing" readout.
 *
 * A terminal only ever sees bytes, so there is no API to ask claude/opencode
 * what they are up to. Two signals are available and both are used here:
 *
 *  - the OSC title the program sets (coding CLIs put the current task there),
 *    captured by the terminal layer into {@link paneTitles};
 *  - the text of the live screen. For a full-screen TUI the alternate buffer
 *    holds exactly what is drawn right now; for an inline renderer (claude
 *    draws into the normal buffer) the bottom rows are the live UI and the rest
 *    is transcript.
 *
 * Everything below is therefore a heuristic over UI text. Two properties matter
 * more than raw hit rate, because both were the cause of the readout jumping
 * around:
 *
 *  - **Precision over recall for the model.** The transcript above the footer is
 *    arbitrary prose, and prose says "sonnet" or "model matching" all the time.
 *    Only the last few non-empty rows — the status line — are searched, and a
 *    candidate must still look like a model id to be accepted, so a duration or
 *    an English word can never latch.
 *  - **Hysteresis for everything else.** A single poll can land mid-repaint and
 *    read a half-cleared screen. Verdicts are therefore observations with a
 *    timestamp and decay after a grace period, rather than being recomputed from
 *    one frame — which is what made "working" flicker to "idle" and task
 *    descriptions blink out.
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
const SCAN_ROWS = 30;
/** Non-empty rows from the bottom that count as "the status line". The model
 *  lives there; anything higher up is transcript and must not be trusted. */
const FOOTER_LINES = 4;
/** Non-empty rows from the bottom that count as "the live UI": the spinner, the
 *  input box, a permission prompt. Wide enough for a prompt box, tight enough
 *  that a transcript quoting "esc to interrupt" cannot fake a running turn. */
const LIVE_LINES = 12;
const POLL_MS = 700;

/** How long a positive working/awaiting reading survives without being seen
 *  again. Covers the repaint frames where the screen is momentarily blank. */
const ACTIVITY_GRACE_MS = 3000;
/** How long the spinner phrase is kept after it stops being drawn, so the task
 *  line does not blink out between two turns. */
const TASK_TTL_MS = 30_000;
/** The model is sticky (a dialog can cover the footer) but not forever: a pane
 *  that gets a new program must not keep the old one's badge. */
const MODEL_TTL_MS = 10 * 60_000;

// A command is in flight: coding CLIs print an interrupt hint next to their
// spinner for as long as they are generating or running a tool.
const WORKING = [
  /\besc(?:ape)?\b[^\n]{0,12}\binterrupt\b/i,
  /\bctrl\+c\b[^\n]{0,20}\b(?:stop|interrupt|cancel|abort)\b/i,
  /\bctrl\+b\b[^\n]{0,24}\bbackground\b/i,
  /\bpress esc to (?:stop|cancel)\b/i,
];

// A spinner line: an animation glyph followed by a word. Every CLI draws one
// only while it is busy. Deliberately excludes "·", "•" and "*": those start
// ordinary bullet lines in a CLI's own output and would fake a running turn.
const SPINNER_LINE =
  /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷✢✳✶✻✽✱∗◐◓◑◒]\s+[A-Za-z]/;

// Elapsed-time token as drawn in a status line ("(12s ·", "· 1m 20s ·"). Only
// read off lines that look like a status line, never off transcript prose.
const TIMER = /\b(\d{1,4})\s?s\b/g;
const STATUS_LINE = /[·•│|]/;

// The CLI stopped and wants an answer: a permission prompt, a select menu, or
// a plain y/n question.
const AWAITING = [
  /\b(?:do|would) you (?:want|like) to\b/i,
  /❯\s*\d\.\s/,
  /\(\s*y\s*\/\s*n\s*\)/i,
  /\[\s*y\s*\/\s*n\s*\]/i,
  /\bpress enter to continue\b/i,
  /\ballow\b[^\n]{0,40}\?\s*$/im,
];

/** Families a string must name to be accepted as a model. Without this any
 *  bare word next to "model" — "matching", "reference" — became the badge. */
const MODEL_FAMILY =
  /(claude|gpt|gemini|grok|llama|qwen|deepseek|mistral|kimi|glm|opus|sonnet|haiku|fable|codex)/i;

/** Shapes to pull out of the status line, most specific first. */
const MODEL = [
  // opencode-style provider-qualified ids: anthropic/claude-sonnet-4-5
  /\b([a-z][\w.]*\/[\w.:-]*(?:claude|gpt|gemini|grok|llama|qwen|deepseek|mistral|kimi|glm)[\w.:-]*)/i,
  /\b(claude-[\w.-]+)/i,
  /\b((?:opus|sonnet|haiku|fable)(?:[- ]?\d+(?:\.\d+)?)?)\b/i,
  /\b(gpt-[\w.-]+)\b/i,
  /\b(o[34](?:-[\w.]+)?)\b/,
  /\b(gemini[- ][\w.-]+)/i,
  /\b(grok[- ][\w.-]+)/i,
  /\b(codex[- ][\w.-]+)/i,
];

/** Explicitly labelled model line, e.g. "Model: Opus 4.5". The colon is
 *  required — "the model matching this" is prose, not a status line. */
const MODEL_LABELLED = /\bmodel:\s*([\w.\-/]+(?:\s+[\d.]+)?)/i;

/** A duration, a percentage, a bare number: never a model, however it was
 *  captured. This is what put a ticking timer in the model badge. */
const NOT_A_MODEL = /^(?:\d+(?:\.\d+)?\s*(?:ms|s|m|h|k|%)?|v?\d+(?:\.\d+)*)$/i;

/** The spinner's phrase: "✽ Cogitating… (12s · esc to interrupt)". */
const SPINNER_PHRASE = /^[^\w\n]*([A-Za-z][A-Za-z '-]{2,30}[….]{1,3})/;

/** Titles that say nothing about a task (the program's own name, or a path). */
function isGenericTitle(title: string, launch: string | null): boolean {
  const t = title.trim();
  if (!t) return true;
  if (launch && t.toLowerCase() === launch.toLowerCase()) return true;
  if (/^(?:bash|zsh|fish|sh|node|npm|pnpm|yarn|python\d?)\b/i.test(t)) return true;
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

/** The bottom-most `count` non-empty rows: the CLI's live UI, never the
 *  transcript scrolled above it. Working on non-empty rows matters because an
 *  inline renderer leaves blank padding under the input box, which would
 *  otherwise push the status line out of a fixed-height window. */
function bottomLines(tail: string, count: number): string {
  const lines = tail.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-count).join("\n");
}

function footerOf(tail: string): string {
  return bottomLines(tail, FOOTER_LINES);
}

function isModelLike(candidate: string): boolean {
  const c = candidate.replace(/[.,;:)\]]+$/, "").trim();
  if (!c || c.length > 48) return false;
  if (NOT_A_MODEL.test(c)) return false;
  return MODEL_FAMILY.test(c);
}

function findModel(tail: string): string | null {
  const footer = footerOf(tail);
  for (const re of MODEL) {
    const hit = lastMatch(footer, re);
    if (hit && isModelLike(hit)) return hit.replace(/[.,;:)\]]+$/, "");
  }
  const labelled = lastMatch(footer, MODEL_LABELLED);
  return labelled && isModelLike(labelled) ? labelled : null;
}

/** Largest elapsed-time value drawn on a status line, or null. Compared across
 *  polls: a timer that advanced is proof the CLI is mid-turn, whatever wording
 *  its interrupt hint uses. */
function findTimer(tail: string): number | null {
  let max: number | null = null;
  for (const line of bottomLines(tail, LIVE_LINES).split("\n")) {
    if (!STATUS_LINE.test(line) && !SPINNER_LINE.test(line)) continue;
    TIMER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TIMER.exec(line)) !== null) {
      const n = Number(m[1]);
      if (max === null || n > max) max = n;
    }
  }
  return max;
}

/** The phrase next to the spinner, as a fallback task description. */
function findSpinnerTask(tail: string): string | null {
  for (const line of bottomLines(tail, LIVE_LINES).split("\n").reverse()) {
    if (!WORKING.some((re) => re.test(line)) && !SPINNER_LINE.test(line)) continue;
    const head = line.split("(")[0];
    const m = SPINNER_PHRASE.exec(head.trim());
    if (m) return m[1].trim();
  }
  return null;
}

/** Rolling per-pane observations. Every field is "when was this last true",
 *  never "is it true in this frame" — see the hysteresis note at the top. */
interface Scan {
  workingAt: number;
  awaitingAt: number;
  model: string | null;
  modelAt: number;
  task: string | null;
  taskAt: number;
  timer: number | null;
  /** Text of the last scan, to notice the screen is being redrawn at all. */
  blank: boolean;
  /** The pane's output counter when this was taken; see {@link scanAll}. */
  seq: number;
}

const EMPTY_SCAN: Scan = {
  workingAt: 0,
  awaitingAt: 0,
  model: null,
  modelAt: 0,
  task: null,
  taskAt: 0,
  timer: null,
  blank: true,
  seq: -1,
};

const scans = writable<Map<string, Scan>>(new Map());

function scanPane(paneId: string, prev: Scan | undefined, seq: number): Scan {
  const now = Date.now();
  const before = prev ?? EMPTY_SCAN;
  const tail = readPaneTail(paneId, SCAN_ROWS);

  // Nothing drawn (pane never opened, or caught mid-clear): keep what we had
  // rather than reporting a confident "idle" from an empty screen.
  if (!tail.trim()) return { ...before, blank: true, seq };

  const timer = findTimer(tail);
  // A status-line timer that advanced since the last poll means a turn is in
  // flight. Guard against the transcript: only an increase counts, and only up
  // to a plausible per-poll step.
  const timerAdvanced =
    timer !== null &&
    before.timer !== null &&
    timer > before.timer &&
    timer - before.timer <= 30;

  const live = bottomLines(tail, LIVE_LINES);
  const working =
    WORKING.some((re) => re.test(live)) ||
    live.split("\n").some((l) => SPINNER_LINE.test(l)) ||
    timerAdvanced;
  const awaiting = AWAITING.some((re) => re.test(live));
  const model = findModel(tail);
  const task = findSpinnerTask(tail);

  return {
    workingAt: working ? now : before.workingAt,
    awaitingAt: awaiting ? now : before.awaitingAt,
    model: model ?? before.model,
    modelAt: model ? now : before.modelAt,
    task: task ?? before.task,
    taskAt: task ? now : before.taskAt,
    timer,
    blank: false,
    seq,
  };
}

/** Whether any of this pane's observations is still inside its grace period, so
 *  the readout can change on the clock alone even with nothing new drawn. */
function decaying(scan: Scan, now: number): boolean {
  return (
    fresh(scan.workingAt, ACTIVITY_GRACE_MS, now) ||
    fresh(scan.awaitingAt, ACTIVITY_GRACE_MS, now) ||
    fresh(scan.taskAt, TASK_TTL_MS, now) ||
    fresh(scan.modelAt, MODEL_TTL_MS, now)
  );
}

/** Re-scan every launched pane whose screen can have changed.
 *
 *  A scan is a few dozen `translateToString` calls plus twenty-odd regexes, and
 *  it ran for every launched pane on every tick whether or not that pane had
 *  drawn anything — the wrong shape when the whole point is a screenful of
 *  agents, most of them waiting. The pane's output counter says exactly when a
 *  re-read could produce a different answer, so a quiet pane costs a lookup. */
function scanAll(paneIds: string[]) {
  const prev = get(scans);
  const now = Date.now();
  const next = new Map<string, Scan>();
  let changed = prev.size !== paneIds.length;
  let pending = false;
  for (const id of paneIds) {
    const before = prev.get(id);
    const seq = outputSeq(id);
    const scan = before && before.seq === seq ? before : scanPane(id, before, seq);
    next.set(id, scan);
    if (scan !== before) changed = true;
    if (decaying(scan, now)) pending = true;
  }
  // Publishing on an unchanged scan is not pointless while an observation is
  // still inside its grace period: those expire on wall-clock time, and the
  // derived readout only recomputes when one of its inputs fires.
  if (changed || pending) scans.set(next);
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

function fresh(at: number, ttl: number, now: number): boolean {
  return at > 0 && now - at < ttl;
}

/**
 * Merged status per pane. The screen scan decides, because it reflects the
 * CLI's own UI; the terminal layer's run state is only consulted for panes the
 * scan knows nothing about (a plain shell, or a pane never drawn yet).
 */
export const cliStatus = derived(
  [scans, paneRuns, paneTitles, attentionPanes, paneInstances],
  ([$scans, $runs, $titles, $attention, $panes]) => {
    const now = Date.now();
    const out = new Map<string, CliStatus>();
    for (const pane of $panes) {
      const scan = $scans.get(pane.paneId);
      const run = $runs.get(pane.paneId);
      const title = $titles.get(pane.paneId);
      const scanned = !!scan && !scan.blank;
      const dead = pane.launch !== null && !isAlive(pane.paneId);

      let activity: CliActivity = "idle";
      if (dead) {
        activity = "idle";
      } else if (scanned && fresh(scan.awaitingAt, ACTIVITY_GRACE_MS, now)) {
        activity = "awaiting";
      } else if (scanned && fresh(scan.workingAt, ACTIVITY_GRACE_MS, now)) {
        activity = "working";
      } else if (run?.state === "failed") {
        activity = "failed";
      } else if (!scanned && (run?.state === "starting" || run?.state === "running")) {
        // No CLI UI to read: fall back on the shell run heuristic. For a pane
        // that *is* being scanned this signal is worse than useless — a coding
        // CLI never returns to a prompt, so its run state stays "running" long
        // after the turn ended.
        activity = "working";
      } else if (!scanned && $attention.has(pane.paneId)) {
        activity = "awaiting";
      }

      const named = title && !isGenericTitle(title, pane.launch) ? cleanTitle(title) : null;
      const spinner = scan && fresh(scan.taskAt, TASK_TTL_MS, now) ? scan.task : null;
      const model = scan && fresh(scan.modelAt, MODEL_TTL_MS, now) ? scan.model : null;

      out.set(pane.paneId, {
        activity,
        model: dead ? null : model,
        task: named ?? spinner ?? null,
      });
    }
    return out;
  },
);

/**
 * Ring a launched pane only when its turn actually ended.
 *
 * The terminal layer cannot tell "the agent finished" from "the agent finished
 * writing a file", "`/usage` printed a table" or "the startup banner is done" —
 * all three are a burst of output followed by silence, which is why the bell
 * used to fire on all of them. The screen scan can: a coding CLI draws its
 * spinner/interrupt hint for exactly as long as a turn is in flight. So the
 * ring hangs off the working → (awaiting | idle) edge and nothing else.
 *
 * Two guards keep the edge honest:
 *  - the turn must have been observed working for {@link MIN_TURN_MS}, so a
 *    single poll landing on a spinner frame during startup or a slash command
 *    cannot manufacture a completed turn;
 *  - `idle` only counts once the working observation has fully decayed
 *    (ACTIVITY_GRACE_MS of no spinner), which the derived store already does.
 */
const MIN_TURN_MS = 2500;

interface Turn {
  activity: CliActivity;
  /** When this pane was first seen working in the current turn. */
  workingSince: number;
}

const turns = new Map<string, Turn>();

function watchTurns(map: Map<string, CliStatus>) {
  const now = Date.now();
  for (const [paneId, status] of map) {
    const prev = turns.get(paneId);
    const activity = status.activity;
    if (!prev) {
      turns.set(paneId, { activity, workingSince: activity === "working" ? now : 0 });
      continue;
    }
    if (activity === prev.activity) continue;
    const workingSince = activity === "working" ? now : 0;
    const ended =
      prev.activity === "working" &&
      (activity === "awaiting" || activity === "idle") &&
      prev.workingSince > 0 &&
      now - prev.workingSince >= MIN_TURN_MS;
    turns.set(paneId, { activity, workingSince });
    if (ended) cliTurnEnded(paneId);
  }
  for (const paneId of [...turns.keys()]) {
    if (!map.has(paneId)) turns.delete(paneId);
  }
}

// Subscribed here rather than from a component: the ring must not depend on the
// sidebar being mounted, and a derived store with no subscriber never runs.
cliStatus.subscribe(watchTurns);

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

/** What the detector currently sees for one pane, for diagnosing a wrong
 *  readout against the real screen. Reachable from the devtools console as
 *  `__cliScan("<paneId>")`. */
export function debugScan(paneId: string) {
  const tail = readPaneTail(paneId, SCAN_ROWS);
  const live = bottomLines(tail, LIVE_LINES);
  return {
    tail,
    live,
    footer: footerOf(tail),
    model: findModel(tail),
    timer: findTimer(tail),
    spinnerTask: findSpinnerTask(tail),
    working:
      WORKING.some((re) => re.test(live)) || live.split("\n").some((l) => SPINNER_LINE.test(l)),
    awaiting: AWAITING.some((re) => re.test(live)),
  };
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__cliScan = debugScan;
}
