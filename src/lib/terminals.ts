import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { get, writable } from "svelte/store";
import { ipc } from "./ipc";
import { settings, type AppSettings } from "./settings";
import { fontStack, xtermTheme } from "./theme";
import * as bell from "./bell";

export const loadingPanes = writable<Set<string>>(new Set());

/** Execution state of the last command line submitted in a pane.
 *  - `starting`: queued, waiting for the pane's program to accept input
 *  - `running`:  submitted, not seen finishing yet
 *  - `done`:     finished; exit code 0, or unknown (no shell integration)
 *  - `failed`:   finished with a non-zero exit code (needs OSC 133 shell
 *                integration — see {@link scanShellStatus}) */
export type PaneRunState = "starting" | "running" | "done" | "failed";

export interface PaneRun {
  state: PaneRunState;
  /** Exit code when the shell reported one; null when unknown. */
  exitCode: number | null;
}

/** Per-pane run state. Panes with nothing ever run are absent. */
export const paneRuns = writable<Map<string, PaneRun>>(new Map());

/** Pane id → the title the program set via OSC 0/1/2. Coding CLIs put the task
 *  they are working on here, which is the only structured "what is it doing"
 *  signal a terminal gets; see cliStatus.ts. */
export const paneTitles = writable<Map<string, string>>(new Map());

/** Pane id → the directory its process was actually spawned in.
 *
 *  This cannot be derived from the pane's current tab, which is the subtle part.
 *  `attach` returns early once `entry.opened` is set and `spawnPty` is guarded by
 *  `entry.spawned`, so a pane's working directory is fixed at first spawn and
 *  never revisited. Dragging a pane into a tab bound to a different worktree does
 *  not move its running shell — so any label saying "this agent is working on
 *  PR #123" has to follow the *process*, not the tab, or it lies. */
export const paneRoots = writable<Map<string, string>>(new Map());

function setPaneRoot(paneId: string, root: string) {
  paneRoots.update((m) => {
    if (m.get(paneId) === root) return m;
    return new Map(m).set(paneId, root);
  });
}

function setTitle(paneId: string, title: string) {
  paneTitles.update((m) => {
    if (m.get(paneId) === title) return m;
    return new Map(m).set(paneId, title);
  });
}

function setRun(paneId: string, state: PaneRunState, exitCode: number | null = null) {
  paneRuns.update((m) => new Map(m).set(paneId, { state, exitCode }));
}

function clearRun(paneId: string) {
  paneRuns.update((m) => {
    if (!m.has(paneId)) return m;
    const next = new Map(m);
    next.delete(paneId);
    return next;
  });
}

// Pane currently under an OS file drag (for drop-target highlight).
export const fileDropPaneId = writable<string | null>(null);

interface Entry {
  paneId: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
  opening: boolean;
  spawned: boolean;
  exited: boolean;
  /** Mirrors membership of {@link loadingPanes}. Output arrives thousands of
   *  times a minute across a screenful of agents and each store write allocates
   *  a Set and wakes every subscriber, so the veil is only cleared once. */
  loading: boolean;
  /** Bumped for every batch of output written to this pane. Pollers use it to
   *  skip panes whose screen cannot have changed since they last looked. */
  outputSeq: number;
  /** A line was submitted and its command has not been seen finishing yet. */
  busy: boolean;
  /** performance.now() of the last submitted line / the last PTY output. */
  submittedAt: number;
  lastOutputAt: number;
  /** Bytes the PTY has produced since that line was submitted. */
  outputSinceSubmit: number;
  /** The pane's program has emitted OSC 133 at least once, so its "finished"
   *  markers are authoritative and the quiet heuristic is only a safety net. */
  shellIntegration: boolean;
  /** The tty's foreground process group has been seen matching the shell, so
   *  the check tracks this pane's commands and can veto a "finished" verdict. */
  foregroundKnown: boolean;
  foregroundProbing: boolean;
  quietTimer?: ReturnType<typeof setTimeout>;
}

// Terminals live outside the component tree so panes survive layout re-renders.
const registry = new Map<string, Entry>();

// Commands to run once a pane's PTY finishes spawning. The launched program
// (shell/claude/opencode) may not be reading input yet at runtime, so we
// buffer here and flush once the program's output settles.
const pendingRun = new Map<string, PendingInput>();

/** Text queued for a pane, plus whether to press Enter for it.
 *
 *  `execute: false` is the "send to pane" affordance: destructive git and gh
 *  commands are composed for the user and left on the prompt unexecuted, so they
 *  read and confirm the exact invocation rather than trusting a dialog. */
interface PendingInput {
  text: string;
  execute: boolean;
}

// Per-pane buffer for OSC sequences split across PTY read chunks.
const oscBuffers = new Map<string, string>();

// Same, for the OSC 133 status scan (kept separate: it reads the raw chunk
// before the OSC 52 pass rewrites it). Only held while a chunk ended on a
// possibly-unfinished escape sequence, so the common case leaves nothing behind.
const statusTails = new Map<string, string>();

// A pane waiting to be typed into watches its own output for the moment its
// program becomes ready (see flushPending). Those watchers live here and are
// called from the one global output listener: registering a `listen()` per
// pending pane instead would make every chunk of every pane pay for another IPC
// callback dispatch.
const outputHooks = new Map<string, (text: string) => void>();

/** Opening bytes of any OSC sequence. Both scans below can only match inside
 *  one, so a chunk without this skips them entirely. */
const OSC_START = "\x1b]";

function addLoading(paneId: string, entry: Entry) {
  entry.loading = true;
  loadingPanes.update(s => new Set(s).add(paneId));
}

function removeLoading(paneId: string) {
  const entry = registry.get(paneId);
  if (entry) entry.loading = false;
  loadingPanes.update(s => {
    if (!s.has(paneId)) return s;
    const next = new Set(s);
    next.delete(paneId);
    return next;
  });
}

const OSC52 = /\x1b\]52;([pc]);([A-Za-z0-9+/=]*?)(?:\x07|\x1b\\)/g;

function processOsc52(paneId: string, text: string): string {
  const re = OSC52;
  re.lastIndex = 0;
  let m;
  let lastIndex = 0;
  const parts: string[] = [];
  while ((m = re.exec(text)) !== null) {
    const b64 = m[2];
    if (b64) {
      try {
        navigator.clipboard.writeText(atob(b64)).catch(() => {});
      } catch {
        // invalid base64 payload
      }
    }
    parts.push(text.slice(lastIndex, m.index));
    lastIndex = m.index + m[0].length;
  }

  const tail = text.slice(lastIndex);
  if (tail.startsWith("\x1b]52") && !tail.includes("\x07") && !tail.includes("\x1b\\")) {
    oscBuffers.set(paneId, tail);
  } else {
    parts.push(tail);
  }

  return parts.join("");
}

// Shell integration (OSC 133 "semantic prompts"): a shell configured for it
// emits `ESC ] 133 ; D ; <exit-code> BEL` when a command finishes. That is the
// only exit code we can observe — a vault command is typed into an already
// running shell, so the PTY's own exit status says nothing about it. Shells
// without the integration fall back to the quiet-settle heuristic below, which
// can tell "finished" from "still running" but never "failed".
const OSC133_DONE = /\x1b\]133;D(?:;(-?\d+))?(?:\x07|\x1b\\)/g;

// Any 133 marker (A/B/C/D) proves the shell is instrumented, which is what
// lets us stop guessing from output silence on that pane.
const OSC133_ANY = /\x1b\]133;[A-D]/;

function scanShellStatus(paneId: string, chunk: string) {
  const text = (statusTails.get(paneId) ?? "") + chunk;
  const entry = registry.get(paneId);
  if (entry && !entry.shellIntegration && OSC133_ANY.test(text)) {
    entry.shellIntegration = true;
  }
  let code: number | null = null;
  let end = 0;
  let m: RegExpExecArray | null;
  OSC133_DONE.lastIndex = 0;
  while ((m = OSC133_DONE.exec(text)) !== null) {
    code = m[1] ? Number(m[1]) : 0;
    end = m.index + m[0].length;
  }
  // Keep only what follows the last match, so a sequence sitting in the tail
  // cannot be counted twice; the slice is long enough to hold a split marker.
  // Kept only when it could still hold half of one, so an idle pane holds no
  // state and the next chunk can skip this scan on the cheap check alone.
  const tail = text.slice(Math.max(end, text.length - 24));
  if (tail.includes("\x1b")) statusTails.set(paneId, tail);
  else statusTails.delete(paneId);
  if (code !== null) finishRun(paneId, code);
}

/** Focusing a pane acknowledges a run that finished cleanly there, clearing its
 *  marker (same idea as the bell). Failed and in-flight runs are left alone. */
export function acknowledgeRun(paneId: string) {
  if (get(paneRuns).get(paneId)?.state === "done") clearRun(paneId);
}

/** Mark the pane's running command finished. `exitCode` null = unknown. */
function finishRun(paneId: string, exitCode: number | null) {
  const entry = registry.get(paneId);
  if (!entry?.busy) return;
  clearTimeout(entry.quietTimer);
  entry.busy = false;
  setRun(paneId, exitCode !== null && exitCode !== 0 ? "failed" : "done", exitCode);
  bell.notifyPane(paneId);
}

let listenersReady = false;

/** One entry per pane that produced output in the batch. The backend already
 *  decoded the bytes, so `data` is text, not base64. */
interface PtyChunk {
  pane_id: string;
  data: string;
}

function applyOutput(paneId: string, text: string) {
  const entry = registry.get(paneId);
  if (!entry) return;

  if (entry.loading) removeLoading(paneId);
  entry.outputSeq++;
  noteOutput(entry, text.length);
  outputHooks.get(paneId)?.(text);

  // The pending buffers still have to be honoured even when this chunk holds no
  // escape at all: a sequence split across chunks left its opening half behind.
  const mayHaveOsc = text.includes(OSC_START);
  if (mayHaveOsc || statusTails.has(paneId)) scanShellStatus(paneId, text);

  let out = text;
  const carried = oscBuffers.get(paneId);
  if (carried !== undefined) {
    oscBuffers.delete(paneId);
    out = carried + text;
  }
  if (carried !== undefined || mayHaveOsc) out = processOsc52(paneId, out);
  if (out) entry.term.write(out);
}

export async function initPtyListeners(onExit: (paneId: string) => void) {
  if (listenersReady) return;
  listenersReady = true;
  // One event carries every pane's output for the last few milliseconds — see
  // the coalescing note in src-tauri/src/pty.rs.
  await listen<PtyChunk[]>("pty-output", (e) => {
    for (const chunk of e.payload) applyOutput(chunk.pane_id, chunk.data);
  });
  await listen<{ pane_id: string }>("pty-exit", (e) => {
    const entry = registry.get(e.payload.pane_id);
    if (entry) {
      entry.exited = true;
      entry.busy = false;
      clearTimeout(entry.quietTimer);
    }
    removeLoading(e.payload.pane_id);
    onExit(e.payload.pane_id);
  });
}

// Backslash-escape shell-special chars so a dropped path pastes as a single
// argument (matches how native terminals handle file drops). Coding CLIs
// (claude/opencode) read this as literal text; the shell reads it as one path.
function shellEscapePath(path: string): string {
  return path.replace(/([^A-Za-z0-9_./:@%+=-])/g, "\\$1");
}

// Map a physical (device-pixel) cursor position to the pane under it.
function paneIdAtPoint(physX: number, physY: number): string | null {
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(physX / dpr, physY / dpr);
  const host = el?.closest<HTMLElement>("[data-pane-id]");
  return host?.dataset.paneId ?? null;
}

let fileDropReady = false;

// OS file drops are intercepted by the webview (dragDropEnabled), so DOM drop
// events never fire for external files. Listen to Tauri's drag-drop event,
// find the pane under the cursor, and type the escaped paths into its PTY.
export async function initFileDrop() {
  if (fileDropReady) return;
  fileDropReady = true;
  await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "over") {
      fileDropPaneId.set(paneIdAtPoint(p.position.x, p.position.y));
    } else if (p.type === "leave") {
      fileDropPaneId.set(null);
    } else if (p.type === "drop") {
      fileDropPaneId.set(null);
      const paneId = paneIdAtPoint(p.position.x, p.position.y);
      if (!paneId || !p.paths.length) return;
      const text = p.paths.map(shellEscapePath).join(" ") + " ";
      typeInPane(paneId, text);
    }
  });
}

// Reactively update all open terminals when settings (fonts, theme) change.
let lastFontKey = "";
settings.subscribe(s => {
  // A store subscriber runs synchronously inside whatever called settings.set,
  // which may be a component render or effect — so a throw here escapes as that
  // component's error and can take the app down. Contain it: bad settings or one
  // torn-down terminal must not stop the other panes from restyling.
  try {
    applyAppearance(s);
  } catch (err) {
    console.error("[terminals] failed to apply appearance settings:", err);
  }
});

function applyAppearance(s: AppSettings) {
  const { fonts } = s.appearance.theme;
  const theme = xtermTheme(s.appearance.theme);
  const family = fontStack(fonts.terminal, "mono");
  for (const entry of registry.values()) {
    if (!entry.opened || !entry.term) continue;
    try {
      entry.term.options.fontSize = fonts.terminalSize;
      entry.term.options.fontFamily = family;
      entry.term.options.theme = theme;
    } catch (err) {
      console.error("[terminals] failed to restyle a pane:", err);
    }
  }

  // A font change alters the cell size but not the element size, so no
  // ResizeObserver fires: without an explicit re-fit the grid keeps the old
  // rows/cols and full-screen TUIs (claude, opencode) stay drawn at the old
  // geometry until something else resizes them. Fit on the next frame, once
  // xterm has re-measured the character cell.
  const fontKey = `${family}|${fonts.terminalSize}`;
  if (fontKey === lastFontKey) return;
  lastFontKey = fontKey;
  requestAnimationFrame(() => {
    for (const paneId of registry.keys()) fitPane(paneId);
  });
}

function create(paneId: string): Entry {
  const s = get(settings);
  const term = new Terminal({
    fontFamily: fontStack(s.appearance.theme.fonts.terminal, "mono"),
    fontSize: s.appearance.theme.fonts.terminalSize,
    cursorBlink: s.terminal.cursorBlink,
    cursorStyle: s.terminal.cursorStyle,
    allowProposedApi: true,
    scrollback: s.terminal.scrollback,
    theme: xtermTheme(s.appearance.theme),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new CanvasAddon());
  term.loadAddon(new WebLinksAddon());

  const el = document.createElement("div");
  el.className = "h-full w-full";

  const entry: Entry = {
    paneId,
    term,
    fit,
    el,
    opened: false,
    opening: false,
    spawned: false,
    exited: false,
    loading: false,
    outputSeq: 0,
    busy: false,
    submittedAt: 0,
    lastOutputAt: 0,
    outputSinceSubmit: 0,
    shellIntegration: false,
    foregroundKnown: false,
    foregroundProbing: false,
  };
  // A program asking for attention (BEL) rings straight away — no heuristics.
  term.onBell(() => bell.notifyPane(paneId));
  term.onTitleChange((title) => setTitle(paneId, title));
  registry.set(paneId, entry);
  return entry;
}

// Bell heuristic, for shells and TUIs without shell integration: a pane is
// "done" once it has been quiet for a while after a submitted line.
//
// The catch is the echo: pressing Enter makes the program spit back a newline
// immediately, so a command that then works silently (`sleep 5`) would look
// finished 800ms later. Real completion is followed by a redrawn prompt (or the
// command's output) — far more bytes than a bare echo — or, for a command that
// took a while, by output landing well after the Enter. Requiring either keeps
// `ls` (instant, lots of bytes) and `sleep 5` (late output) both correct.
const QUIET_MS = 800;
const ECHO_BYTES = 32;
const ECHO_MS = 300;

// Silence alone cannot answer the question, though: `cargo tauri build` prints
// nothing for minutes while one crate compiles, which looks exactly like a
// finished command. So before the quiet window is allowed to end a run, ask the
// tty who is in the foreground — the shell itself (idle) or a command it
// launched. That is exact, and needs no shell integration.
const BUSY_POLL_MS = 1500;

// Panes where the foreground check is uninformative (Windows, or a launcher
// whose program replaced the shell so the pgid never changes) still ride on
// silence alone. There, scale the window with how long the command has run: a
// command already minutes in has earned a longer silence before we call it
// done, capped so a genuinely finished one still reports promptly.
const QUIET_RATIO = 0.5;
const QUIET_MAX_MS = 10_000;
// When the shell emits OSC 133 the D marker is what ends a run; this is only a
// backstop for the case where the marker never arrives (e.g. the pane's shell
// was replaced by a program that does not speak it).
const INTEGRATED_QUIET_MS = 60_000;

function quietWindow(entry: Entry): number {
  if (entry.shellIntegration) return INTEGRATED_QUIET_MS;
  // The foreground check has proven meaningful on this pane, so it — not the
  // clock — decides when the run ends; no need to stretch the window.
  if (entry.foregroundKnown) return QUIET_MS;
  const elapsed = performance.now() - entry.submittedAt;
  return Math.min(QUIET_MAX_MS, Math.max(QUIET_MS, elapsed * QUIET_RATIO));
}

// Settle the run once the pane has gone quiet: confirm against the tty's
// foreground process group, and keep polling for as long as it says a command
// is still running.
async function settleRun(paneId: string) {
  const entry = registry.get(paneId);
  if (!entry?.busy) return;
  const echoOnly =
    entry.outputSinceSubmit <= ECHO_BYTES && entry.lastOutputAt - entry.submittedAt < ECHO_MS;
  if (echoOnly) return;

  let busy: boolean | null = null;
  try {
    busy = await ipc.ptyForegroundBusy(paneId);
  } catch {
    // Pane died mid-check; fall through to the silence verdict.
  }
  // The pane may have been destroyed, or new output arrived, while awaiting.
  if (registry.get(paneId) !== entry || !entry.busy) return;

  if (busy === false) entry.foregroundKnown = true;
  if (busy === true && entry.foregroundKnown) {
    // A command really is still running (a silent compile, a build stage).
    // Keep waiting rather than declaring the run finished.
    clearTimeout(entry.quietTimer);
    entry.quietTimer = setTimeout(() => settleRun(paneId), BUSY_POLL_MS);
    return;
  }
  // No shell integration on this pane (or the marker never arrived): the
  // command finished, but with an exit code we cannot know.
  finishRun(paneId, null);
}

// The foreground check can only be trusted once we have seen it report the
// shell as idle at least once — a pane whose launcher program replaced the
// shell never changes pgid, and there "busy" would be a permanent false alarm.
// Output arriving while nothing is running means a prompt is being drawn, which
// is exactly the moment the shell should be in the foreground: probe there.
function probeForeground(paneId: string, entry: Entry) {
  if (entry.foregroundKnown || entry.foregroundProbing) return;
  entry.foregroundProbing = true;
  ipc
    .ptyForegroundBusy(paneId)
    .then((busy) => {
      if (busy === false) entry.foregroundKnown = true;
    })
    .catch(() => {})
    .finally(() => {
      entry.foregroundProbing = false;
    });
}

function noteOutput(entry: Entry, bytes: number) {
  entry.lastOutputAt = performance.now();
  if (!entry.busy) {
    probeForeground(entry.paneId, entry);
    return;
  }
  entry.outputSinceSubmit += bytes;
  clearTimeout(entry.quietTimer);
  entry.quietTimer = setTimeout(() => settleRun(entry.paneId), quietWindow(entry));
}

function noteInput(paneId: string, data: string) {
  const entry = registry.get(paneId);
  if (!entry) return;
  bell.clearAttention(paneId);
  if (!data.includes("\r") && !data.includes("\n")) return;
  entry.busy = true;
  entry.submittedAt = performance.now();
  entry.outputSinceSubmit = 0;
  setRun(paneId, "running");
}

/** Mount pane terminal into host element; spawn the PTY on first attach. */
export function attach(
  paneId: string,
  host: HTMLElement,
  cwd: string,
  launch: string | null,
) {
  const entry = registry.get(paneId) ?? create(paneId);
  // A host can still hold another pane's terminal: a pane component reused for
  // a different pane id (tab switch onto a same-shaped grid) keeps its host DOM
  // node. Evict strays first, or both terminals stack in the one pane.
  for (const child of [...host.children]) {
    if (child !== entry.el) child.remove();
  }
  // Idempotent: re-homing into the same host must not re-run open/onData,
  // else each keystroke replays the whole input history.
  if (entry.el.parentElement !== host) host.appendChild(entry.el);
  if (entry.opened) {
    fitPane(paneId);
  } else if (!entry.opening) {
    entry.opening = true;
    if (launch) addLoading(paneId, entry);
    openWhenSized(entry, paneId, cwd, launch);
  }
}

// xterm's hidden input <textarea> mis-measures when the terminal is opened at
// zero size (before the flex layout gives the host dimensions). A mis-measured
// textarea sits oversized/mispositioned over the viewport: it catches stray
// mouse-move input and accumulates/duplicates keystrokes. Defer open() until
// the element is actually laid out.
function openWhenSized(
  entry: Entry,
  paneId: string,
  cwd: string,
  launch: string | null,
  tries = 0,
) {
  if ((entry.el.clientWidth === 0 || entry.el.clientHeight === 0) && tries < 120) {
    requestAnimationFrame(() => openWhenSized(entry, paneId, cwd, launch, tries + 1));
    return;
  }
  entry.opening = false;
  entry.opened = true;
  entry.term.open(entry.el);
  entry.term.onData((data) => {
    // Keystrokes must reach the PTY even if the run-state bookkeeping trips
    // over an entry that was torn down between keypress and handler.
    try {
      noteInput(paneId, data);
    } catch (err) {
      console.error(`[terminals] noteInput failed for pane ${paneId}:`, err);
    }
    ipc.writePty(paneId, data);
  });
  patchWebkitgtkComposition(entry, paneId);
  fitPane(paneId);
  if (!entry.spawned) {
    entry.spawned = true;
    setPaneRoot(paneId, cwd);
    ipc
      .spawnPty(paneId, cwd, launch, entry.term.rows, entry.term.cols)
      .then(() => flushPending(paneId, launch))
      .catch((err) => {
        removeLoading(paneId);
        entry.term.writeln(`\x1b[31mfailed to spawn: ${err}\x1b[0m`);
        if (pendingRun.delete(paneId)) setRun(paneId, "failed");
      });
  }
}

// WebKitGTK (Tauri on Linux) delivers ordinary keystrokes as IME input: it
// fires `compositionend` + `input` for every key but WITHOUT a matching
// `compositionstart`, and never clears the hidden textarea. xterm relies on
// `compositionstart` to record where the composition begins; missing it, its
// read offset stays at 0, so each `compositionend` makes it re-read the whole
// accumulated textarea value and replay the entire input history. A parallel
// keyCode-229 keydown path (`_handleAnyTextareaChanges`) also fires, doubling
// characters. Symptom: typing "abc" sends a, ab, abc (each key replays history).
//
// Fix: detect a `compositionend` with no preceding `compositionstart` (the
// broken WebKitGTK path), send only that key's data ourselves, and reset the
// textarea so xterm's deferred `setTimeout` sends read an empty value and emit
// nothing. Real IME (which fires `compositionstart`) is left to xterm untouched.
function patchWebkitgtkComposition(entry: Entry, paneId: string) {
  const ta = (entry.term as unknown as { textarea?: HTMLTextAreaElement }).textarea;
  if (!ta) return;
  let sawCompositionStart = false;
  ta.addEventListener("compositionstart", () => {
    sawCompositionStart = true;
  });
  ta.addEventListener("compositionend", (e) => {
    if (!sawCompositionStart) {
      const data = (e as CompositionEvent).data;
      if (data) ipc.writePty(paneId, data);
      ta.value = "";
    }
    sawCompositionStart = false;
  });
}

/** Queue a command to run once the pane's PTY has spawned. */
export function queueRun(paneId: string, command: string) {
  pendingRun.set(paneId, { text: command, execute: true });
  setRun(paneId, "starting");
}

/** Queue text to be typed — not executed — once the pane's PTY has spawned.
 *
 *  Deliberately does not set a run state: nothing is running, the user is being
 *  handed a command to inspect. */
export function queueType(paneId: string, text: string) {
  pendingRun.set(paneId, { text, execute: false });
}

// A TUI (claude/opencode) is NOT ready for input the moment it enters the
// alternate screen: it first paints a splash, then does async startup (e.g.
// opencode connecting to a provider) with the screen quiet, and only later
// renders its interactive UI and starts reading input. Typing during that quiet
// gap gets dropped, so a plain output-settle (or alt-screen entry) fires too
// early. What reliably marks the interactive render is the synchronized-output
// frame the app emits when it draws real content: DECSET 2026 (`\x1b[?2026h`).
// Both claude and opencode emit it only once their live UI paints — measured on
// opencode this lands ~2.6s in, well after alt-screen (~0.8s). We treat the
// first such frame as "the UI is up", then wait for the render to settle before
// typing. A plain shell never emits this, so for a null launch we fall back to
// pure output-settle.
const READY_FRAME = /\x1b\[\?2026h/;

function flushPending(paneId: string, launch: string | null) {
  const queued = pendingRun.get(paneId);
  if (queued === undefined) return;
  pendingRun.delete(paneId);

  // Once the program is "ready" (alt screen entered, or shell), wait for output
  // to go quiet for SETTLE_MS so we don't type mid-render. SAFETY_MS forces a
  // send if we never detect readiness (e.g. a program that skips the alt screen).
  const SETTLE_MS = 200;
  const SAFETY_MS = 15000;

  // A launched TUI must paint its interactive UI first; a shell is ready now.
  let ready = launch === null;
  let carry = "";
  let settleTimer: ReturnType<typeof setTimeout>;
  let done = false;

  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(settleTimer);
    clearTimeout(safetyTimer);
    outputHooks.delete(paneId);
    if (queued.execute) runInPane(paneId, queued.text);
    else typeInPane(paneId, queued.text);
  };

  const arm = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(go, SETTLE_MS);
  };

  outputHooks.set(paneId, (text) => {
    if (done) return;
    if (!ready) {
      // Keep a small tail so the frame marker is still matched if it's split
      // across PTY read chunks; ignore output until the UI actually paints.
      carry = (carry + text).slice(-256);
      if (!READY_FRAME.test(carry)) return;
      ready = true;
      carry = "";
    }
    arm();
  });

  // Shell prints its prompt immediately; start the settle window now for it.
  if (ready) arm();

  // Safety: proceed no matter what after SAFETY_MS
  const safetyTimer = setTimeout(go, SAFETY_MS);
}

/** Un-home a pane's terminal from `host`, leaving the terminal itself alive so
 *  it re-attaches when the pane is shown again. */
export function detach(paneId: string, host: HTMLElement) {
  const entry = registry.get(paneId);
  if (entry && entry.el.parentElement === host) entry.el.remove();
}

export function isAlive(paneId: string): boolean {
  const entry = registry.get(paneId);
  return !!entry && !entry.exited;
}

/** How many batches of output this pane has received. A poller that remembers
 *  the value it last saw can skip the pane entirely while this is unchanged:
 *  nothing has been written, so the screen it would read is the same one. */
export function outputSeq(paneId: string): number {
  return registry.get(paneId)?.outputSeq ?? 0;
}

/** Last `rows` lines of what the pane currently shows, as plain text.
 *  For a full-screen TUI (claude/opencode) the active buffer is the alternate
 *  screen, so this is exactly the live UI — no stale scrollback mixed in. */
export function readPaneTail(paneId: string, rows = 24): string {
  const entry = registry.get(paneId);
  if (!entry?.opened) return "";
  const buf = entry.term.buffer.active;
  const end = buf.baseY + entry.term.rows;
  const start = Math.max(0, end - rows);
  const lines: string[] = [];
  for (let i = start; i < end; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n");
}

export function fitPane(paneId: string) {
  const entry = registry.get(paneId);
  if (!entry || !entry.opened || !entry.el.isConnected) return;
  // fit() throws if xterm's renderer was disposed under us (pane closed during
  // a pending rAF or ResizeObserver callback). fitPane is called from effects,
  // so an escaping throw would unmount the pane's boundary for no good reason.
  try {
    entry.fit.fit();
  } catch (err) {
    console.error(`[terminals] fit failed for pane ${paneId}:`, err);
    return;
  }
  if (entry.spawned && !entry.exited) {
    ipc.resizePty(paneId, entry.term.rows, entry.term.cols).catch(() => {});
  }
}

export function focusTerminal(paneId: string) {
  registry.get(paneId)?.term.focus();
}

/** Type text into a pane's terminal without submitting it. */
export function typeInPane(paneId: string, text: string) {
  const entry = registry.get(paneId);
  if (!entry || entry.exited) return;
  ipc.writePty(paneId, text);
  entry.term.focus();
}

export function runInPane(paneId: string, command: string) {
  const entry = registry.get(paneId);
  if (!entry || entry.exited) return;
  noteInput(paneId, "\r");
  ipc.writePty(paneId, command + "\r");
  entry.term.focus();
}

export function destroyPane(paneId: string) {
  const entry = registry.get(paneId);
  if (!entry) return;
  registry.delete(paneId);
  pendingRun.delete(paneId);
  outputHooks.delete(paneId);
  oscBuffers.delete(paneId);
  statusTails.delete(paneId);
  clearRun(paneId);
  paneTitles.update((m) => {
    if (!m.has(paneId)) return m;
    const next = new Map(m);
    next.delete(paneId);
    return next;
  });
  paneRoots.update((m) => {
    if (!m.has(paneId)) return m;
    const next = new Map(m);
    next.delete(paneId);
    return next;
  });
  removeLoading(paneId);
  clearTimeout(entry.quietTimer);
  bell.clearAttention(paneId);
  if (entry.spawned && !entry.exited) ipc.killPty(paneId).catch(() => {});
  entry.term.dispose();
  entry.el.remove();
}

export function destroyAll() {
  for (const id of [...registry.keys()]) destroyPane(id);
}
