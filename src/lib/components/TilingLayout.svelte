<script lang="ts">
  import TilingLayout from "./TilingLayout.svelte";
  import TerminalPane from "./TerminalPane.svelte";
  import EditorPane from "./EditorPane.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import type { LayoutNode } from "../types";
  import { maximizedPaneId, resizeSplit, resizeCorners } from "../stores";

  let { node }: { node: LayoutNode } = $props();
  let container: HTMLDivElement | undefined;

  let cornerGroups = $derived.by<{ rowSplitIds: string[]; colSplitIds: string[]; xPct: number; yPct: number }[]>(() => {
    if (node.type !== "split") return [];
    const groups: { rowSplitIds: string[]; colSplitIds: string[]; xPct: number; yPct: number }[] = [];

    if (node.dir === "row") {
      const colChildren: { id: string; ratio: number }[] = [];
      if (node.a.type === "split" && node.a.dir === "col") colChildren.push({ id: node.a.id, ratio: node.a.ratio });
      if (node.b.type === "split" && node.b.dir === "col") colChildren.push({ id: node.b.id, ratio: node.b.ratio });
      if (!colChildren.length) return groups;

      const byRatio = new Map<number, string[]>();
      for (const c of colChildren) {
        const k = Math.round(c.ratio * 1000);
        if (!byRatio.has(k)) byRatio.set(k, []);
        byRatio.get(k)!.push(c.id);
      }
      for (const [k, ids] of byRatio) {
        groups.push({ rowSplitIds: [node.id], colSplitIds: ids, xPct: node.ratio * 100, yPct: (k / 1000) * 100 });
      }
    } else {
      const rowChildren: { id: string; ratio: number }[] = [];
      if (node.a.type === "split" && node.a.dir === "row") rowChildren.push({ id: node.a.id, ratio: node.a.ratio });
      if (node.b.type === "split" && node.b.dir === "row") rowChildren.push({ id: node.b.id, ratio: node.b.ratio });
      if (!rowChildren.length) return groups;

      const byRatio = new Map<number, string[]>();
      for (const c of rowChildren) {
        const k = Math.round(c.ratio * 1000);
        if (!byRatio.has(k)) byRatio.set(k, []);
        byRatio.get(k)!.push(c.id);
      }
      for (const [k, ids] of byRatio) {
        groups.push({ rowSplitIds: ids, colSplitIds: [node.id], xPct: (k / 1000) * 100, yPct: node.ratio * 100 });
      }
    }
    return groups;
  });

  /** Teardown for the splitter gesture in flight, if any. */
  let stopActiveSplitDrag: (() => void) | null = null;

  // A splitter gesture listens on the window, so it has to be torn down on every
  // way out — `pointercancel` and a lost window focus fire instead of `pointerup`
  // when the OS takes the pointer away. A leaked `pointermove` would rewrite the
  // layout on every mouse move for the rest of the session, remounting panes
  // under the cursor.
  function beginSplitDrag(onMove: (ev: PointerEvent) => void, onUp: () => void) {
    stopActiveSplitDrag?.();
    stopActiveSplitDrag = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  }

  function endSplitDrag(onMove: (ev: PointerEvent) => void, onUp: () => void) {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    window.removeEventListener("blur", onUp);
    if (stopActiveSplitDrag === onUp) stopActiveSplitDrag = null;
  }

  // Every layout write remounts this component; a gesture still in flight when
  // that happens would otherwise leak its listeners for good.
  $effect(() => () => stopActiveSplitDrag?.());

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
      endSplitDrag(onMove, onUp);
    }
    beginSplitDrag(onMove, onUp);
  }

  function startCornerDrag(e: PointerEvent, rowSplitIds: string[], colSplitIds: string[]) {
    if (!container) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = container.getBoundingClientRect();

    function onMove(ev: PointerEvent) {
      const x = (ev.clientX - rect.left) / rect.width;
      const y = (ev.clientY - rect.top) / rect.height;
      resizeCorners(
        rowSplitIds, Math.min(0.9, Math.max(0.1, x)),
        colSplitIds, Math.min(0.9, Math.max(0.1, y)),
      );
    }
    function onUp() {
      endSplitDrag(onMove, onUp);
    }
    beginSplitDrag(onMove, onUp);
  }
</script>

{#if node.type === "pane"}
  {#if !$maximizedPaneId || $maximizedPaneId === node.id}
    <!-- Keyed on pane id: without it a tab switch onto a same-shaped grid
         reuses the pane component (and its host DOM node) for a different
         pane, bleeding the previous tab's terminal into this slot. -->
    {#key node.id}
      <!-- Per-pane boundary: one pane blowing up leaves the sibling panes,
           and their live PTYs, untouched. -->
      {#if node.kind === "editor"}
        <ErrorBoundary label="Editor pane">
          <EditorPane pane={node} />
        </ErrorBoundary>
      {:else}
        <ErrorBoundary label="Terminal pane">
          <TerminalPane pane={node} />
        </ErrorBoundary>
      {/if}
    {/key}
  {/if}
{:else}
  {#if $maximizedPaneId}
    <TilingLayout node={node.a} />
    <TilingLayout node={node.b} />
  {:else}
  <div
    bind:this={container}
    class="relative flex h-full w-full min-w-0 min-h-0 {node.dir === 'col' ? 'flex-col' : ''}"
  >
    {#each cornerGroups as group (group.rowSplitIds[0] + '-' + group.colSplitIds[0])}
      <div
        class="absolute z-10 w-3 h-3 -ml-1.5 -mt-1.5 bg-emerald-500/40 hover:bg-emerald-500/60 active:bg-emerald-500/80 rounded-sm cursor-nwse-resize"
        style="left: {group.xPct}%; top: {group.yPct}%"
        onpointerdown={(e) => startCornerDrag(e, group.rowSplitIds, group.colSplitIds)}
      ></div>
    {/each}
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
{/if}
