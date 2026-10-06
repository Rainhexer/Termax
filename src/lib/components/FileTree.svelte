<script lang="ts">
  import { ask } from "@tauri-apps/plugin-dialog";
  import {
    addPane,
    changes,
    closePane,
    explorerLocked,
    focusedPaneId,
    fsTick,
    highlightedChange,
    layout,
    lockFlash,
    openFile,
  } from "../stores";
  import {
    MIN_TREE_QUERY,
    buildBadges,
    collapseAll,
    collapseAllUnder,
    createEntry,
    deleteEntry,
    expandTo,
    expandedDirs,
    flattenTree,
    moveEntry,
    parentDir,
    pasteInto,
    refreshTree,
    refreshTreeSearch,
    renameEntry,
    setTreeQuery,
    toggleDir,
    treeChildren,
    treeClipboard,
    treeMatches,
    treeQuery,
    treeSearching,
  } from "../filetree";
  import type { PasteResult, TreeRow } from "../filetree";
  import { startTreeDrag, treeDragPaths, treeDropDir } from "../treeDrag";
  import type { TreeDropTarget } from "../treeDrag";
  import {
    clearUndo,
    nextUndoLabel,
    recordUndo,
    redoLast,
    redoStack,
    undoLast,
    undoStack,
  } from "../treeUndo";
  import type { UndoResult } from "../treeUndo";
  import { collectPanes } from "../layout";
  import { enabledLaunchers, settings } from "../settings";
  import type { Launcher } from "../settings";
  import { queueType, shellEscapePath, typeInPane } from "../terminals";
  import { activeTabRoot } from "../worktrees";
  import { ipc } from "../ipc";
  import type { TreeEntry } from "../types";
  import FileTreeNode from "./FileTreeNode.svelte";
  import TerminalIcon from "./TerminalIcon.svelte";

  /** Filling the sidebar's swap panel: the tab that selected this component is
   *  the disclosure, so the header loses its own toggle and the tree takes the
   *  height instead of capping itself. */
  let { fill = false }: { fill?: boolean } = $props();

  let open = $state(true);
  let menu = $state<{ x: number; y: number; entry: TreeEntry } | null>(null);
  /** Right-click on the empty space below the rows: the same actions that do
   *  not need an entry to act on, aimed at the project root. */
  let rootMenu = $state<{ x: number; y: number } | null>(null);
  /** Whether the context menu's agent list is showing. */
  let agentsOpen = $state(false);

  /* --------------------------------------------------------- selection
   *
   *  Three pieces of state, not one, because a file manager's selection is
   *  three questions with different answers: what is highlighted, what the
   *  keyboard and the single-entry menu items act on, and where a shift-range
   *  is measured from. Collapsing them (making the cursor "the last item in
   *  the set", say) breaks the moment a range is drawn upwards. */
  /** Every highlighted path. */
  let selection = $state<Set<string>>(new Set());
  /** The row the keyboard moves and single-entry actions target. Always in
   *  `selection` while anything is selected. */
  let cursor = $state<string | null>(null);
  /** Where the next shift-click measures from — the last *unextended* pick. */
  let anchor = $state<string | null>(null);

  /** Last failed filesystem action, shown under the search box. */
  let error = $state<string | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let searchEl = $state<HTMLInputElement | null>(null);

  /** An open name prompt. One dialog serves all three naming actions: they
   *  differ only in their title and in what they do with the answer. */
  let naming = $state<
    | { kind: "file" | "folder"; dir: string; value: string }
    | { kind: "rename"; path: string; value: string }
    | null
  >(null);
  let nameEl = $state<HTMLInputElement | null>(null);

  const badges = $derived(buildBadges($changes));
  const agents = $derived(enabledLaunchers($settings).filter((l) => l.command !== null));

  const query = $derived($treeQuery.trim());
  const isSearch = $derived(query.length >= MIN_TREE_QUERY);
  /** Search results are already a flat list of full paths, so they are shown
   *  at depth 0 with the containing folder spelled out beside the name — the
   *  tree's indentation would be meaningless for rows from all over it. */
  const rows = $derived<TreeRow[]>(
    isSearch
      ? ($treeMatches?.entries ?? []).map((entry) => ({ entry, depth: 0 }))
      : flattenTree($treeChildren, $expandedDirs),
  );

  /** Paths on the clipboard as a cut, so their rows can show they are going. */
  const cutPaths = $derived(
    $treeClipboard?.mode === "cut" ? new Set($treeClipboard.paths) : new Set<string>(),
  );
  const dragging = $derived(new Set($treeDragPaths));

  // Re-fetch the root and expanded dirs whenever the debounced watcher fires.
  $effect(() => {
    $fsTick;
    refreshTree();
  });

  $effect(() => {
    if (!menu && !rootMenu) return;
    function close() {
      menu = null;
      rootMenu = null;
      agentsOpen = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  });

  // The prompt owns the keyboard while it is up.
  $effect(() => {
    if (naming) nameEl?.focus();
  });

  /** Undo and redo, listened for on the window rather than on the tree.
   *
   *  Every other explorer shortcut needs a focused row to mean anything —
   *  "copy *what*?" — but undo names its own subject, and requiring focus made
   *  it unreachable exactly when it was wanted: a move refreshes the tree,
   *  which re-creates the rows, which drops focus to <body>, so the Ctrl+Z
   *  right after a move never arrived. Anything inside a pane is left alone —
   *  a terminal and an editor have their own meanings for these keys. */
  $effect(() => {
    function onWindowKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      const el = e.target as HTMLElement | null;
      if (
        el?.closest?.(
          "input, textarea, [contenteditable='true'], .monaco-editor, [data-pane-id]",
        )
      ) {
        return;
      }
      e.preventDefault();
      // Ctrl+Shift+Z is the other half of Ctrl+Y, as it is everywhere else.
      void (key === "y" || e.shiftKey ? redo() : undo());
    }
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
  });

  /** Selected paths in the order they are drawn, so a multi-entry action reads
   *  down the tree rather than in whatever order the rows were clicked. */
  function selectedPaths(): string[] {
    const ordered = rows.filter((r) => selection.has(r.entry.path)).map((r) => r.entry.path);
    // A selected path can be off screen — a folder was collapsed under it, or
    // the search box swapped the rows out — and it is still selected.
    for (const path of selection) if (!ordered.includes(path)) ordered.push(path);
    return ordered;
  }

  function selectOnly(path: string | null) {
    selection = path === null ? new Set() : new Set([path]);
    cursor = path;
    anchor = path;
  }

  function selectPaths(paths: string[]) {
    selection = new Set(paths);
    cursor = paths.at(-1) ?? null;
    anchor = cursor;
  }

  /** Ctrl-click: add or remove one row, leaving the rest of the selection. */
  function toggleOne(path: string) {
    const next = new Set(selection);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selection = next;
    cursor = path;
    anchor = path;
  }

  /** Shift-click: every row between the anchor and here, in display order.
   *  The anchor is left where it was, so a second shift-click re-draws the
   *  range from the same start instead of growing it from the last end. */
  function selectRange(to: string) {
    const from = anchor ?? to;
    const a = rows.findIndex((r) => r.entry.path === from);
    const b = rows.findIndex((r) => r.entry.path === to);
    if (a < 0 || b < 0) {
      selectOnly(to);
      return;
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    selection = new Set(rows.slice(lo, hi + 1).map((r) => r.entry.path));
    cursor = to;
  }

  function onSelect(entry: TreeEntry, e: MouseEvent) {
    if (e.shiftKey) selectRange(entry.path);
    else if (e.ctrlKey || e.metaKey) toggleOne(entry.path);
    else selectOnly(entry.path);
  }

  function openMenu(e: MouseEvent, entry: TreeEntry) {
    // Right-clicking inside the selection acts on all of it; right-clicking
    // outside it moves the selection there first, which is the only reading of
    // the gesture that cannot delete something the user was not pointing at.
    if (!selection.has(entry.path)) selectOnly(entry.path);
    else cursor = entry.path;
    listEl?.focus();
    agentsOpen = false;
    menu = {
      x: Math.min(e.clientX, window.innerWidth - 220),
      // Roughly the menu's own height, so a right-click near the bottom of the
      // window opens a menu that is fully on screen rather than clipped.
      y: Math.min(e.clientY, Math.max(8, window.innerHeight - 460)),
      entry,
    };
  }

  const hasChanges = $derived(menu ? badges.files.has(menu.entry.path) : false);
  /** How many entries the menu's actions apply to. */
  const menuCount = $derived(menu ? Math.max(1, selection.size) : 0);
  const suffix = $derived(menuCount > 1 ? ` ${menuCount} items` : "");

  let flashing = $state(false);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    $lockFlash;
    if ($lockFlash === 0) return;
    clearTimeout(flashTimer);
    flashing = true;
    flashTimer = setTimeout(() => {
      flashing = false;
    }, 300);
  });

  /** Absolute path, against the root the tree is actually showing — a tab
   *  bound to a worktree has the same relative paths as a different checkout. */
  function absolutePath(path: string): string {
    return `${$activeTabRoot ?? ""}/${path}`;
  }

  /** The folder an action lands in: a directory itself, or a file's parent. */
  function containingDir(entry: TreeEntry): string {
    return entry.isDir ? entry.path : parentDir(entry.path);
  }

  /** Put paths on the focused terminal's prompt. Typed, not run — a lone folder
   *  is prefixed with `cd `, since that is the only thing anyone means by
   *  "open this folder in the terminal", and the user still presses Enter. */
  function openInTerminal(entry: TreeEntry) {
    const paneId = $focusedPaneId;
    if (!paneId || !isTerminalPane(paneId)) return;
    const paths = menuPaths(entry);
    const text = paths.map(shellEscapePath).join(" ");
    const lone = paths.length === 1 && entry.isDir;
    typeInPane(paneId, lone ? `cd ${text}` : `${text} `);
  }

  /** Open a fresh pane running `launcher` and hand it the path.
   *
   *  Typed, never executed: the path is the start of a sentence the user is
   *  about to finish ("…refactor this"), and the agent is still booting when
   *  this is called, which is why the text is queued rather than written — see
   *  `flushPending` in terminals.ts. */
  function openWithAgent(launcher: Launcher, entry: TreeEntry) {
    const paneId = addPane(launcher.command, launcher.name);
    queueType(paneId, `${menuPaths(entry).map(shellEscapePath).join(" ")} `);
  }

  /** Editor panes showing a path that no longer exists, closed.
   *  Deleting or moving a file out from under a pane leaves it displaying a
   *  buffer of something that is gone, which the next save would recreate. */
  function closePanesUnder(path: string) {
    const prefix = `${path}/`;
    for (const pane of collectPanes($layout)) {
      if (pane.kind !== "editor" || !pane.file) continue;
      if (pane.file === path || pane.file.startsWith(prefix)) closePane(pane.id);
    }
  }

  /** True when the explorer will accept a change; flashes the padlock if not.
   *  The lock already makes editor panes read-only, and a lock that stops you
   *  editing a file but not deleting it would not be a lock. */
  function unlocked(): boolean {
    if (!$explorerLocked) return true;
    lockFlash.update((n) => n + 1);
    error = "Explorer is locked — use the padlock to allow changes.";
    return false;
  }

  /** Re-read the tree and, if the search box is showing results, the search. */
  async function reload() {
    await refreshTree();
    refreshTreeSearch();
  }

  function act(fn: () => void) {
    fn();
    menu = null;
    rootMenu = null;
    agentsOpen = false;
  }

  function startNaming(next: NonNullable<typeof naming>) {
    if (!unlocked()) return;
    error = null;
    naming = next;
  }

  async function submitName() {
    const pending = naming;
    if (!pending) return;
    const name = pending.value.trim();
    if (!name) return;
    naming = null;
    error = null;
    try {
      if (pending.kind === "rename") {
        const to = await renameEntry(pending.path, name);
        recordUndo({ label: `rename of ${name}`, pairs: [{ from: pending.path, to }] });
        closePanesUnder(pending.path);
        selectOnly(to);
      } else {
        const created = await createEntry(pending.dir, name, pending.kind === "folder");
        await expandTo(created);
        selectOnly(created);
        if (pending.kind === "file") openFile(created);
      }
      await reload();
    } catch (err) {
      error = String(err);
    }
  }

  /* ------------------------------------------------------ clipboard */

  /** What a menu item or a shortcut acts on: the whole selection when the
   *  entry it was invoked from is part of it, that entry alone otherwise. */
  function menuPaths(entry: TreeEntry): string[] {
    return selection.has(entry.path) ? selectedPaths() : [entry.path];
  }

  function copyToClipboard(paths: string[], mode: "copy" | "cut") {
    if (paths.length === 0) return;
    // Only a cut is an edit; copying is free and works while locked.
    if (mode === "cut" && !unlocked()) return;
    error = null;
    treeClipboard.set({ paths, mode });
  }

  /** Where a paste lands: the selected folder, or the folder holding whatever
   *  is selected — and the root when nothing is. */
  function pasteTarget(): string {
    const entry = cursorEntry();
    return entry ? containingDir(entry) : "";
  }

  async function paste(dir: string) {
    if (!$treeClipboard || !unlocked()) return;
    error = null;
    let result: PasteResult | null = null;
    try {
      result = await pasteInto(dir);
    } catch (err) {
      error = String(err);
      // A paste that failed part-way still moved or copied the entries before
      // the one that failed, and those are undoable.
      result = (err as { result?: PasteResult }).result ?? null;
    }
    if (result?.pairs.length) {
      const { mode, pairs } = result;
      // Only a cut is undoable. Undoing a pasted *copy* would mean deleting
      // it, and a delete here is permanent — so the copy stays, and Ctrl+Z
      // reaches past it to the last move.
      if (mode === "cut") {
        const what = pairs.length > 1 ? `${pairs.length} items` : pairs[0].to.split("/").pop();
        recordUndo({ label: `move of ${what}`, pairs });
        // A cut leaves editor panes pointing at paths that have moved; the pane
        // would otherwise re-create the file at the old location on its next save.
        for (const { from } of pairs) closePanesUnder(from);
      }
      // Expanding to one of them opens every folder above it, which is the
      // destination — so what was just pasted is on screen, not filed away
      // inside a folder that is still closed.
      await expandTo(pairs[0].to);
      selectPaths(pairs.map((p) => p.to));
    }
    await reload();
  }

  /* ----------------------------------------------------------- drag */

  function isTerminalPane(paneId: string): boolean {
    const pane = collectPanes($layout).find((p) => p.id === paneId);
    return !!pane && pane.kind !== "editor";
  }

  /** Press on a row: might be a click, might be the start of a drag.
   *
   *  Dragging a row outside the selection takes that row alone and leaves the
   *  selection untouched until the release — the click handler is what changes
   *  it, and a drag that is cancelled should change nothing at all. */
  function onRowPointerDown(e: PointerEvent, entry: TreeEntry) {
    // Focus the *list*, never the row. A row is destroyed and re-created by
    // every refresh — which every file operation triggers — and focus on a
    // destroyed node falls back to <body>, where Ctrl+Z is somebody else's
    // shortcut. The list outlives all of it and handles the keys anyway.
    listEl?.focus();
    const paths = selection.has(entry.path) ? selectedPaths() : [entry.path];
    const label = paths.length === 1 ? entry.name : `${paths.length} items`;
    startTreeDrag(e, paths, label, { onDrop, canDropInPane: isTerminalPane });
  }

  function onDrop(target: TreeDropTarget, paths: string[]) {
    if (target.kind === "pane") {
      // Project-relative, like "Open in terminal" and unlike an *OS* file drop,
      // which has no root to be relative to. Panes start in the root, and a
      // relative path is also what an agent wants to be handed.
      typeInPane(target.paneId, `${paths.map(shellEscapePath).join(" ")} `);
      return;
    }
    void moveInto(target.path, paths);
  }

  /** Move dropped entries into `dir`, reporting what could not be moved.
   *
   *  Each is moved on its own rather than as a batch: a name that is already
   *  taken in the destination fails one entry, and the rest should still land
   *  where they were dropped. */
  async function moveInto(dir: string, paths: string[]) {
    if (!unlocked()) return;
    error = null;
    const pairs: { from: string; to: string }[] = [];
    const failures: string[] = [];
    for (const from of paths) {
      try {
        const to = await moveEntry(from, dir);
        if (to !== from) {
          closePanesUnder(from);
          pairs.push({ from, to });
        }
      } catch (err) {
        failures.push(String(err));
      }
    }
    if (pairs.length) {
      const what = pairs.length > 1 ? `${pairs.length} items` : pairs[0].to.split("/").pop();
      recordUndo({ label: `move of ${what}`, pairs });
      await expandTo(pairs[0].to);
      selectPaths(pairs.map((p) => p.to));
    }
    if (failures.length) error = failures.join("; ");
    await reload();
  }

  /* --------------------------------------------------------- deleting */

  /** Whether a path is a folder, according to what the tree currently shows. */
  function isDirPath(path: string): boolean {
    return rows.find((r) => r.entry.path === path)?.entry.isDir ?? false;
  }

  /** Delete, permanently — there is no trash, which is exactly why Ctrl+Z does
   *  not reach this. Undo covers moves, whose inverse cannot lose anything. */
  async function deleteSelection(paths: string[]) {
    if (!unlocked() || paths.length === 0) return;
    const many = paths.length > 1;
    const what = many
      ? `these ${paths.length} items`
      : isDirPath(paths[0])
        ? "this folder"
        : "this file";
    const list = paths.slice(0, 10).join("\n") + (paths.length > 10 ? `\n… and ${paths.length - 10} more` : "");
    const ok = await ask(
      `Permanently delete ${what}?\n\n${list}\n\nFolders go with everything inside them.\n\nThis cannot be undone — it does not go to the trash.`,
      {
        title: many ? `Delete ${paths.length} items?` : "Delete?",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      },
    );
    if (!ok) return;
    error = null;
    const failures: string[] = [];
    for (const path of paths) {
      try {
        await deleteEntry(path);
        closePanesUnder(path);
      } catch (err) {
        failures.push(String(err));
      }
    }
    selectOnly(null);
    if (failures.length) error = failures.join("; ");
    await reload();
  }

  /* ----------------------------------------------------------- undo */

  const undoLabel = $derived(nextUndoLabel($undoStack));
  const redoLabel = $derived(nextUndoLabel($redoStack));

  /** Undo the last move the explorer made — a drag, a cut-and-paste, a rename.
   *
   *  The stack is per-root: a tab bound to a worktree is a different checkout
   *  with the same relative paths, and undoing into it would put a file back in
   *  the wrong one. */
  $effect(() => {
    $activeTabRoot;
    clearUndo();
  });

  function undo() {
    return step(undoLast, "undo");
  }

  function redo() {
    return step(redoLast, "redo");
  }

  async function step(run: () => Promise<UndoResult | null>, what: string) {
    if (!unlocked()) return;
    error = null;
    const result = await run();
    if (!result) return;
    if (result.restored.length) {
      await expandTo(result.restored[0]);
      selectPaths(result.restored);
    }
    if (result.failures.length) error = `Could not ${what}: ${result.failures.join("; ")}`;
    await reload();
  }

  /** Open a search hit in the tree: leave the tree expanded at it, and drop
   *  the query so the user lands back in the structure they were browsing. */
  async function revealHit(entry: TreeEntry) {
    setTreeQuery("");
    await expandTo(entry.path);
    selectOnly(entry.path);
    if (entry.isDir) await toggleDir(entry.path);
  }

  function activate(entry: TreeEntry) {
    if (isSearch) {
      if (entry.isDir) {
        void revealHit(entry);
      } else {
        openFile(entry.path);
      }
      return;
    }
    if (!entry.isDir) openFile(entry.path);
  }

  function toggle(entry: TreeEntry) {
    if (isSearch) {
      void revealHit(entry);
      return;
    }
    if (entry.isDir) void toggleDir(entry.path);
  }

  /** Keep the keyboard cursor on screen without scrolling the sidebar around
   *  the mouse: `nearest` moves only when the row is actually out of view. */
  function scrollToCursor() {
    requestAnimationFrame(() => {
      const index = rows.findIndex((r) => r.entry.path === cursor);
      if (index < 0) return;
      listEl?.querySelectorAll<HTMLElement>('[role="treeitem"]')[index]?.scrollIntoView({
        block: "nearest",
      });
    });
  }

  /** Move the cursor. With `extend`, the selection grows from the anchor as it
   *  goes (shift+arrow), which is the keyboard's version of a shift-click. */
  function move(delta: number, extend = false) {
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r.entry.path === cursor);
    const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : at + delta;
    const path = rows[Math.min(rows.length - 1, Math.max(0, next))].entry.path;
    if (extend) selectRange(path);
    else selectOnly(path);
    scrollToCursor();
  }

  function cursorEntry(): TreeEntry | null {
    return rows.find((r) => r.entry.path === cursor)?.entry ?? null;
  }

  function onKeydown(e: KeyboardEvent) {
    if (naming) return;
    const entry = cursorEntry();

    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case "c":
          e.preventDefault();
          copyToClipboard(selectedPaths(), "copy");
          return;
        case "x":
          e.preventDefault();
          copyToClipboard(selectedPaths(), "cut");
          return;
        case "v":
          e.preventDefault();
          void paste(pasteTarget());
          return;
        case "a":
          e.preventDefault();
          selection = new Set(rows.map((r) => r.entry.path));
          return;
      }
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1, e.shiftKey);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(-1, e.shiftKey);
        return;
      case "ArrowRight":
        if (!entry) return;
        e.preventDefault();
        if (entry.isDir && !$expandedDirs.has(entry.path)) void toggleDir(entry.path);
        else move(1);
        return;
      case "ArrowLeft": {
        if (!entry) return;
        e.preventDefault();
        if (entry.isDir && $expandedDirs.has(entry.path)) {
          void toggleDir(entry.path);
          return;
        }
        // Not expandable (or already closed): step out to the parent, which is
        // how a tree gets you back up without hunting for the row.
        const parent = parentDir(entry.path);
        if (!entry.isDir && parent) selectOnly(parent);
        else if (entry.isDir && entry.path.includes("/")) selectOnly(parentDir(entry.path));
        scrollToCursor();
        return;
      }
      case "Enter":
        if (!entry) return;
        e.preventDefault();
        if (entry.isDir) toggle(entry);
        else activate(entry);
        return;
      case "Delete":
        e.preventDefault();
        void deleteSelection(selectedPaths());
        return;
      case "F2":
        if (!entry) return;
        e.preventDefault();
        startNaming({ kind: "rename", path: entry.path, value: entry.name });
        return;
      case "Escape":
        if (query) {
          setTreeQuery("");
          return;
        }
        if ($treeClipboard) {
          treeClipboard.set(null);
          return;
        }
        selectOnly(null);
        return;
    }
  }

  /** Where a header "New…" button puts things: beside the selection, or at the
   *  root when nothing is selected. */
  function newTarget(): string {
    const entry = cursorEntry();
    return entry ? containingDir(entry) : "";
  }
</script>

<div class="flex min-h-0 flex-col gap-1 {fill ? 'flex-1' : ''}">
  <div class="flex items-center gap-1 px-1">
    {#if fill}
      <h2 class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Explorer</h2>
    {:else}
      <button
        class="flex items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
        onclick={() => (open = !open)}
      >
        <span class="text-[9px]">{open ? "▼" : "▶"}</span>
        Explorer
      </button>
    {/if}

    <div class="ml-auto flex items-center gap-0.5">
      <button
        class="flex h-4 w-4 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="New file{newTarget() ? ` in ${newTarget()}/` : ''}"
        onclick={() => startNaming({ kind: "file", dir: newTarget(), value: "" })}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1H7" />
          <path d="M9 1.75v3.5h3.5" />
          <path d="M11.5 9v5M9 11.5h5" />
        </svg>
      </button>
      <button
        class="flex h-4 w-4 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="New folder{newTarget() ? ` in ${newTarget()}/` : ''}"
        onclick={() => startNaming({ kind: "folder", dir: newTarget(), value: "" })}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 13.25H2.75a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3.1l1.4 1.6h5a1 1 0 0 1 1 1V8" />
          <path d="M11.5 9.5v5M9 12h5" />
        </svg>
      </button>
      <button
        class="flex h-4 w-4 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Collapse all folders"
        onclick={() => collapseAll()}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 6.5 8 3l4 3.5M4 12.5 8 9l4 3.5" />
        </svg>
      </button>
      <button
        class="flex h-4 w-4 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Refresh"
        onclick={() => void reload()}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
          <path d="M13.5 2.5v3.2h-3.2" />
        </svg>
      </button>
      <button
        class="flex h-4 w-4 items-center justify-center rounded transition-all duration-200 {$explorerLocked
          ? 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-400'
          : 'text-emerald-400 hover:bg-zinc-800'}
          {flashing ? 'text-red-500 scale-125' : ''}"
        title={$explorerLocked
          ? "Unlock: allow editing, renaming and deleting"
          : "Lock: files read-only, no renames or deletes"}
        onclick={() => explorerLocked.update((v) => !v)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="11" width="16" height="10" rx="2" />
          {#if $explorerLocked}
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          {:else}
            <path d="M8 11V7a4 4 0 0 1 7.7-1.5" />
          {/if}
        </svg>
      </button>
    </div>
  </div>

  {#if open || fill}
    <!-- The search box sits above the tree rather than replacing it: typing
         swaps the rows underneath for matches from anywhere in the project,
         and clearing the box puts the tree back exactly as it was. -->
    <div class="relative px-1">
      <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <circle cx="7" cy="7" r="4.25" />
          <path d="m10.2 10.2 3.05 3.05" />
        </svg>
      </span>
      <input
        bind:this={searchEl}
        class="h-6 w-full rounded border border-zinc-800 bg-zinc-900/70 pl-7 pr-6 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-600/60 focus:outline-none"
        placeholder="Search files…"
        spellcheck="false"
        value={$treeQuery}
        oninput={(e) => setTreeQuery(e.currentTarget.value)}
        onkeydown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if ($treeQuery) setTreeQuery("");
            else searchEl?.blur();
          } else if (e.key === "ArrowDown" || e.key === "Enter") {
            e.preventDefault();
            listEl?.focus();
            if (!cursor) move(1);
            else if (e.key === "Enter") {
              const entry = cursorEntry();
              if (entry) activate(entry);
            }
          }
        }}
      />
      {#if $treeQuery}
        <button
          class="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300"
          title="Clear search"
          onclick={() => { setTreeQuery(""); searchEl?.focus(); }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      {/if}
    </div>

    {#if error}
      <p class="px-1 text-[10px] leading-tight text-red-400">{error}</p>
    {/if}

    <!-- The list is also the drop zone for the project root: releasing a drag
         over the empty space below the rows moves the entries back out to the
         top level, which otherwise has no row to aim at. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div
      bind:this={listEl}
      role="tree"
      tabindex="-1"
      data-tree-root="true"
      class="min-h-0 overflow-y-auto outline-none {fill ? 'flex-1' : 'max-h-72'}
        {$treeDropDir === '' ? 'rounded ring-1 ring-inset ring-emerald-400/70' : ''}"
      onkeydown={onKeydown}
      onclick={(e) => {
        // Clicking past the last row clears the selection, the way clicking the
        // background of a file manager window does.
        if (!(e.target as HTMLElement).closest("[data-path]")) selectOnly(null);
      }}
      oncontextmenu={(e) => {
        // Anything that is not a row: the space below the last one, or the
        // "Empty directory." line. A right-click on a row has already opened
        // that row's own menu, and this would replace it.
        if ((e.target as HTMLElement).closest("[data-path]")) return;
        e.preventDefault();
        listEl?.focus();
        selectOnly(null);
        menu = null;
        rootMenu = { x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, Math.max(8, window.innerHeight - 260)) };
      }}
    >
      {#if isSearch && $treeSearching && rows.length === 0}
        <p class="px-1 py-1 text-[11px] text-zinc-600">Searching…</p>
      {:else if rows.length === 0}
        <p class="px-1 py-1 text-[11px] text-zinc-600">
          {isSearch ? `Nothing matches “${query}”.` : "Empty directory."}
        </p>
      {:else}
        {#each rows as row (row.entry.path)}
          <FileTreeNode
            entry={row.entry}
            depth={row.depth}
            expanded={!isSearch && row.entry.isDir && $expandedDirs.has(row.entry.path)}
            selected={selection.has(row.entry.path)}
            badge={row.entry.isDir ? null : (badges.files.get(row.entry.path) ?? null)}
            count={row.entry.isDir ? (badges.dirCounts.get(row.entry.path) ?? 0) : 0}
            showDir={isSearch}
            dropDir={row.entry.isDir ? row.entry.path : parentDir(row.entry.path)}
            dropTarget={row.entry.isDir && $treeDropDir === row.entry.path}
            dragging={dragging.has(row.entry.path)}
            cut={cutPaths.has(row.entry.path)}
            onactivate={activate}
            ontoggle={toggle}
            onselect={onSelect}
            onmenu={openMenu}
            ondragstart={onRowPointerDown}
          />
        {/each}
        {#if isSearch && $treeMatches?.truncated}
          <p class="px-1 py-1 text-[10px] italic text-zinc-600">
            Showing the first {rows.length} matches — narrow the search for the rest.
          </p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

{#if menu}
  {@const entry = menu.entry}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed z-50 w-52 rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
    style="left: {menu.x}px; top: {menu.y}px"
    onpointerdown={(e) => e.stopPropagation()}
  >
    <!-- Opening is a one-entry idea: with several selected the menu drops
         these rows rather than picking which of them "Open" would have meant. -->
    {#if menuCount === 1}
      {#if entry.isDir}
        <button class="menu-item" onclick={() => act(() => void toggleDir(entry.path))}>
          {$expandedDirs.has(entry.path) ? "Collapse" : "Expand"}
        </button>
        <button class="menu-item" onclick={() => act(() => collapseAllUnder(entry.path))}>
          Collapse all children
        </button>
      {:else}
        <button class="menu-item" onclick={() => act(() => openFile(entry.path))}>
          Open
        </button>
      {/if}
    {/if}

    <!-- Hover to expand, exactly like a menu bar: the agents are a list the
         user is choosing from, not an action, so opening it must not cost a
         click. Clicking the row works too, for the keyboard-averse mouse. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="relative" onmouseenter={() => (agentsOpen = true)}>
      <button
        class="menu-item flex items-center"
        disabled={agents.length === 0}
        onclick={() => (agentsOpen = !agentsOpen)}
      >
        <span class={agents.length === 0 ? "text-zinc-600" : ""}>Open{suffix} with agent</span>
        <span class="ml-auto text-zinc-500">{agents.length === 0 ? "—" : "▸"}</span>
      </button>
      {#if agentsOpen && agents.length}
        <div
          class="absolute top-0 z-50 w-44 rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl {menu.x >
          window.innerWidth - 384
            ? 'right-full mr-0.5'
            : 'left-full ml-0.5'}"
        >
          {#each agents as agent (agent.id)}
            <button
              class="menu-item flex items-center gap-2"
              onclick={() => act(() => openWithAgent(agent, entry))}
            >
              <span class="text-emerald-400"><TerminalIcon type={agent.icon} className="h-3.5 w-3.5" /></span>
              <span class="truncate">{agent.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    {#if !entry.isDir && menuCount === 1}
      <button class="menu-item" onclick={() => act(() => void ipc.openInDefaultApp(entry.path).catch((err) => (error = String(err))))}>
        Open in default app
      </button>
    {/if}
    <button class="menu-item" onclick={() => act(() => openInTerminal(entry))}>
      {menuCount > 1 ? `Type ${menuCount} paths in terminal` : "Open in terminal"}
    </button>

    <div class="my-1 h-px bg-zinc-800"></div>

    <button
      class="menu-item"
      onclick={() => act(() => startNaming({ kind: "file", dir: containingDir(entry), value: "" }))}
    >
      New file…
    </button>
    <button
      class="menu-item"
      onclick={() => act(() => startNaming({ kind: "folder", dir: containingDir(entry), value: "" }))}
    >
      New folder…
    </button>

    <div class="my-1 h-px bg-zinc-800"></div>

    <button class="menu-item flex items-center" disabled={!undoLabel} onclick={() => act(() => void undo())}>
      <span class={undoLabel ? "" : "text-zinc-600"}>
        {undoLabel ? `Undo ${undoLabel}` : "Nothing to undo"}
      </span>
      <span class="ml-auto text-[10px] text-zinc-600">Ctrl+Z</span>
    </button>
    <button class="menu-item flex items-center" disabled={!redoLabel} onclick={() => act(() => void redo())}>
      <span class={redoLabel ? "" : "text-zinc-600"}>
        {redoLabel ? `Redo ${redoLabel}` : "Nothing to redo"}
      </span>
      <span class="ml-auto text-[10px] text-zinc-600">Ctrl+Y</span>
    </button>

    <div class="my-1 h-px bg-zinc-800"></div>

    <button class="menu-item flex items-center" onclick={() => act(() => copyToClipboard(menuPaths(entry), "cut"))}>
      <span>Cut{suffix}</span>
      <span class="ml-auto text-[10px] text-zinc-600">Ctrl+X</span>
    </button>
    <button class="menu-item flex items-center" onclick={() => act(() => copyToClipboard(menuPaths(entry), "copy"))}>
      <span>Copy{suffix}</span>
      <span class="ml-auto text-[10px] text-zinc-600">Ctrl+C</span>
    </button>
    <button
      class="menu-item flex items-center"
      disabled={!$treeClipboard}
      onclick={() => act(() => void paste(containingDir(entry)))}
    >
      <span class={$treeClipboard ? "" : "text-zinc-600"}>
        Paste{$treeClipboard && $treeClipboard.paths.length > 1 ? ` ${$treeClipboard.paths.length} items` : ""}
        {entry.isDir ? "into folder" : ""}
      </span>
      <span class="ml-auto text-[10px] text-zinc-600">Ctrl+V</span>
    </button>

    {#if menuCount === 1}
      <button
        class="menu-item"
        onclick={() => act(() => startNaming({ kind: "rename", path: entry.path, value: entry.name }))}
      >
        Rename…
      </button>
    {/if}
    <button
      class="menu-item flex items-center text-red-400"
      onclick={() => act(() => void deleteSelection(menuPaths(entry)))}
      title="Permanent — this cannot be undone"
    >
      <span>Delete{suffix}…</span>
      <span class="ml-auto text-[10px] text-zinc-600">Del</span>
    </button>

    <div class="my-1 h-px bg-zinc-800"></div>

    <button
      class="menu-item"
      onclick={() => act(() => navigator.clipboard.writeText(menuPaths(entry).map(absolutePath).join("\n")))}
    >
      Copy path{suffix ? "s" : ""}
    </button>
    <button
      class="menu-item"
      onclick={() => act(() => navigator.clipboard.writeText(menuPaths(entry).join("\n")))}
    >
      Copy relative path{suffix ? "s" : ""}
    </button>
    <button class="menu-item" onclick={() => act(() => ipc.revealInFileManager(entry.path))}>
      Reveal in file manager
    </button>
    {#if hasChanges}
      <button class="menu-item" onclick={() => act(() => highlightedChange.set(entry.path))}>
        Show in Changes
      </button>
    {/if}
  </div>
{/if}

{#if rootMenu}
  <!-- The empty space below the rows is the project root, so a right-click
       there offers exactly the actions that need no entry to act on: what to
       create in the root, what to paste into it, and what to undo. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed z-50 w-52 rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
    style="left: {rootMenu.x}px; top: {rootMenu.y}px"
    onpointerdown={(e) => e.stopPropagation()}
  >
    <button class="menu-item flex items-center" disabled={!undoLabel} onclick={() => act(() => void undo())}>
      <span class={undoLabel ? "" : "text-zinc-600"}>
        {undoLabel ? `Undo ${undoLabel}` : "Nothing to undo"}
      </span>
      <span class="ml-auto text-[10px] text-zinc-600">Ctrl+Z</span>
    </button>
    <button class="menu-item flex items-center" disabled={!redoLabel} onclick={() => act(() => void redo())}>
      <span class={redoLabel ? "" : "text-zinc-600"}>
        {redoLabel ? `Redo ${redoLabel}` : "Nothing to redo"}
      </span>
      <span class="ml-auto text-[10px] text-zinc-600">Ctrl+Y</span>
    </button>

    <div class="my-1 h-px bg-zinc-800"></div>

    <button class="menu-item" onclick={() => act(() => startNaming({ kind: "file", dir: "", value: "" }))}>
      New file…
    </button>
    <button class="menu-item" onclick={() => act(() => startNaming({ kind: "folder", dir: "", value: "" }))}>
      New folder…
    </button>
    <button class="menu-item flex items-center" disabled={!$treeClipboard} onclick={() => act(() => void paste(""))}>
      <span class={$treeClipboard ? "" : "text-zinc-600"}>
        Paste{$treeClipboard && $treeClipboard.paths.length > 1
          ? ` ${$treeClipboard.paths.length} items`
          : ""} here
      </span>
      <span class="ml-auto text-[10px] text-zinc-600">Ctrl+V</span>
    </button>

    <div class="my-1 h-px bg-zinc-800"></div>

    <button
      class="menu-item"
      onclick={() => act(() => (selection = new Set(rows.map((r) => r.entry.path))))}
    >
      Select all
    </button>
    <button class="menu-item" onclick={() => act(() => collapseAll())}>Collapse all folders</button>
    <button class="menu-item" onclick={() => act(() => void reload())}>Refresh</button>
  </div>
{/if}

{#if naming}
  {@const pending = naming}
  <!-- The backdrop dismisses, and it is the only click target: testing
       `e.target` rather than stopping propagation inside the panel keeps the
       dialog itself free of handlers it has no use for. -->
  <div
    role="presentation"
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-32"
    onclick={(e) => { if (e.target === e.currentTarget) naming = null; }}
  >
    <div
      role="dialog"
      aria-modal="true"
      class="w-80 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-2xl"
    >
      <h3 class="mb-1 text-xs font-semibold text-zinc-200">
        {pending.kind === "rename"
          ? "Rename"
          : pending.kind === "folder"
            ? "New folder"
            : "New file"}
      </h3>
      <p class="mb-2 truncate font-mono text-[10px] text-zinc-500">
        {pending.kind === "rename" ? pending.path : `${pending.dir || "."}/`}
      </p>
      <input
        bind:this={nameEl}
        class="h-7 w-full rounded border border-zinc-700 bg-zinc-950 px-2 font-mono text-[11px] text-zinc-100 focus:border-emerald-600 focus:outline-none"
        spellcheck="false"
        bind:value={pending.value}
        onkeydown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void submitName(); }
          else if (e.key === "Escape") { e.preventDefault(); naming = null; }
        }}
      />
      <div class="mt-2 flex justify-end gap-2">
        <button
          class="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"
          onclick={() => (naming = null)}
        >Cancel</button>
        <button
          class="rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          disabled={!pending.value.trim()}
          onclick={() => void submitName()}
        >{pending.kind === "rename" ? "Rename" : "Create"}</button>
      </div>
    </div>
  </div>
{/if}
