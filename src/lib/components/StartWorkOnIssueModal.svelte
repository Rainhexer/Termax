<script lang="ts">
  /** Hand an issue to a coding agent.
   *
   *  A dialog rather than a one-click button, unlike the pull-request flow.
   *  Starting work on a PR is unambiguous — the branch exists and the agent's
   *  job is "review or continue this". An issue has neither: *which* agent, on
   *  *what* branch, told *what*, are three real decisions, and getting any of
   *  them wrong wastes an agent run. So they are shown, prefilled with the
   *  answer that is right most of the time, and left editable.
   *
   *  What the confirmation buys is visible up front: the exact prompt the agent
   *  will receive, and a warning if someone already has a branch for this issue.
   */
  import { activeProject, flashGitMessage } from "../stores";
  import { enabledLaunchers, launcherById, settings, DEFAULT_ISSUE_PROMPT } from "../settings";
  import { branchNameForIssue, renderIssuePrompt, startWorkOnIssue } from "../worktrees";
  import { ipc } from "../ipc";
  import { linkedBranches, loadIssueDetail } from "../issues";
  import type { Issue } from "../types";

  let { issue, onclose }: { issue: Issue; onclose: () => void } = $props();

  const launchers = $derived(enabledLaunchers($settings));

  /** Default agent: the issue-specific setting, else the pull-request one, else
   *  the first launcher that actually runs something. */
  const defaultLauncherId = $derived.by(() => {
    const behavior = $settings.behavior;
    const configured = behavior.issueLauncherId || behavior.prLauncherId;
    if (configured && launchers.some((l) => l.id === configured)) return configured;
    return (launchers.find((l) => l.command !== null) ?? launchers[0])?.id ?? "shell";
  });

  let launcherId = $state("");
  let branch = $state("");
  let base = $state("");
  let prompt = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** Branches GitHub already has linked to this issue. */
  let existing = $state<string[] | null>(null);
  let bodyLoaded = $state(false);

  const launcher = $derived(launcherById(launcherId || defaultLauncherId));
  /** A plain shell gets no prompt: there is nothing there to read it. */
  const isShell = $derived(launcher?.command === null);

  // Keyed on the issue rather than run once, because Svelte reuses this
  // component when the panel swaps one issue for another: seeding the fields at
  // declaration would leave the previous issue's branch name in the box.
  $effect(() => {
    const number = issue.number;
    // Synchronous reset first, so the form never shows the last issue's values
    // during the fetch below.
    branch = branchNameForIssue(number, issue.title);
    prompt = "";
    existing = null;
    bodyLoaded = false;

    void (async () => {
      // The list has no body — too expensive to fetch per row — but the prompt
      // is far more useful with it, so it is pulled once here.
      const [detail, branches] = await Promise.all([
        loadIssueDetail(number),
        linkedBranches(number),
      ]);
      // Guard against a slower earlier request landing after the user moved on.
      if (number !== issue.number) return;
      existing = branches;
      // Read after the await, which is deliberately outside the effect's
      // tracked scope: editing the template in settings must not wipe a prompt
      // the user has already started rewriting here.
      const template = $settings.behavior.issuePromptTemplate.trim() || DEFAULT_ISSUE_PROMPT;
      prompt = renderIssuePrompt(template, {
        number,
        title: issue.title,
        url: issue.url,
        body: detail?.body ?? "",
      });
      bodyLoaded = true;
      // Adopting a branch GitHub already linked beats making a second one for
      // the same issue, so it becomes the default when there is exactly one.
      if (branches.length === 1) branch = branches[0];
    })();
  });

  async function start() {
    const project = $activeProject;
    if (!project || busy) return;
    busy = true;
    error = null;
    const problem = await startWorkOnIssue({
      projectPath: project.path,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      branch: branch.trim(),
      base: base.trim() || undefined,
      launch: launcher?.command ?? null,
      launcherName: launcher?.name ?? "Shell",
      prompt: isShell ? undefined : prompt,
    });
    busy = false;
    if (problem) {
      error = problem;
      return;
    }
    flashGitMessage(`#${issue.number} → ${launcher?.name ?? "a shell"} on ${branch.trim()}`);
    onclose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && !busy) onclose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
  <button class="absolute inset-0 cursor-default" aria-label="Close dialog" onclick={onclose}></button>
  <div
    class="relative flex max-h-[88vh] w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
  >
    <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-zinc-100">Start work on #{issue.number}</h2>
        <p class="truncate text-[11px] text-zinc-500">{issue.title}</p>
      </div>
      <button class="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onclick={onclose}>✕</button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <!-- Agent -->
      <div class="flex flex-col gap-1">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Agent</span>
        <div class="flex flex-wrap gap-1.5">
          {#each launchers as option (option.id)}
            <button
              class="rounded-md px-2 py-1 text-[11px] {(launcherId || defaultLauncherId) === option.id
                ? 'bg-emerald-600/25 text-emerald-200 ring-1 ring-emerald-500/40'
                : 'bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200'}"
              title={option.command ?? "A plain shell — no prompt is sent"}
              onclick={() => (launcherId = option.id)}
            >{option.name}</button>
          {/each}
        </div>
      </div>

      <!-- Branch -->
      <div class="flex flex-col gap-1">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Branch</span>
        <div class="flex items-center gap-1.5">
          <input
            class="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
            bind:value={branch}
            placeholder="branch name"
          />
          <span class="shrink-0 text-[10px] text-zinc-600">from</span>
          <input
            class="w-28 shrink-0 rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
            bind:value={base}
            placeholder="default"
          />
        </div>
        <p class="text-[10px] text-zinc-600">
          Created on GitHub and linked to this issue, so merging its pull request
          closes the issue automatically.
        </p>
        {#if existing?.length}
          <p class="rounded-md border border-amber-500/40 bg-amber-950/30 px-2 py-1 text-[10px] text-amber-300">
            {existing.length === 1 ? "A branch is" : `${existing.length} branches are`} already
            linked to this issue: <span class="font-mono">{existing.join(", ")}</span>.
            {existing.length === 1 ? "It's selected above — someone may be on this already." : ""}
          </p>
        {/if}
      </div>

      <!-- Prompt -->
      {#if isShell}
        <p class="rounded-md border border-zinc-700 bg-zinc-900/60 px-2 py-1.5 text-[11px] text-zinc-400">
          A shell gets no prompt — the worktree and tab are still created, and
          you can launch whatever you like inside it.
        </p>
      {:else}
        <label class="flex min-h-0 flex-col gap-1">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Prompt for {launcher?.name}
          </span>
          <textarea
            class="h-40 resize-none rounded bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
            bind:value={prompt}
            placeholder={bodyLoaded ? "" : "Reading the issue…"}
          ></textarea>
          <!-- The honest description of what happens: Termax auto-runs nothing,
               including this. -->
          <span class="text-[10px] text-zinc-600">
            Typed into {launcher?.name} but not sent — you press Enter.
          </span>
        </label>
      {/if}

      {#if error}
        <div class="rounded-md border border-red-500/40 bg-red-950/40 px-2 py-1.5">
          <p class="whitespace-pre-wrap break-words font-mono text-[10px] text-red-300">{error}</p>
        </div>
      {/if}
    </div>

    <div class="flex items-center justify-between gap-2 border-t border-zinc-800 px-4 py-3">
      <button
        class="text-[11px] text-zinc-500 hover:text-zinc-300"
        title="Open this issue on GitHub"
        onclick={() => ipc.openUrl(issue.url)}
      >View on GitHub ↗</button>
      <div class="flex items-center gap-2">
        <button class="rounded-md px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-zinc-800" onclick={onclose}>
          Cancel
        </button>
        <button
          class="rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          disabled={busy || !branch.trim()}
          onclick={start}
        >{busy ? "Setting up…" : `Start in ${launcher?.name ?? "a shell"}`}</button>
      </div>
    </div>
  </div>
</div>
