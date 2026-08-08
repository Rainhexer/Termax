<script lang="ts">
  import {
    changes,
    changesError,
    checkoutBranch,
    fetchRemote,
    gitBusy,
    gitError,
    gitMessage,
    gitMode,
    gitStatus,
    highlightedChange,
    loadBranches,
    openBranchOnRemote,
    openFile,
    pullRemote,
    refreshChanges,
    restricted,
    revokeCurrentFolderTrust,
    sendToPane,
    showUntracked,
    showStaged,
    showUnstaged,
    toggleUntracked,
    toggleStaged,
    toggleUnstaged,
    trustCurrentFolder,
  } from "../stores";
  import type { ChangeEntry } from "../types";

  let listEl = $state<HTMLDivElement>();
  let flashPath = $state<string | null>(null);

  // Branch switcher dropdown state.
  let branchMenuOpen = $state(false);
  let branchList = $state<string[]>([]);
  let branchFilter = $state("");
  let branchAnchor = $state<HTMLElement>();
  let branchMenuEl = $state<HTMLDivElement>();
  /** The Changes panel sits pinned to the bottom of the sidebar, so the menu can
   *  run out of window below it; when it does, flip it to open upward instead. */
  let branchMenuUp = $state(false);
  /** Set once the menu has been measured, so it never renders in the wrong
   *  direction for even a frame. */
  let branchMenuMeasured = $state(false);
  /** Set when listing branches failed, so the menu can distinguish "this repo has
   *  no other branches" from "git could not be asked". */
  let branchError = $state<string | null>(null);

  async function toggleBranchMenu() {
    if (branchMenuOpen) {
      branchMenuOpen = false;
      return;
    }
    branchFilter = "";
    branchError = null;
    branchMenuOpen = true;
    try {
      branchList = await loadBranches();
    } catch (err) {
      branchList = [];
      branchError = String(err);
    }
  }

  async function pickBranch(name: string) {
    branchMenuOpen = false;
    await checkoutBranch(name);
  }

  let filteredBranches = $derived(
    branchFilter.trim()
      ? branchList.filter((b) => b.toLowerCase().includes(branchFilter.trim().toLowerCase()))
      : branchList,
  );

  // Pick the menu's open direction from real measurements: open downward unless
  // the menu would stick past the bottom of the window, in which case open
  // upward — but only if it actually fits above. Re-evaluate on window resizes.
  $effect(() => {
    if (!branchMenuOpen || !branchAnchor || !branchMenuEl) {
      branchMenuMeasured = false;
      return;
    }
    const place = () => {
      const rect = branchAnchor.getBoundingClientRect();
      const height = branchMenuEl.offsetHeight;
      const margin = 4;
      const fitsBelow = window.innerHeight - rect.bottom - margin >= height;
      const fitsAbove = rect.top - margin >= height;
      branchMenuUp = !fitsBelow && fitsAbove;
      branchMenuMeasured = true;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });

  // Close the branch menu on outside click or Escape.
  $effect(() => {
    if (!branchMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (branchAnchor && !branchAnchor.contains(e.target as Node)) branchMenuOpen = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") branchMenuOpen = false;
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  });

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

  // Git-mode status letters. "U" is unmerged (a conflict) — git's porcelain uses
  // "C" for *copied*, and reusing that letter here made a merge conflict render
  // in the palette's "copied/renamed" colour with no hint that it was a conflict.
  const gitColor: Record<string, string> = {
    A: "text-emerald-400",
    M: "text-amber-400",
    D: "text-red-400",
    R: "text-amber-400",
    C: "text-purple-400",
    U: "text-red-400",
  };

  const statusWord: Record<string, string> = {
    A: "added",
    M: "modified",
    D: "deleted",
    R: "renamed",
    C: "copied",
    U: "conflict",
  };

  function badge(change: ChangeEntry): { char: string; color: string } {
    if (change.area === "untracked") return { char: "?", color: "text-blue-400" };
    if (change.area === "staged" || change.area === "unstaged") {
      // Staged entries used to collapse to a single "S", which hid whether the
      // staged change was an add or a *delete*, and made the same file staged vs
      // unstaged look like two unrelated kinds of change. Show the real letter and
      // let the colour carry the staged/unstaged distinction instead.
      const color =
        change.area === "staged" ? "text-emerald-400" : (gitColor[change.status] ?? "text-amber-400");
      return { char: change.status, color };
    }
    return {
      char: statusChar[change.status] ?? "M",
      color: statusColor[change.status] ?? "text-amber-400",
    };
  }

  /** Human wording for a change row's tooltip. */
  function describeChange(change: ChangeEntry): string {
    if (!change.area) return `${change.path} — ${change.status}`;
    if (change.area === "untracked") return `${change.path} — untracked (not in git yet)`;
    const word = statusWord[change.status] ?? change.status;
    return `${change.path} — ${word}, ${change.area}\nClick to open the diff`;
  }

  let visible = $derived(
    $changes.filter((c) => {
      if (c.area === "staged" && !$showStaged) return false;
      if (c.area === "unstaged" && !$showUnstaged) return false;
      if (c.area === "untracked" && !$showUntracked) return false;
      return true;
    }),
  );
</script>

<div class="flex flex-col gap-1">
  {#if $restricted}
    <div class="mx-1 mb-1 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-950/40 px-2 py-1.5">
      <!-- "session snapshot tracking" was jargon defined nowhere. Say what the
           user actually gets and what they lose. -->
      <span class="min-w-0 flex-1 text-[11px] text-amber-300">
        This folder isn't trusted, so Termax won't run git here. It's still
        tracking which files you change, but only since you opened the project —
        no branches, no diffs against your last commit.
      </span>
      <button
        class="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/30"
        title="Allow Termax to run git in this folder"
        onclick={trustCurrentFolder}
      >Trust folder</button>
    </div>
  {/if}
  {#if $gitMode}
    <div class="flex flex-wrap items-center gap-1.5 px-1 pb-0.5">
      {#if $gitStatus}
        <div class="relative" bind:this={branchAnchor}>
          <button
            class="flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold hover:bg-emerald-900/60 disabled:opacity-50 {$gitStatus.detached
              ? 'bg-amber-950/60 text-amber-400'
              : 'bg-emerald-950/60 text-emerald-400'}"
            title={$gitStatus.detached
              ? `Not on a branch — HEAD is detached at ${$gitStatus.branch}. Commits made here belong to no branch until you create one. Click to switch to a branch.`
              : "Switch branch"}
            disabled={$gitBusy}
            onclick={toggleBranchMenu}
          >
            <!-- In detached state git.rs puts the short SHA in `branch`, so the
                 old label read "HEAD (a1b2c3d)" — which looks like a branch named
                 HEAD. Say what it actually is. -->
            <span class="truncate">{$gitStatus.detached ? `detached @ ${$gitStatus.branch}` : $gitStatus.branch}</span>
            <span class="text-[8px] text-emerald-500/70">▾</span>
          </button>

          {#if branchMenuOpen}
            <div
              bind:this={branchMenuEl}
              class="absolute left-0 z-20 w-56 max-h-72 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/50
                {branchMenuUp ? 'bottom-full mb-1' : 'top-full mt-1'}
                {branchMenuMeasured ? '' : 'invisible'}"
            >
              {#if $gitStatus.remoteUrl}
                <button
                  class="flex w-full items-center gap-1.5 border-b border-zinc-800 px-2 py-1.5 text-left text-[11px] text-zinc-300 hover:bg-zinc-800"
                  title={`Open ${$gitStatus.branch} on ${$gitStatus.remoteUrl}`}
                  onclick={() => {
                    branchMenuOpen = false;
                    openBranchOnRemote();
                  }}
                >
                  <span class="text-zinc-500">↗</span>
                  <span class="min-w-0 flex-1 truncate">View branch on remote</span>
                </button>
              {/if}
              <div class="border-b border-zinc-800 p-1">
                <input
                  class="w-full rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
                  placeholder="Switch branch…"
                  bind:value={branchFilter}
                  onmousedown={(e) => e.stopPropagation()}
                />
              </div>
              <div class="max-h-52 overflow-y-auto py-0.5">
                {#each filteredBranches as b (b)}
                  <button
                    class="flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono text-[11px] hover:bg-zinc-800
                      {b === $gitStatus.branch ? 'text-emerald-400' : 'text-zinc-300'}"
                    onclick={() => pickBranch(b)}
                  >
                    <span class="w-2.5 shrink-0 text-emerald-400">{b === $gitStatus.branch ? "✓" : ""}</span>
                    <span class="min-w-0 flex-1 truncate">{b}</span>
                  </button>
                {:else}
                  {#if branchError}
                    <p class="px-2 py-1.5 text-[11px] text-red-400">Couldn't list branches.</p>
                    <p class="px-2 pb-1.5 font-mono text-[10px] text-red-300/80">{branchError}</p>
                  {:else}
                    <p class="px-2 py-1.5 text-[11px] text-zinc-600">
                      {branchFilter.trim() ? "No matching branches" : "No other branches"}
                    </p>
                  {/if}
                {/each}
              </div>
            </div>
          {/if}
        </div>
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
        {#if $gitMessage}
          <span class="min-w-0 flex-1 truncate text-[10px] text-zinc-500" title={$gitMessage}>{$gitMessage}</span>
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
        <!-- Offering a button whose own tooltip predicted its failure was worse
             than not offering it: a fast-forward cannot work once the branch has
             diverged, so say what to do instead. -->
        {#if $gitStatus.ahead > 0}
          <button
            class="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/30"
            title="Types `git pull --rebase` into a pane — you press Enter"
            onclick={() => sendToPane("git pull --rebase")}
          >Rebase in terminal</button>
        {:else}
          <button
            class="shrink-0 rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
            title="git pull --ff-only"
            disabled={$gitBusy}
            onclick={pullRemote}
          >{$gitBusy ? "Pulling…" : "Pull"}</button>
        {/if}
      </div>
    {/if}

    {#if $gitError}
      <div class="mx-1 mb-1 flex items-start gap-1 rounded-md border border-red-500/40 bg-red-950/40 px-2 py-1">
        <p class="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[10px] text-red-300">{$gitError}</p>
        <button
          class="shrink-0 rounded px-1 text-[10px] text-red-300/70 hover:bg-red-500/20 hover:text-red-200"
          title="Dismiss"
          onclick={() => gitError.set(null)}
        >✕</button>
      </div>
    {/if}
  {:else if !$restricted}
    <p class="px-1 pb-0.5 text-[10px] text-zinc-600">No git repository</p>
  {/if}

  <div class="flex items-center justify-between px-1">
    <h2 class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
      Changes {#if visible.length}<span class="text-zinc-600">({visible.length})</span>{/if}
    </h2>
    <div class="flex items-center gap-1">
      {#if $gitMode}
        <button
          class="rounded px-1.5 font-mono text-[10px] font-bold {$showStaged
            ? 'text-emerald-400 hover:bg-zinc-800'
            : 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-400'}"
          title={$showStaged ? "Hide staged files" : "Show staged files"}
          onclick={toggleStaged}
        >S</button>
        <button
          class="rounded px-1.5 font-mono text-[10px] font-bold {$showUnstaged
            ? 'text-amber-400 hover:bg-zinc-800'
            : 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-400'}"
          title={$showUnstaged ? "Hide unstaged files" : "Show unstaged files"}
          onclick={toggleUnstaged}
        >M</button>
        <button
          class="rounded px-1.5 font-mono text-[10px] font-bold {$showUntracked
            ? 'text-blue-400 hover:bg-zinc-800'
            : 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-400'}"
          title={$showUntracked ? "Hide untracked files" : "Show untracked files"}
          onclick={toggleUntracked}
        >U</button>
      {/if}
      {#if $gitMode}
        <button
          class="rounded px-1 text-[10px] text-zinc-600 hover:bg-zinc-800 hover:text-amber-400"
          title="Withdraw trust: stop Termax running git in this folder"
          onclick={revokeCurrentFolderTrust}
        >🔓</button>
      {/if}
      <button
        class="rounded px-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
        title="Refresh"
        onclick={() => refreshChanges()}
      >⟳</button>
    </div>
  </div>

  {#if $changesError}
    <!-- Must come before the "clean" message: a failed read used to render as a
         clean working tree, which told the user everything was fine when the app
         had in fact lost track of their changes entirely. -->
    <div class="mx-1 mb-1 rounded-md border border-red-500/40 bg-red-950/40 px-2 py-1.5">
      <p class="text-[11px] font-semibold text-red-300">Couldn't read changes.</p>
      <p class="mt-0.5 whitespace-pre-wrap break-words font-mono text-[10px] text-red-300/80">{$changesError}</p>
      <button
        class="mt-1 text-[11px] font-semibold text-red-200 hover:underline"
        onclick={() => refreshChanges()}
      >Try again</button>
    </div>
  {:else if visible.length === 0}
    <p class="px-1 text-[11px] text-zinc-600">
      {#if $gitMode}
        Working tree clean.
      {:else}
        No tracked changes since this project was opened.
      {/if}
    </p>
  {/if}

  <div class="max-h-60 min-h-0 overflow-y-auto" bind:this={listEl}>
    {#each visible as change (`${change.area ?? "snap"}:${change.path}`)}
      {@const b = badge(change)}
      <button
        class="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-zinc-800/70
          {flashPath === change.path ? 'bg-emerald-500/20' : ''}"
        data-path={change.path}
        title={describeChange(change)}
        onclick={() => openFile(change.path, { diff: true })}
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
