<script lang="ts">
  /** The one place worktrees are seen and managed.
   *
   *  Before this panel, worktrees existed only as side effects: they appeared
   *  when you started work on a pull request or an issue, were labelled by a
   *  chip in three different places, and could be deleted from exactly one
   *  surface — a cleanup list buried under the pull-request panel that only ever
   *  showed trees Termax itself had created, and only once they were already
   *  broken or merged. There was nowhere to answer "what worktrees do I have?",
   *  and no way to make one for a branch that was neither a PR nor an issue.
   *
   *  So this reads `worktreeRows` — git's list, joined to the tabs and pull
   *  requests the app knows about — rather than deriving its own view. Every
   *  other surface keeps its chip; this is where the chip's subject lives.
   */
  import { ask } from "@tauri-apps/plugin-dialog";
  import {
    forgetMissingWorktrees,
    goToWorktree,
    refreshGitWorktrees,
    refreshWorktreePrs,
    removeWorktree,
    samePath,
    worktreeRows,
    type WorktreeRow,
  } from "../worktrees";
  import { activeRoot, flashGitMessage, gitMode, restricted } from "../stores";
  import NewWorktreeModal from "./NewWorktreeModal.svelte";

  /** Filling the sidebar's swap panel, exactly as the PR and issue panels do:
   *  the tab that selected this component is the disclosure, so there is no
   *  header toggle and the list takes the height it is given. */
  let { fill = false }: { fill?: boolean } = $props();

  let expanded = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let creating = $state(false);

  const rows = $derived($worktreeRows);
  const linked = $derived(rows.filter((r) => !r.isMain));
  const missing = $derived(rows.filter((r) => r.state === "missing"));
  /** Trees whose pull request is finished with. The reason this panel exists:
   *  they accumulate one per merged PR and nothing ever suggested removing
   *  them, so a long-lived repository quietly grows a checkout per feature. */
  const merged = $derived(rows.filter((r) => r.state === "merged"));

  /** Selecting this section is the user asking for current information, so it
   *  re-reads git and resolves the merged/closed pull requests once. Everything
   *  after that is driven by explicit refreshes — see the network posture in
   *  `pr.ts`, which is why the PR lookups live behind `refreshWorktreePrs`. */
  $effect(() => {
    if (!$gitMode || $restricted) return;
    void (async () => {
      await refreshGitWorktrees();
      await refreshWorktreePrs();
    })();
  });

  const DOTS: Record<WorktreeRow["state"], { glyph: string; color: string; hint: string }> = {
    main: { glyph: "●", color: "text-zinc-400", hint: "The project's main working tree" },
    active: { glyph: "●", color: "text-emerald-400", hint: "Open in a tab" },
    idle: { glyph: "○", color: "text-zinc-600", hint: "On disk, with no tab open in it" },
    merged: { glyph: "○", color: "text-purple-400", hint: "Its pull request is closed or merged" },
    missing: { glyph: "!", color: "text-amber-400", hint: "This directory no longer exists" },
  };

  /** The second line: what this tree is for, in the order that matters. */
  function subtitle(row: WorktreeRow): string {
    const parts: string[] = [];
    if (row.isMain) parts.push("project root");
    if (row.state === "missing") parts.push("directory is gone");
    if (row.tabs.length) parts.push(`${row.tabs.length} tab${row.tabs.length === 1 ? "" : "s"}`);
    // "no tabs open" is only worth saying about a tree that is still live work.
    // On a merged one it is the expected state, and repeating it down a list of
    // finished branches is noise the badge already covers.
    else if (row.state === "idle") parts.push("no tabs open");
    if (row.detached) parts.push("detached");
    if (row.locked) parts.push("locked");
    return parts.join(" · ");
  }

  function prBadge(row: WorktreeRow): { text: string; color: string } | null {
    if (!row.pr) return null;
    if (row.pr.state === "MERGED") return { text: `#${row.pr.number} merged`, color: "text-purple-400" };
    if (row.pr.state === "CLOSED") return { text: `#${row.pr.number} closed`, color: "text-red-400" };
    return { text: `#${row.pr.number}`, color: row.pr.isDraft ? "text-zinc-500" : "text-emerald-400" };
  }

  /** Whether this row is the tree the active tab is running in.
   *
   *  Compared as paths, the way `worktrees.ts` does: git's spelling and the
   *  session's canonical spelling of one tree differ on Windows in separators
   *  and the `\\?\` prefix, and by a trailing separator anywhere. */
  function here(row: WorktreeRow): boolean {
    return samePath(row.path, $activeRoot);
  }

  /** One way in, for every row: `goToWorktree` already knows how to reach a tree
   *  that has a group open, the project root, or one with no tab yet — and going
   *  through it is what keeps this panel landing on the same subtab the tab bar
   *  would. */
  async function jump(row: WorktreeRow) {
    actionError = null;
    if (row.state === "missing") {
      actionError = "That directory no longer exists. Forget it, or recreate the worktree.";
      return;
    }
    await goToWorktree(row.label, row.path);
  }

  async function copyPath(row: WorktreeRow) {
    try {
      await navigator.clipboard.writeText(row.path);
      flashGitMessage("Path copied");
    } catch (err) {
      actionError = String(err);
    }
  }

  /** Delete the directory. Two questions rather than one, because the second is
   *  a different decision: the first asks to remove a tree git considers clean,
   *  and only git refusing reveals that it is not. */
  async function remove(row: WorktreeRow) {
    const tabs = row.tabs.length
      ? `\n\n${row.tabs.length} open tab${row.tabs.length === 1 ? "" : "s"} will close.`
      : "";
    const ok = await ask(
      `Delete the worktree at\n${row.path}?\n\nThe branch and its commits are untouched.${tabs}`,
      { title: "Delete worktree?", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" },
    );
    if (!ok) return;

    busy = row.path;
    actionError = null;
    let problem = await removeWorktree(row.path);
    let removed = problem === null;

    // git refuses a tree with uncommitted work, which is the one case where
    // forcing is a real choice rather than a shortcut — so it is offered here
    // and nowhere else, naming what would be lost.
    if (problem && /contains modified or untracked files|use --force/i.test(problem)) {
      const discard = await ask(
        `${row.label} has uncommitted changes.\n\nDeleting the worktree now throws them away. This cannot be undone.`,
        { title: "Discard uncommitted changes?", kind: "warning", okLabel: "Discard and delete", cancelLabel: "Keep" },
      );
      if (discard) {
        problem = await removeWorktree(row.path, { discardChanges: true });
        removed = problem === null;
      } else {
        // Backing out of the second question is a decision, not a failure: the
        // worktree is still there, and saying "removed" would be a lie.
        problem = null;
      }
    }

    busy = null;
    actionError = problem;
    if (removed) {
      flashGitMessage(`Removed ${row.label}`);
      expanded = null;
    }
  }

  /** Remove every worktree whose pull request is done, in one pass.
   *
   *  One confirmation for the batch rather than one per tree: they are the same
   *  decision made nine times, and asking nine times is how a cleanup surface
   *  ends up never being used. Each removal still applies its own guards, so a
   *  tree with a running pane or uncommitted work survives and is named at the
   *  end instead of being forced through. */
  async function cleanMerged() {
    const targets = merged;
    const n = targets.length;
    const ok = await ask(
      `Delete ${n} worktree${n === 1 ? "" : "s"} whose pull request is closed or merged?\n\n${targets
        .map((row) => `  ${row.label}`)
        .join("\n")}\n\nThe branches and their commits are untouched. Any tree with uncommitted changes or a running pane is kept.`,
      { title: "Clean up merged worktrees?", kind: "warning", okLabel: `Delete ${n}`, cancelLabel: "Cancel" },
    );
    if (!ok) return;

    busy = "merged";
    actionError = null;
    const kept: string[] = [];
    let removed = 0;
    for (const row of targets) {
      const problem = await removeWorktree(row.path);
      if (problem) kept.push(`${row.label}: ${problem}`);
      else removed += 1;
    }
    busy = null;
    if (kept.length) actionError = `Kept ${kept.length}:\n${kept.join("\n")}`;
    if (removed) flashGitMessage(`Removed ${removed} merged worktree${removed === 1 ? "" : "s"}`);
  }

  /** Drop git's record for every tree whose directory is gone. Repository-wide,
   *  because `git worktree prune` is — the confirm says so rather than implying
   *  this touches only the row it was launched from. */
  async function forget() {
    const n = missing.length;
    const ok = await ask(
      `Forget ${n} worktree${n === 1 ? "" : "s"} whose director${n === 1 ? "y is" : "ies are"} gone?\n\nThis runs \`git worktree prune\`, which drops every stale record in this repository. Nothing on disk is touched.`,
      { title: "Forget missing worktrees?", kind: "warning", okLabel: "Forget", cancelLabel: "Cancel" },
    );
    if (!ok) return;
    busy = "prune";
    actionError = null;
    const problem = await forgetMissingWorktrees();
    busy = null;
    if (problem) actionError = problem;
    else flashGitMessage(`Forgot ${n} worktree${n === 1 ? "" : "s"}`);
  }

</script>

{#if $gitMode && !$restricted}
  <div class="flex min-h-0 flex-col {fill ? 'flex-1' : ''}">
    <div class="flex items-center gap-1 px-1 pb-1">
      <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Worktrees
      </span>
      {#if linked.length}<span class="text-[10px] text-zinc-600">{linked.length}</span>{/if}
      <div class="flex flex-1 items-center justify-end gap-1">
        {#if missing.length}
          <button
            class="rounded px-1 text-[10px] text-amber-400 hover:bg-zinc-800 disabled:opacity-40"
            title="Run `git worktree prune`: drop git's record of every worktree whose directory is gone"
            disabled={busy !== null}
            onclick={forget}
          >Forget {missing.length}</button>
        {/if}
        {#if merged.length}
          <button
            class="rounded px-1 text-[10px] text-purple-300 hover:bg-zinc-800 disabled:opacity-40"
            title="Delete every worktree whose pull request is closed or merged"
            disabled={busy !== null}
            onclick={cleanMerged}
          >{busy === "merged" ? "Cleaning…" : `Clean ${merged.length}`}</button>
        {/if}
        <button
          class="rounded px-1 text-[10px] font-semibold text-emerald-400 hover:bg-zinc-800 disabled:opacity-40"
          title="Create a worktree for a branch and open a tab in it"
          disabled={busy !== null}
          onclick={() => (creating = true)}
        >+ New</button>
        <button
          class="rounded px-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400 disabled:opacity-40"
          title="Re-read the worktree list"
          disabled={busy !== null}
          onclick={() => void refreshGitWorktrees()}
        >⟳</button>
      </div>
    </div>

    {#if actionError}
      <div class="mx-1 mb-1 flex items-start gap-1 rounded-md border border-red-500/40 bg-red-950/40 px-2 py-1">
        <p class="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[10px] text-red-300">{actionError}</p>
        <button
          class="shrink-0 rounded px-1 text-[10px] text-red-300/70 hover:bg-red-500/20 hover:text-red-200"
          title="Dismiss"
          onclick={() => (actionError = null)}
        >✕</button>
      </div>
    {/if}

    <div class="min-h-0 overflow-y-auto {fill ? 'flex-1' : 'max-h-72'}">
      {#each rows as row (row.path)}
        {@const dot = DOTS[row.state]}
        {@const badge = prBadge(row)}
        {@const current = here(row)}
        <div class="rounded-md {current ? 'bg-emerald-500/10' : ''}">
          <div class="flex items-start gap-1">
            <!-- Jumping is the point of the list, so it is the row itself. The
                 detail (path, tabs, destructive actions) is behind the chevron,
                 which keeps a mis-click from being anything worse than a tab
                 switch. -->
            <button
              class="flex min-w-0 flex-1 flex-col items-start rounded-md px-1 py-0.5 text-left transition-colors hover:bg-zinc-800/70 disabled:opacity-50"
              title="{row.path}&#10;{dot.hint}"
              disabled={busy !== null}
              onclick={() => void jump(row)}
            >
              <span class="flex w-full min-w-0 items-center gap-1.5">
                <span class="shrink-0 font-mono text-[10px] {dot.color}">{dot.glyph}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">{row.label}</span>
                {#if row.isMain}
                  <span class="shrink-0 text-[9px] text-zinc-600">main</span>
                {:else if badge}
                  <span class="shrink-0 text-[9px] {badge.color}">{badge.text}</span>
                {/if}
              </span>
              <span class="ml-[18px] truncate text-[10px] text-zinc-600">{subtitle(row)}</span>
            </button>
            <button
              class="shrink-0 rounded px-1 py-0.5 text-[8px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
              title="Details and actions"
              onclick={() => (expanded = expanded === row.path ? null : row.path)}
            >{expanded === row.path ? "▾" : "▸"}</button>
          </div>

          {#if expanded === row.path}
            <div class="mb-1 ml-4 flex flex-col gap-1 border-l border-zinc-800 pl-2">
              <p class="break-all font-mono text-[10px] text-zinc-500">{row.path}</p>
              {#if row.tabs.length}
                <p class="truncate text-[10px] text-zinc-600">
                  Open in: {row.tabs.map((t) => t.title).join(", ")}
                </p>
              {/if}
              <div class="flex flex-wrap items-center gap-1">
                <button
                  class="rounded px-1 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  onclick={() => void copyPath(row)}
                >Copy path</button>
                {#if row.state !== "missing"}
                  <button
                    class="rounded px-1 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-emerald-300 disabled:opacity-40"
                    title={row.tabs.length ? "Switch to this worktree" : "Open a tab in this worktree"}
                    disabled={busy !== null}
                    onclick={() => void jump(row)}
                  >{row.tabs.length ? "Go to it" : "Open a tab"}</button>
                {/if}
                {#if row.isMain}
                  <span class="px-1 text-[10px] text-zinc-600">
                    The main tree can't be removed.
                  </span>
                {:else if row.state === "missing"}
                  <button
                    class="rounded px-1 text-[10px] text-amber-400 hover:bg-zinc-800 disabled:opacity-40"
                    title="Drop git's record of every worktree whose directory is gone"
                    disabled={busy !== null}
                    onclick={forget}
                  >Forget</button>
                {:else}
                  <button
                    class="rounded px-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-red-300 disabled:opacity-40"
                    title="Delete this worktree's directory. The branch and its commits stay."
                    disabled={busy !== null}
                    onclick={() => void remove(row)}
                  >{busy === row.path ? "Removing…" : "Remove"}</button>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/each}

      {#if !linked.length}
        <p class="px-1 py-1 text-[10px] text-zinc-600">
          No linked worktrees. Starting work on a pull request or an issue creates
          one, or make one here for any branch.
        </p>
      {/if}
    </div>
  </div>
{/if}

{#if creating}
  <NewWorktreeModal onclose={() => (creating = false)} />
{/if}
