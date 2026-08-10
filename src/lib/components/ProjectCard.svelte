<script lang="ts">
  /** One project, drawn as a folder.
   *
   *  The card has to answer "what state did I leave this in?" before you open
   *  it, so every decoration carries data: the paper slips peeking out of the
   *  folder are the last three commits, the grid is four weeks of activity, and
   *  the counters are the working tree. Nothing here is a placeholder shape. */
  import {
    ACCENT_CLASSES,
    accentFor,
    activitySeries,
    dirtyCount,
    fullTime,
    prettyPath,
    relativeTime,
    repoSubPage,
  } from "../home";
  import type { Project, ProjectStats } from "../types";
  import ActivityGrid from "./ActivityGrid.svelte";

  let {
    project,
    stats,
    pending = false,
    height,
    renaming = false,
    onopen,
    onmenu,
    onrename,
    oncancelrename,
    onopenurl,
    ontrust,
  }: {
    project: Project;
    stats?: ProjectStats;
    pending?: boolean;
    /** Measured slot height; the card degrades rather than overflowing. */
    height: number;
    renaming?: boolean;
    onopen: () => void;
    onmenu: (e: MouseEvent) => void;
    onrename: (name: string) => void;
    oncancelrename: () => void;
    onopenurl: (url: string) => void;
    ontrust: () => void;
  } = $props();

  const accent = $derived(accentFor(project.path));
  const tone = $derived(ACCENT_CLASSES[accent]);

  /** Two degradation steps rather than a scrollbar: the home screen fits on one
   *  screen by dropping detail, in the order you'd drop it yourself. */
  const compact = $derived(height < 158);
  const tiny = $derived(height < 128);

  /** The flap is a fixed height, not a percentage: its contents are two rows of
   *  fixed-size text, so a percentage either starves them on a short card or
   *  leaves a band of nothing on a tall one. Whatever height is left over goes
   *  to the identity zone, which has something to do with it — one more commit. */
  const flapHeight = $derived(tiny ? 40 : compact ? 46 : 56);

  const dirty = $derived(dirtyCount(stats));
  const series = $derived(activitySeries(stats?.activity ?? []));
  const commits = $derived(stats?.recentCommits ?? []);
  const commit = $derived(commits[0] ?? null);

  /** How many commit lines the identity zone can hold: its height, less the
   *  name and path, divided by a line. */
  const commitLines = $derived(
    Math.max(0, Math.min(commits.length, Math.floor((height - 8 - flapHeight - 34) / 14))),
  );

  /** The one-word verdict, and its colour. Order is severity: a conflict
   *  outranks being behind, which outranks having edits.
   *
   *  Named `verdict` rather than `state`: a `$`-prefixed identifier is store
   *  syntax in a template, so `{state.glyph}` would be read as a subscription. */
  const verdict = $derived.by(() => {
    if (!stats) return { glyph: "…", label: "reading", cls: "text-zinc-500" };
    if (stats.missing) return { glyph: "✕", label: "missing", cls: "text-red-400" };
    if (!stats.trusted) return { glyph: "▲", label: "untrusted", cls: "text-amber-400" };
    if (!stats.isRepo) return { glyph: "○", label: "no git", cls: "text-zinc-500" };
    if (stats.conflicts > 0) return { glyph: "!", label: "conflict", cls: "text-red-400" };
    if (dirty > 0) return { glyph: "*", label: "changes", cls: "text-amber-400" };
    if (stats.behind > 0) return { glyph: "↓", label: "behind", cls: "text-blue-400" };
    if (stats.ahead > 0) return { glyph: "↑", label: "ahead", cls: "text-blue-400" };
    return { glyph: "✓", label: "clean", cls: "text-emerald-400" };
  });

  /** Paper slips = recent commits. Three of them when there is history, one
   *  hollow slip when there is not, so the folder silhouette survives an empty
   *  or untrusted project. */
  const slips = $derived(commits.length ? commits.map((_, i) => i) : [0]);

  const host = $derived(
    stats?.remoteUrl ? stats.remoteUrl.replace(/^https:\/\//, "") : null,
  );
  const issuesUrl = $derived(repoSubPage(stats?.remoteUrl ?? null, "issues"));
  const pullsUrl = $derived(repoSubPage(stats?.remoteUrl ?? null, "pulls"));

  // Seeded from the prop and re-seeded every time the rename field opens, so
  // the "initial value only" caveat does not apply: by the time the input is
  // rendered the effect below has already re-run.
  // svelte-ignore state_referenced_locally
  let renameValue = $state(project.name);
  $effect(() => {
    if (renaming) renameValue = project.name;
  });

  function commitRename() {
    const name = renameValue.trim();
    if (name && name !== project.name) onrename(name);
    else oncancelrename();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onopen();
    }
  }

  /** Chip clicks must not also open the project. */
  function chip(action: () => void) {
    return (e: MouseEvent) => {
      e.stopPropagation();
      action();
    };
  }
</script>

<div
  class="group relative h-full w-full cursor-pointer text-left outline-none
         transition-transform duration-150 hover:-translate-y-0.5
         focus-visible:-translate-y-0.5"
  role="button"
  tabindex="0"
  title={`${project.name}\n${project.path}`}
  onclick={onopen}
  onkeydown={onKeydown}
  oncontextmenu={(e) => {
    e.preventDefault();
    onmenu(e);
  }}
>
  <!-- Folder tab, drawn inside the card's box so a grid gap never clips it.
       Carries the project's identity colour: at a glance across a full grid,
       the tab is what tells two similarly-named checkouts apart. -->
  <div
    class="absolute left-0 top-0 h-2.5 w-2/5 rounded-t-md border border-b-0 border-zinc-800
           {tone.tab}"
  ></div>

  <!-- Folder back: everything else stacks on this. -->
  <div
    class="absolute inset-x-0 bottom-0 top-2 overflow-hidden rounded-lg rounded-tl-none
           border border-zinc-800 bg-gradient-to-b from-zinc-800 to-zinc-900 shadow-lg
           transition-colors group-hover:border-zinc-700 {tone.glow}"
  >
    <!-- Commit slips: the last commits, peeking out from behind the flap the
         way paper does out of a folder. Sized to tuck under it, so they read as
         texture from across the room and as "there is history here" up close. -->
    <div class="pointer-events-none absolute right-2 top-1.5 h-9 w-11">
      {#each slips as index (index)}
        <div
          class="absolute right-0 top-0 h-8 w-10 rounded-[2px] border
                 {commit
            ? 'border-zinc-500/50 bg-zinc-300/70'
            : 'border-dashed border-zinc-700 bg-transparent'}"
          style="transform: rotate({-7 + index * 6}deg) translateX({index * -3}px);
                 z-index: {slips.length - index}"
        >
          {#if commit && index === 0}
            <div class="flex flex-col gap-[3px] p-1.5">
              <div class="h-px w-6 rounded bg-zinc-500/70"></div>
              <div class="h-px w-7 rounded bg-zinc-500/50"></div>
              <div class="h-px w-4 rounded bg-zinc-500/50"></div>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Identity zone. Sits above the flap and holds what you read first. -->
    <div class="relative px-3 pt-2">
      <div class="flex items-start gap-2 pr-16">
        <div class="min-w-0 flex-1">
          {#if renaming}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="w-full rounded border border-emerald-500/60 bg-zinc-950 px-1.5 py-0.5 text-sm
                     font-semibold text-zinc-100 outline-none"
              autofocus
              bind:value={renameValue}
              onclick={(e) => e.stopPropagation()}
              onkeydown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") oncancelrename();
              }}
              onblur={commitRename}
            />
          {:else}
            <div class="flex items-center gap-1.5">
              {#if project.pinned}
                <span class="{tone.text} shrink-0 text-[10px]" title="Pinned to home">◆</span>
              {/if}
              <h3 class="truncate text-sm font-semibold leading-tight text-zinc-100">
                {project.name}
              </h3>
              <span
                class="shrink-0 font-mono text-[11px] {verdict.cls} {pending ? 'animate-pulse' : ''}"
                title={verdict.label}
              >{verdict.glyph}</span>
            </div>
          {/if}
          <p class="truncate font-mono text-[10px] leading-tight text-zinc-500" title={project.path}>
            {prettyPath(project.path)}
          </p>
        </div>
      </div>

      {#if commitLines > 0}
        <!-- What you were last doing here: the most useful thing on the card, so
             it gets the open space rather than the crowded flap. The newest line
             is brightest — the rest are context for it. -->
        <div class="mt-1 flex flex-col gap-px pr-1">
          {#each commits.slice(0, commitLines) as entry, index (entry.sha)}
            <div class="flex items-baseline gap-1.5 overflow-hidden {index === 0 ? '' : 'pr-16'}">
              <span class="shrink-0 font-mono text-[10px] text-zinc-600">{entry.sha}</span>
              <span
                class="truncate text-[10px] {index === 0 ? 'text-zinc-300' : 'text-zinc-500'}"
                title={entry.subject}
              >{entry.subject}</span>
              <span
                class="ml-auto shrink-0 font-mono text-[10px] text-zinc-600"
                title="{entry.author} · {fullTime(entry.timestamp)}"
              >{relativeTime(entry.timestamp)}</span>
            </div>
          {/each}
        </div>
      {:else if stats?.isRepo && !commits.length && !tiny}
        <p class="mt-1 text-[10px] text-zinc-600">No commits yet</p>
      {/if}
    </div>

    <!-- Front flap: translucent and blurred, exactly like the folder's front
         panel. Every row is shrink-0 — a flex row that is allowed to shrink
         collapses to nothing when the flap is short, taking its content with
         it, which is silent data loss rather than a layout bug. -->
    <div
      class="absolute inset-x-0 bottom-0 flex flex-col justify-center gap-1
             rounded-b-lg border-t border-white/10 bg-zinc-950/70 px-3
             backdrop-blur-[3px]"
      style="height: {flapHeight}px"
    >
      {#if stats?.missing}
        <p class="shrink-0 truncate text-[11px] text-red-400">Folder is missing or unmounted</p>
      {:else if stats && !stats.trusted}
        <div class="flex shrink-0 items-center justify-between gap-2">
          <p class="truncate text-[11px] text-amber-400">Not trusted — git is off</p>
          <button
            class="shrink-0 rounded border border-amber-400/40 px-1.5 py-0.5 text-[10px]
                   text-amber-300 hover:bg-amber-400/10"
            onclick={chip(ontrust)}
          >Trust</button>
        </div>
      {:else}
        <!-- Two columns: the git facts read left to right, while the activity
             grid and the links out hold the right edge. On a wide card this is
             what keeps the middle of the flap from being a hole. -->
        <div class="flex items-end gap-3">
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <!-- Branch and divergence. -->
            <div class="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
              {#if stats?.branch}
                <span
                  class="min-w-0 truncate rounded px-1 py-px {tone.fill} {tone.text}"
                  title={stats.detached ? "Detached HEAD" : `On branch ${stats.branch}`}
                >{stats.detached ? "◇" : "⑂"} {stats.branch}</span>
              {:else if stats && !stats.isRepo}
                <span class="shrink-0 rounded bg-zinc-800 px-1 py-px text-zinc-500">not a repo</span>
              {:else}
                <span class="shrink-0 rounded bg-zinc-800 px-1 py-px text-zinc-600">····</span>
              {/if}
              {#if stats && stats.ahead > 0}
                <span class="shrink-0 text-blue-400" title="{stats.ahead} commits to push">
                  ↑{stats.ahead}
                </span>
              {/if}
              {#if stats && stats.behind > 0}
                <span class="shrink-0 text-blue-400" title="{stats.behind} commits to pull">
                  ↓{stats.behind}
                </span>
              {/if}
              {#if stats?.isRepo && stats.upstream === null && !stats.detached}
                <span class="shrink-0 text-zinc-600" title="No upstream branch set">⊘</span>
              {/if}
              {#if stats && stats.worktrees > 0}
                <span
                  class="shrink-0 text-purple-400"
                  title="{stats.worktrees} linked worktree{stats.worktrees === 1 ? '' : 's'}"
                >⊞{stats.worktrees}</span>
              {/if}
              <span class="ml-auto flex shrink-0 items-center gap-1">
                {#if stats?.agentDocs?.length}
                  <span
                    class="rounded bg-emerald-500/15 px-1 text-emerald-400"
                    title="Agent instructions present: {stats.agentDocs.join(', ')}"
                  >agents</span>
                {/if}
                {#each (stats?.stack ?? []).slice(0, 2) as tag (tag)}
                  <span class="rounded bg-zinc-800 px-1 text-zinc-400">{tag}</span>
                {/each}
              </span>
            </div>

            <!-- Working tree, in terminal shorthand; tooltips spell it out. -->
            <div class="flex shrink-0 items-center gap-2 font-mono text-[10px]">
              {#if !stats}
                <span class="text-zinc-700">····</span>
              {:else if dirty === 0}
                <span class="text-emerald-400" title="Working tree clean">✓ clean</span>
              {:else}
                {#if stats.staged > 0}
                  <span class="text-blue-400" title="{stats.staged} staged">+{stats.staged}</span>
                {/if}
                {#if stats.unstaged > 0}
                  <span class="text-amber-400" title="{stats.unstaged} modified">~{stats.unstaged}</span>
                {/if}
                {#if stats.untracked > 0}
                  <span class="text-zinc-400" title="{stats.untracked} untracked">?{stats.untracked}</span>
                {/if}
                {#if stats.conflicts > 0}
                  <span class="text-red-400" title="{stats.conflicts} conflicted">!{stats.conflicts}</span>
                {/if}
              {/if}
            </div>
          </div>

          <!-- Right edge: where this project lives on the web, and how alive it
               has been over the last four weeks. -->
          <div class="flex shrink-0 flex-col items-end gap-1">
            {#if stats?.remoteUrl}
              <span class="flex shrink-0 items-center gap-0.5 font-mono text-[10px]">
                <button
                  class="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
                  title="Open {host}"
                  onclick={chip(() => onopenurl(stats.remoteUrl!))}
                >⌂</button>
                {#if issuesUrl}
                  <button
                    class="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-amber-400"
                    title="Open issues on {host}"
                    onclick={chip(() => onopenurl(issuesUrl))}
                  >⊙</button>
                {/if}
                {#if pullsUrl}
                  <button
                    class="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-purple-400"
                    title="Open pull requests on {host}"
                    onclick={chip(() => onopenurl(pullsUrl))}
                  >⇄</button>
                {/if}
              </span>
            {/if}
            {#if !compact && stats?.isRepo}
              <ActivityGrid {series} {accent} cell={4} gap={1} />
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
