<script lang="ts">
  import FileTreeNode from "./FileTreeNode.svelte";
  import type { TreeEntry } from "../types";
  import type { TreeBadge } from "../filetree";
  import { expandedDirs, treeChildren, toggleDir } from "../filetree";
  import { openFile } from "../stores";

  let {
    entry,
    fileBadges,
    dirCounts,
    onmenu,
  }: {
    entry: TreeEntry;
    fileBadges: Map<string, TreeBadge>;
    dirCounts: Map<string, number>;
    onmenu: (e: MouseEvent, entry: TreeEntry) => void;
  } = $props();

  const expanded = $derived(entry.isDir && $expandedDirs.has(entry.path));
  const children = $derived($treeChildren.get(entry.path) ?? []);
  const badge = $derived(entry.isDir ? null : (fileBadges.get(entry.path) ?? null));
  const count = $derived(entry.isDir ? (dirCounts.get(entry.path) ?? 0) : 0);

  function onRowClick() {
    if (!entry.isDir) openFile(entry.path);
  }

  function onRowDblClick() {
    if (entry.isDir) toggleDir(entry.path);
  }
</script>

<button
  class="flex h-6 w-full items-center gap-1 rounded px-1 text-left hover:bg-zinc-800/70"
  title={entry.name}
  onclick={onRowClick}
  ondblclick={onRowDblClick}
  oncontextmenu={(e) => { e.preventDefault(); onmenu(e, entry); }}
>
  {#if entry.isDir}
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <span
      class="flex w-3.5 shrink-0 items-center justify-center text-[9px] text-zinc-500"
      onclick={(e) => { e.stopPropagation(); toggleDir(entry.path); }}
    >{expanded ? "▼" : "▶"}</span>
  {:else}
    <span class="w-3.5 shrink-0"></span>
  {/if}
  <span
    class="min-w-0 flex-1 truncate font-mono text-[11px] {entry.ignored
      ? 'italic text-zinc-500 opacity-50'
      : entry.isDir
        ? 'text-zinc-300'
        : 'text-zinc-400'}"
  >{entry.name}{entry.isDir ? "/" : ""}</span>
  <span class="w-6 shrink-0 text-right font-mono text-[10px] font-bold">
    {#if badge}
      <span class={badge.color}>{badge.char}</span>
    {:else if count > 0}
      <span class="font-normal text-amber-500/80">({count})</span>
    {/if}
  </span>
</button>

{#if expanded}
  <div class="ml-[7px] border-l border-zinc-800/70 pl-2">
    {#each children as child (child.path)}
      <FileTreeNode entry={child} {fileBadges} {dirCounts} {onmenu} />
    {/each}
    {#if children.length === 0}
      <p class="px-1 py-0.5 text-[10px] italic text-zinc-700">empty</p>
    {/if}
  </div>
{/if}
