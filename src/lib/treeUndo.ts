// Undo for the explorer's move operations.
//
// Ctrl+Z in a text editor undoes a keystroke; here it undoes a *filesystem*
// change, which is a different kind of promise — and the reason only moves are
// on the stack. A move has an inverse that is itself a move: nothing is written
// over, nothing is removed, and the worst case of getting it wrong is a file
// somewhere unexpected. Creating and deleting do not have that property. Undoing
// a create would have to delete, and deletes here are permanent (see
// `delete_entry` in fstree.rs), so a mistimed Ctrl+Z would destroy work rather
// than restore it. Undo therefore covers what can be reversed and stays out of
// what cannot.
//
// A rename counts as a move: it changes where an entry is addressed from, and
// its inverse is another rename.
//
// The disk is shared. Between the move and the undo an agent may have rewritten,
// moved or removed the very file being put back, so every inverse can fail, and
// failing one entry of several must not abandon the rest.
//
// Redo is the same operation read the other way: the pairs that an undo actually
// applied are exactly what Ctrl+Y replays. It is offered here — and was not for
// creates and deletes — for the same reason undo is: replaying a move cannot
// destroy anything. Any new move clears it, so redo only ever means "put back
// what I just took back".

import { get, writable } from "svelte/store";
import { moveEntry, parentDir, renameEntry } from "./filetree";

/** One undoable move: where each entry was, and where it went. Covers a drag, a
 *  cut-and-paste and a rename, which differ only in which half changed. */
export interface TreeUndoOp {
  /** What the menu item says it will undo. */
  label: string;
  pairs: { from: string; to: string }[];
}

/** How far back Ctrl+Z reaches. */
const MAX_UNDO = 50;

export const undoStack = writable<TreeUndoOp[]>([]);
/** Undone moves, waiting for Ctrl+Y. Emptied by the next new move, which is
 *  what makes redo mean "put back what I just took back" and nothing looser. */
export const redoStack = writable<TreeUndoOp[]>([]);

export function recordUndo(op: TreeUndoOp) {
  if (op.pairs.length === 0) return;
  undoStack.update((stack) => [...stack, op].slice(-MAX_UNDO));
  redoStack.set([]);
}

/** Forget everything. Called when the tree changes root: the stack is a list of
 *  paths, and the same relative path in another worktree is another file. */
export function clearUndo() {
  undoStack.set([]);
  redoStack.set([]);
}

/** What the next Ctrl+Z / Ctrl+Y would act on, or null when there is nothing. */
export function nextUndoLabel(stack: TreeUndoOp[]): string | null {
  return stack.at(-1)?.label ?? null;
}

/** The result of an undo: what to select, and what could not be put back. */
export interface UndoResult {
  /** Paths the undo restored, for the caller to select and reveal. */
  restored: string[];
  /** One message per entry that could not be moved back. */
  failures: string[];
}

/** Undo the most recent move: every entry goes back where it came from.
 *
 *  The stack entry is popped whether or not every part of it applied: a second
 *  Ctrl+Z should reach the move before it, not retry the half that just failed
 *  for a reason (the file is gone, the name is taken) that pressing the key
 *  again will not change. Only the parts that *did* apply become redoable. */
export async function undoLast(): Promise<UndoResult | null> {
  const op = pop(undoStack);
  if (!op) return null;
  // Reversed: entries were moved in order, and one may have landed inside a
  // folder that an earlier pair moved.
  const result = await apply([...op.pairs].reverse(), "back");
  push(redoStack, { label: op.label, pairs: result.applied });
  return result;
}

/** Redo the move Ctrl+Z last took back. */
export async function redoLast(): Promise<UndoResult | null> {
  const op = pop(redoStack);
  if (!op) return null;
  const result = await apply(op.pairs, "forward");
  push(undoStack, { label: op.label, pairs: result.applied });
  return result;
}

function pop(stack: typeof undoStack): TreeUndoOp | undefined {
  const list = get(stack);
  const op = list.at(-1);
  if (op) stack.set(list.slice(0, -1));
  return op;
}

function push(stack: typeof undoStack, op: TreeUndoOp) {
  if (op.pairs.length === 0) return;
  stack.update((list) => [...list, op].slice(-MAX_UNDO));
}

/** Move every pair, in the given direction, reporting what landed and what did
 *  not. One failure never abandons the rest — the entries are independent, and
 *  a file an agent removed in the meantime should not strand the other four. */
async function apply(
  pairs: { from: string; to: string }[],
  direction: "back" | "forward",
): Promise<UndoResult & { applied: { from: string; to: string }[] }> {
  const restored: string[] = [];
  const failures: string[] = [];
  const applied: { from: string; to: string }[] = [];
  for (const pair of pairs) {
    const [at, target] = direction === "back" ? [pair.to, pair.from] : [pair.from, pair.to];
    try {
      restored.push(await moveTo(at, target));
      applied.push(pair);
    } catch (err) {
      failures.push(String(err));
    }
  }
  // Kept in the order the pairs were recorded, so a redo replays the move the
  // way it happened rather than in the order the undo unwound it.
  if (direction === "back") applied.reverse();
  return { restored, failures, applied };
}

/** Move whatever is at `at` so that it sits at `target`, and say where it
 *  ended up.
 *
 *  A move and a rename are the same record — one changed the folder, the other
 *  the name — so this replays whichever of the two actually differs, and both
 *  when an action managed both. */
async function moveTo(at: string, target: string): Promise<string> {
  let path = at;
  const dir = parentDir(target);
  if (parentDir(path) !== dir) path = await moveEntry(path, dir);
  const name = target.slice(target.lastIndexOf("/") + 1);
  if (path.slice(path.lastIndexOf("/") + 1) !== name) path = await renameEntry(path, name);
  return path;
}
