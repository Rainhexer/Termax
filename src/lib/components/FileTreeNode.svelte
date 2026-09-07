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
   *  select, menu, drag) and renders what it is told, which is what lets the
   *  keyboard, the mouse and a drag drive the same selection.
   *
   *  Click selects, double-click opens — a file manager's split, and the one
   *  that leaves a single click free to mean "add this to the selection". */
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
    /** This folder would receive a drop released now. */
    dropTarget = false,
    /** This entry is in the set currently being dragged. */
    dragging = false,
    /** This entry is on the clipboard as a cut, so it is about to move. */
    cut = false,
    /** The folder a drop on this row lands in: itself, or a file's parent. */
    dropDir,
    onactivate,
    ontoggle,
    onselect,
    onmenu,
    ondragstart,
  }: {
    entry: TreeEntry;
    depth: number;
    expanded?: boolean;
    selected?: boolean;
    badge?: TreeBadge | null;
    count?: number;
    showDir?: boolean;
    dropTarget?: boolean;
    dragging?: boolean;
    cut?: boolean;
    dropDir: string;
    onactivate: (entry: TreeEntry) => void;
    ontoggle: (entry: TreeEntry) => void;
    onselect: (entry: TreeEntry, e: MouseEvent) => void;
    onmenu: (e: MouseEvent, entry: TreeEntry) => void;
    ondragstart: (e: PointerEvent, entry: TreeEntry) => void;
  } = $props();

  /** Pixels per level. Tight enough that a deep path still fits a 256px
   *  sidebar, wide enough that the guide lines stay countable. */
  const INDENT = 10;
  const BASE = 4;

  const icon = $derived(iconFor(entry, expanded));
  /** One guide line per level this row sits under. */
  const guides = $derived(Array.from({ length: depth }, (_, level) => level));
  const parentDir = $derived(entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "");

  /** A single click only ever changes the selection — which is what makes a
   *  selection possible at all: with one click opening files, ctrl-clicking
   *  five of them to copy would have opened five editor panes on the way, and
   *  shift-clicking across folders would have expanded every one it passed. */
  function onClick(e: MouseEvent) {
    onselect(entry, e);
  }

  /** Opening is the second click. A modified double-click is still someone
   *  building a selection, so it opens nothing.
   *
   *  The chevron keeps its single click: it is a control for one folder, not a
   *  way of choosing what the selection is. */
  function onDblClick(e: MouseEvent) {
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (entry.isDir) ontoggle(entry);
    else onactivate(entry);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  role="treeitem"
  tabindex="-1"
  aria-selected={selected}
  aria-expanded={entry.isDir ? expanded : undefined}
  data-path={entry.path}
  data-tree-dir={dropDir}
  data-tree-is-dir={entry.isDir}
  class="relative flex h-6 w-full cursor-pointer touch-none select-none items-center gap-1 pr-1 {dropTarget
    ? 'bg-emerald-500/25 ring-1 ring-inset ring-emerald-400'
    : selected
      ? 'bg-emerald-500/15 ring-1 ring-inset ring-emerald-500/40'
      : 'hover:bg-zinc-800/70'} {dragging ? 'opacity-40' : ''} {cut ? 'opacity-50 italic' : ''}"
  style="padding-left: {BASE + depth * INDENT}px"
  title={entry.path}
  onclick={onClick}
  ondblclick={onDblClick}
  onpointerdown={(e) => ondragstart(e, entry)}
  oncontextmenu={(e) => { e.preventDefault(); onmenu(e, entry); }}
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
      onclick={(e) => { e.stopPropagation(); ontoggle(entry); }}
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
