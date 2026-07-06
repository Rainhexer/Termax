<script lang="ts">
  import TilingLayout from "./TilingLayout.svelte";
  import TerminalPane from "./TerminalPane.svelte";
  import EditorPane from "./EditorPane.svelte";
  import type { LayoutNode } from "../types";
  import { resizeSplit } from "../stores";

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
    class="flex h-full w-full min-w-0 min-h-0 {node.dir === 'col' ? 'flex-col' : ''}"
  >
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
