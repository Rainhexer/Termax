// Ctrl+S saves the file open in the focused pane from anywhere in the app,
// not just when the Monaco editor itself has focus. Each editor pane registers
// its save function here; the global keydown handler in App.svelte looks the
// focused pane up and calls it. Panes are keyed by id for their whole life and
// unregister on teardown, so a stale entry can never fire.

const handlers = new Map<string, () => void>();

/** Register `save` for `paneId`; returns the unregister function. */
export function registerSave(paneId: string, save: () => void): () => void {
  handlers.set(paneId, save);
  return () => {
    if (handlers.get(paneId) === save) handlers.delete(paneId);
  };
}

/** Save the file open in pane `paneId`. False when the pane is not an editor
 *  (terminal, welcome pane), leaving the keystroke free for its other uses. */
export function savePaneFile(paneId: string): boolean {
  const save = handlers.get(paneId);
  if (!save) return false;
  void save();
  return true;
}
