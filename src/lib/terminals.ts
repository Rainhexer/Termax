import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { get, writable } from "svelte/store";
import { ipc } from "./ipc";
import { settings } from "./settings";

export const loadingPanes = writable<Set<string>>(new Set());

// Pane currently under an OS file drag (for drop-target highlight).
export const fileDropPaneId = writable<string | null>(null);

interface Entry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
  opening: boolean;
  spawned: boolean;
  exited: boolean;
}

// Terminals live outside the component tree so panes survive layout re-renders.
const registry = new Map<string, Entry>();

// Commands to run once a pane's PTY finishes spawning. The launched program
// (shell/claude/opencode) may not be reading input yet at runtime, so we
// buffer here and flush once the program's output settles.
const pendingRun = new Map<string, string>();

// Per-pane buffer for OSC sequences split across PTY read chunks.
const oscBuffers = new Map<string, string>();

function addLoading(paneId: string) {
  loadingPanes.update(s => new Set(s).add(paneId));
}

function removeLoading(paneId: string) {
  loadingPanes.update(s => {
    const next = new Set(s);
    next.delete(paneId);
    return next;
  });
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function processOsc52(paneId: string, text: string): string {
  const re = /\x1b\]52;([pc]);([A-Za-z0-9+/=]*?)(?:\x07|\x1b\\)/g;
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

let listenersReady = false;

export async function initPtyListeners(onExit: (paneId: string) => void) {
  if (listenersReady) return;
  listenersReady = true;
  await listen<{ pane_id: string; data: string }>("pty-output", (e) => {
    const entry = registry.get(e.payload.pane_id);
    if (!entry) return;

    removeLoading(e.payload.pane_id);

    const raw = b64ToBytes(e.payload.data);
    const chunk = new TextDecoder().decode(raw);

    let text = oscBuffers.get(e.payload.pane_id) ?? "";
    oscBuffers.delete(e.payload.pane_id);
    text += chunk;

    const cleaned = processOsc52(e.payload.pane_id, text);
    if (cleaned) entry.term.write(cleaned);
  });
  await listen<{ pane_id: string }>("pty-exit", (e) => {
    const entry = registry.get(e.payload.pane_id);
    if (entry) entry.exited = true;
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

// Reactively update all open terminals when settings change.
settings.subscribe(s => {
  const fontSize = s.appearance.fontSize;
  const fontFamily = s.appearance.fontFamily;
  for (const entry of registry.values()) {
    if (entry.opened) {
      entry.term.options.fontSize = fontSize;
      entry.term.options.fontFamily = fontFamily;
    }
  }
});

function create(paneId: string): Entry {
  const s = get(settings);
  const term = new Terminal({
    fontFamily: s.appearance.fontFamily,
    fontSize: s.appearance.fontSize,
    cursorBlink: s.terminal.cursorBlink,
    cursorStyle: s.terminal.cursorStyle,
    allowProposedApi: true,
    scrollback: s.terminal.scrollback,
    theme: {
      background: "#131316",
      foreground: "#e4e4e7",
      cursor: s.terminal.cursorColor,
      cursorAccent: "#131316",
      selectionBackground: "#3f3f46",
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
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new CanvasAddon());
  term.loadAddon(new WebLinksAddon());

  const el = document.createElement("div");
  el.className = "h-full w-full";

  const entry: Entry = { term, fit, el, opened: false, opening: false, spawned: false, exited: false };
  registry.set(paneId, entry);
  return entry;
}

/** Mount pane terminal into host element; spawn the PTY on first attach. */
export function attach(
  paneId: string,
  host: HTMLElement,
  cwd: string,
  launch: string | null,
) {
  const entry = registry.get(paneId) ?? create(paneId);
  // Idempotent: re-homing into the same host must not re-run open/onData,
  // else each keystroke replays the whole input history.
  if (entry.el.parentElement !== host) host.appendChild(entry.el);
  if (entry.opened) {
    fitPane(paneId);
  } else if (!entry.opening) {
    entry.opening = true;
    if (launch) addLoading(paneId);
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
  entry.term.onData((data) => ipc.writePty(paneId, data));
  patchWebkitgtkComposition(entry, paneId);
  fitPane(paneId);
  if (!entry.spawned) {
    entry.spawned = true;
    ipc
      .spawnPty(paneId, cwd, launch, entry.term.rows, entry.term.cols)
      .then(() => flushPending(paneId, launch))
      .catch((err) => {
        removeLoading(paneId);
        entry.term.writeln(`\x1b[31mfailed to spawn: ${err}\x1b[0m`);
        pendingRun.delete(paneId);
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
  pendingRun.set(paneId, command);
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
  const command = pendingRun.get(paneId);
  if (command === undefined) return;
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
  let unlistenOutput: (() => void) | undefined;
  let done = false;

  const go = () => {
    if (done) return;
    done = true;
    clearTimeout(settleTimer);
    clearTimeout(safetyTimer);
    unlistenOutput?.();
    runInPane(paneId, command);
  };

  const arm = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(go, SETTLE_MS);
  };

  const onOutput = (e: { payload: { pane_id: string; data: string } }) => {
    if (e.payload.pane_id !== paneId || done) return;
    if (!ready) {
      // Keep a small tail so the frame marker is still matched if it's split
      // across PTY read chunks; ignore output until the UI actually paints.
      carry = (carry + new TextDecoder().decode(b64ToBytes(e.payload.data))).slice(-256);
      if (!READY_FRAME.test(carry)) return;
      ready = true;
      carry = "";
    }
    arm();
  };

  // Shell prints its prompt immediately; start the settle window now for it.
  if (ready) arm();

  // Watch output for readiness + settle
  listen<{ pane_id: string; data: string }>("pty-output", onOutput).then(fn => {
    if (done) fn(); else unlistenOutput = fn;
  });

  // Safety: proceed no matter what after SAFETY_MS
  const safetyTimer = setTimeout(go, SAFETY_MS);
}

export function isAlive(paneId: string): boolean {
  const entry = registry.get(paneId);
  return !!entry && !entry.exited;
}

export function fitPane(paneId: string) {
  const entry = registry.get(paneId);
  if (!entry || !entry.opened || !entry.el.isConnected) return;
  entry.fit.fit();
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
  ipc.writePty(paneId, command + "\r");
  entry.term.focus();
}

export function destroyPane(paneId: string) {
  const entry = registry.get(paneId);
  if (!entry) return;
  registry.delete(paneId);
  pendingRun.delete(paneId);
  oscBuffers.delete(paneId);
  removeLoading(paneId);
  if (entry.spawned && !entry.exited) ipc.killPty(paneId).catch(() => {});
  entry.term.dispose();
  entry.el.remove();
}

export function destroyAll() {
  for (const id of [...registry.keys()]) destroyPane(id);
}
