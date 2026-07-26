<script lang="ts">
  import type { PaneNode } from "../types";
  import { attach, detach, fitPane, focusTerminal, loadingPanes, fileDropPaneId } from "../terminals";
  import { activeProject, focusedPaneId, closePane, addPane, movePane, splitPaneAt, draggedPaneId, maximizedPaneId, toggleMaximizedPane, togglePaneBell } from "../stores";
  import { attentionPanes, clearAttention, previewChime } from "../bell";

  type DropZone = "top" | "bottom" | "left" | "right" | "center";

  let { pane }: { pane: PaneNode } = $props();
  let host: HTMLDivElement;
  let self: HTMLDivElement;
  let currentZone = $state<DropZone | null>(null);

  const focused = $derived($focusedPaneId === pane.id);
  const fileDropTarget = $derived($fileDropPaneId === pane.id);
  const loading = $derived(pane.launch && $loadingPanes.has(pane.id));
  const ringing = $derived($attentionPanes.has(pane.id));

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
    clearAttention(pane.id);
  }

  $effect(() => {
    const id = pane.id;
    attach(id, host, $activeProject?.path ?? ".", pane.launch);
    const ro = new ResizeObserver(() => fitPane(id));
    ro.observe(host);
    return () => {
      ro.disconnect();
      // This component may be re-run for a different pane id; leave the host
      // empty so the old terminal does not linger under the new one.
      detach(id, host);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div
  bind:this={self}
  data-pane-id={pane.id}
  class="relative flex h-full w-full min-w-0 min-h-0 flex-col overflow-hidden rounded-lg border pane-term-bg transition-colors
    {fileDropTarget || (currentZone && currentZone !== 'center') ? 'border-emerald-400' : focused ? 'border-emerald-500/60' : 'border-zinc-800'}
    {ringing ? 'bell-pulse' : ''}"
  onmousedown={focus}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  {#if fileDropTarget}
    <div class="pointer-events-none absolute inset-0 z-20 rounded-lg bg-emerald-500/10 ring-2 ring-inset ring-emerald-400"></div>
  {/if}
  {#if currentZone && currentZone !== "center"}
    <div class="pointer-events-none absolute inset-0 z-10 rounded-lg bg-emerald-500/5"></div>
    {#if currentZone === "top"}
      <div class="pointer-events-none absolute inset-x-3 top-0 z-10 h-[3px] rounded-t glow-accent"></div>
    {:else if currentZone === "bottom"}
      <div class="pointer-events-none absolute inset-x-3 bottom-0 z-10 h-[3px] rounded-b glow-accent"></div>
    {:else if currentZone === "left"}
      <div class="pointer-events-none absolute inset-y-3 left-0 z-10 w-[3px] rounded-l glow-accent"></div>
    {:else if currentZone === "right"}
      <div class="pointer-events-none absolute inset-y-3 right-0 z-10 w-[3px] rounded-r glow-accent"></div>
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
        class="rounded px-1.5 py-0.5 hover:bg-zinc-800
          {ringing ? 'text-amber-400' : pane.bell ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-200'}"
        title={pane.bell ? "Bell on — chime + pulse when this pane finishes or wants input" : "Notify me when this pane finishes or wants input"}
        onclick={(e) => {
          e.stopPropagation();
          // `pane` is refreshed by the toggle, so read the old state first.
          const wasOn = pane.bell;
          clearAttention(pane.id);
          togglePaneBell(pane.id);
          if (!wasOn) previewChime();
        }}
      >
        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          {#if !pane.bell}
            <path d="M3 3l18 18" />
          {/if}
        </svg>
      </button>
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
        class="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title={$maximizedPaneId === pane.id ? "Restore pane" : "Fullscreen pane"}
        onclick={(e) => { e.stopPropagation(); toggleMaximizedPane(pane.id); }}
      >{$maximizedPaneId === pane.id ? '⤡' : '⛶'}</button>
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
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 pane-term-veil">
        <div class="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400"></div>
        <span class="text-xs text-zinc-400">Starting {pane.title}…</span>
      </div>
    {/if}
  </div>
</div>
