<script lang="ts">
  /** Merge a pull request, behind a preflight report rather than a yes/no confirm.
   *
   *  A merge button is where "simple" turns into "I merged the wrong thing", and
   *  GitHub's refusals (branch protection, required checks, merge queues) arrive
   *  as opaque errors *after* the click. So this asks GitHub what it would do
   *  first, shows the answer, and refuses to enable the button when the answer is
   *  no — naming which condition blocked it. On an unexpected failure it shows
   *  gh's stderr verbatim, because that is where the real detail lives.
   */
  import { ipc } from "../ipc";
  import { activeRoot, flashGitMessage } from "../stores";
  import { forgetSettledPr, loadPrDetail, refreshPrs } from "../pr";
  import { removeWorktree, worktreeRows } from "../worktrees";
  import type { PrDetail, PullRequest } from "../types";

  let { pr, onclose }: { pr: PullRequest; onclose: () => void } = $props();

  type Method = "squash" | "rebase" | "merge";
  let method = $state<Method>("squash");
  let deleteBranch = $state(false);
  let removeTree = $state(false);
  let detail = $state<PrDetail | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** Set once GitHub has accepted the merge. The merge is not repeatable, so
   *  the button must not stay live if the cleanup that follows it fails. */
  let merged = $state(false);

  /** The worktree this pull request was built in, if it still exists.
   *
   *  Merging is the moment its reason to exist ends, which is why the offer to
   *  clean it up belongs here — beside "delete the branch", the decision it
   *  rhymes with — rather than in a list that sits in the sidebar afterwards
   *  waiting to be noticed. */
  const tree = $derived(
    $worktreeRows.find(
      (row) => !row.isMain && row.state !== "missing" && row.branch === pr.headRefName,
    ) ?? null,
  );

  $effect(() => {
    void load();
  });

  async function load() {
    loading = true;
    detail = await loadPrDetail(pr.number);
    loading = false;
  }

  /** Why merging is refused, or null when it is allowed.
   *
   *  `mergeStateStatus` — not `mergeable` — is what catches branch protection: a
   *  pull request can be MERGEABLE and BLOCKED at the same time. */
  const blocker = $derived.by(() => {
    if (!detail) return "Checking with GitHub…";
    if (detail.isDraft) return "This is a draft. Mark it ready for review first.";
    if (detail.mergeable === "CONFLICTING")
      return `It conflicts with ${pr.baseRefName} and has to be resolved first.`;
    switch (detail.mergeStateStatus) {
      case "BLOCKED":
        return "Branch protection isn't satisfied yet (a required review or check).";
      case "BEHIND":
        return `It's behind ${pr.baseRefName} and has to be updated first.`;
      case "DIRTY":
        return "GitHub reports the merge as dirty and won't accept it.";
      case "DRAFT":
        return "This is a draft. Mark it ready for review first.";
      default:
        return null;
    }
  });

  const checks = $derived(detail?.checks ?? null);

  const reviewText = $derived.by(() => {
    switch (detail?.reviewDecision) {
      case "APPROVED":
        return { text: "Approved", color: "text-emerald-400" };
      case "CHANGES_REQUESTED":
        return { text: "Changes requested", color: "text-red-400" };
      case "REVIEW_REQUIRED":
        return { text: "Review required", color: "text-amber-400" };
      default:
        return { text: "No review required", color: "text-zinc-500" };
    }
  });

  async function merge() {
    if (blocker || busy || merged) return;
    busy = true;
    error = null;
    try {
      await ipc.ghPrMerge(pr.number, method, deleteBranch, $activeRoot ?? undefined);
      merged = true;
      flashGitMessage(`Merged #${pr.number}`);
    } catch (err) {
      error = String(err);
      busy = false;
      return;
    }

    // The branch's pull request just stopped being open, so the cached "no
    // settled PR for this branch" is now wrong — and it is what tells the
    // worktree panel this tree is finished with.
    forgetSettledPr(pr.headRefName);

    if (removeTree && tree) {
      const problem = await removeWorktree(tree.path);
      if (problem) {
        // The merge itself succeeded; only the cleanup did not. Say so, and
        // leave the dialog open rather than closing on a half-done action.
        error = `Merged #${pr.number}, but the worktree could not be removed:\n\n${problem}`;
        busy = false;
        await refreshPrs(true);
        return;
      }
    }

    busy = false;
    await refreshPrs(true);
    onclose();
  }

  /** The equivalent command, for the escape hatch. */
  const command = $derived(
    `gh pr merge ${pr.number} --${method}${deleteBranch ? " --delete-branch" : ""}`,
  );

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      flashGitMessage("Command copied");
    } catch (err) {
      error = String(err);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- The click-to-dismiss backdrop is a real <button>, not a div with a click
     handler: keyboard-reachable and announced, so no a11y suppression is needed.
     It sits behind the panel and is labelled for screen readers. -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
  <button class="absolute inset-0 cursor-default" aria-label="Close dialog" onclick={onclose}></button>
  <div
    class="relative flex max-h-[88vh] w-[520px] max-w-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
  >
    <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
      <h2 class="min-w-0 truncate text-sm font-semibold text-zinc-100">
        Merge #{pr.number} — {pr.title}
      </h2>
      <button class="shrink-0 rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onclick={onclose}>✕</button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <p class="font-mono text-[11px] text-zinc-500">
        <span class="text-zinc-300">{pr.headRefName}</span> → {pr.baseRefName}
      </p>

      {#if loading}
        <p class="text-[12px] text-zinc-500">Asking GitHub whether this can merge…</p>
      {:else if !detail}
        <p class="text-[12px] text-red-300">
          GitHub couldn't be asked about this pull request, so merging is disabled.
        </p>
      {:else}
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt class="text-zinc-500">Review</dt>
          <dd class={reviewText.color}>{reviewText.text}</dd>

          <dt class="text-zinc-500">Checks</dt>
          <dd>
            {#if checks && checks.passed + checks.failed + checks.pending + checks.skipped > 0}
              {#if checks.failed}<span class="text-red-400">{checks.failed} failed</span>{/if}
              {#if checks.pending}<span class="text-amber-400">{checks.failed ? " · " : ""}{checks.pending} running</span>{/if}
              {#if checks.passed}<span class="text-emerald-500">{checks.failed || checks.pending ? " · " : ""}{checks.passed} passed</span>{/if}
              {#if checks.skipped}<span class="text-zinc-600"> · {checks.skipped} skipped</span>{/if}
            {:else}
              <span class="text-zinc-600">none</span>
            {/if}
          </dd>

          <dt class="text-zinc-500">Mergeable</dt>
          <dd class={detail.mergeable === "MERGEABLE" ? "text-emerald-400" : "text-amber-400"}>
            {detail.mergeable === "UNKNOWN" ? "GitHub is still computing this" : detail.mergeable.toLowerCase()}
            <span class="text-zinc-600">({detail.mergeStateStatus.toLowerCase()})</span>
          </dd>
        </dl>

        {#if checks?.failing.length}
          <p class="break-words font-mono text-[10px] text-red-300/80">Failing: {checks.failing.join(", ")}</p>
        {/if}

        <div class="flex flex-col gap-1">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Method</span>
          <div class="flex gap-1">
            {#each ["squash", "rebase", "merge"] as m (m)}
              <button
                class="flex-1 rounded-md px-2 py-1 text-[12px] capitalize transition-colors {method === m
                  ? 'bg-zinc-800 text-emerald-400 ring-1 ring-emerald-500/40'
                  : 'text-zinc-400 hover:bg-zinc-800/60'}"
                onclick={() => (method = m as Method)}
              >{m}</button>
            {/each}
          </div>
        </div>

        <label class="flex items-center gap-2 text-[12px] text-zinc-300">
          <input type="checkbox" bind:checked={deleteBranch} class="accent-emerald-500" />
          Delete <span class="font-mono text-[11px]">{pr.headRefName}</span> after merging
        </label>

        {#if tree}
          <label class="flex items-start gap-2 text-[12px] text-zinc-300">
            <input type="checkbox" bind:checked={removeTree} class="mt-0.5 accent-emerald-500" />
            <span class="min-w-0">
              Remove its worktree{tree.tabs.length
                ? ` and close ${tree.tabs.length} tab${tree.tabs.length === 1 ? "" : "s"}`
                : ""}
              <span class="block break-all font-mono text-[10px] text-zinc-600">{tree.path}</span>
              <!-- Refused rather than forced, so a tree holding the only copy of
                   something survives the click. -->
              <span class="block text-[10px] text-zinc-600">
                Kept if it has uncommitted changes or a running pane.
              </span>
            </span>
          </label>
        {/if}

        {#if blocker}
          <p class="rounded-md border border-amber-500/40 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-300">
            {blocker}
          </p>
        {/if}

        {#if error}
          <div class="rounded-md border border-red-500/40 bg-red-950/40 px-2 py-1.5">
            <p class="text-[11px] font-semibold text-red-300">
              {merged ? "The merge landed; the cleanup didn't." : "GitHub refused the merge."}
            </p>
            <p class="mt-0.5 whitespace-pre-wrap break-words font-mono text-[10px] text-red-300/80">{error}</p>
          </div>
        {/if}
      {/if}
    </div>

    <div class="flex items-center justify-between gap-2 border-t border-zinc-800 px-4 py-3">
      <button
        class="font-mono text-[10px] text-zinc-500 hover:text-zinc-300"
        title={`Copy: ${command}`}
        onclick={copyCommand}
      >Copy command ⧉</button>
      <div class="flex items-center gap-2">
        <button class="rounded-md px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-zinc-800" onclick={onclose}>
          Cancel
        </button>
        <button
          class="rounded-md bg-purple-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-purple-500 disabled:opacity-40"
          disabled={busy || loading || merged || !!blocker}
          title={blocker ?? `gh pr merge ${pr.number} --${method}`}
          onclick={merge}
        >{merged ? "Merged" : busy ? "Merging…" : `Merge (${method})`}</button>
      </div>
    </div>
  </div>
</div>
