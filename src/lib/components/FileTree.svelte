<script lang="ts">
  import { ask } from "@tauri-apps/plugin-dialog";
  import {
    activeProject,
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
    expandTo,
    expandedDirs,
    flattenTree,
    refreshTree,
    refreshTreeSearch,
    setTreeQuery,
    toggleDir,
    treeChildren,
    treeMatches,
    treeQuery,
    treeSearching,
  } from "../filetree";
  import type { TreeRow } from "../filetree";
  import { collectPanes } from "../layout";
  import { enabledLaunchers, settings } from "../settings";
  import type { Launcher } from "../settings";
  import { queueType, typeInPane } from "../terminals";
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
  /** Whether the context menu's agent list is showing. */
  let agentsOpen = $state(false);
  /** Path of the row the keyboard and the context menu act on. */
  let selected = $state<string | null>(null);
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

  // Re-fetch the root and expanded dirs whenever the debounced watcher fires.
  $effect(() => {
    $fsTick;
    refreshTree();
  });

  $effect(() => {
    if (!menu) return;
    function close() {
      menu = null;
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

  function openMenu(e: MouseEvent, entry: TreeEntry) {
    agentsOpen = false;
    menu = {
      x: Math.min(e.clientX, window.innerWidth - 220),
      // Roughly the menu's own height, so a right-click near the bottom of the
      // window opens a menu that is fully on screen rather than clipped.
      y: Math.min(e.clientY, Math.max(8, window.innerHeight - 420)),
      entry,
    };
  }

  const hasChanges = $derived(menu ? badges.files.has(menu.entry.path) : false);

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

  function absolutePath(path: string): string {
    return `${$activeProject?.path ?? ""}/${path}`;
  }

  /** The folder an action lands in: a directory itself, or a file's parent. */
  function containingDir(entry: TreeEntry): string {
    if (entry.isDir) return entry.path;
    const cut = entry.path.lastIndexOf("/");
    return cut < 0 ? "" : entry.path.slice(0, cut);
  }

  /** Put the path on the focused terminal's prompt. Typed, not run — a folder
   *  is prefixed with `cd `, since that is the only thing anyone means by
   *  "open this folder in the terminal", and the user still presses Enter. */
  function openInTerminal(entry: TreeEntry) {
    const paneId = $focusedPaneId;
    if (!paneId) return;
    const pane = collectPanes($layout).find((p) => p.id === paneId);
    if (!pane || pane.kind === "editor") return;
    const path = /\s/.test(entry.path) ? `"${entry.path}"` : entry.path;
    typeInPane(paneId, entry.isDir ? `cd ${path}` : path);
  }

  /** Open a fresh pane running `launcher` and hand it the path.
   *
   *  Typed, never executed: the path is the start of a sentence the user is
   *  about to finish ("…refactor this"), and the agent is still booting when
   *  this is called, which is why the text is queued rather than written — see
   *  `flushPending` in terminals.ts. */
  function openWithAgent(launcher: Launcher, entry: TreeEntry) {
    const paneId = addPane(launcher.command, launcher.name);
    const path = /\s/.test(entry.path) ? `"${entry.path}"` : entry.path;
    queueType(paneId, `${path} `);
  }

  /** Editor panes showing a path that no longer exists, closed.
   *  Deleting a file out from under a pane leaves it displaying a buffer of
   *  something that is gone, which the next save would recreate. */
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
        const to = await ipc.renameEntry(pending.path, name);
        closePanesUnder(pending.path);
        selected = to;
      } else {
        const created = await ipc.createEntry(pending.dir, name, pending.kind === "folder");
        await expandTo(created);
        selected = created;
        if (pending.kind === "file") openFile(created);
      }
      await reload();
    } catch (err) {
      error = String(err);
    }
  }

  async function deleteEntry(entry: TreeEntry) {
    if (!unlocked()) return;
    const what = entry.isDir ? "folder" : "file";
    const extra = entry.isDir ? "\n\nEverything inside it goes too." : "";
    const ok = await ask(
      `Permanently delete this ${what}?\n\n${entry.path}${extra}\n\nThis cannot be undone — it does not go to the trash.`,
      { title: `Delete ${what}?`, kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" },
    );
    if (!ok) return;
    try {
      await ipc.deleteEntry(entry.path);
      closePanesUnder(entry.path);
      if (selected === entry.path) selected = null;
      error = null;
    } catch (err) {
      error = String(err);
    }
    await reload();
  }

  /** Open a search hit in the tree: leave the tree expanded at it, and drop
   *  the query so the user lands back in the structure they were browsing. */
  async function revealHit(entry: TreeEntry) {
    setTreeQuery("");
    await expandTo(entry.path);
    selected = entry.path;
    if (entry.isDir) await toggleDir(entry.path);
  }

  function activate(entry: TreeEntry) {
    selected = entry.path;
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
    selected = entry.path;
    if (isSearch) {
      void revealHit(entry);
      return;
    }
    if (entry.isDir) void toggleDir(entry.path);
  }

  /** Keep the keyboard cursor on screen without scrolling the sidebar around
   *  the mouse: `nearest` moves only when the row is actually out of view. */
  function scrollToSelected() {
    requestAnimationFrame(() => {
      const index = rows.findIndex((r) => r.entry.path === selected);
      if (index < 0) return;
      listEl?.querySelectorAll<HTMLElement>('[role="treeitem"]')[index]?.scrollIntoView({
        block: "nearest",
      });
    });
  }

  function move(delta: number) {
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r.entry.path === selected);
    const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : at + delta;
    selected = rows[Math.min(rows.length - 1, Math.max(0, next))].entry.path;
    scrollToSelected();
  }

  function selectedEntry(): TreeEntry | null {
    return rows.find((r) => r.entry.path === selected)?.entry ?? null;
  }

  function onKeydown(e: KeyboardEvent) {
    if (naming) return;
    const entry = selectedEntry();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
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
        const parent = containingDir(entry);
        if (!entry.isDir && parent) selected = parent;
        else if (entry.isDir && entry.path.includes("/")) {
          selected = entry.path.slice(0, entry.path.lastIndexOf("/"));
        }
        scrollToSelected();
        return;
      }
      case "Enter":
        if (!entry) return;
        e.preventDefault();
        if (entry.isDir) toggle(entry);
        else activate(entry);
        return;
      case "Delete":
        if (!entry) return;
        e.preventDefault();
        void deleteEntry(entry);
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
        selected = null;
        return;
    }
  }

  /** Where a header "New…" button puts things: beside the selection, or at the
   *  root when nothing is selected. */
  function newTarget(): string {
    const entry = selectedEntry();
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
            if (!selected) move(1);
            else if (e.key === "Enter") {
              const entry = selectedEntry();
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

    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div
      bind:this={listEl}
      role="tree"
      tabindex="-1"
      class="min-h-0 overflow-y-auto outline-none {fill ? 'flex-1' : 'max-h-72'}"
      onkeydown={onKeydown}
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
            selected={selected === row.entry.path}
            badge={row.entry.isDir ? null : (badges.files.get(row.entry.path) ?? null)}
            count={row.entry.isDir ? (badges.dirCounts.get(row.entry.path) ?? 0) : 0}
            showDir={isSearch}
            onactivate={activate}
            ontoggle={toggle}
            onselect={(entry) => (selected = entry.path)}
            onmenu={openMenu}
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
        <span class={agents.length === 0 ? "text-zinc-600" : ""}>Open with agent</span>
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

    {#if !entry.isDir}
      <button class="menu-item" onclick={() => act(() => void ipc.openInDefaultApp(entry.path).catch((err) => (error = String(err))))}>
        Open in default app
      </button>
    {/if}
    <button class="menu-item" onclick={() => act(() => openInTerminal(entry))}>
      Open in terminal
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
    <button
      class="menu-item"
      onclick={() => act(() => startNaming({ kind: "rename", path: entry.path, value: entry.name }))}
    >
      Rename…
    </button>
    <button class="menu-item text-red-400" onclick={() => act(() => void deleteEntry(entry))}>
      Delete…
    </button>

    <div class="my-1 h-px bg-zinc-800"></div>

    <button class="menu-item" onclick={() => act(() => navigator.clipboard.writeText(absolutePath(entry.path)))}>
      Copy path
    </button>
    <button class="menu-item" onclick={() => act(() => navigator.clipboard.writeText(entry.path))}>
      Copy relative path
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
