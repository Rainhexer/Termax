<script lang="ts">
  /** One row of the explorer.
   *
   *  Flat, not recursive: the parent hands it a depth and it draws its own
   *  indentation, so the row — and therefore its hover and selection highlight —
   *  spans the full width of the sidebar. Nesting the rows inside indented
   *  wrappers, as this component used to, indents the highlight along with the
   *  text and leaves a stripe of dead space down the left of every subtree.
   *
   *  All state lives in the parent. The row reports intent (open, toggle,
   *  select, menu) and renders what it is told, which is what lets the keyboard
   *  and the mouse drive the same selection. */
  import type { TreeEntry } from "../types";
  import type { TreeBadge } from "../filetree";
  import { iconFor } from "../fileIcons";
  import FileIcon from "./FileIcon.svelte";

  let {
    entry,
    depth,
    expanded = false,
    selected = false,
    badge = null,
    count = 0,
    /** Show the containing folder after the name (search results). */
    showDir = false,
    onactivate,
    ontoggle,
    onselect,
    onmenu,
  }: {
    entry: TreeEntry;
    depth: number;
    expanded?: boolean;
    selected?: boolean;
    badge?: TreeBadge | null;
    count?: number;
    showDir?: boolean;
    onactivate: (entry: TreeEntry) => void;
    ontoggle: (entry: TreeEntry) => void;
    onselect: (entry: TreeEntry) => void;
    onmenu: (e: MouseEvent, entry: TreeEntry) => void;
  } = $props();

  /** Pixels per level. Tight enough that a deep path still fits a 256px
   *  sidebar, wide enough that the guide lines stay countable. */
  const INDENT = 10;
  const BASE = 4;

  const icon = $derived(iconFor(entry, expanded));
  /** One guide line per level this row sits under. */
  const guides = $derived(Array.from({ length: depth }, (_, level) => level));
  const parentDir = $derived(entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "");
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  role="treeitem"
  tabindex="-1"
  aria-selected={selected}
  aria-expanded={entry.isDir ? expanded : undefined}
  data-path={entry.path}
  class="relative flex h-6 w-full cursor-pointer items-center gap-1 pr-1 {selected
    ? 'bg-emerald-500/15 ring-1 ring-inset ring-emerald-500/40'
    : 'hover:bg-zinc-800/70'}"
  style="padding-left: {BASE + depth * INDENT}px"
  title={entry.path}
  onclick={() => { onselect(entry); if (entry.isDir) ontoggle(entry); else onactivate(entry); }}
  oncontextmenu={(e) => { e.preventDefault(); onselect(entry); onmenu(e, entry); }}
>
  <!-- Indent guides. One per level crossed, drawn behind the row's own
       content so the highlight still reaches the sidebar's left edge. -->
  {#each guides as level (level)}
    <span
      class="pointer-events-none absolute top-0 bottom-0 w-px bg-zinc-800"
      style="left: {BASE + level * INDENT + 6}px"
    ></span>
  {/each}

  {#if entry.isDir}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <span
      class="z-10 flex w-3 shrink-0 items-center justify-center text-[8px] text-zinc-500 hover:text-zinc-200"
      onclick={(e) => { e.stopPropagation(); onselect(entry); ontoggle(entry); }}
    >{expanded ? "▼" : "▶"}</span>
  {:else}
    <span class="w-3 shrink-0"></span>
  {/if}

  <FileIcon glyph={icon.glyph} color={icon.color} className="h-3.5 w-3.5 z-10" />

  <span
    class="z-10 min-w-0 flex-1 truncate font-mono text-[11px] {entry.ignored
      ? 'italic text-zinc-500 opacity-60'
      : entry.isDir
        ? 'text-zinc-300'
        : 'text-zinc-400'}"
  >
    {entry.name}{entry.isDir ? "/" : ""}
    {#if showDir && parentDir}
      <span class="ml-1 text-[10px] text-zinc-600">{parentDir}</span>
    {/if}
  </span>

  <span class="z-10 w-6 shrink-0 text-right font-mono text-[10px] font-bold">
    {#if badge}
      <span class={badge.color}>{badge.char}</span>
    {:else if count > 0}
      <span class="font-normal text-amber-500/80">({count})</span>
    {/if}
  </span>
</div>
