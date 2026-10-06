/**
 * Which files the agents in this window have just touched.
 *
 * There is no API for this: an agent is a program in a PTY, and all it hands us
 * is the text it draws. But every coding CLI announces its file tools on that
 * screen — `⏺ Read(src/lib/foo.ts)`, `Update(src/lib/foo.ts)`, `Write(...)` —
 * so the same screen scan that powers the sidebar's status readout can also
 * record what was read and what was written, and when.
 *
 * This exists for one reason: an agent that read a file a moment ago is about
 * to write it back from what it saw. Editing that file right now is not
 * dangerous — the save path merges rather than overwrites (see merge.rs) — but
 * it is worth knowing before you type, because the agent's write will not
 * contain your line. So the editor puts a warning in its title bar.
 *
 * Heuristic, and deliberately loose about paths: the CLI may print an absolute
 * path, a project-relative one, or a middle-truncated one when its box is
 * narrow. All three have to match the file a pane has open.
 */

import { get, writable } from "svelte/store";

export type AgentOpKind = "read" | "write";

export interface AgentFileActivity {
  /** Path exactly as the CLI printed it. */
  path: string;
  /** Last time the file was read, 0 if never seen. */
  readAt: number;
  /** Last time it was written, 0 if never seen. */
  writeAt: number;
  /** Pane whose screen this came from. */
  paneId: string;
}

/** How long a read stays worth warning about. Long enough to cover a slow
 *  turn — read, think, write — and short enough that a file read five minutes
 *  ago is not still nagging. */
export const AGENT_READ_WARN_MS = 120_000;

/** Files touched recently, newest last. Bounded: a long session touches
 *  thousands of files and only the recent ones can be warned about. */
export const agentFileOps = writable<AgentFileActivity[]>([]);
const MAX_TRACKED = 200;

/** Tools that mean "the agent has the current contents of this file". */
const READ_TOOLS = /^(?:read|view|cat|open)$/i;
/** Tools that mean "the file on disk is the agent's version now". */
const WRITE_TOOLS = /^(?:write|edit|update|multiedit|notebookedit|create|patch|apply)$/i;

/** `⏺ Read(src/lib/foo.ts)` — a tool call with its argument in parentheses,
 *  which is how claude and codex draw them. The first argument is the path;
 *  anything after a comma (an offset, a limit) is not. */
const CALL = /(?:^|[^\w])(\w+)\(\s*["'`]?([^,)"'`\n]+)["'`]?\s*[,)]/g;
/** `Read src/lib/foo.ts` — the spaced form opencode and aider draw. Requires a
 *  path-shaped argument so a sentence starting with "Read the docs" cannot
 *  register a file. */
const SPACED = /(?:^|[^\w])(\w+)\s+([~./\w-]*[/.][\w./@+~-]*(?:…|\.\.\.)?[\w./@+~-]*)/g;

/** Trailing punctuation and quoting the CLI's own box drawing leaves behind. */
function cleanPath(raw: string): string {
  return raw.trim().replace(/^["'`]|["'`]$/g, "").replace(/[.,;:]+$/, "");
}

/** Does a path printed by a CLI name the file `file` (project-relative)? */
export function pathMatches(printed: string, file: string): boolean {
  if (!printed || !file) return false;
  const p = printed.replace(/^\.\//, "");
  if (p === file || p.endsWith("/" + file) || file.endsWith("/" + p) || file === p) return true;
  // Middle-truncated by a narrow pane ("src/…/EditorPane.svelte"): all that is
  // left to compare is the name, so require the ellipsis before trusting it.
  if (/…|\.\.\./.test(p)) {
    const name = p.split("/").pop() ?? "";
    return name.length > 0 && (file === name || file.endsWith("/" + name));
  }
  // A bare file name with no directory part. Same-named files in different
  // directories collide here; the cost is a warning that is one folder off, and
  // the alternative is missing every CLI that prints just the name.
  if (!p.includes("/")) {
    const name = file.split("/").pop();
    return name === p;
  }
  return false;
}

/** Ops seen on a pane's screen, so a transcript line that stays visible for a
 *  minute is recorded once — at the moment it first appeared. */
interface Seen {
  at: number;
  /** Scan on which this line was last on screen. */
  tick: number;
}
const seen = new Map<string, { tick: number; lines: Map<string, Seen> }>();
/** Scans a line can be off screen before a reappearance counts as a new op —
 *  which is what lets a second read of the same file refresh its timestamp. */
const FORGET_TICKS = 3;

/** Record the file tools visible on one pane's screen.
 *
 *  Called from the status scan, which already has the text and only runs when
 *  the pane drew something. Lines that scrolled past between two scans are
 *  missed; that is the accepted cost of reading a screen instead of an API. */
export function noteAgentScreen(paneId: string, tail: string): void {
  const state = seen.get(paneId) ?? { tick: 0, lines: new Map<string, Seen>() };
  seen.set(paneId, state);
  state.tick++;
  const now = Date.now();
  const fresh: Array<{ path: string; kind: AgentOpKind }> = [];

  for (const line of tail.split("\n")) {
    for (const re of [CALL, SPACED]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const kind: AgentOpKind | null = READ_TOOLS.test(m[1])
          ? "read"
          : WRITE_TOOLS.test(m[1])
            ? "write"
            : null;
        if (!kind) continue;
        const path = cleanPath(m[2]);
        if (!path || path.length > 300) continue;
        const sig = `${kind}:${path}`;
        const before = state.lines.get(sig);
        if (before && state.tick - before.tick <= FORGET_TICKS) {
          before.tick = state.tick; // still on screen: same op, not a new one
          continue;
        }
        state.lines.set(sig, { at: now, tick: state.tick });
        fresh.push({ path, kind });
      }
    }
  }

  // Drop lines that scrolled away long ago, so the map cannot grow with the
  // transcript.
  for (const [sig, entry] of state.lines) {
    if (state.tick - entry.tick > 200) state.lines.delete(sig);
  }
  if (fresh.length) record(paneId, fresh, now);
}

function record(paneId: string, ops: Array<{ path: string; kind: AgentOpKind }>, now: number) {
  agentFileOps.update((list) => {
    const next = list.slice();
    for (const op of ops) {
      const at = next.findIndex((e) => e.path === op.path && e.paneId === paneId);
      const entry: AgentFileActivity =
        at >= 0 ? { ...next[at] } : { path: op.path, readAt: 0, writeAt: 0, paneId };
      if (op.kind === "read") entry.readAt = now;
      else entry.writeAt = now;
      if (at >= 0) next.splice(at, 1);
      next.push(entry);
    }
    return next.length > MAX_TRACKED ? next.slice(next.length - MAX_TRACKED) : next;
  });
}

/** The most recent *unfulfilled* read of `file`: an agent looked at it and has
 *  not written it back yet. A read older than the agent's own write says
 *  nothing — that turn is over. */
export function pendingRead(
  ops: AgentFileActivity[],
  file: string,
  now = Date.now(),
): AgentFileActivity | null {
  let best: AgentFileActivity | null = null;
  for (const op of ops) {
    if (op.readAt <= op.writeAt) continue;
    if (now - op.readAt > AGENT_READ_WARN_MS) continue;
    if (!pathMatches(op.path, file)) continue;
    if (!best || op.readAt > best.readAt) best = op;
  }
  return best;
}

/** Forget everything recorded for a pane that has gone away. */
export function forgetPane(paneId: string): void {
  seen.delete(paneId);
  agentFileOps.update((list) => {
    const next = list.filter((e) => e.paneId !== paneId);
    return next.length === list.length ? list : next;
  });
}

/**
 * Wall clock for the warning, ticking only while there is something to time
 * out. The warning has to disappear on its own — nothing draws when a read
 * simply gets old — but a permanent 1s interval would wake every editor pane in
 * the window for the rest of the session, so it runs only while an op is still
 * inside its window and stops itself when the last one ages out.
 */
export const agentClock = writable(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;

function anyFresh(list: AgentFileActivity[], now: number): boolean {
  return list.some((op) => now - Math.max(op.readAt, op.writeAt) < AGENT_READ_WARN_MS);
}

if (typeof window !== "undefined") {
  agentFileOps.subscribe((list) => {
    if (clockTimer || !anyFresh(list, Date.now())) return;
    clockTimer = setInterval(() => {
      const now = Date.now();
      if (!anyFresh(get(agentFileOps), now)) {
        clearInterval(clockTimer);
        clockTimer = undefined;
        return;
      }
      agentClock.set(now);
    }, 1000);
  });
}

/** Tracking sizes, for the diagnostics log. */
export function diagCounts(): Record<string, number> {
  return { agentFileOps: get(agentFileOps).length, agentScanPanes: seen.size };
}
