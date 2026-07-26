<script lang="ts">
  import {
    tabs,
    activeTabId,
    switchTab,
    newTab,
    closeTab,
    renameTab,
    reorderTab,
    movePaneToTab,
    movePaneToNewTab,
    draggedPaneId,
    draggedTabId,
    tabsWithAttention,
  } from "../stores";
  import type { Tab } from "../types";

  let editingId = $state<string | null>(null);
  let draft = $state("");
  /** Insertion slot for a tab drag: index in the pre-move list, or null. */
  let dropIndex = $state<number | null>(null);
  /** Tab highlighted as the destination of a dragged pane. */
  let paneTargetId = $state<string | null>(null);
  /** True while a dragged pane hovers the "+" button (drop = new tab). */
  let paneToNewTab = $state(false);
  let menu = $state<{ id: string; x: number; y: number } | null>(null);

  // Spring-loaded tabs: hovering one with a pane in hand switches to it, so the
  // pane can then be dropped on an exact position inside that tab's grid.
  let springTimer: ReturnType<typeof setTimeout> | undefined;

  // The bar hides itself for a single tab, but must appear while a pane is in
  // flight so it can be dropped onto another tab (or torn off into a new one).
  const visible = $derived($tabs.length > 1 || !!$draggedPaneId);

  function startRename(id: string, title: string) {
    menu = null;
    editingId = id;
    draft = title;
  }

  function commitRename() {
    if (editingId) renameTab(editingId, draft);
    editingId = null;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") commitRename();
    else if (e.key === "Escape") editingId = null;
  }

  function onTabPointerDown(e: MouseEvent, id: string) {
    // Middle click closes, matching browser/terminal convention.
    if (e.button === 1) {
      e.preventDefault();
      closeTab(id);
    }
  }

  function openMenu(e: MouseEvent, id: string) {
    e.preventDefault();
    menu = { id, x: e.clientX, y: e.clientY };
  }

  function closeOthers(id: string) {
    menu = null;
    for (const t of $tabs) if (t.id !== id) closeTab(t.id);
  }

  function springLoad(id: string) {
    clearTimeout(springTimer);
    if (id === $activeTabId) return;
    springTimer = setTimeout(() => switchTab(id), 550);
  }

  function cancelSpring() {
    clearTimeout(springTimer);
  }

  function onTabDragStart(e: DragEvent, id: string) {
    draggedTabId.set(id);
    e.dataTransfer?.setData("text/tab", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function onTabDragEnd() {
    draggedTabId.set(null);
    dropIndex = null;
    paneTargetId = null;
    cancelSpring();
  }

  function onDragEndAnywhere() {
    cancelSpring();
    dropIndex = null;
    paneTargetId = null;
    paneToNewTab = false;
    draggedTabId.set(null);
    draggedPaneId.set(null);
  }

  function onTabDragOver(e: DragEvent, tab: Tab, i: number) {
    if ($draggedTabId) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      dropIndex = e.clientX > rect.left + rect.width / 2 ? i + 1 : i;
    } else if ($draggedPaneId) {
      e.preventDefault();
      if (paneTargetId !== tab.id) {
        paneTargetId = tab.id;
        springLoad(tab.id);
      }
    }
  }

  function onTabDragLeave(e: DragEvent, tab: Tab) {
    const related = e.relatedTarget as HTMLElement | null;
    const target = e.currentTarget as HTMLElement;
    if (related && target.contains(related)) return;
    if (paneTargetId === tab.id) {
      paneTargetId = null;
      cancelSpring();
    }
  }

  function onTabDrop(e: DragEvent, tab: Tab, i: number) {
    e.preventDefault();
    cancelSpring();
    const tabId = $draggedTabId;
    const paneId = $draggedPaneId;
    const slot = dropIndex;
    dropIndex = null;
    paneTargetId = null;
    if (tabId) {
      reorderTab(tabId, slot ?? i);
      draggedTabId.set(null);
    } else if (paneId) {
      movePaneToTab(paneId, tab.id);
      draggedPaneId.set(null);
    }
  }

  function onPlusDragOver(e: DragEvent) {
    if (!$draggedPaneId && !$draggedTabId) return;
    e.preventDefault();
    if ($draggedTabId) dropIndex = $tabs.length;
    else paneToNewTab = true;
  }

  function onPlusDrop(e: DragEvent) {
    e.preventDefault();
    paneToNewTab = false;
    const tabId = $draggedTabId;
    const paneId = $draggedPaneId;
    const slot = dropIndex;
    dropIndex = null;
    if (tabId) {
      reorderTab(tabId, slot ?? $tabs.length);
      draggedTabId.set(null);
    } else if (paneId) {
      movePaneToNewTab(paneId);
      draggedPaneId.set(null);
    }
  }
</script>

<!-- A spring-loaded switch unmounts the dragged pane, so its own `dragend` may
     never fire; clear the drag state globally to avoid a stuck drag. -->
<svelte:window
  onclick={() => (menu = null)}
  ondragend={onDragEndAnywhere}
  ondrop={onDragEndAnywhere}
/>

{#if visible}
  <div class="flex h-9 shrink-0 items-stretch overflow-hidden border-b border-zinc-800 bg-zinc-950">
    {#each $tabs as tab, i (tab.id)}
      {@const active = tab.id === $activeTabId}
      {@const ringing = $tabsWithAttention.has(tab.id)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="group relative flex h-full min-w-0 max-w-52 flex-1 cursor-pointer items-center gap-2 border-r border-zinc-800 px-3 text-xs transition-colors
          {active
            ? 'bg-zinc-900 text-emerald-400'
            : 'text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-300'}
          {$draggedTabId === tab.id ? 'opacity-40' : ''}
          {paneTargetId === tab.id ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-400' : ''}
          {ringing ? 'bell-pulse-tab' : ''}"
        draggable={editingId !== tab.id}
        onclick={() => switchTab(tab.id)}
        ondblclick={() => startRename(tab.id, tab.title)}
        onmousedown={(e) => onTabPointerDown(e, tab.id)}
        oncontextmenu={(e) => openMenu(e, tab.id)}
        ondragstart={(e) => onTabDragStart(e, tab.id)}
        ondragend={onTabDragEnd}
        ondragover={(e) => onTabDragOver(e, tab, i)}
        ondragleave={(e) => onTabDragLeave(e, tab)}
        ondrop={(e) => onTabDrop(e, tab, i)}
        title={tab.title}
      >
        {#if active}
          <span class="absolute inset-x-0 bottom-0 h-0.5 bg-emerald-400"></span>
        {/if}
        {#if dropIndex === i}
          <span class="pointer-events-none absolute inset-y-1 left-0 z-10 w-0.5 rounded bg-emerald-400"></span>
        {:else if dropIndex === i + 1}
          <span class="pointer-events-none absolute inset-y-1 right-0 z-10 w-0.5 rounded bg-emerald-400"></span>
        {/if}
        {#if editingId === tab.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="min-w-0 flex-1 rounded-sm bg-zinc-800 px-1 text-xs text-zinc-100 outline-none ring-1 ring-emerald-500/50"
            bind:value={draft}
            autofocus
            onclick={(e) => e.stopPropagation()}
            onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
            onblur={commitRename}
            onkeydown={onKey}
          />
        {:else}
          {#if ringing}
            <span class="h-1.5 w-1.5 shrink-0 rounded-full glow-warn"></span>
          {/if}
          <span class="min-w-0 flex-1 truncate">{tab.title}</span>
        {/if}
        <button
          class="shrink-0 rounded-sm px-1 text-zinc-600 opacity-0 hover:bg-red-900/50 hover:text-red-300 group-hover:opacity-100 {active ? 'opacity-70' : ''}"
          title="Close tab"
          onclick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
        >✕</button>
      </div>
    {/each}
    <button
      class="relative flex w-9 shrink-0 items-center justify-center text-lg text-zinc-600 hover:bg-zinc-900 hover:text-emerald-400
        {paneToNewTab ? 'bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-400' : ''}"
      title={$draggedPaneId ? "Move pane to a new tab" : "New tab"}
      onclick={newTab}
      ondragover={onPlusDragOver}
      ondragleave={() => (paneToNewTab = false)}
      ondrop={onPlusDrop}
    >
      {#if dropIndex === $tabs.length}
        <span class="pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded bg-emerald-400"></span>
      {/if}
      +
    </button>
  </div>
{/if}

{#if menu}
  {@const target = menu}
  <div
    class="fixed z-50 min-w-40 rounded-md border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl"
    style="left: {target.x}px; top: {target.y}px"
  >
    <button
      class="block w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800 hover:text-emerald-400"
      onclick={() => startRename(target.id, $tabs.find((t) => t.id === target.id)?.title ?? "")}
    >Rename…</button>
    <button
      class="block w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800 hover:text-emerald-400 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-300"
      disabled={$tabs.length <= 1}
      onclick={() => closeOthers(target.id)}
    >Close other tabs</button>
    <button
      class="block w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-red-900/50 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-300"
      disabled={$tabs.length <= 1}
      onclick={() => { const id = target.id; menu = null; closeTab(id); }}
    >Close tab</button>
  </div>
{/if}
