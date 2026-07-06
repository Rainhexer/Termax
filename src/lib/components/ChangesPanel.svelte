<script lang="ts">
  import { changes, diffPath, refreshChanges } from "../stores";

  const statusColor: Record<string, string> = {
    created: "text-emerald-400",
    modified: "text-amber-400",
    deleted: "text-red-400",
  };
  const statusChar: Record<string, string> = {
    created: "A",
    modified: "M",
    deleted: "D",
  };
</script>

<div class="flex min-h-0 flex-1 flex-col gap-1">
  <div class="flex items-center justify-between px-1">
    <h2 class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
      Changes {#if $changes.length}<span class="text-zinc-600">({$changes.length})</span>{/if}
    </h2>
    <button
      class="rounded px-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
      title="Refresh"
      onclick={refreshChanges}
    >⟳</button>
  </div>

  {#if $changes.length === 0}
    <p class="px-1 text-[11px] text-zinc-600">No changes this session.</p>
  {/if}

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#each $changes as change (change.path)}
      <button
        class="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-zinc-800/70"
        title={change.path}
        onclick={() => diffPath.set(change.path)}
      >
        <span class="w-3 shrink-0 font-mono text-[11px] font-bold {statusColor[change.status]}">
          {statusChar[change.status]}
        </span>
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">{change.path}</span>
        <span class="shrink-0 font-mono text-[10px]">
          <span class="text-emerald-500">+{change.added}</span>
          <span class="text-red-500">−{change.removed}</span>
        </span>
      </button>
    {/each}
  </div>
</div>
