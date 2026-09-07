<script lang="ts">
  /** Issues for the active repository.
   *
   *  Sibling of `PullRequests.svelte`, and deliberately shaped like it: the same
   *  collapsed-by-default header, the same per-`kind` empty states, the same
   *  "expensive detail only when you ask" split. Collapsed is not merely a
   *  layout choice — it is what guarantees Termax makes no issue calls for a
   *  user who does not use issues. See the network posture in `issues.ts`.
   *
   *  Where it diverges is the filter bar, which the PR panel has no equivalent
   *  of. A repository's open pull requests are a list you read; its issues are a
   *  database you query, and a panel that could only show "the 30 newest" would
   *  be a strictly worse version of the website. The row itself stays a summary:
   *  the detail modal is where an issue is actually worked on.
   */
  import {
    ago,
    clearFilter,
    filterActive,
    issueCache,
    issueFilter,
    issuePanelOpen,
    patchFilter,
    refreshIssues,
    repoMeta,
    toggleFilterLabel,
  } from "../issues";
  import { addPane, gitMode, restricted, switchGroup, tabs, worktrees } from "../stores";
  import { gitWorktrees, groupForIssue } from "../worktrees";
  import { ipc } from "../ipc";
  import type { Issue } from "../types";
  import CreateIssueModal from "./CreateIssueModal.svelte";
  import IssueDetailModal from "./IssueDetailModal.svelte";
  import StartWorkOnIssueModal from "./StartWorkOnIssueModal.svelte";
  import LabelChip from "./LabelChip.svelte";

  /** Filling the sidebar's swap panel: the tab that selected this component is
   *  the disclosure, so the header drops its own toggle and the list takes the
   *  height it is given instead of capping itself. `issuePanelOpen` still gates
   *  the fetching — the sidebar sets it from the selected tab. */
  let { fill = false }: { fill?: boolean } = $props();

  let creating = $state(false);
  let viewing = $state<number | null>(null);
  let starting = $state<Issue | null>(null);
  let showFilters = $state(false);
  let copied = $state<string | null>(null);
  /** Live text in the search box. Committed on Enter rather than per keystroke:
   *  every commit is a network call. */
  let searchDraft = $state("");

  const issues = $derived($issueCache.issues);
  const problem = $derived($issueCache.problem);
  const meta = $derived($repoMeta);

  /** Labels worth offering as one-tap filters: the ones actually in use on the
   *  issues currently shown, most common first. A repository's full label list
   *  is in the filter drawer; this is the part that pays for its space. */
  const commonLabels = $derived.by(() => {
    const counts = new Map<string, { name: string; color: string; n: number }>();
    for (const issue of issues) {
      for (const label of issue.labels) {
        const seen = counts.get(label.name);
        if (seen) seen.n += 1;
        else counts.set(label.name, { name: label.name, color: label.color, n: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  });

  /** Issue number → the worktree already working on it. Local and free: no
   *  network call to find out an agent is on something.
   *
   *  The three stores are referenced explicitly because `groupForIssue` reads them
   *  through `get()`, which runes do not track — without them the badge would
   *  only refresh when the issue list itself changed, so a worktree created
   *  seconds ago would not show up until the next fetch. */
  const boundGroups = $derived.by(() => {
    void $gitWorktrees;
    void $worktrees;
    void $tabs;
    const map = new Map<number, { recordId: string; path: string }>();
    for (const issue of issues) {
      const found = groupForIssue(issue.number);
      if (found) map.set(issue.number, found);
    }
    return map;
  });

  function stateColor(issue: Issue): string {
    if (issue.state === "OPEN") return "text-emerald-400";
    if (issue.stateReason === "NOT_PLANNED" || issue.stateReason === "DUPLICATE")
      return "text-zinc-500";
    return "text-purple-400";
  }

  function stateTitle(issue: Issue): string {
    if (issue.state === "OPEN") return "Open";
    if (issue.stateReason === "NOT_PLANNED") return "Closed as not planned";
    if (issue.stateReason === "DUPLICATE") return "Closed as a duplicate";
    return "Closed as completed";
  }

  function commitSearch() {
    patchFilter({ search: searchDraft.trim() || undefined });
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = key;
      setTimeout(() => {
        if (copied === key) copied = null;
      }, 1500);
    } catch (err) {
      console.error("clipboard write failed", err);
    }
  }
</script>

{#if $gitMode && !$restricted}
  <div class="flex min-h-0 flex-col gap-0.5 {fill ? 'flex-1' : ''}">
    <div class="flex items-center gap-1 px-1">
      {#if fill}
        <h2 class="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Issues
          {#if issues.length}
            <span class="text-zinc-600">({issues.length}{$issueCache.truncated ? "+" : ""})</span>
          {/if}
        </h2>
      {:else}
        <button
          class="flex items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
          title={$issuePanelOpen
            ? "Hide issues (also stops checking GitHub)"
            : "Show issues (checks GitHub)"}
          onclick={() => issuePanelOpen.update((v) => !v)}
        >
          <span class="text-[9px]">{$issuePanelOpen ? "▼" : "▶"}</span>
          Issues
          {#if $issuePanelOpen && issues.length}
            <span class="text-zinc-600">({issues.length}{$issueCache.truncated ? "+" : ""})</span>
          {/if}
        </button>
      {/if}
      <div class="flex flex-1 items-center justify-end gap-1">
        {#if $issuePanelOpen}
          {#if $issueCache.loading}
            <span class="font-mono text-[10px] text-zinc-600">checking…</span>
          {/if}
          {#if !problem}
            <button
              class="rounded px-1 text-[10px] {$filterActive
                ? 'text-emerald-400'
                : 'text-zinc-500'} hover:bg-zinc-800 hover:text-zinc-300"
              title="Filter issues"
              onclick={() => (showFilters = !showFilters)}
            >⌗</button>
            <button
              class="rounded px-1 text-[10px] font-semibold text-emerald-400 hover:bg-zinc-800"
              title="Open a new issue"
              onclick={() => (creating = true)}
            >+ Issue</button>
          {/if}
          <button
            class="rounded px-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400 disabled:opacity-40"
            title="Check GitHub for issues now"
            disabled={$issueCache.loading}
            onclick={() => refreshIssues(true)}
          >⟳</button>
        {/if}
      </div>
    </div>

    {#if $issuePanelOpen && showFilters && !problem}
      <div class="mx-1 mb-1 flex flex-col gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-1.5">
        <input
          class="w-full rounded bg-zinc-900 px-1.5 py-1 font-mono text-[10px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
          bind:value={searchDraft}
          placeholder="Search — GitHub syntax, e.g. -label:wontfix"
          title="Full GitHub search syntax. Press Enter to run it."
          onkeydown={(e) => e.key === "Enter" && commitSearch()}
          onblur={commitSearch}
        />

        <div class="flex items-center gap-1">
          {#each [["open", "Open"], ["closed", "Closed"], ["all", "All"]] as [value, label] (value)}
            <button
              class="rounded px-1.5 py-0.5 text-[10px] {($issueFilter.state ?? 'open') === value
                ? 'bg-emerald-600/25 text-emerald-300'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'}"
              onclick={() => patchFilter({ state: value as "open" | "closed" | "all" })}
            >{label}</button>
          {/each}
          <span class="ml-auto"></span>
          {#if meta.me}
            <button
              class="rounded px-1.5 py-0.5 text-[10px] {$issueFilter.assignee === '@me'
                ? 'bg-emerald-600/25 text-emerald-300'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'}"
              title="Only issues assigned to {meta.me}"
              onclick={() =>
                patchFilter({ assignee: $issueFilter.assignee === "@me" ? undefined : "@me" })}
            >Mine</button>
            <button
              class="rounded px-1.5 py-0.5 text-[10px] {$issueFilter.author === '@me'
                ? 'bg-emerald-600/25 text-emerald-300'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'}"
              title="Only issues you opened"
              onclick={() =>
                patchFilter({ author: $issueFilter.author === "@me" ? undefined : "@me" })}
            >Authored</button>
          {/if}
        </div>

        {#if meta.milestones.length}
          <select
            class="w-full rounded bg-zinc-900 px-1 py-0.5 text-[10px] text-zinc-300 outline-none ring-1 ring-zinc-800"
            value={$issueFilter.milestone ?? ""}
            onchange={(e) =>
              patchFilter({ milestone: (e.currentTarget as HTMLSelectElement).value || undefined })}
          >
            <option value="">Any milestone</option>
            {#each meta.milestones as m (m.number)}
              <option value={m.title}>{m.title} ({m.openIssues} open)</option>
            {/each}
          </select>
        {/if}

        {#if meta.labels.length}
          <div class="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
            {#each meta.labels as label (label.name)}
              <LabelChip
                name={label.name}
                color={label.color}
                active={$issueFilter.labels?.includes(label.name) ?? false}
                title={label.description || label.name}
                onclick={() => toggleFilterLabel(label.name)}
              />
            {/each}
          </div>
        {/if}

        {#if $filterActive}
          <button
            class="self-start text-[10px] text-zinc-500 hover:text-zinc-300"
            onclick={() => {
              searchDraft = "";
              clearFilter();
            }}
          >Clear filters</button>
        {/if}
      </div>
    {/if}

    {#if $issuePanelOpen}
      {#if problem}
        <!-- Each failure mode gets its own next step, exactly as the pull-request
             panel does. A shared "something went wrong" leaves nothing to do. -->
        <div class="mx-1 mb-1 rounded-md border border-zinc-700 bg-zinc-900/60 px-2 py-1.5">
          {#if problem.kind === "notInstalled"}
            <p class="text-[11px] text-zinc-400">
              The GitHub CLI isn't installed. Termax uses it to talk to GitHub, so
              it never needs a token of its own.
            </p>
            <button
              class="mt-1 text-[11px] font-semibold text-emerald-400 hover:underline"
              onclick={() => ipc.openUrl("https://cli.github.com")}
            >Install the GitHub CLI ↗</button>
          {:else if problem.kind === "notAuthenticated"}
            <p class="text-[11px] text-zinc-400">
              The GitHub CLI isn't signed in yet. Sign-in happens in a terminal
              because GitHub asks for a one-time code.
            </p>
            <div class="mt-1 flex items-center gap-2">
              <button
                class="text-[11px] font-semibold text-emerald-400 hover:underline"
                onclick={() => addPane(null, "Shell")}
              >Open a shell</button>
              <button
                class="font-mono text-[11px] text-zinc-500 hover:text-zinc-300"
                onclick={() => copy("gh auth login", "auth")}
              >{copied === "auth" ? "copied" : "gh auth login ⧉"}</button>
            </div>
          {:else if problem.kind === "notGitHub"}
            <p class="text-[11px] text-zinc-400">
              This repository's remote isn't on GitHub, so there are no issues to
              show here. Everything else in Termax works normally.
            </p>
          {:else if problem.kind === "noRemote"}
            <p class="text-[11px] text-zinc-400">
              This repository has no remote yet. Add one to use issues.
            </p>
          {:else}
            <p class="text-[11px] text-zinc-400">GitHub couldn't be reached.</p>
            <p class="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] text-red-300">{problem.message}</p>
          {/if}
        </div>
      {:else if issues.length === 0}
        <p class="px-1 pb-1 text-[11px] text-zinc-600">
          {#if $issueCache.fetchedAt === 0}
            Checking GitHub…
          {:else if $filterActive}
            <!-- Never let a filter's empty result read as an empty repository. -->
            No issues match this filter.
            <button class="text-zinc-500 underline hover:text-zinc-300" onclick={clearFilter}>Clear it</button>
          {:else}
            No open issues.
          {/if}
        </p>
      {/if}

      {#if !problem && commonLabels.length}
        <div class="flex flex-wrap gap-1 px-1 pb-1">
          {#each commonLabels as label (label.name)}
            <LabelChip
              name={label.name}
              color={label.color}
              active={$issueFilter.labels?.includes(label.name) ?? false}
              title="Filter by {label.name} ({label.n})"
              onclick={() => toggleFilterLabel(label.name)}
            />
          {/each}
        </div>
      {/if}

      <div class="min-h-0 overflow-y-auto {fill ? 'flex-1' : 'max-h-72'}">
        {#each issues as issue (issue.number)}
          {@const bound = boundGroups.get(issue.number)}
          <div class="group flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-zinc-800/70">
            <button
              class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              title="#{issue.number}: {issue.title}&#10;{stateTitle(issue)} · by {issue.author
                .login} · updated {ago(issue.updatedAt)}{issue.assignees.length
                ? `\nAssigned to ${issue.assignees.map((a) => a.login).join(', ')}`
                : ''}"
              onclick={() => (viewing = issue.number)}
            >
              <span class="shrink-0 font-mono text-[10px] {stateColor(issue)}" title={stateTitle(issue)}>
                {issue.state === "OPEN" ? "◉" : "◎"}
              </span>
              <span class="shrink-0 font-mono text-[10px] font-semibold text-zinc-500">#{issue.number}</span>
              <span class="min-w-0 flex-1 truncate text-[11px] text-zinc-300">{issue.title}</span>
              {#if issue.assignees.length}
                <span class="shrink-0 text-[9px] text-zinc-500" title="Assigned">◍</span>
              {/if}
              {#if bound}
                <span class="shrink-0 text-[9px] text-emerald-400" title="A worktree is already open on this">⎇</span>
              {/if}
            </button>
            <!-- The one action worth a permanent button rather than a menu: it
                 is the whole reason this panel is in a terminal app. -->
            <button
              class="shrink-0 rounded px-1 text-[9px] {bound
                ? 'text-emerald-400 opacity-100'
                : 'text-zinc-600 opacity-0'} transition-opacity hover:bg-zinc-800 hover:text-emerald-300 group-hover:opacity-100"
              title={bound
                ? "Switch to the worktree already working on this"
                : "Create a linked branch and open an agent on it"}
              onclick={() => (bound ? switchGroup(bound.recordId) : (starting = issue))}
            >{bound ? "Go to it" : "→ Agent"}</button>
          </div>
        {/each}
      </div>

      {#if $issueCache.truncated}
        <p class="px-1 pb-1 text-[10px] text-zinc-600">
          More issues match than are shown — narrow the filter to see the rest.
        </p>
      {/if}
    {/if}
  </div>
{/if}
<!-- No `{:else}`: without a git-mode session there are no issues, and the
     Changes panel already explains why (no repo, or an untrusted folder). -->

{#if creating}
  <CreateIssueModal onclose={() => (creating = false)} oncreated={(n) => (viewing = n)} />
{/if}
{#if viewing !== null}
  {@const number = viewing}
  <IssueDetailModal
    {number}
    onclose={() => (viewing = null)}
    onstartwork={() => {
      // Hand off from the detail modal to the agent picker, keeping only one
      // dialog on screen at a time.
      const issue = issues.find((i) => i.number === number);
      viewing = null;
      if (issue) starting = issue;
    }}
  />
{/if}
{#if starting}
  <StartWorkOnIssueModal issue={starting} onclose={() => (starting = null)} />
{/if}
