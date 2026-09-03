import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { get, writable } from "svelte/store";
import { ipc } from "./ipc";
import { perf, setQueueDepthSource } from "./perf";
import { settings, type AppSettings } from "./settings";
import { fontStack, xtermTheme } from "./theme";
import { paneFontSize } from "./paneFont";
import * as bell from "./bell";
import * as renderers from "./renderers";
import * as scheduler from "./writeScheduler";

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

// Titles arrive at frame rate, not at human rate: a coding CLI rewrites its
// OSC title on every state change, several times a second. Each write here
// wakes the `cliStatus` derived store, which recomputes over *every* pane and
// re-renders the sidebar — so publishing them as they land makes the UI cost
// scale with (frames × panes) for information nobody can read that fast.
// Collect them and publish at most once a frame instead.
const pendingTitles = new Map<string, string>();
let titleFlush: number | undefined;

function setTitle(paneId: string, title: string) {
  pendingTitles.set(paneId, title);
  titleFlush ??= requestAnimationFrame(flushTitles);
}

function flushTitles() {
  titleFlush = undefined;
  paneTitles.update((m) => {
    let next: Map<string, string> | null = null;
    for (const [paneId, title] of pendingTitles) {
      if (m.get(paneId) === title) continue;
      next ??= new Map(m);
      next.set(paneId, title);
    }
    pendingTitles.clear();
    return next ?? m;
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
  /** The terminal is homed in a mounted host, so it is on screen. Maintained by
   *  {@link attach}/{@link detach}, which is exactly when it changes — asking
   *  the DOM instead would force layout on the output hot path. Drives write
   *  scheduling priority and which panes get a WebGL context. */
  visible: boolean;
  /** What the backend currently believes: whether it should still be shipping
   *  this pane's bytes. Usually equal to {@link visible}, but see
   *  {@link syncStream} for the startup case where it is deliberately not. */
  streaming: boolean;
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
  /** performance.now() of the last keystroke sent to the PTY, newline or not.
   *  Typing echoes back as output, so any "the program is repainting on its
   *  own" signal has to be able to rule the user out. */
  lastInputAt: number;
  /** Bytes the PTY has produced since that line was submitted. */
  outputSinceSubmit: number;
  /** The pane's program has emitted OSC 133 at least once, so its "finished"
   *  markers are authoritative and the quiet heuristic is only a safety net. */
  shellIntegration: boolean;
  /** The tty's foreground process group has been seen matching the shell, so
   *  the check tracks this pane's commands and can veto a "finished" verdict. */
  foregroundKnown: boolean;
  foregroundProbing: boolean;
  /** performance.now() of the last foreground probe, so the output path cannot
   *  issue one per chunk. See {@link probeForeground}. */
  foregroundProbedAt: number;
  quietTimer?: ReturnType<typeof setTimeout>;
  /** The backend screen version this pane was last settled against while
   *  hidden, or -1 when there is no baseline yet. A hidden pane's bytes never
   *  reach us, so this — not {@link lastOutputAt} — is how a settle attempt
   *  tells "it drew something since I last looked". See {@link settleRun}. */
  hiddenSeq: number;
  /** The program this pane was launched with (null = plain shell). A coding CLI
   *  never returns to a shell prompt, so none of the shell run heuristics below
   *  — quiet windows, foreground pgid, OSC 133, BEL — mean "the turn ended"
   *  there. Those panes are settled by the screen scan instead; see
   *  {@link cliTurnEnded}. */
  launch: string | null;
  /** Per-pane font-size offset from the theme (Ctrl +/-). See paneFont.ts. */
  fontDelta: number;
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
  /** False = run/type without stealing DOM focus (vault "stay" mode). */
  focus: boolean;
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
  if (entry) {
    entry.loading = false;
    // It was possibly held open only for this; it may now stop streaming.
    syncStream(entry);
  }
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
  // Shell verdicts say nothing about a coding CLI's turn — see cliTurnEnded.
  if (entry.launch !== null) return;
  clearTimeout(entry.quietTimer);
  entry.busy = false;
  setRun(paneId, exitCode !== null && exitCode !== 0 ? "failed" : "done", exitCode);
  bell.notifyPane(paneId);
}

/** The screen scan decided a coding CLI's turn is over: it either went quiet or
 *  put a prompt up. This — not silence, not OSC 133, not BEL — is what ends a
 *  run in a launched pane, because everything the CLI does mid-turn (editing a
 *  file, answering `/usage`, finishing its startup banner) looks identical to a
 *  finished command from the terminal layer's point of view. */
export function cliTurnEnded(paneId: string) {
  const entry = registry.get(paneId);
  if (!entry || entry.launch === null) return;
  clearTimeout(entry.quietTimer);
  entry.busy = false;
  setRun(paneId, "done", null);
  bell.notifyPane(paneId);
}

let listenersReady = false;

/** `bytes` is the chunk's length as the backend measured it, which is what the
 *  backend's flow control is owed — not `text.length`, and not the length of
 *  whatever survives the OSC passes below. Every path here has to settle it. */
function applyOutput(paneId: string, text: string, bytes: number) {
  const entry = registry.get(paneId);
  if (!entry) {
    // A pane the backend still has but this frontend does not — a window reload
    // leaves its PTYs running. Nothing can draw the bytes, but they must still
    // be acknowledged or the backend parks that pane's reader against a debt
    // nobody is left to settle.
    scheduler.discard(paneId, bytes);
    return;
  }

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
  // Queued rather than written: xterm spends its parse budget per instance, so
  // handing every pane its output as it lands is what makes typing wait behind
  // a screenful of agents. See writeScheduler.ts.
  //
  // Nothing left to draw — a chunk that was all clipboard escape, or one held
  // back whole as a split sequence — still owes its acknowledgement.
  if (out) scheduler.enqueue(paneId, out, bytes);
  else scheduler.discard(paneId, bytes);
}

/** Something a *hidden* pane's program did. Its bytes no longer reach us, so
 *  the backend's screen model reports these in their place; mirrors
 *  `vt::Signal` in src-tauri/src/vt.rs. */
type PaneSignal =
  | { kind: "title"; title: string }
  | { kind: "bell" }
  | { kind: "clipboard"; data: string }
  | { kind: "commandDone"; code: number | null }
  | { kind: "shellIntegration" };

function applySignal(paneId: string, signal: PaneSignal) {
  const entry = registry.get(paneId);
  switch (signal.kind) {
    case "title":
      setTitle(paneId, signal.title);
      return;
    case "bell":
      // Same rule the visible path uses: a coding CLI rings for its own
      // reasons, so only a plain shell's bell means "your turn".
      if (entry?.launch === null) bell.notifyPane(paneId);
      return;
    case "clipboard":
      try {
        navigator.clipboard.writeText(atob(signal.data)).catch(() => {});
      } catch {
        // invalid base64 payload
      }
      return;
    case "shellIntegration":
      if (entry) entry.shellIntegration = true;
      return;
    case "commandDone":
      finishRun(paneId, signal.code);
  }
}

/** Wire format of a batch; mirrors `encode_batch` in src-tauri/src/pty.rs. */
const FRAME_VERSION = 1;
const RECORD_OUTPUT = 0;
const RECORD_EXIT = 1;
/** One decoder for every batch: it is stateless here (the backend already
 *  reassembled characters split across PTY reads), so building one per record
 *  would only pay for the construction. */
const decoder = new TextDecoder();

/** Read one batch and replay its records in order.
 *
 *  `[u8 version] ( [u8 kind][u16 id_len][id] [u32 data_len][data]? )*`,
 *  little-endian. Exits and signals arrive in the same frame as output, behind
 *  the bytes they follow — see the note on `Record` in pty.rs. */
function readBatch(buffer: ArrayBuffer, onExit: (paneId: string) => void) {
  const started = performance.now();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length === 0) return;
  if (bytes[0] !== FRAME_VERSION) {
    console.error(`[terminals] unknown pty frame version ${bytes[0]}; dropping batch`);
    return;
  }

  let at = 1;
  let records = 0;
  while (at < bytes.length) {
    const kind = bytes[at];
    at += 1;
    const idLen = view.getUint16(at, true);
    at += 2;
    const paneId = decoder.decode(bytes.subarray(at, at + idLen));
    at += idLen;
    records++;

    if (kind === RECORD_EXIT) {
      handleExit(paneId, onExit);
      continue;
    }
    const dataLen = view.getUint32(at, true);
    at += 4;
    const text = decoder.decode(bytes.subarray(at, at + dataLen));
    at += dataLen;

    if (kind !== RECORD_OUTPUT) {
      applySignal(paneId, JSON.parse(text) as PaneSignal);
      continue;
    }
    perf.note("bytes", dataLen);
    applyOutput(paneId, text, dataLen);
  }
  perf.note("batches", 1);
  perf.note("paneChunks", records);
  perf.note("decodeMs", performance.now() - started);
}

function handleExit(paneId: string, onExit: (paneId: string) => void) {
  const entry = registry.get(paneId);
  if (entry) {
    entry.exited = true;
    entry.busy = false;
    clearTimeout(entry.quietTimer);
  }
  removeLoading(paneId);
  onExit(paneId);
}

export async function initPtyListeners(onExit: (paneId: string) => void) {
  if (listenersReady) return;
  listenersReady = true;

  scheduler.setPaneLookup((paneId) => {
    const entry = registry.get(paneId);
    return entry?.opened ? { term: entry.term, visible: entry.visible } : undefined;
  });
  setQueueDepthSource(scheduler.queueDepth);
  scheduler.startAcks();

  // One batch carries every pane's output for the last few milliseconds, as raw
  // bytes over a channel rather than as an evaluated script — see the transport
  // note at the top of src-tauri/src/pty.rs. Attached before anything spawns:
  // output produced with no stream attached is dropped, not buffered.
  const stream = new Channel<ArrayBuffer>();
  stream.onmessage = (buffer) => readBatch(buffer, onExit);
  await ipc.attachPtyStream(stream);
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
  renderers.setChoice(s.terminal.renderer, (paneId) => !!registry.get(paneId)?.visible);
  const { fonts } = s.appearance.theme;
  const theme = xtermTheme(s.appearance.theme);
  const family = fontStack(fonts.terminal, "mono");
  for (const entry of registry.values()) {
    if (!entry.opened || !entry.term) continue;
    try {
      entry.term.options.fontSize = paneFontSize(fonts.terminalSize, entry.fontDelta);
      entry.term.options.fontFamily = family;
      entry.term.options.theme = theme;
      entry.term.options.cursorBlink = s.terminal.cursorBlink;
      entry.term.options.cursorStyle = s.terminal.cursorStyle;
      // Applied to live panes, not only to ones opened afterwards. Scrollback
      // is the largest thing a pane owns — xterm holds every line as three
      // 32-bit words per cell, so a full 10,000-line history is tens of
      // megabytes of the webview's memory per pane — and lowering the setting
      // is the one lever a user has over it. Assigning it here trims the
      // existing buffers straight away, which is the point: a change that only
      // took effect on the next pane could not relieve the panes that are
      // already heavy.
      entry.term.options.scrollback = s.terminal.scrollback;
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

/** Pane id → font offset, kept outside the registry so a pane's zoom is known
 *  before its terminal exists (a restored layout sets it as the pane mounts). */
const fontDeltas = new Map<string, number>();
/** Apply a pane's font-size offset. Called by the pane component from the
 *  layout, which owns the value; a live terminal is restyled and re-fitted so
 *  full-screen TUIs redraw at the new cell size instead of keeping the old
 *  rows/cols (same reason `applyAppearance` re-fits on a font change). */
export function setPaneFontDelta(paneId: string, delta: number) {
  const previous = fontDeltas.get(paneId);
  fontDeltas.set(paneId, delta);
  if (previous === delta) return;
  const entry = registry.get(paneId);
  if (!entry) return;
  entry.fontDelta = delta;
  if (!entry.opened) return;
  try {
    entry.term.options.fontSize = paneFontSize(
      get(settings).appearance.theme.fonts.terminalSize,
      delta,
    );
  } catch (err) {
    console.error(`[terminals] failed to resize text in pane ${paneId}:`, err);
    return;
  }
  requestAnimationFrame(() => fitPane(paneId));
}

function create(paneId: string): Entry {
  const s = get(settings);
  const term = new Terminal({
    fontFamily: fontStack(s.appearance.theme.fonts.terminal, "mono"),
    fontSize: paneFontSize(s.appearance.theme.fonts.terminalSize, fontDeltas.get(paneId)),
    cursorBlink: s.terminal.cursorBlink,
    cursorStyle: s.terminal.cursorStyle,
    allowProposedApi: true,
    scrollback: s.terminal.scrollback,
    theme: xtermTheme(s.appearance.theme),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  // The renderer is not loaded here: it is chosen when the pane is shown, since
  // which one it gets depends on whether it is visible and on how many WebGL
  // contexts are already spoken for. See renderers.ts.

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
    visible: false,
    streaming: true,
    loading: false,
    outputSeq: 0,
    busy: false,
    submittedAt: 0,
    lastOutputAt: 0,
    lastInputAt: 0,
    outputSinceSubmit: 0,
    shellIntegration: false,
    foregroundKnown: false,
    foregroundProbing: false,
    foregroundProbedAt: 0,
    hiddenSeq: -1,
    launch: null,
    fontDelta: fontDeltas.get(paneId) ?? 0,
  };
  // A program asking for attention (BEL) rings straight away — no heuristics.
  // Except in a coding-CLI pane: those ring the bell for their own reasons
  // (a finished sub-step, a redraw, startup) and the ring must mean "your turn".
  term.onBell(() => {
    if (registry.get(paneId)?.launch === null) bell.notifyPane(paneId);
  });
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

/** The backend's screen version for a pane, when it changed since `seq`; null
 *  when nothing was drawn (or the pane is gone). One row is asked for because
 *  only the version is read — the text is what `refreshHiddenScreens` fetches. */
async function screenSeqSince(paneId: string, seq: number): Promise<number | null> {
  try {
    const [screen] = await ipc.paneScreens([{ paneId, seq }], 1);
    return screen?.seq ?? null;
  } catch {
    return null;
  }
}

// Settle the run once the pane has gone quiet: confirm against the tty's
// foreground process group, and keep polling for as long as it says a command
// is still running.
async function settleRun(paneId: string) {
  const entry = registry.get(paneId);
  if (!entry?.busy) return;
  if (entry.visible) {
    const echoOnly =
      entry.outputSinceSubmit <= ECHO_BYTES && entry.lastOutputAt - entry.submittedAt < ECHO_MS;
    if (echoOnly) return;
  } else {
    // Nothing arrives for a hidden pane — that is the point of syncStream — so
    // the quiet window it was armed with measured nothing, and the echo test
    // above has no bytes to weigh. The backend parses that pane's output into
    // its screen model regardless and bumps a version per chunk: ask for that
    // instead. This is what once left a vault command run into a pane in
    // another tab spinning "running" for the rest of the session, since the
    // only other way out is the OSC 133 marker most shells never send.
    // -1 is this side's "no baseline yet"; the backend's version is unsigned,
    // and 0 there means the pane has processed nothing, so it asks the same.
    const seq = await screenSeqSince(paneId, Math.max(entry.hiddenSeq, 0));
    if (registry.get(paneId) !== entry || !entry.busy) return;
    if (seq !== null) {
      const drew = entry.hiddenSeq >= 0;
      entry.hiddenSeq = seq;
      entry.lastOutputAt = performance.now();
      if (drew) {
        // Output is still landing: wait it out, exactly as noteOutput would.
        clearTimeout(entry.quietTimer);
        entry.quietTimer = setTimeout(() => settleRun(paneId), quietWindow(entry));
        return;
      }
    }
  }

  let busy: boolean | null = null;
  try {
    busy = await ipc.ptyForegroundBusy(paneId);
  } catch {
    // Pane died mid-check; fall through to the silence verdict.
  }
  // The pane may have been destroyed, or new output arrived, while awaiting.
  if (registry.get(paneId) !== entry || !entry.busy) return;

  if (busy === false) entry.foregroundKnown = true;
  // A hidden pane is trusted without the latch: the latch guards against a
  // launcher program that replaced the shell (permanently "busy"), and those
  // panes never reach here — `finishRun` and `noteOutput` both bail on a
  // launched pane. Waiting for a latch that only output can produce would just
  // put the run back to being declared finished the moment it goes quiet.
  if (busy === true && (entry.foregroundKnown || !entry.visible)) {
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
//
// Two limits on when that probe is allowed to run, and both of them are about
// cost rather than correctness. Every probe is an IPC call — a `fetch` across
// the webview's process boundary, handled on the same thread that dispatches
// key presses — and this is called from the output path, so an unguarded probe
// costs one round trip per chunk of output, forever, on every pane that never
// answers. That is not a small number: a redrawing coding CLI produces tens of
// chunks a second.
//
//  - A launched pane is never asked at all. Its program replaced the shell in
//    the foreground, so the pgid can never come back equal and `foregroundKnown`
//    can never latch — and nothing reads the answer either, because every run
//    heuristic that would consume it (`noteOutput`, `finishRun`, `settleRun`)
//    returns early for a launched pane. It was a call whose reply was thrown
//    away, made forever, on exactly the panes that produce the most output.
//  - A shell pane is asked at most once per {@link PROBE_INTERVAL_MS}. One
//    answer is all this needs (it only ever latches `foregroundKnown`), so the
//    rest were re-asking a question already in flight or already answered "not
//    yet" a millisecond ago.
const PROBE_INTERVAL_MS = 1000;

function probeForeground(paneId: string, entry: Entry) {
  if (entry.launch !== null) return;
  if (entry.foregroundKnown || entry.foregroundProbing) return;
  const now = performance.now();
  if (now - entry.foregroundProbedAt < PROBE_INTERVAL_MS) return;
  entry.foregroundProbedAt = now;
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
  if (entry.launch !== null) return;
  clearTimeout(entry.quietTimer);
  entry.quietTimer = setTimeout(() => settleRun(entry.paneId), quietWindow(entry));
}

// Alt+Enter (and Shift/Ctrl variants) insert a newline into a CLI's prompt
// rather than submitting it: the terminal sends ESC before the CR. Counting
// those as a submitted line is what made composing a multi-line prompt start —
// and 800ms later finish — a phantom run, ringing the bell mid-typing.
const NEWLINE_KEY = /(?:^|[^\x1b])[\r\n]/;

function noteInput(paneId: string, data: string) {
  const entry = registry.get(paneId);
  if (!entry) return;
  bell.clearAttention(paneId);
  entry.lastInputAt = performance.now();
  if (!NEWLINE_KEY.test(data)) return;
  entry.busy = true;
  entry.submittedAt = performance.now();
  entry.outputSinceSubmit = 0;
  entry.hiddenSeq = -1;
  setRun(paneId, "running");
  // Arriving output is what normally arms the settle timer, and a hidden pane
  // gets none: a run submitted into one (the command vault re-running in a
  // pane that lives in another tab) would never have a settle path at all.
  // Arming here gives every submitted line one of its own; a visible pane's
  // first chunk of echo re-arms it a few milliseconds later anyway.
  if (entry.launch === null) {
    clearTimeout(entry.quietTimer);
    entry.quietTimer = setTimeout(() => settleRun(paneId), quietWindow(entry));
  }
}

/** Mount pane terminal into host element; spawn the PTY on first attach. */
export function attach(
  paneId: string,
  host: HTMLElement,
  cwd: string,
  launch: string | null,
) {
  const entry = registry.get(paneId) ?? create(paneId);
  entry.launch = launch;
  // A host can still hold another pane's terminal: a pane component reused for
  // a different pane id (tab switch onto a same-shaped grid) keeps its host DOM
  // node. Evict strays first, or both terminals stack in the one pane.
  for (const child of [...host.children]) {
    if (child !== entry.el) child.remove();
  }
  // Idempotent: re-homing into the same host must not re-run open/onData,
  // else each keystroke replays the whole input history.
  if (entry.el.parentElement !== host) host.appendChild(entry.el);
  setVisible(entry, true);
  if (entry.opened) {
    renderers.apply(paneId, entry.term, true);
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
  // After `open`, which is when the screen element the renderer draws into
  // exists.
  renderers.apply(paneId, entry.term, entry.visible);
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
export function queueRun(paneId: string, command: string, opts: { focus?: boolean } = {}) {
  pendingRun.set(paneId, { text: command, execute: true, focus: opts.focus ?? true });
  setRun(paneId, "starting");
}

/** Queue text to be typed — not executed — once the pane's PTY has spawned.
 *
 *  Deliberately does not set a run state: nothing is running, the user is being
 *  handed a command to inspect. */
export function queueType(paneId: string, text: string) {
  pendingRun.set(paneId, { text, execute: false, focus: true });
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
    // Nothing is watching this pane's raw stream any more; if it is off screen
    // it can stop being shipped.
    const entry = registry.get(paneId);
    if (entry) syncStream(entry);
    if (queued.execute) runInPane(paneId, queued.text, { focus: queued.focus });
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
  if (!entry || entry.el.parentElement !== host) return;
  entry.el.remove();
  setVisible(entry, false);
  // Hand the GL context back so a pane that is actually on screen can use it.
  // xterm has already stopped drawing this one (its IntersectionObserver sees
  // the detached element), so a plain canvas renderer costs it nothing.
  if (entry.opened) renderers.apply(paneId, entry.term, false);
}

export function isAlive(paneId: string): boolean {
  const entry = registry.get(paneId);
  return !!entry && !entry.exited;
}

// Screens of panes that are not on screen
// ---------------------------------------
// A hidden pane's bytes stop crossing the IPC boundary — that is the point of
// the backend's screen model — so its xterm buffer goes stale the moment it is
// hidden and cannot answer `readPaneTail`. The backend can: it holds the pane's
// live screen either way. What arrives here is the text of the last few dozen
// rows, refreshed by {@link refreshHiddenScreens}, which is all the status scan
// ever reads.

interface RemoteScreen {
  /** The backend's version of this pane's screen. Also what {@link outputSeq}
   *  reports for a hidden pane: the frontend counts batches it received, and it
   *  is no longer receiving any. */
  seq: number;
  text: string;
}

const remoteScreens = new Map<string, RemoteScreen>();
let refreshing = false;

function setVisible(entry: Entry, visible: boolean) {
  if (entry.visible !== visible) {
    entry.visible = visible;
    // A pane coming back on screen is handed the output it missed, so whatever
    // was cached for it is immediately stale — and its xterm buffer, once that
    // replay lands, is authoritative again.
    if (visible) remoteScreens.delete(entry.paneId);
    // Either direction invalidates the settle baseline: going hidden means the
    // next check has not looked yet, and coming back means real bytes take
    // over from the version poll.
    entry.hiddenSeq = -1;
  }
  syncStream(entry);
}

/** Bring the backend's idea of whether this pane needs its bytes shipped into
 *  line with ours.
 *
 *  Not simply "is it on screen". Two things watch the raw stream for a pane that
 *  is still starting: the loading veil, cleared by the first byte, and
 *  {@link flushPending}, which waits for a launched program to paint its
 *  interactive UI before typing into it. Neither can see a stream that has
 *  stopped arriving — so a pane switched away from mid-startup would sit under
 *  its veil until the 15-second safety timer fired. Such a pane keeps streaming
 *  until it is up, which is a few seconds, once. */
function syncStream(entry: Entry) {
  if (!entry.spawned || entry.exited) return;
  const wanted = entry.visible || entry.loading || pendingRun.has(entry.paneId);
  if (wanted === entry.streaming) return;
  entry.streaming = wanted;
  ipc.setPaneVisible(entry.paneId, wanted).catch(() => {
    // The pane died mid-call. Re-reading on the next transition is enough;
    // failing to hide only costs us the bytes we were trying not to ship.
  });
}

/** Pull fresh screens for the hidden panes among `paneIds`.
 *
 *  One call for all of them, and the backend leaves out every pane still at the
 *  version we already hold — with most agents waiting most of the time, the
 *  reply is usually empty. Overlapping calls are dropped rather than queued:
 *  the next tick will ask again, and a poller must not be able to pile up. */
export async function refreshHiddenScreens(paneIds: string[], rows: number) {
  if (refreshing) return;
  const queries = paneIds
    .filter((paneId) => {
      const entry = registry.get(paneId);
      return entry && !entry.visible && !entry.exited;
    })
    .map((paneId) => ({ paneId, seq: remoteScreens.get(paneId)?.seq ?? 0 }));
  if (!queries.length) return;

  refreshing = true;
  try {
    for (const screen of await ipc.paneScreens(queries, rows)) {
      // Shown again while the call was in flight: its terminal is being brought
      // up to date with the real bytes, so a snapshot would only be older.
      if (registry.get(screen.paneId)?.visible) continue;
      remoteScreens.set(screen.paneId, { seq: screen.seq, text: screen.text });
    }
  } catch {
    // Backend not up yet, or a pane closed mid-call; the next tick retries.
  } finally {
    refreshing = false;
  }
}

/** How many batches of output this pane has received. A poller that remembers
 *  the value it last saw can skip the pane entirely while this is unchanged:
 *  nothing has been written, so the screen it would read is the same one.
 *
 *  For a hidden pane this is the backend's count, since no batches arrive here
 *  for it at all. The two counters are unrelated sequences, but nothing compares
 *  them across a visibility change: showing a pane clears its cached screen and
 *  replays its real bytes, so the poller re-reads it either way. */
export function outputSeq(paneId: string): number {
  const entry = registry.get(paneId);
  if (entry && !entry.visible) return remoteScreens.get(paneId)?.seq ?? 0;
  return entry?.outputSeq ?? 0;
}

/** Milliseconds since this pane last received a keystroke, or Infinity if it
 *  never has. Lets a caller tell the program's own repaints apart from the echo
 *  of someone typing into it. */
export function msSinceInput(paneId: string): number {
  const entry = registry.get(paneId);
  if (!entry || entry.lastInputAt === 0) return Infinity;
  return performance.now() - entry.lastInputAt;
}

/** Last `rows` lines of what the pane currently shows, as plain text.
 *  For a full-screen TUI (claude/opencode) the active buffer is the alternate
 *  screen, so this is exactly the live UI — no stale scrollback mixed in. */
export function readPaneTail(paneId: string, rows = 24): string {
  const entry = registry.get(paneId);
  if (!entry) return "";
  // A hidden pane's xterm buffer stopped being fed when the pane left the
  // screen, so reading it would report whatever was drawn at that moment,
  // forever. The backend's screen is the live one — see remoteScreens above.
  // Refusing to answer at all is what once made the sidebar call every
  // off-screen agent "idle".
  if (!entry.visible) return remoteScreens.get(paneId)?.text ?? "";
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
  const entry = registry.get(paneId);
  if (!entry) return;
  // Focus is what the WebGL pool is rationed by: the pane you are working in is
  // the one whose redraw latency you can feel.
  renderers.noteFocus(paneId);
  entry.term.focus();
}

/** Type text into a pane's terminal without submitting it. */
export function typeInPane(paneId: string, text: string) {
  const entry = registry.get(paneId);
  if (!entry || entry.exited) return;
  ipc.writePty(paneId, text);
  entry.term.focus();
}

export function runInPane(paneId: string, command: string, opts: { focus?: boolean } = {}) {
  const entry = registry.get(paneId);
  if (!entry || entry.exited) return;
  noteInput(paneId, "\r");
  ipc.writePty(paneId, command + "\r");
  if (opts.focus ?? true) entry.term.focus();
}

export function destroyPane(paneId: string) {
  const entry = registry.get(paneId);
  if (!entry) return;
  registry.delete(paneId);
  fontDeltas.delete(paneId);
  pendingRun.delete(paneId);
  outputHooks.delete(paneId);
  oscBuffers.delete(paneId);
  statusTails.delete(paneId);
  pendingTitles.delete(paneId);
  remoteScreens.delete(paneId);
  renderers.release(paneId);
  // Drops whatever was queued for this pane, but still reports those bytes: the
  // backend parks a pane's reader until they are acknowledged.
  scheduler.forget(paneId);
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
  // Called even for a pane whose program already exited. The signal is a no-op
  // there, but everything else `kill` does is not: the backend still holds that
  // pane's handle (with its pty master fd and its unreaped child), its screen
  // model, and its flow-control entry until someone asks for them to go. Left
  // out, every pane that ended by itself leaked all three for the life of the
  // app — which is most of them, since closing a pane usually means quitting
  // the program in it first.
  if (entry.spawned) ipc.killPty(paneId).catch(() => {});
  entry.term.dispose();
  entry.el.remove();
}

export function destroyAll() {
  for (const id of [...registry.keys()]) destroyPane(id);
}

/** Per-pane bookkeeping sizes, for the diagnostics log. Every one of these is
 *  keyed by pane id and cleared in `destroyPane`, so each should sit at the
 *  number of open panes: one that keeps climbing across a session of opening
 *  and closing panes is the leak. `terms` counts xterm instances still alive,
 *  which is the expensive thing to leak. */
export function diagCounts(): Record<string, number> {
  let opened = 0;
  let visible = 0;
  let exited = 0;
  let bufferLines = 0;
  let bufferCells = 0;
  for (const entry of registry.values()) {
    if (entry.opened) opened++;
    if (entry.visible) visible++;
    if (entry.exited) exited++;
    try {
      // Lines held, and the cells they amount to. xterm stores a line as a
      // Uint32Array of three words per cell, so cells × 12 bytes is very nearly
      // what a pane's history costs — which is the number to hold next to the
      // webview's resident size.
      const lines = entry.term.buffer.active.length;
      bufferLines += lines;
      bufferCells += lines * entry.term.cols;
    } catch {
      // A terminal disposed under us contributes nothing.
    }
  }
  return {
    terms: registry.size,
    termsOpened: opened,
    termsVisible: visible,
    termsExited: exited,
    termBufferLines: bufferLines,
    termBufferKb: Math.round((bufferCells * 12) / 1024),
    pendingRun: pendingRun.size,
    outputHooks: outputHooks.size,
    oscBuffers: oscBuffers.size,
    statusTails: statusTails.size,
    pendingTitles: pendingTitles.size,
    remoteScreens: remoteScreens.size,
    fontDeltas: fontDeltas.size,
    paneTitles: get(paneTitles).size,
    paneRoots: get(paneRoots).size,
    paneRuns: get(paneRuns).size,
    loadingPanes: get(loadingPanes).size,
  };
}
