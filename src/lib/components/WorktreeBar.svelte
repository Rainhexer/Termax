<script lang="ts">
  /** The worktree row: one tab per tree you are working in.
   *
   *  Worktrees used to be peers of ordinary tabs in one flat bar, which had two
   *  costs. "Which tree am I typing in?" was a per-tab question answered by a
   *  chip small enough to truncate away, and a tree effectively held one tab —
   *  the one that created it — because a second tab for the same tree looked
   *  exactly like a tab for a different one.
   *
   *  So the bar is two rows. This is the outer one, and it is deliberately not
   *  styled like the subtab row below it: a top accent rather than an underline,
   *  a mono branch name, and its own ground. Below it, {@link TabBar} shows only
   *  the subtabs of whichever tree is selected here.
   */
  import { ask } from "@tauri-apps/plugin-dialog";
  import {
    ROOT_GROUP,
    activeGroupKey,
    closeGroup,
    collectTabPanes,
    draggedGroupKey,
    draggedPaneId,
    groupKeys,
    groupsWithAttention,
    persistLayout,
    switchGroup,
    tabsInGroup,
  } from "../stores";
  import { dropTarget, startGroupDrag } from "../paneDrag";
  import { isAlive } from "../terminals";
  import { pruneUnreferencedWorktrees, worktreeGroups } from "../worktrees";
  import type { WorktreeGroup } from "../worktrees";
  import NewWorktreeModal from "./NewWorktreeModal.svelte";

  let creating = $state(false);

  /** Insertion slot for a worktree-tab drag: index in the pre-move key list. */
  const dropIndex = $derived(
    $draggedGroupKey && $dropTarget?.kind === "group" ? $dropTarget.slot : null,
  );
  /** Worktree tab highlighted as the destination of a dragged pane. */
  const paneTargetKey = $derived(
    $draggedPaneId && $dropTarget?.kind === "group" ? $dropTarget.key : null,
  );

  function hint(group: WorktreeGroup): string {
    const lines: string[] = [];
    lines.push(group.isRoot ? `${group.label} (project root)` : group.label);
    if (group.branch && group.branch !== group.label) lines.push(`On ${group.branch}`);
    if (group.pr) lines.push(`PR #${group.pr.number}: ${group.pr.title}`);
    lines.push(
      group.tabCount === 0
        ? "No tabs open — click to open one"
        : `${group.tabCount} tab${group.tabCount === 1 ? "" : "s"}`,
    );
    if (group.missing) lines.push("This worktree's directory no longer exists.");
    if (group.path) lines.push(group.path);
    return lines.join("\n");
  }

  function prBadge(group: WorktreeGroup): { text: string; color: string } | null {
    const pr = group.pr;
    if (!pr) return null;
    if (pr.state === "MERGED") return { text: `#${pr.number}`, color: "text-purple-300" };
    if (pr.state === "CLOSED") return { text: `#${pr.number}`, color: "text-red-300" };
    return { text: `#${pr.number}`, color: pr.isDraft ? "text-zinc-500" : "text-emerald-300" };
  }

  /** Closing a worktree tab stops every terminal under it, which is exactly what
   *  must not happen silently to a working agent. The directory is never
   *  touched — that is the Trees panel's Remove. */
  async function close(group: WorktreeGroup) {
    const members = tabsInGroup(group.key);
    const running = members.flatMap((t) => collectTabPanes(t)).filter((id) => isAlive(id)).length;
    if (running) {
      const ok = await ask(
        `Closing ${group.label} will stop ${running} running pane${running === 1 ? "" : "s"}.\n\nAnything they haven't saved is lost. The worktree itself stays on disk.`,
        { title: "Stop working here?", kind: "warning", okLabel: "Close anyway", cancelLabel: "Keep open" },
      );
      if (!ok) return;
    }
    closeGroup(group.key);
    // The record is only pruned on project open, to keep a registration made
    // moments before its tab from being swept away. Nothing is pending here, so
    // the workspace can drop it now rather than at the next restart — and it has
    // to be saved again, because `closeTab` snapshotted the workspace before the
    // record went.
    pruneUnreferencedWorktrees();
    persistLayout();
  }
</script>

<!-- Renders as a fragment of the TitleBar's flex row, so the worktree tabs and
     the window controls share one strip and its height. -->
{#each $worktreeGroups as group, i (group.key)}
  {@const active = group.key === $activeGroupKey}
  {@const ringing = $groupsWithAttention.has(group.key)}
  {@const badge = prBadge(group)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="group relative flex h-full min-w-0 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 border-r border-zinc-800 px-3 text-xs transition-colors
      {active
        ? 'bg-zinc-900 text-emerald-300'
        : 'text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-300'}
      {$draggedGroupKey === group.key ? 'opacity-40' : ''}
      {paneTargetKey === group.key ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-400' : ''}
      {ringing ? 'bell-pulse-tab' : ''}"
    data-group-key={group.key}
    onclick={() => switchGroup(group.key)}
    onpointerdown={(e) => startGroupDrag(e, group.key, group.label)}
    title={hint(group)}
  >
    <!-- A top accent, where a subtab uses a bottom underline: the two rows must
         never be mistaken for one another at a glance. -->
    {#if active}
      <span class="absolute inset-x-0 top-0 h-0.5 bg-emerald-400"></span>
    {/if}
    {#if dropIndex === i}
      <span class="pointer-events-none absolute inset-y-1 left-0 z-10 w-0.5 rounded bg-emerald-400"></span>
    {:else if dropIndex === i + 1}
      <span class="pointer-events-none absolute inset-y-1 right-0 z-10 w-0.5 rounded bg-emerald-400"></span>
    {/if}

    {#if ringing}
      <span class="h-1.5 w-1.5 shrink-0 rounded-full glow-warn"></span>
    {:else if group.missing}
      <span class="shrink-0 font-mono text-[10px] text-amber-400" title="Directory is gone">!</span>
    {:else}
      <span class="shrink-0 font-mono text-[10px] {active ? 'text-emerald-400' : 'text-zinc-600'}"
        >{group.isRoot ? "⌂" : "⎇"}</span
      >
    {/if}
    <span class="min-w-0 flex-1 truncate font-mono text-[11px] {group.missing ? 'text-amber-300' : ''}"
      >{group.label}</span
    >
    {#if badge}
      <span class="shrink-0 text-[9px] {badge.color}">{badge.text}</span>
    {/if}
    {#if group.tabCount > 1}
      <span
        class="shrink-0 rounded bg-zinc-800 px-1 text-[9px] leading-4 text-zinc-400"
        title="{group.tabCount} tabs open in this worktree"
      >{group.tabCount}</span>
    {/if}
    {#if !group.isRoot}
      <button
        class="shrink-0 rounded-sm px-1 text-zinc-600 opacity-0 hover:bg-red-900/50 hover:text-red-300 group-hover:opacity-100 {active ? 'opacity-70' : ''}"
        title="Stop working in this worktree — closes its tabs, keeps the directory"
        onclick={(e) => { e.stopPropagation(); void close(group); }}
      >✕</button>
    {/if}
  </div>
{/each}
<button
  class="relative flex w-9 shrink-0 items-center justify-center text-lg text-zinc-600 hover:bg-zinc-900 hover:text-emerald-400"
  title={$draggedGroupKey ? "Move this worktree to the end" : "New worktree"}
  data-new-worktree
  onclick={() => (creating = true)}
>
  {#if dropIndex === $groupKeys.length}
    <span class="pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded bg-emerald-400"></span>
  {/if}
  +
</button>

{#if creating}
  <NewWorktreeModal onclose={() => (creating = false)} />
{/if}
