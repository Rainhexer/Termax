<script lang="ts">
  import type { PaneNode } from "../types";
  import { attach, fitPane, focusTerminal, loadingPanes } from "../terminals";
  import { activeProject, focusedPaneId, closePane, addPane, movePane } from "../stores";

  let { pane }: { pane: PaneNode } = $props();
  let host: HTMLDivElement;
  let dragOver = $state(false);

  const focused = $derived($focusedPaneId === pane.id);
  const loading = $derived(pane.launch && $loadingPanes.has(pane.id));

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const fromId = e.dataTransfer?.getData("text/pane");
    if (fromId) movePane(fromId, pane.id);
  }

  function focus() {
    focusedPaneId.set(pane.id);
    focusTerminal(pane.id);
  }

  // Re-runs whenever pane.id changes (e.g. after a drag-swap), moving the
  // correct persistent terminal element into this host.
  $effect(() => {
    const id = pane.id;
    attach(id, host, $activeProject?.path ?? ".", pane.launch);
    const ro = new ResizeObserver(() => fitPane(id));
    ro.observe(host);
    return () => ro.disconnect();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div
  class="flex h-full w-full min-w-0 min-h-0 flex-col overflow-hidden rounded-lg border bg-[#131316] transition-colors
    {dragOver ? 'border-emerald-400' : focused ? 'border-emerald-500/60' : 'border-zinc-800'}"
  onmousedown={focus}
  ondragover={(e) => { e.preventDefault(); dragOver = true; }}
  ondragleave={() => (dragOver = false)}
  ondrop={onDrop}
>
  <div
    class="flex h-7 shrink-0 cursor-grab items-center gap-1 border-b border-zinc-800 bg-zinc-900/80 px-2 active:cursor-grabbing"
    draggable="true"
    ondragstart={(e) => e.dataTransfer?.setData("text/pane", pane.id)}
  >
    <span class="truncate text-[11px] font-medium {focused ? 'text-emerald-400' : 'text-zinc-400'}">
      {pane.title}
    </span>
    <div class="ml-auto flex items-center gap-0.5">
      <button
        class="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Split right"
        onclick={(e) => { e.stopPropagation(); focusedPaneId.set(pane.id); addPane(null, "shell", "row"); }}
      >◨</button>
      <button
        class="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Split down"
        onclick={(e) => { e.stopPropagation(); focusedPaneId.set(pane.id); addPane(null, "shell", "col"); }}
      >⬓</button>
      <button
        class="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-red-900/50 hover:text-red-300"
        title="Close pane"
        onclick={(e) => { e.stopPropagation(); closePane(pane.id); }}
      >✕</button>
    </div>
  </div>
  <div class="relative min-h-0 flex-1">
    <div class="h-full w-full p-1.5" bind:this={host}></div>
    {#if loading}
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#131316]/80">
        <div class="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400"></div>
        <span class="text-xs text-zinc-400">Starting {pane.title}…</span>
      </div>
    {/if}
  </div>
</div>
