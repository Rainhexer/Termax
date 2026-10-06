<script lang="ts">
  /** Open a pull request for the checked-out branch.
   *
   *  Four fields, deliberately. Reviewers, labels, assignees, milestones and
   *  templates are absent — this is not trying to be a worse `gh pr create`. When
   *  the user needs any of that there is one button that hands the whole thing to
   *  the browser, and their agent is one pane away with the full CLI.
   */
  import { ipc } from "../ipc";
  import { activeRoot, changes, createBranch, gitStatus, flashGitMessage } from "../stores";
  import { refreshPrs } from "../pr";

  let { onclose }: { onclose: () => void } = $props();

  let title = $state("");
  let body = $state("");
  let base = $state("");
  let draft = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let prefilling = $state(true);

  const status = $derived($gitStatus);
  const branch = $derived(status && !status.detached ? status.branch : null);
  /** `gh pr create` pushes when the branch has no upstream. Saying so up front is
   *  the difference between a tool and a surprise. */
  const willPush = $derived(!!status && (!status.hasUpstream || status.ahead > 0));

  /** A pull request needs two different branches. Being on the default branch is
   *  the single most common way to arrive here and be unable to continue, so it
   *  gets a fix rather than an error: name a branch and go. */
  const sameBranch = $derived(!!branch && branch === base.trim());

  /** Changes a pull request will *not* contain. A PR is made of commits, so
   *  uncommitted work is invisible to it — worth saying when there is a lot of it,
   *  because the natural assumption is the opposite. */
  const uncommitted = $derived($changes.filter((c) => c.area !== "untracked").length);

  let newBranch = $state("");
  let branching = $state(false);

  /** Suggest a branch name from the title the user is already writing. */
  const suggestedBranch = $derived(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40),
  );

  async function branchOff() {
    const name = (newBranch.trim() || suggestedBranch).trim();
    if (!name || branching) return;
    branching = true;
    error = null;
    try {
      await createBranch(name);
      newBranch = "";
    } catch (err) {
      error = String(err);
    } finally {
      branching = false;
    }
  }

  $effect(() => {
    void prefill();
  });

  async function prefill() {
    try {
      const root = $activeRoot ?? undefined;
      const defaultBranch = (await ipc.gitDefaultBranch()) ?? "main";
      base = defaultBranch;
      const subjects = await ipc.gitCommitSubjects(defaultBranch, 30, root);
      // A single commit makes a better title than a body; several make a list.
      if (subjects.length === 1) {
        title = subjects[0];
      } else if (subjects.length > 1) {
        title = subjects[subjects.length - 1];
        body = subjects.map((s) => `- ${s}`).join("\n");
      }
    } catch (err) {
      // Prefilling is a convenience. Failing it should not block the form.
      console.debug("could not prefill the pull request", err);
    } finally {
      prefilling = false;
    }
  }

  async function submit() {
    if (!title.trim() || !base.trim() || busy) return;
    busy = true;
    error = null;
    try {
      const url = await ipc.ghPrCreate(
        title.trim(),
        body,
        base.trim(),
        draft,
        $activeRoot ?? undefined,
      );
      flashGitMessage(draft ? "Draft pull request created" : "Pull request created");
      await refreshPrs(true);
      if (url) void ipc.openUrl(url).catch(() => {});
      onclose();
    } catch (err) {
      error = String(err);
    } finally {
      busy = false;
    }
  }

  function openInBrowser() {
    const remote = status?.remoteUrl;
    if (!remote || !branch) return;
    const head = branch.split("/").map(encodeURIComponent).join("/");
    const target = base.split("/").map(encodeURIComponent).join("/");
    void ipc.openUrl(`${remote}/compare/${target}...${head}?expand=1`).catch(() => {});
    onclose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- The click-to-dismiss backdrop is a real <button>, not a div with a click
     handler. That makes it keyboard-reachable and announced, so it needs no
     a11y suppression — unlike the `svelte-ignore` pattern used elsewhere in this
     codebase, which Svelte 5 no longer honours for these rules anyway. It sits
     behind the panel and is labelled for screen readers. -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
  <button class="absolute inset-0 cursor-default" aria-label="Close dialog" onclick={onclose}></button>
  <div
    class="relative flex max-h-[88vh] w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
  >
    <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
      <h2 class="text-sm font-semibold text-zinc-100">New pull request</h2>
      <button class="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onclick={onclose}>✕</button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      {#if !branch}
        <p class="text-[12px] text-amber-300">
          You're not on a branch (detached HEAD), so there's nothing to open a pull
          request from. Switch to a branch first.
        </p>
      {:else}
        <div class="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
          <span class="text-emerald-400">{branch}</span>
          <span>→</span>
          <input
            class="w-40 rounded bg-zinc-900 px-2 py-1 text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
            bind:value={base}
            placeholder="base branch"
          />
        </div>

        <label class="flex flex-col gap-1">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Title</span>
          <input
            class="rounded bg-zinc-900 px-2 py-1.5 text-[13px] text-zinc-100 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
            bind:value={title}
            placeholder={prefilling ? "Reading your commits…" : "What does this change?"}
          />
        </label>

        <label class="flex min-h-0 flex-col gap-1">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Description</span>
          <textarea
            class="h-40 resize-none rounded bg-zinc-900 px-2 py-1.5 font-mono text-[12px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
            bind:value={body}
            placeholder="Prefilled from your commit messages; edit freely."
          ></textarea>
        </label>

        <label class="flex items-center gap-2 text-[12px] text-zinc-300">
          <input type="checkbox" bind:checked={draft} class="accent-emerald-500" />
          Open as a draft
        </label>

        {#if sameBranch}
          <!-- GitHub cannot open a pull request from a branch onto itself. Rather
               than let the user fill in the form and be refused by gh, offer the
               step that unblocks them: a branch to put the work on. Uncommitted
               changes follow along, so nothing is lost. -->
          <div class="rounded-md border border-amber-500/40 bg-amber-950/30 px-2 py-2">
            <p class="text-[11px] text-amber-300">
              You're on <span class="font-mono">{branch}</span>, which is also the
              base. A pull request needs a separate branch to merge <em>from</em>.
            </p>
            <div class="mt-1.5 flex items-center gap-1.5">
              <input
                class="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
                bind:value={newBranch}
                placeholder={suggestedBranch || "new-branch-name"}
                onkeydown={(e) => e.key === "Enter" && branchOff()}
              />
              <button
                class="shrink-0 rounded bg-amber-500/20 px-2 py-1 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/30 disabled:opacity-40"
                disabled={branching || !(newBranch.trim() || suggestedBranch)}
                onclick={branchOff}
              >{branching ? "Creating…" : "Create branch"}</button>
            </div>
            <p class="mt-1 text-[10px] text-amber-300/70">
              Your {uncommitted} uncommitted change{uncommitted === 1 ? "" : "s"} come with you.
            </p>
          </div>
        {/if}

        {#if uncommitted > 0 && !sameBranch}
          <p class="rounded-md border border-zinc-700 bg-zinc-900/60 px-2 py-1.5 text-[11px] text-zinc-400">
            {uncommitted} uncommitted change{uncommitted === 1 ? "" : "s"} won't be in
            this pull request — it's made from your commits. Commit them first if
            they belong in it.
          </p>
        {/if}

        {#if willPush && !sameBranch}
          <p class="rounded-md border border-amber-500/40 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-300">
            This will push <span class="font-mono">{branch}</span> to origin
            {#if !status?.hasUpstream}(it has no upstream yet){/if}.
          </p>
        {/if}

        {#if error}
          <div class="rounded-md border border-red-500/40 bg-red-950/40 px-2 py-1.5">
            <p class="whitespace-pre-wrap break-words font-mono text-[10px] text-red-300">{error}</p>
          </div>
        {/if}
      {/if}
    </div>

    <div class="flex items-center justify-between gap-2 border-t border-zinc-800 px-4 py-3">
      <button
        class="text-[11px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
        title="Open GitHub's own form, with reviewers, labels and templates"
        disabled={!branch || !status?.remoteUrl}
        onclick={openInBrowser}
      >Open in browser instead ↗</button>
      <div class="flex items-center gap-2">
        <button class="rounded-md px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-zinc-800" onclick={onclose}>
          Cancel
        </button>
        <button
          class="rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          disabled={busy || !branch || !title.trim() || !base.trim() || sameBranch}
          title={sameBranch ? `${branch} can't be merged into itself — create a branch first` : ""}
          onclick={submit}
        >{busy ? "Creating…" : draft ? "Create draft" : "Create pull request"}</button>
      </div>
    </div>
  </div>
</div>
