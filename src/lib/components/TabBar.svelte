<script lang="ts">
  import { tabs, activeTabId, switchTab, newTab, closeTab, renameTab } from "../stores";

  let editingId = $state<string | null>(null);
  let draft = $state("");

  function startRename(id: string, title: string) {
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
</script>

{#if $tabs.length > 1}
  <div class="flex h-9 shrink-0 items-stretch overflow-hidden border-b border-zinc-800 bg-zinc-950">
    {#each $tabs as tab (tab.id)}
      {@const active = tab.id === $activeTabId}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="group relative flex h-full min-w-0 max-w-52 flex-1 cursor-pointer items-center gap-2 border-r border-zinc-800 px-3 text-xs transition-colors
          {active
            ? 'bg-zinc-900 text-emerald-400'
            : 'text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-300'}"
        onclick={() => switchTab(tab.id)}
        ondblclick={() => startRename(tab.id, tab.title)}
        title={tab.title}
      >
        {#if active}
          <span class="absolute inset-x-0 bottom-0 h-0.5 bg-emerald-400"></span>
        {/if}
        {#if editingId === tab.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="min-w-0 flex-1 rounded-sm bg-zinc-800 px-1 text-xs text-zinc-100 outline-none ring-1 ring-emerald-500/50"
            bind:value={draft}
            autofocus
            onclick={(e) => e.stopPropagation()}
            onblur={commitRename}
            onkeydown={onKey}
          />
        {:else}
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
      class="flex w-9 shrink-0 items-center justify-center text-lg text-zinc-600 hover:bg-zinc-900 hover:text-emerald-400"
      title="New tab"
      onclick={newTab}
    >+</button>
  </div>
{/if}
