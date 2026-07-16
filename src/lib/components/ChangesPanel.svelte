<script lang="ts">
  import {
    changes,
    diffTarget,
    fetchRemote,
    gitBusy,
    gitError,
    gitMode,
    gitStatus,
    highlightedChange,
    pullRemote,
    refreshChanges,
    showUntracked,
    toggleUntracked,
  } from "../stores";
  import type { ChangeEntry } from "../types";

  let listEl = $state<HTMLDivElement>();
  let flashPath = $state<string | null>(null);

  // "Show in Changes" from the file tree: scroll the entry into view and flash it.
  $effect(() => {
    const path = $highlightedChange;
    if (!path || !listEl) return;
    highlightedChange.set(null);
    const el = listEl.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    flashPath = path;
    const timer = setTimeout(() => (flashPath = null), 1600);
    return () => clearTimeout(timer);
  });

  // Snapshot-mode statuses
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

  // Git-mode unstaged status letters
  const gitColor: Record<string, string> = {
    A: "text-emerald-400",
    M: "text-amber-400",
    D: "text-red-400",
    R: "text-amber-400",
    C: "text-purple-400",
  };

  function badge(change: ChangeEntry): { char: string; color: string } {
    if (change.area === "staged") return { char: "S", color: "text-emerald-400" };
    if (change.area === "untracked") return { char: "U", color: "text-blue-400" };
    if (change.area === "unstaged") {
      return { char: change.status, color: gitColor[change.status] ?? "text-amber-400" };
    }
    return {
      char: statusChar[change.status] ?? "M",
      color: statusColor[change.status] ?? "text-amber-400",
    };
  }

  let visible = $derived(
    $showUntracked ? $changes : $changes.filter((c) => c.area !== "untracked"),
  );
</script>

<div class="flex min-h-0 flex-1 flex-col gap-1">
  {#if $gitMode}
    <div class="flex flex-wrap items-center gap-1.5 px-1 pb-0.5">
      {#if $gitStatus}
        <span
          class="max-w-full truncate rounded bg-emerald-950/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-400"
          title={$gitStatus.detached ? "Detached HEAD" : "Current branch"}
        >{$gitStatus.detached ? `HEAD (${$gitStatus.branch})` : $gitStatus.branch}</span>
        {#if $gitStatus.hasUpstream}
          {#if $gitStatus.ahead > 0}
            <span class="font-mono text-[10px] text-emerald-500" title="Commits ahead of upstream">↑{$gitStatus.ahead}</span>
          {/if}
          {#if $gitStatus.behind > 0}
            <span class="font-mono text-[10px] text-amber-500" title="Commits behind upstream">↓{$gitStatus.behind}</span>
          {/if}
          <button
            class="rounded px-1 font-mono text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400 disabled:opacity-40"
            title="Fetch from remote (check for updates)"
            disabled={$gitBusy}
            onclick={fetchRemote}
          >⤓</button>
        {:else}
          <span class="text-[10px] text-zinc-600">(no remote)</span>
        {/if}
      {/if}
    </div>

    {#if $gitStatus && $gitStatus.behind > 0}
      {@const n = $gitStatus.behind}
      <div class="mx-1 mb-1 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-950/40 px-2 py-1.5">
        <span class="min-w-0 flex-1 text-[11px] text-amber-300">
          Behind {$gitStatus.upstream ?? "upstream"} by {n} commit{n === 1 ? "" : "s"}.
          {#if $gitStatus.ahead > 0}Local branch has diverged.{:else}Pull to update.{/if}
        </span>
        <button
          class="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
          title={$gitStatus.ahead > 0
            ? "git pull --ff-only (will fail on a diverged branch; resolve in a terminal)"
            : "git pull --ff-only"}
          disabled={$gitBusy}
          onclick={pullRemote}
        >{$gitBusy ? "Pulling…" : "Pull"}</button>
      </div>
    {/if}

    {#if $gitError}
      <div class="mx-1 mb-1 rounded-md border border-red-500/40 bg-red-950/40 px-2 py-1">
        <p class="whitespace-pre-wrap break-words font-mono text-[10px] text-red-300">{$gitError}</p>
      </div>
    {/if}
  {:else}
    <p class="px-1 pb-0.5 text-[10px] text-zinc-600">No git repository</p>
  {/if}

  <div class="flex items-center justify-between px-1">
    <h2 class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
      Changes {#if visible.length}<span class="text-zinc-600">({visible.length})</span>{/if}
    </h2>
    <div class="flex items-center gap-1">
      {#if $gitMode}
        <button
          class="rounded px-1.5 font-mono text-[10px] font-bold {$showUntracked
            ? 'text-blue-400 hover:bg-zinc-800'
            : 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-400'}"
          title={$showUntracked ? "Hide untracked files" : "Show untracked files"}
          onclick={toggleUntracked}
        >U</button>
      {/if}
      <button
        class="rounded px-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
        title="Refresh"
        onclick={refreshChanges}
      >⟳</button>
    </div>
  </div>

  {#if visible.length === 0}
    <p class="px-1 text-[11px] text-zinc-600">
      {$gitMode ? "Working tree clean." : "No changes this session."}
    </p>
  {/if}

  <div class="min-h-0 flex-1 overflow-y-auto" bind:this={listEl}>
    {#each visible as change (`${change.area ?? "snap"}:${change.path}`)}
      {@const b = badge(change)}
      <button
        class="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-zinc-800/70
          {flashPath === change.path ? 'bg-emerald-500/20' : ''}"
        data-path={change.path}
        title="{change.path}{change.area ? ` (${change.area})` : ''}"
        onclick={() => diffTarget.set({ path: change.path, area: change.area })}
      >
        <span class="w-3 shrink-0 font-mono text-[11px] font-bold {b.color}">{b.char}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">{change.path}</span>
        <span class="shrink-0 font-mono text-[10px]">
          <span class="text-emerald-500">+{change.added}</span>
          <span class="text-red-500">−{change.removed}</span>
        </span>
      </button>
    {/each}
  </div>
</div>
