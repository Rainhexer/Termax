<script lang="ts">
  /** Pull requests for the active repository.
   *
   *  Deliberately a separate component from ChangesPanel: that panel is already
   *  310 lines of working-tree concerns, and this one has a different data source
   *  (network, cached, per-repo) with a completely different failure model. The
   *  two share only the sidebar.
   *
   *  Collapsed by default, and that is not merely a layout choice — the collapsed
   *  state is what guarantees Termax makes no network calls for a user who does
   *  not use pull requests. See the network posture in pr.ts.
   */
  import { currentPr, loadPrDetail, prCache, prPanelOpen, refreshPrs } from "../pr";
  import {
    activeProject,
    activeRoot,
    addPane,
    flashGitMessage,
    gitMode,
    gitStatus,
    restricted,
    sendToPane,
  } from "../stores";
  import { groupForBranch, startWorkOnPr } from "../worktrees";
  import { enabledLaunchers, launcherById, settings } from "../settings";
  import { ipc } from "../ipc";
  import CreatePrModal from "./CreatePrModal.svelte";
  import MergePrDialog from "./MergePrDialog.svelte";
  import type { PrDetail, PullRequest } from "../types";

  /** Filling the sidebar's swap panel: the tab that selected this component is
   *  the disclosure, so the header drops its own toggle and the list takes the
   *  height it is given instead of capping itself. `prPanelOpen` still gates the
   *  fetching — the sidebar sets it from the selected tab. */
  let { fill = false }: { fill?: boolean } = $props();

  /** Expanded row → its detail, or null while loading. */
  let expanded = $state<number | null>(null);
  let detail = $state<PrDetail | null>(null);
  let copied = $state<string | null>(null);
  let creating = $state(false);
  let merging = $state<PullRequest | null>(null);
  let busyPr = $state<number | null>(null);
  let actionError = $state<string | null>(null);

  let prs = $derived($prCache.prs);
  let problem = $derived($prCache.problem);

  /** Launcher a PR tab opens with. A setting rather than "whatever is focused":
   *  one click spawning an agent should be predictable. */
  const prLauncher = $derived.by(() => {
    const list = enabledLaunchers($settings);
    const configured = $settings.behavior.prLauncherId;
    if (configured) return launcherById(configured);
    return list.find((l) => l.command !== null) ?? list[0];
  });

  async function startWork(pr: PullRequest) {
    const project = $activeProject;
    if (!project || busyPr !== null) return;
    busyPr = pr.number;
    actionError = null;
    const problem = await startWorkOnPr({
      projectPath: project.path,
      branch: pr.headRefName,
      prNumber: pr.number,
      title: pr.title,
      isCrossRepository: pr.isCrossRepository,
      launch: prLauncher?.command ?? null,
      launcherName: prLauncher?.name ?? "Shell",
    });
    busyPr = null;
    if (problem) actionError = problem;
    else if (pr.isCrossRepository) {
      flashGitMessage("Fork PR checked out read-only — use `gh pr checkout` to push back");
    }
  }

  async function markReady(pr: PullRequest) {
    busyPr = pr.number;
    actionError = null;
    try {
      await ipc.ghPrReady(pr.number, $activeRoot ?? undefined);
      flashGitMessage(`#${pr.number} is ready for review`);
      await refreshPrs(true);
    } catch (err) {
      actionError = String(err);
    } finally {
      busyPr = null;
    }
  }

  async function closePr(pr: PullRequest) {
    // Closing is reversible on GitHub, so a plain confirm is proportionate —
    // unlike merging, which gets the preflight dialog.
    if (!confirm(`Close pull request #${pr.number} without merging?\n\n${pr.title}`)) return;
    busyPr = pr.number;
    actionError = null;
    try {
      await ipc.ghPrClose(pr.number, $activeRoot ?? undefined);
      flashGitMessage(`Closed #${pr.number}`);
      await refreshPrs(true);
    } catch (err) {
      actionError = String(err);
    } finally {
      busyPr = null;
    }
  }

  async function push() {
    const status = $gitStatus;
    if (!status || status.detached) return;
    const branch = status.branch;
    if (!confirm(`Push ${branch} to origin?`)) return;
    actionError = null;
    try {
      await ipc.gitPush(branch, false, $activeRoot ?? undefined);
      flashGitMessage(`Pushed ${branch}`);
      await refreshPrs(true);
    } catch (err) {
      // A non-fast-forward rejection needs --force-with-lease, which is a second,
      // separate decision and never the default.
      actionError = String(err);
    }
  }


  async function toggleRow(pr: PullRequest) {
    if (expanded === pr.number) {
      expanded = null;
      detail = null;
      return;
    }
    expanded = pr.number;
    detail = null;
    const loaded = await loadPrDetail(pr.number);
    // Guard against a slower earlier request landing after the user moved on.
    if (expanded === pr.number) detail = loaded;
  }

  function stateColor(pr: PullRequest): string {
    if (pr.state === "MERGED") return "text-purple-400";
    if (pr.state === "CLOSED") return "text-red-400";
    if (pr.isDraft) return "text-zinc-500";
    return "text-emerald-400";
  }

  function stateTitle(pr: PullRequest): string {
    if (pr.state === "MERGED") return "Merged";
    if (pr.state === "CLOSED") return "Closed without merging";
    if (pr.isDraft) return "Draft — not ready for review";
    return "Open";
  }

  /** Review state as a short word. gh returns "" for a repo that requires no
   *  review, which pr.ts already collapsed to null — that is "no reviews
   *  requested", not "not yet reviewed", so it renders as nothing at all. */
  function reviewLabel(decision: string | null): { text: string; color: string } | null {
    switch (decision) {
      case "APPROVED":
        return { text: "approved", color: "text-emerald-400" };
      case "CHANGES_REQUESTED":
        return { text: "changes requested", color: "text-red-400" };
      case "REVIEW_REQUIRED":
        return { text: "review required", color: "text-amber-400" };
      default:
        return null;
    }
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
          Pull Requests
          {#if prs.length}<span class="text-zinc-600">({prs.length})</span>{/if}
        </h2>
      {:else}
        <button
          class="flex items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
          title={$prPanelOpen
            ? "Hide pull requests (also stops checking GitHub)"
            : "Show pull requests (checks GitHub)"}
          onclick={() => prPanelOpen.update((v) => !v)}
        >
          <span class="text-[9px]">{$prPanelOpen ? "▼" : "▶"}</span>
          Pull Requests
          {#if $prPanelOpen && prs.length}<span class="text-zinc-600">({prs.length})</span>{/if}
        </button>
      {/if}
      <div class="flex flex-1 items-center justify-end gap-1">
        {#if $prPanelOpen}
          {#if $prCache.loading}
            <span class="font-mono text-[10px] text-zinc-600">checking…</span>
          {/if}
          {#if !problem && $gitStatus && !$gitStatus.detached}
            {#if $gitStatus.ahead > 0 || !$gitStatus.hasUpstream}
              <button
                class="rounded px-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
                title="git push --set-upstream origin {$gitStatus.branch}"
                onclick={push}
              >↑ Push</button>
            {/if}
            {#if !$currentPr}
              <button
                class="rounded px-1 text-[10px] font-semibold text-emerald-400 hover:bg-zinc-800"
                title="Open a pull request for {$gitStatus.branch}"
                onclick={() => (creating = true)}
              >+ PR</button>
            {/if}
          {/if}
          <button
            class="rounded px-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400 disabled:opacity-40"
            title="Check GitHub for pull requests now"
            disabled={$prCache.loading}
            onclick={() => refreshPrs(true)}
          >⟳</button>
        {/if}
      </div>
    </div>

    {#if $prPanelOpen && actionError}
      <div class="mx-1 mb-1 flex items-start gap-1 rounded-md border border-red-500/40 bg-red-950/40 px-2 py-1">
        <p class="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[10px] text-red-300">{actionError}</p>
        <button
          class="shrink-0 rounded px-1 text-[10px] text-red-300/70 hover:bg-red-500/20 hover:text-red-200"
          title="Dismiss"
          onclick={() => (actionError = null)}
        >✕</button>
      </div>
    {/if}

    {#if $prPanelOpen}
      {#if problem}
        <!-- Each failure mode gets its own next step. A shared "something went
             wrong" would leave the user with nothing to do. -->
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
                title="Open a shell pane so you can run the sign-in command"
                onclick={() => addPane(null, "Shell")}
              >Open a shell</button>
              <button
                class="font-mono text-[11px] text-zinc-500 hover:text-zinc-300"
                title="Copy the sign-in command"
                onclick={() => copy("gh auth login", "auth")}
              >{copied === "auth" ? "copied" : "gh auth login ⧉"}</button>
            </div>
          {:else if problem.kind === "notGitHub"}
            <p class="text-[11px] text-zinc-400">
              This repository's remote isn't on GitHub, so there are no pull
              requests to show here. Everything else in Termax works normally.
            </p>
          {:else if problem.kind === "noRemote"}
            <p class="text-[11px] text-zinc-400">
              This repository has no remote yet. Add one to open pull requests.
            </p>
          {:else}
            <p class="text-[11px] text-zinc-400">GitHub couldn't be reached.</p>
            <p class="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] text-red-300">{problem.message}</p>
          {/if}
        </div>
      {:else if prs.length === 0}
        <p class="px-1 pb-1 text-[11px] text-zinc-600">
          {$prCache.fetchedAt === 0 ? "Checking GitHub…" : "No open pull requests."}
        </p>
      {/if}

      <div class="min-h-0 overflow-y-auto {fill ? 'flex-1' : 'max-h-72'}">
        {#each prs as pr (pr.number)}
          {@const isCurrent = $currentPr?.number === pr.number}
          {@const review = reviewLabel(pr.reviewDecision)}
          {@const bound = groupForBranch(pr.headRefName)}
          <div class="rounded-md {isCurrent ? 'bg-emerald-500/10' : ''}">
            <button
              class="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-zinc-800/70"
              title="#{pr.number}: {pr.title}&#10;{pr.baseRefName} ← {pr.headRefName}&#10;by {pr
                .author.login}{isCurrent ? '\nThis is the branch you have checked out' : ''}"
              onclick={() => toggleRow(pr)}
            >
              <span class="shrink-0 font-mono text-[10px] {stateColor(pr)}" title={stateTitle(pr)}>●</span>
              <span class="shrink-0 font-mono text-[10px] font-semibold text-zinc-500">#{pr.number}</span>
              <span class="min-w-0 flex-1 truncate text-[11px] text-zinc-300">{pr.title}</span>
              {#if review}
                <span class="shrink-0 text-[9px] {review.color}" title="Review: {review.text}">◆</span>
              {/if}
              <span class="shrink-0 text-[8px] text-zinc-600">{expanded === pr.number ? "▾" : "▸"}</span>
            </button>

            {#if expanded === pr.number}
              <div class="mb-1 ml-4 flex flex-col gap-1 border-l border-zinc-800 pl-2">
                <p class="font-mono text-[10px] text-zinc-500">
                  <span class="text-zinc-400">{pr.headRefName}</span> → {pr.baseRefName}
                </p>
                <p class="text-[10px] text-zinc-500">
                  by {pr.author.login}{pr.isDraft ? " · draft" : ""}{pr.isCrossRepository
                    ? " · from a fork"
                    : ""}
                </p>

                {#if detail}
                  {@const c = detail.checks}
                  {#if c.passed + c.failed + c.pending + c.skipped > 0}
                    <p class="font-mono text-[10px]">
                      {#if c.failed}<span class="text-red-400">{c.failed} failed</span>{/if}
                      {#if c.pending}<span class="text-amber-400">{c.failed ? " · " : ""}{c.pending} running</span>{/if}
                      {#if c.passed}<span class="text-emerald-500">{c.failed || c.pending ? " · " : ""}{c.passed} passed</span>{/if}
                      {#if c.skipped}<span class="text-zinc-600"> · {c.skipped} skipped</span>{/if}
                    </p>
                    {#if c.failing.length}
                      <p class="break-words font-mono text-[10px] text-red-300/80">{c.failing.join(", ")}</p>
                    {/if}
                  {/if}
                  {#if detail.mergeable === "CONFLICTING"}
                    <p class="text-[10px] text-red-400">Conflicts with {pr.baseRefName}.</p>
                  {:else if detail.mergeStateStatus === "BLOCKED"}
                    <p class="text-[10px] text-amber-400">Blocked — branch protection isn't satisfied yet.</p>
                  {:else if detail.mergeStateStatus === "BEHIND"}
                    <p class="text-[10px] text-amber-400">Behind {pr.baseRefName} — needs updating first.</p>
                  {/if}
                {:else}
                  <p class="text-[10px] text-zinc-600">Loading details…</p>
                {/if}

                <div class="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
                  <button
                    class="rounded bg-emerald-600/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-600/30 disabled:opacity-40"
                    title={bound
                      ? "Switch to the worktree already working on this"
                      : `Create a worktree for ${pr.headRefName} and open ${prLauncher?.name ?? "a shell"} in a new tab`}
                    disabled={busyPr !== null}
                    onclick={() => startWork(pr)}
                  >{busyPr === pr.number ? "Working…" : bound ? "Go to it" : "Start work"}</button>

                  {#if pr.isDraft}
                    <button
                      class="text-[10px] text-zinc-400 hover:text-emerald-300 disabled:opacity-40"
                      title="Take this pull request out of draft"
                      disabled={busyPr !== null}
                      onclick={() => markReady(pr)}
                    >Mark ready</button>
                  {/if}

                  <button
                    class="text-[10px] text-purple-300 hover:underline disabled:opacity-40"
                    title="Check whether this can merge, then merge it"
                    disabled={busyPr !== null}
                    onclick={() => (merging = pr)}
                  >Merge…</button>

                  <button
                    class="text-[10px] text-zinc-500 hover:text-red-300 disabled:opacity-40"
                    title="Close without merging"
                    disabled={busyPr !== null}
                    onclick={() => closePr(pr)}
                  >Close</button>

                  <button
                    class="text-[10px] text-emerald-400 hover:underline"
                    title="Open this pull request on GitHub"
                    onclick={() => ipc.openUrl(pr.url)}
                  >GitHub ↗</button>

                  <button
                    class="text-[10px] text-zinc-500 hover:text-zinc-300"
                    title="Copy the branch name"
                    onclick={() => copy(pr.headRefName, `b${pr.number}`)}
                  >{copied === `b${pr.number}` ? "copied" : "Copy branch"}</button>

                  <!-- Escape hatch: the terminal is a better log viewer than a
                       256px sidebar, and gh already streams. -->
                  <button
                    class="text-[10px] text-zinc-500 hover:text-zinc-300"
                    title="Type `gh pr checks --watch` into a pane (you press Enter)"
                    onclick={() => sendToPane(`gh pr checks ${pr.number} --watch`)}
                  >Watch checks</button>
                  <button
                    class="text-[10px] text-zinc-500 hover:text-zinc-300"
                    title="Type `gh pr diff` into a pane (you press Enter)"
                    onclick={() => sendToPane(`gh pr diff ${pr.number}`)}
                  >Diff</button>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>

      {#if $gitStatus && !$gitStatus.detached && !$currentPr && prs.length > 0}
        <p class="px-1 pb-1 text-[10px] text-zinc-600">
          No pull request for <span class="font-mono text-zinc-500">{$gitStatus.branch}</span>.
        </p>
      {/if}
    {/if}
  </div>
{/if}
<!-- No `{:else}`: without a git-mode session there are no pull requests, and the
     Changes panel already explains why (no repo, or an untrusted folder). A
     second empty state here would just repeat it. -->

{#if creating}
  <CreatePrModal onclose={() => (creating = false)} />
{/if}
{#if merging}
  <MergePrDialog pr={merging} onclose={() => (merging = null)} />
{/if}

