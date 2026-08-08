<script lang="ts">
  /** Open a new issue.
   *
   *  Unlike `CreatePrModal`, this one *does* offer labels, assignees and a
   *  milestone. The reasoning that kept them out of the pull-request form does
   *  not transfer: a PR is created once from a branch you are standing on and
   *  reviewed on the website minutes later, whereas an issue is often filed and
   *  then never looked at again outside a list — an unlabelled, unassigned issue
   *  is the one that gets lost. The pickers are the repository's real values, so
   *  this cannot produce a label that does not exist.
   */
  import { ipc } from "../ipc";
  import { activeRoot, flashGitMessage } from "../stores";
  import { loadRepoMeta, refreshIssues, repoMeta } from "../issues";
  import LabelChip from "./LabelChip.svelte";

  let {
    onclose,
    oncreated = null,
  }: { onclose: () => void; oncreated?: ((number: number) => void) | null } = $props();

  let title = $state("");
  let body = $state("");
  let labels = $state<string[]>([]);
  let assignees = $state<string[]>([]);
  let milestone = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let showLabels = $state(false);
  let showAssignees = $state(false);

  const meta = $derived($repoMeta);

  $effect(() => {
    // The panel loads this on open, but the modal can be reached before that
    // finishes — and an empty picker with no explanation looks broken.
    void loadRepoMeta();
  });

  function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  async function submit() {
    if (!title.trim() || busy) return;
    busy = true;
    error = null;
    try {
      const url = await ipc.ghIssueCreate(
        title.trim(),
        body,
        labels,
        assignees,
        milestone || undefined,
        $activeRoot ?? undefined,
      );
      // gh prints the new issue's URL and nothing more machine-readable, so the
      // number comes from its last path segment.
      const number = Number(url.split("/").pop());
      flashGitMessage(Number.isFinite(number) ? `Opened issue #${number}` : "Issue opened");
      await refreshIssues(true);
      if (Number.isFinite(number) && oncreated) oncreated(number);
      onclose();
    } catch (err) {
      error = String(err);
    } finally {
      busy = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
    // Ctrl/Cmd+Enter submits from inside the textarea, where plain Enter is a
    // newline and the button is a long way from the hands.
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void submit();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
  <button class="absolute inset-0 cursor-default" aria-label="Close dialog" onclick={onclose}></button>
  <div
    class="relative flex max-h-[88vh] w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
  >
    <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
      <h2 class="text-sm font-semibold text-zinc-100">New issue</h2>
      <button class="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onclick={onclose}>✕</button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <label class="flex flex-col gap-1">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Title</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="rounded bg-zinc-900 px-2 py-1.5 text-[13px] text-zinc-100 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
          bind:value={title}
          autofocus
          placeholder="What's the problem?"
        />
      </label>

      <label class="flex min-h-0 flex-col gap-1">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Description</span>
        <textarea
          class="h-44 resize-none rounded bg-zinc-900 px-2 py-1.5 font-mono text-[12px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
          bind:value={body}
          placeholder="Steps to reproduce, what you expected, what happened. Markdown works."
        ></textarea>
      </label>

      <div class="flex flex-col gap-2">
        <!-- Labels -->
        <div class="flex flex-col gap-1">
          <button
            class="flex items-center gap-1 self-start text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
            onclick={() => (showLabels = !showLabels)}
          >
            <span class="text-[9px]">{showLabels ? "▼" : "▶"}</span>
            Labels
            {#if labels.length}<span class="text-zinc-600">({labels.length})</span>{/if}
          </button>
          {#if labels.length && !showLabels}
            <div class="flex flex-wrap gap-1">
              {#each labels as name (name)}
                {@const found = meta.labels.find((l) => l.name === name)}
                <LabelChip {name} color={found?.color ?? "999999"} />
              {/each}
            </div>
          {/if}
          {#if showLabels}
            {#if meta.labels.length === 0}
              <p class="text-[11px] text-zinc-600">
                {meta.loaded ? "This repository has no labels." : "Loading labels…"}
              </p>
            {:else}
              <div class="flex max-h-32 flex-wrap gap-1 overflow-y-auto rounded border border-zinc-800 bg-zinc-900/60 p-1.5">
                {#each meta.labels as label (label.name)}
                  <LabelChip
                    name={label.name}
                    color={label.color}
                    active={labels.includes(label.name)}
                    title={label.description || label.name}
                    onclick={() => (labels = toggle(labels, label.name))}
                  />
                {/each}
              </div>
            {/if}
          {/if}
        </div>

        <!-- Assignees -->
        <div class="flex flex-col gap-1">
          <button
            class="flex items-center gap-1 self-start text-[11px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
            onclick={() => (showAssignees = !showAssignees)}
          >
            <span class="text-[9px]">{showAssignees ? "▼" : "▶"}</span>
            Assignees
            {#if assignees.length}<span class="text-zinc-600">({assignees.length})</span>{/if}
          </button>
          {#if assignees.length && !showAssignees}
            <p class="font-mono text-[10px] text-zinc-400">{assignees.join(", ")}</p>
          {/if}
          {#if showAssignees}
            <div class="flex flex-wrap gap-1">
              {#if meta.me}
                <button
                  class="rounded-full px-2 py-0.5 text-[10px] {assignees.includes(meta.me)
                    ? 'bg-emerald-600/30 text-emerald-200'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}"
                  onclick={() => (assignees = toggle(assignees, meta.me!))}
                >{meta.me} (you)</button>
              {/if}
              {#each meta.assignees.filter((a) => a.login !== meta.me) as user (user.login)}
                <button
                  class="rounded-full px-2 py-0.5 font-mono text-[10px] {assignees.includes(user.login)
                    ? 'bg-emerald-600/30 text-emerald-200'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}"
                  onclick={() => (assignees = toggle(assignees, user.login))}
                >{user.login}</button>
              {/each}
              {#if meta.assignees.length === 0 && !meta.me}
                <p class="text-[11px] text-zinc-600">
                  {meta.loaded ? "No assignable users." : "Loading…"}
                </p>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Milestone -->
        {#if meta.milestones.length}
          <label class="flex items-center gap-2">
            <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Milestone</span>
            <select
              class="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
              bind:value={milestone}
            >
              <option value="">None</option>
              {#each meta.milestones as m (m.number)}
                <option value={m.title}>{m.title}{m.state === "closed" ? " (closed)" : ""}</option>
              {/each}
            </select>
          </label>
        {/if}
      </div>

      {#if error}
        <div class="rounded-md border border-red-500/40 bg-red-950/40 px-2 py-1.5">
          <p class="whitespace-pre-wrap break-words font-mono text-[10px] text-red-300">{error}</p>
        </div>
      {/if}
    </div>

    <div class="flex items-center justify-between gap-2 border-t border-zinc-800 px-4 py-3">
      <span class="text-[10px] text-zinc-600">⌘/Ctrl + Enter to submit</span>
      <div class="flex items-center gap-2">
        <button class="rounded-md px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-zinc-800" onclick={onclose}>
          Cancel
        </button>
        <button
          class="rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          disabled={busy || !title.trim()}
          onclick={submit}
        >{busy ? "Opening…" : "Open issue"}</button>
      </div>
    </div>
  </div>
</div>
