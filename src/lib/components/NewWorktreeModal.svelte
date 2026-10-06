<script lang="ts">
  /** Create a worktree for any branch.
   *
   *  Until this dialog a worktree could only appear as a side effect of starting
   *  work on a pull request or an issue, which meant the feature was unreachable
   *  for the ordinary case: a second checkout of a branch, to run the tests on
   *  while an agent keeps typing in the first one.
   *
   *  Three decisions, in the order they matter: which branch, what to base it on
   *  if it does not exist yet, and what to launch in the tab. The path is shown
   *  rather than asked for — `worktreePathFor` picks a sibling directory by a
   *  rule worth learning once, and letting people scatter trees across the disk
   *  buys nothing but support questions.
   */
  import { activeProject, flashGitMessage, loadBranches } from "../stores";
  import { enabledLaunchers, settings } from "../settings";
  import { branchesElsewhere, createWorktree, worktreePathFor } from "../worktrees";

  let { onclose }: { onclose: () => void } = $props();

  const launchers = $derived(enabledLaunchers($settings));

  /** Default: the pull-request launcher if one is configured, else a plain
   *  shell. Unlike the issue flow this dialog sends no prompt, so an agent is a
   *  choice rather than the obvious answer. */
  const defaultLauncherId = $derived.by(() => {
    const configured = $settings.behavior.prLauncherId;
    if (configured && launchers.some((l) => l.id === configured)) return configured;
    return launchers[0]?.id ?? "shell";
  });

  let launcherId = $state("");
  let branch = $state("");
  let base = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let known = $state<string[]>([]);

  const launcher = $derived(launchers.find((l) => l.id === (launcherId || defaultLauncherId)));
  const name = $derived(branch.trim());
  const exists = $derived(known.includes(name));
  /** Where the tree will land, so the convention is visible before it is used. */
  const path = $derived(name && $activeProject ? worktreePathFor($activeProject.path, name) : "");
  /** Git allows a branch in one worktree only, so this one would be refused —
   *  and `createWorktree` would jump to the holder instead of creating. Said up
   *  front rather than after the click. */
  const heldAt = $derived(name ? ($branchesElsewhere.get(name) ?? null) : null);

  $effect(() => {
    void loadBranches()
      .then((list) => (known = list))
      .catch(() => (known = []));
  });

  async function create() {
    const project = $activeProject;
    if (!project || busy || !name) return;
    busy = true;
    error = null;
    const problem = await createWorktree({
      projectPath: project.path,
      branch: name,
      // A base only means anything for a branch being created; passing one for
      // an existing branch would silently reset it.
      start: exists ? undefined : base.trim() || undefined,
      launch: launcher?.command ?? null,
      launcherName: launcher?.name ?? "Shell",
    });
    busy = false;
    if (problem) {
      error = problem;
      return;
    }
    flashGitMessage(`Worktree for ${name}`);
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
    class="relative flex max-h-[88vh] w-[520px] max-w-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
  >
    <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-zinc-100">New worktree</h2>
        <p class="truncate text-[11px] text-zinc-500">
          A second checkout of this repository, in its own tab.
        </p>
      </div>
      <button class="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onclick={onclose}>✕</button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div class="flex flex-col gap-1">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Branch</span>
        <div class="flex items-center gap-1.5">
          <input
            class="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
            list="worktree-branches"
            bind:value={branch}
            placeholder="branch name"
          />
          <datalist id="worktree-branches">
            {#each known as option (option)}<option value={option}></option>{/each}
          </datalist>
          {#if !exists}
            <span class="shrink-0 text-[10px] text-zinc-600">from</span>
            <input
              class="w-28 shrink-0 rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
              bind:value={base}
              placeholder="HEAD"
            />
          {/if}
        </div>
        <p class="text-[10px] text-zinc-600">
          {#if !name}
            Pick a branch, or type a new name to create one.
          {:else if exists}
            <span class="font-mono text-zinc-500">{name}</span> exists — it will be
            checked out here as it stands.
          {:else}
            <span class="font-mono text-zinc-500">{name}</span> will be created
            from <span class="font-mono text-zinc-500">origin/{name}</span> if the
            remote has it{base.trim()
              ? `, otherwise from ${base.trim()}`
              : ", otherwise from HEAD"}.
          {/if}
        </p>
        {#if heldAt}
          <p class="rounded-md border border-amber-500/40 bg-amber-950/30 px-2 py-1 text-[10px] text-amber-300">
            <span class="font-mono">{name}</span> is already checked out at
            <span class="font-mono">{heldAt}</span>. Git allows a branch in one
            worktree only, so this will take you there instead of making another.
          </p>
        {/if}
      </div>

      <div class="flex flex-col gap-1">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Open with</span>
        <div class="flex flex-wrap gap-1.5">
          {#each launchers as option (option.id)}
            <button
              class="rounded-md px-2 py-1 text-[11px] {(launcherId || defaultLauncherId) === option.id
                ? 'bg-emerald-600/25 text-emerald-200 ring-1 ring-emerald-500/40'
                : 'bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200'}"
              title={option.command ?? "A plain shell"}
              onclick={() => (launcherId = option.id)}
            >{option.name}</button>
          {/each}
        </div>
      </div>

      {#if path}
        <div class="flex flex-col gap-0.5">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Location</span>
          <p class="break-all font-mono text-[10px] text-zinc-500">{path}</p>
          <!-- The single most common surprise about worktrees, said before it
               bites: a fresh tree has no node_modules, no target/, no build. -->
          <p class="text-[10px] text-zinc-600">
            A sibling directory, so no gitignore entry is needed. It shares git
            history but not build output — the setup command from Settings is
            typed into a new pane for you to run.
          </p>
        </div>
      {/if}

      {#if error}
        <div class="rounded-md border border-red-500/40 bg-red-950/40 px-2 py-1.5">
          <p class="whitespace-pre-wrap break-words font-mono text-[10px] text-red-300">{error}</p>
        </div>
      {/if}
    </div>

    <div class="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
      <button class="rounded-md px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-zinc-800" onclick={onclose}>
        Cancel
      </button>
      <button
        class="rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        disabled={busy || !name}
        onclick={create}
      >{busy ? "Creating…" : heldAt ? "Go to worktree" : "Create worktree"}</button>
    </div>
  </div>
</div>
