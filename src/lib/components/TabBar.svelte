<script lang="ts">
  /** The subtab row: the tabs of the worktree currently selected above.
   *
   *  Two shapes, one component. `inline` renders as a fragment of the TitleBar's
   *  flex row — the single strip a project with no worktree open has always had.
   *  Otherwise it renders its own thinner strip below the title bar, nested
   *  under the worktree tab it belongs to (see WorktreeBar).
   *
   *  Everything here is scoped to one group: reordering, cycling, "close other
   *  tabs" and the "+" all stay inside the worktree, because leaving it would
   *  change the branch and the files under the user without saying so.
   */
  import {
    activeTabId,
    closeTab,
    collectTabPanes,
    draggedPaneId,
    draggedTabId,
    groupTabs,
    newTab,
    primaryRoot,
    renameTab,
    switchTab,
    tabs,
    tabsWithAttention,
  } from "../stores";
  import { dropTarget, startTabDrag } from "../paneDrag";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { isAlive } from "../terminals";
  import WorktreeChip from "./WorktreeChip.svelte";
  import type { Tab } from "../types";

  let { inline = false }: { inline?: boolean } = $props();

  let editingId = $state<string | null>(null);
  let draft = $state("");
  let menu = $state<{ id: string; x: number; y: number } | null>(null);

  // Drop feedback is derived from the one pointer-driven gesture in paneDrag.ts
  // rather than from per-element dragover/dragleave events; spring-loaded tab
  // switching lives there too, since it needs a timer that actually fires.
  /** Insertion slot for a tab drag: index in the pre-move list of this group. */
  const dropIndex = $derived(
    $draggedTabId && $dropTarget?.kind === "tab"
      ? $dropTarget.slot
      : $draggedTabId && $dropTarget?.kind === "newTab"
        ? $groupTabs.length
        : null,
  );
  /** Tab highlighted as the destination of a dragged pane. */
  const paneTargetId = $derived(
    $draggedPaneId && $dropTarget?.kind === "tab" ? $dropTarget.tabId : null,
  );
  /** True while a dragged pane hovers the "+" button (drop = new tab). */
  const paneToNewTab = $derived(!!$draggedPaneId && $dropTarget?.kind === "newTab");

  // Inline, the strip hides itself for a single tab and appears while a pane is
  // in flight so it can be dropped onto another tab — the minimal look a project
  // with one tab and no worktrees has always had. In the two-row layout it is
  // always shown: it is the only place to add a second tab to a worktree, and a
  // row that disappears at one tab would make that unreachable.
  const visible = $derived(!inline || $groupTabs.length > 1 || !!$draggedPaneId);

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

  /** Panes still running across the given tabs. Closing a tab kills its
   *  terminals outright, and an agent mid-task is exactly what must not vanish
   *  without a word. */
  function runningIn(tabList: Tab[]): number {
    return tabList.flatMap((t) => collectTabPanes(t)).filter((id) => isAlive(id)).length;
  }

  async function confirmClosing(tabList: Tab[], what: string): Promise<boolean> {
    const running = runningIn(tabList);
    if (running === 0) return true;
    return await ask(
      `${what} will stop ${running} running pane${running === 1 ? "" : "s"}.\n\nAnything they haven't saved is lost.`,
      { title: "Close tabs?", kind: "warning", okLabel: "Close anyway", cancelLabel: "Keep open" },
    );
  }

  async function closeOthers(id: string) {
    menu = null;
    // Other tabs *in this worktree*: the menu sits in a row that only shows
    // these, so sweeping up another tree's tabs would be a surprise.
    const others = $groupTabs.filter((t) => t.id !== id);
    if (!others.length) return;
    if (!(await confirmClosing(others, `Closing ${others.length} other tab${others.length === 1 ? "" : "s"}`))) return;
    for (const t of others) closeTab(t.id);
  }

  async function closeOne(id: string) {
    menu = null;
    const tab = $groupTabs.find((t) => t.id === id);
    if (!tab) return;
    if (!(await confirmClosing([tab], "Closing this tab"))) return;
    closeTab(id);
  }

  /** A pane that is alone in its tab is already a tab of its own, so tearing it
   *  off is a no-op that `movePaneToNewTab` silently ignores. The drop target
   *  refuses it (see paneDrag.ts), and the "+" says why. */
  const loneDraggedPane = $derived.by(() => {
    const paneId = $draggedPaneId;
    if (!paneId) return false;
    const owner = $groupTabs.find((t) => collectTabPanes(t).includes(paneId));
    return !!owner && collectTabPanes(owner).length === 1;
  });
</script>

<svelte:window onclick={() => (menu = null)} />

{#snippet strip()}
  {#each $groupTabs as tab, i (tab.id)}
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
      data-tab-id={tab.id}
      onclick={() => switchTab(tab.id)}
      ondblclick={() => startRename(tab.id, tab.title)}
      onmousedown={(e) => onTabPointerDown(e, tab.id)}
      onpointerdown={(e) => { if (editingId !== tab.id) startTabDrag(e, tab.id, tab.title); }}
      oncontextmenu={(e) => openMenu(e, tab.id)}
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
        <!-- Only in the single-strip layout: with the worktree row on screen the
             tree, its branch and its pull request are already named above, and
             repeating them on every subtab is noise. -->
        {#if inline}
          <WorktreeChip root={$primaryRoot} showBranch={false} compact />
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
    title={$draggedPaneId
      ? loneDraggedPane
        ? "This pane is already alone in its tab"
        : "Move pane to a new tab"
      : "New tab in this worktree"}
    data-new-tab
    onclick={() => newTab()}
  >
    {#if dropIndex === $groupTabs.length}
      <span class="pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded bg-emerald-400"></span>
    {/if}
    +
  </button>
{/snippet}

{#if visible}
  {#if inline}
    {@render strip()}
  {:else}
    <!-- Its own strip, shorter and darker than the worktree row above it, so the
         nesting is readable without an indent that would waste the width. -->
    <div class="flex h-7 shrink-0 items-stretch border-b border-zinc-800 bg-zinc-950/60">
      {@render strip()}
      <div class="min-w-0 flex-1"></div>
    </div>
  {/if}
{/if}

{#if menu}
  {@const target = menu}
  {@const others = $groupTabs.length - 1}
  <div
    class="fixed z-50 min-w-40 rounded-md border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl"
    style="left: {target.x}px; top: {target.y}px"
  >
    <button
      class="block w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800 hover:text-emerald-400"
      onclick={() => startRename(target.id, $groupTabs.find((t) => t.id === target.id)?.title ?? "")}
    >Rename…</button>
    <button
      class="block w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800 hover:text-emerald-400 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-300"
      disabled={others < 1}
      title={others < 1 ? "There are no other tabs in this worktree" : "Close every tab in this worktree except this one"}
      onclick={() => closeOthers(target.id)}
    >Close {others} other tab{others === 1 ? "" : "s"}</button>
    <button
      class="block w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-red-900/50 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-300"
      disabled={$tabs.length <= 1}
      title={$tabs.length <= 1 ? "The last tab can't be closed" : "Close this tab"}
      onclick={() => closeOne(target.id)}
    >Close tab</button>
  </div>
{/if}
