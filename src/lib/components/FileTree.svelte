<script lang="ts">
  import {
    activeProject,
    changes,
    explorerLocked,
    focusedPaneId,
    fsTick,
    highlightedChange,
    layout,
    lockFlash,
    openFile,
  } from "../stores";
  import {
    buildBadges,
    collapseAllUnder,
    refreshTree,
    treeChildren,
  } from "../filetree";
  import { collectPanes } from "../layout";
  import { typeInPane } from "../terminals";
  import { ipc } from "../ipc";
  import type { TreeEntry } from "../types";
  import FileTreeNode from "./FileTreeNode.svelte";

  let open = $state(true);
  let menu = $state<{ x: number; y: number; entry: TreeEntry } | null>(null);

  const root = $derived($treeChildren.get("") ?? []);
  const badges = $derived(buildBadges($changes));

  // Re-fetch the root and expanded dirs whenever the debounced watcher fires.
  $effect(() => {
    $fsTick;
    refreshTree();
  });

  $effect(() => {
    if (!menu) return;
    function close() {
      menu = null;
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

  function openMenu(e: MouseEvent, entry: TreeEntry) {
    menu = {
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 220),
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

  function absolutePath(entry: TreeEntry): string {
    return `${$activeProject?.path ?? ""}/${entry.path}`;
  }

  function openInTerminal(entry: TreeEntry) {
    const paneId = $focusedPaneId;
    if (!paneId) return;
    const pane = collectPanes($layout).find((p) => p.id === paneId);
    if (!pane || pane.kind === "editor") return;
    typeInPane(paneId, entry.path);
  }

  function act(fn: () => void) {
    fn();
    menu = null;
  }
</script>

<div class="flex min-h-0 flex-col gap-1">
  <div class="flex items-center gap-1 px-1">
    <button
      class="flex items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
      onclick={() => (open = !open)}
    >
      <span class="text-[9px]">{open ? "▼" : "▶"}</span>
      Explorer
    </button>
    <button
      class="flex h-4 w-4 items-center justify-center rounded transition-all duration-200 {$explorerLocked
        ? 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-400'
        : 'text-emerald-400 hover:bg-zinc-800'}
        {flashing ? 'text-red-500 scale-125' : ''}"
      title={$explorerLocked ? "Unlock: allow editing in file panels" : "Lock: file panels read-only"}
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

  {#if open}
    <div class="max-h-72 min-h-0 overflow-y-auto">
      {#if root.length === 0}
        <p class="px-1 text-[11px] text-zinc-600">Empty directory.</p>
      {:else}
        {#each root as entry (entry.path)}
          <FileTreeNode {entry} fileBadges={badges.files} dirCounts={badges.dirCounts} onmenu={openMenu} />
        {/each}
      {/if}
    </div>
  {/if}
</div>

{#if menu}
  {@const entry = menu.entry}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed z-50 w-48 rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
    style="left: {menu.x}px; top: {menu.y}px"
    onpointerdown={(e) => e.stopPropagation()}
  >
    {#if entry.isDir}
      <button class="menu-item" onclick={() => act(() => collapseAllUnder(entry.path))}>
        Collapse all children
      </button>
      <button class="menu-item" onclick={() => act(() => navigator.clipboard.writeText(absolutePath(entry)))}>
        Copy path
      </button>
      <button class="menu-item" onclick={() => act(() => ipc.revealInFileManager(entry.path))}>
        Reveal in file manager
      </button>
    {:else}
      <button class="menu-item" onclick={() => act(() => openFile(entry.path))}>
        Open
      </button>
      <button class="menu-item" onclick={() => act(() => openInTerminal(entry))}>
        Open in terminal
      </button>
      <div class="my-1 h-px bg-zinc-800"></div>
      <button class="menu-item" onclick={() => act(() => navigator.clipboard.writeText(absolutePath(entry)))}>
        Copy path
      </button>
      <button class="menu-item" onclick={() => act(() => navigator.clipboard.writeText(entry.path))}>
        Copy relative path
      </button>
      <div class="my-1 h-px bg-zinc-800"></div>
      <button class="menu-item" onclick={() => act(() => ipc.revealInFileManager(entry.path))}>
        Reveal in file manager
      </button>
      {#if hasChanges}
        <button class="menu-item" onclick={() => act(() => highlightedChange.set(entry.path))}>
          Show in Changes
        </button>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .menu-item {
    display: block;
    width: 100%;
    padding: 0.3rem 0.75rem;
    text-align: left;
    font-size: 0.75rem;
    color: var(--color-zinc-200, #e4e4e7);
  }
  .menu-item:hover {
    background: var(--color-zinc-800, #27272a);
  }
</style>
