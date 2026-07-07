<script lang="ts">
  import type { PaneNode } from "../types";
  import { attach, fitPane, focusTerminal, loadingPanes } from "../terminals";
  import { activeProject, focusedPaneId, closePane, addPane, movePane, splitPaneAt, draggedPaneId } from "../stores";

  type DropZone = "top" | "bottom" | "left" | "right" | "center";

  let { pane }: { pane: PaneNode } = $props();
  let host: HTMLDivElement;
  let self: HTMLDivElement;
  let currentZone = $state<DropZone | null>(null);

  const focused = $derived($focusedPaneId === pane.id);
  const loading = $derived(pane.launch && $loadingPanes.has(pane.id));

  function getDropZone(e: DragEvent): DropZone | null {
    const rect = self.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const edge = 0.25;
    if (y < edge) return "top";
    if (y > 1 - edge) return "bottom";
    if (x < edge) return "left";
    if (x > 1 - edge) return "right";
    return "center";
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    const zone = getDropZone(e);
    if (zone) currentZone = zone;
  }

  function onDragLeave(e: DragEvent) {
    const target = e.currentTarget as HTMLElement;
    const related = e.relatedTarget as HTMLElement | null;
    if (!related || !target.contains(related)) {
      currentZone = null;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    const fromId = e.dataTransfer?.getData("text/pane") ?? $draggedPaneId;
    const zone = currentZone;
    currentZone = null;
    draggedPaneId.set(null);
    if (!fromId) return;

    if (zone === "center") {
      movePane(fromId, pane.id);
    } else if (zone === "left") {
      splitPaneAt(fromId, pane.id, "row", true);
    } else if (zone === "right") {
      splitPaneAt(fromId, pane.id, "row", false);
    } else if (zone === "top") {
      splitPaneAt(fromId, pane.id, "col", true);
    } else if (zone === "bottom") {
      splitPaneAt(fromId, pane.id, "col", false);
    }
  }

  function focus() {
    focusedPaneId.set(pane.id);
    focusTerminal(pane.id);
  }

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
  bind:this={self}
  class="relative flex h-full w-full min-w-0 min-h-0 flex-col overflow-hidden rounded-lg border bg-[#131316] transition-colors
    {currentZone && currentZone !== 'center' ? 'border-emerald-400' : focused ? 'border-emerald-500/60' : 'border-zinc-800'}"
  onmousedown={focus}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  {#if currentZone && currentZone !== "center"}
    <div class="pointer-events-none absolute inset-0 z-10 rounded-lg bg-emerald-500/5"></div>
    {#if currentZone === "top"}
      <div class="pointer-events-none absolute inset-x-3 top-0 z-10 h-[3px] rounded-t bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.4)]"></div>
    {:else if currentZone === "bottom"}
      <div class="pointer-events-none absolute inset-x-3 bottom-0 z-10 h-[3px] rounded-b bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.4)]"></div>
    {:else if currentZone === "left"}
      <div class="pointer-events-none absolute inset-y-3 left-0 z-10 w-[3px] rounded-l bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.4)]"></div>
    {:else if currentZone === "right"}
      <div class="pointer-events-none absolute inset-y-3 right-0 z-10 w-[3px] rounded-r bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.4)]"></div>
    {/if}
  {/if}
  <div
    class="flex h-7 shrink-0 cursor-grab items-center gap-1 border-b border-zinc-800 bg-zinc-900/80 px-2 active:cursor-grabbing"
    draggable="true"
    ondragstart={(e) => { e.dataTransfer?.setData("text/pane", pane.id); draggedPaneId.set(pane.id); }}
    ondragend={() => draggedPaneId.set(null)}
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
