<script lang="ts">
  import TilingLayout from "./TilingLayout.svelte";
  import TerminalPane from "./TerminalPane.svelte";
  import EditorPane from "./EditorPane.svelte";
  import type { LayoutNode } from "../types";
  import { resizeSplit, resizeCorner } from "../stores";

  let { node }: { node: LayoutNode } = $props();
  let container: HTMLDivElement | undefined;

  function startDrag(e: PointerEvent) {
    if (node.type !== "split" || !container) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const horizontal = node.dir === "row";
    const splitId = node.id;

    function onMove(ev: PointerEvent) {
      const pos = horizontal
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      resizeSplit(splitId, Math.min(0.9, Math.max(0.1, pos)));
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startCornerDrag(e: PointerEvent, rowSplitId: string, colSplitId: string) {
    if (!container) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = container.getBoundingClientRect();

    function onMove(ev: PointerEvent) {
      const x = (ev.clientX - rect.left) / rect.width;
      const y = (ev.clientY - rect.top) / rect.height;
      resizeCorner(
        rowSplitId, Math.min(0.9, Math.max(0.1, x)),
        colSplitId, Math.min(0.9, Math.max(0.1, y)),
      );
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
</script>

{#if node.type === "pane"}
  {#if node.kind === "editor"}
    <EditorPane pane={node} />
  {:else}
    <TerminalPane pane={node} />
  {/if}
{:else}
  <div
    bind:this={container}
    class="relative flex h-full w-full min-w-0 min-h-0 {node.dir === 'col' ? 'flex-col' : ''}"
  >
    {#if node.dir === "row"}
      {#if node.a.type === "split" && node.a.dir === "col"}
        <div
          class="absolute z-10 w-3 h-3 -ml-1.5 -mt-1.5 bg-emerald-500/40 hover:bg-emerald-500/60 active:bg-emerald-500/80 rounded-sm cursor-nwse-resize"
          style="left: {node.ratio * 100}%; top: {node.a.ratio * 100}%"
          onpointerdown={(e) => startCornerDrag(e, node.id, node.a.id)}
        ></div>
      {/if}
      {#if node.b.type === "split" && node.b.dir === "col"}
        <div
          class="absolute z-10 w-3 h-3 -ml-1.5 -mt-1.5 bg-emerald-500/40 hover:bg-emerald-500/60 active:bg-emerald-500/80 rounded-sm cursor-nwse-resize"
          style="left: {node.ratio * 100}%; top: {node.b.ratio * 100}%"
          onpointerdown={(e) => startCornerDrag(e, node.id, node.b.id)}
        ></div>
      {/if}
    {:else}
      {#if node.a.type === "split" && node.a.dir === "row"}
        <div
          class="absolute z-10 w-3 h-3 -ml-1.5 -mt-1.5 bg-emerald-500/40 hover:bg-emerald-500/60 active:bg-emerald-500/80 rounded-sm cursor-nwse-resize"
          style="left: {node.a.ratio * 100}%; top: {node.ratio * 100}%"
          onpointerdown={(e) => startCornerDrag(e, node.a.id, node.id)}
        ></div>
      {/if}
      {#if node.b.type === "split" && node.b.dir === "row"}
        <div
          class="absolute z-10 w-3 h-3 -ml-1.5 -mt-1.5 bg-emerald-500/40 hover:bg-emerald-500/60 active:bg-emerald-500/80 rounded-sm cursor-nwse-resize"
          style="left: {node.b.ratio * 100}%; top: {node.ratio * 100}%"
          onpointerdown={(e) => startCornerDrag(e, node.b.id, node.id)}
        ></div>
      {/if}
    {/if}
    <div class="min-w-0 min-h-0" style="flex: {node.ratio} 1 0%">
      <TilingLayout node={node.a} />
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="shrink-0 bg-transparent hover:bg-emerald-500/40 active:bg-emerald-500/60 transition-colors
        {node.dir === 'row' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'}"
      onpointerdown={startDrag}
    ></div>
    <div class="min-w-0 min-h-0" style="flex: {1 - node.ratio} 1 0%">
      <TilingLayout node={node.b} />
    </div>
  </div>
{/if}
