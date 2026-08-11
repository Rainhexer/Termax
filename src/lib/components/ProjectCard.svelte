<script lang="ts">
  /** One project, drawn as a folder.
   *
   *  The card has to answer "what state did I leave this in?" before you open
   *  it, so every mark on it carries data: the chips are the languages the
   *  checkout is actually made of, the grid is four weeks of commits, and the
   *  counters are the working tree. Nothing here is a placeholder shape.
   *
   *  The card does not reflow. Its slot is a fixed aspect ratio (see
   *  HomeScreen) and the three bands below — identity, signals, flap — are laid
   *  out top-to-bottom with fixed room, so a project's numbers stay in the same
   *  place at every window size instead of drifting as the grid resizes. */
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
  import { topLanguages } from "../languages";
  import type { Project, ProjectStats } from "../types";
  import ActivityGrid from "./ActivityGrid.svelte";
  import LangMark from "./LangMark.svelte";

  let {
    project,
    stats,
    pending = false,
    renaming = false,
    onopen,
    onmenu,
    onrename,
    oncancelrename,
    onopenurl,
    ontrust,
    onrelink,
  }: {
    project: Project;
    stats?: ProjectStats;
    pending?: boolean;
    renaming?: boolean;
    onopen: () => void;
    onmenu: (e: MouseEvent) => void;
    onrename: (name: string) => void;
    oncancelrename: () => void;
    onopenurl: (url: string) => void;
    ontrust: () => void;
    onrelink: () => void;
  } = $props();

  const accent = $derived(accentFor(project.path));
  const tone = $derived(ACCENT_CLASSES[accent]);

  const dirty = $derived(dirtyCount(stats));
  const series = $derived(activitySeries(stats?.activity ?? []));
  const commits = $derived(stats?.recentCommits ?? []);
  /** Two lines, always. A count derived from the measured height is what used
   *  to make two identical projects disagree about how much history they had. */
  const shown = $derived(commits.slice(0, 2));
  const languages = $derived(topLanguages(stats?.extensions ?? []));

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

  const host = $derived(stats?.remoteUrl ? stats.remoteUrl.replace(/^https:\/\//, "") : null);
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

  /** Button clicks inside the card must not also open the project. */
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

  <!-- Folder back. A column, so every band gets the room it asked for and the
       flap is pinned to the bottom without absolute positioning. -->
  <div
    class="absolute inset-x-0 bottom-0 top-2 flex flex-col justify-between overflow-hidden
           rounded-lg rounded-tl-none border border-zinc-800 bg-gradient-to-b from-zinc-800
           to-zinc-900 shadow-lg transition-colors group-hover:border-zinc-700 {tone.glow}"
  >
    <!-- Identity. What you read first, on its own with nothing beside it. -->
    <div class="shrink-0 px-4 pt-2.5">
      {#if renaming}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="w-full rounded border border-emerald-500/60 bg-zinc-950 px-2 py-1 text-[15px]
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
        <div class="flex items-center gap-2">
          {#if project.pinned}
            <span class="{tone.text} shrink-0 text-[11px]" title="Pinned to home">◆</span>
          {/if}
          <h3 class="min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight text-zinc-100">
            {project.name}
          </h3>
          <span
            class="shrink-0 font-mono text-xs {verdict.cls} {pending ? 'animate-pulse' : ''}"
            title={verdict.label}
          >{verdict.glyph} {verdict.label}</span>
        </div>
      {/if}
      <p class="mt-1 truncate font-mono text-[11px] leading-tight text-zinc-500" title={project.path}>
        {prettyPath(project.path)}
      </p>
    </div>

    <!-- Signals. Languages on the left, four weeks of commits on the right;
         both are pictures rather than numbers, which is why they share a row. -->
    <div class="flex shrink-0 items-start justify-between gap-3 px-4">
      <div class="flex min-w-0 items-start gap-2">
        {#each languages as lang (lang.name)}
          <LangMark {lang} />
        {/each}
        {#if !languages.length}
          <span class="font-mono text-[10px] text-zinc-600">
            {stats && !stats.trusted ? "language mix not read" : "no code detected"}
          </span>
        {/if}
      </div>

      {#if stats?.isRepo}
        <div class="flex shrink-0 flex-col items-end gap-1">
          <ActivityGrid {series} {accent} cell={7} gap={2} layout="weeks-as-rows" empty="bg-zinc-950/50" />
          <span class="font-mono text-[9px] leading-none text-zinc-600">28d</span>
        </div>
      {/if}
    </div>

    <!-- Recent history. Dimmer than the identity above it: context, not headline. -->
    {#if shown.length}
      <div class="shrink-0 border-t border-zinc-800/70 px-4 py-1.5">
        {#each shown as entry, index (entry.sha)}
          <div class="flex items-baseline gap-2 overflow-hidden py-px">
            <span class="shrink-0 font-mono text-[10px] text-zinc-500">{entry.sha}</span>
            <span
              class="truncate text-[11px] {index === 0 ? 'text-zinc-300' : 'text-zinc-500'}"
              title={entry.subject}
            >{entry.subject}</span>
            <span
              class="ml-auto shrink-0 font-mono text-[10px] text-zinc-600"
              title="{entry.author} · {fullTime(entry.timestamp)}"
            >{relativeTime(entry.timestamp)}</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Front flap: translucent and blurred, exactly like the folder's front
         panel. Two rows, both fixed: git facts, then the ways out to the web. -->
    <div
      class="shrink-0 rounded-b-lg border-t border-white/10 bg-zinc-950/70 px-4 py-2
             backdrop-blur-[3px]"
    >
      {#if stats?.missing}
        <div class="flex items-center justify-between gap-2">
          <p class="min-w-0 truncate text-xs text-red-400">Folder is missing or unmounted</p>
          <button
            class="h-7 shrink-0 rounded-md border border-red-400/40 px-2.5 text-xs text-red-300
                   hover:bg-red-400/10"
            title="Point this project at the folder it now lives in"
            onclick={chip(onrelink)}
          >Relink…</button>
        </div>
      {:else if stats && !stats.trusted}
        <div class="flex items-center justify-between gap-2">
          <p class="truncate text-xs text-amber-400">Not trusted — git is off</p>
          <button
            class="h-7 shrink-0 rounded-md border border-amber-400/40 px-2.5 text-xs text-amber-300
                   hover:bg-amber-400/10"
            onclick={chip(ontrust)}
          >Trust folder</button>
        </div>
      {:else}
        <div class="flex items-center gap-2 font-mono text-[11px]">
          {#if stats?.branch}
            <span
              class="min-w-0 truncate rounded px-1.5 py-0.5 {tone.fill} {tone.text}"
              title={stats.detached ? "Detached HEAD" : `On branch ${stats.branch}`}
            >{stats.detached ? "◇" : "⑂"} {stats.branch}</span>
          {:else if stats && !stats.isRepo}
            <span class="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-500">not a repo</span>
          {:else}
            <span class="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-600">····</span>
          {/if}
          {#if stats && stats.ahead > 0}
            <span class="shrink-0 text-blue-400" title="{stats.ahead} commits to push">↑{stats.ahead}</span>
          {/if}
          {#if stats && stats.behind > 0}
            <span class="shrink-0 text-blue-400" title="{stats.behind} commits to pull">↓{stats.behind}</span>
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

          <!-- Working tree, in terminal shorthand; tooltips spell it out. -->
          <span class="ml-auto flex shrink-0 items-center gap-2">
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
          </span>
        </div>

        <!-- Links out. Sized as real buttons: these are the only things on the
             card you are meant to hit, and hitting one by accident opens a
             browser, so they get labels and a 28px target rather than a glyph. -->
        <div class="mt-1.5 flex items-center gap-1.5">
          {#if stats?.remoteUrl}
            <button
              class="flex h-7 items-center gap-1.5 rounded-md border border-zinc-700/70 px-2.5
                     text-[11px] text-zinc-400 hover:border-zinc-600 hover:bg-zinc-800
                     hover:text-zinc-100"
              title="Open {host}"
              onclick={chip(() => onopenurl(stats.remoteUrl!))}
            ><span class="font-mono">⌂</span> Repo</button>
            {#if issuesUrl}
              <button
                class="flex h-7 items-center gap-1.5 rounded-md border border-zinc-700/70 px-2.5
                       text-[11px] text-zinc-400 hover:border-amber-400/50 hover:bg-amber-400/10
                       hover:text-amber-300"
                title="Open issues on {host}"
                onclick={chip(() => onopenurl(issuesUrl))}
              ><span class="font-mono">⊙</span> Issues</button>
            {/if}
            {#if pullsUrl}
              <button
                class="flex h-7 items-center gap-1.5 rounded-md border border-zinc-700/70 px-2.5
                       text-[11px] text-zinc-400 hover:border-purple-400/50 hover:bg-purple-400/10
                       hover:text-purple-300"
                title="Open pull requests on {host}"
                onclick={chip(() => onopenurl(pullsUrl))}
              ><span class="font-mono">⇄</span> PRs</button>
            {/if}
          {:else}
            <!-- The row keeps its height with no remote, so a card with one and
                 a card without still line up beside each other. -->
            <span class="flex h-7 items-center font-mono text-[11px] text-zinc-600">no remote</span>
          {/if}

          {#if stats?.agentDocs?.length}
            <span
              class="ml-auto flex h-7 shrink-0 items-center rounded-md bg-emerald-500/10 px-2
                     font-mono text-[10px] text-emerald-400"
              title="Agent instructions present: {stats.agentDocs.join(', ')}"
            >agents</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
