<script lang="ts">
  /** Portfolio-level readouts: the state of *everything*, at a glance.
   *
   *  A per-project card answers "what did I leave here?". This strip answers the
   *  question you have before you have picked a project at all — where is the
   *  unfinished work, and did I actually ship anything this month. Each tile is
   *  a real aggregate; none of them are decoration with a number painted on. */
  import { dirtyCount, heatLevel, mergedActivity } from "../home";
  import { detectedAgents } from "../settings";
  import type { Project, ProjectStats } from "../types";
  import ActivityGrid from "./ActivityGrid.svelte";

  let {
    projects,
    stats,
    onfocusproject,
  }: {
    projects: Project[];
    /** Stats that have arrived; the tiles are meaningful while still filling in. */
    stats: ProjectStats[];
    /** Jump to the first project needing attention. */
    onfocusproject: (id: string) => void;
  } = $props();

  const staged = $derived(stats.reduce((n, s) => n + s.staged, 0));
  const unstaged = $derived(stats.reduce((n, s) => n + s.unstaged, 0));
  const untracked = $derived(stats.reduce((n, s) => n + s.untracked, 0));
  const conflicts = $derived(stats.reduce((n, s) => n + s.conflicts, 0));
  const changes = $derived(staged + unstaged + untracked + conflicts);

  const ahead = $derived(stats.reduce((n, s) => n + s.ahead, 0));
  const behind = $derived(stats.reduce((n, s) => n + s.behind, 0));

  /** Projects worth looking at before you pick one: a conflict, uncommitted
   *  work, commits that were never pushed, or a folder that has gone away.
   *  Being *behind* is not on this list — that is the remote's news, not
   *  unfinished work of yours. */
  const attention = $derived(
    stats.filter(
      (s) => s.missing || s.conflicts > 0 || dirtyCount(s) > 0 || s.ahead > 0,
    ),
  );
  /** Worst first: a conflict beats a big pile of edits, which beats a small
   *  one. Three is as many as the tile can list without becoming a second,
   *  worse copy of the grid above it. */
  const worstFirst = $derived(
    [...attention]
      .sort(
        (a, b) =>
          Number(b.conflicts > 0) - Number(a.conflicts > 0) ||
          dirtyCount(b) - dirtyCount(a),
      )
      .slice(0, 3),
  );

  function nameOf(id: string): string {
    return projects.find((p) => p.id === id)?.name ?? "project";
  }

  /** One-glyph summary of why a project is on the attention list. */
  function reason(s: ProjectStats): { glyph: string; detail: string } {
    if (s.missing) return { glyph: "✕", detail: "folder missing" };
    if (s.conflicts > 0) return { glyph: "!", detail: `${s.conflicts} conflicted` };
    if (dirtyCount(s) > 0) return { glyph: "*", detail: `${dirtyCount(s)} uncommitted` };
    return { glyph: "↑", detail: `${s.ahead} to push` };
  }

  const series = $derived(mergedActivity(stats));
  const commits = $derived(series.reduce((n, c) => n + c, 0));
  const best = $derived(series.reduce((max, c) => Math.max(max, c), 0));
  /** Days since the last commit anywhere; null when nothing is known yet. */
  const lastActive = $derived.by(() => {
    for (let i = series.length - 1; i >= 0; i--) if (series[i] > 0) return series.length - 1 - i;
    return null;
  });

  const untrusted = $derived(stats.filter((s) => !s.trusted && !s.missing).length);
  const agentReady = $derived(stats.filter((s) => s.agentDocs.length > 0).length);
  const worktrees = $derived(stats.reduce((n, s) => n + s.worktrees, 0));

  /** Proportional bar segments for the changes tile. Zero-width segments are
   *  dropped so a single-category total renders as one clean bar. */
  const segments = $derived(
    [
      { n: staged, cls: "bg-blue-400", label: "staged" },
      { n: unstaged, cls: "bg-amber-400", label: "modified" },
      { n: untracked, cls: "bg-zinc-500", label: "untracked" },
      { n: conflicts, cls: "bg-red-400", label: "conflicted" },
    ].filter((s) => s.n > 0),
  );
</script>

<div class="grid grid-cols-4 gap-2">
  <!-- Attention. Styled loudest on purpose: it is the only tile that ever
       asks you to do something. -->
  <div
    class="relative overflow-hidden rounded-lg border px-3 py-2
           {attention.length
      ? conflicts > 0
        ? 'border-red-500/40 bg-red-950/30'
        : 'border-amber-400/30 bg-amber-950/20'
      : 'border-zinc-800 bg-zinc-900/60'}"
  >
    <p class="font-mono text-[10px] uppercase tracking-wider text-zinc-500">needs attention</p>
    <div class="mt-0.5 flex items-baseline gap-1.5">
      <span
        class="text-2xl font-bold leading-none
               {attention.length ? (conflicts > 0 ? 'text-red-300' : 'text-amber-300') : 'text-emerald-400'}"
      >{attention.length}</span>
      <span class="text-[11px] text-zinc-500">
        of {projects.length} project{projects.length === 1 ? "" : "s"}
      </span>
    </div>
    {#if worstFirst.length}
      <div class="mt-1 flex flex-col gap-0.5">
        {#each worstFirst as project (project.id)}
          {@const why = reason(project)}
          <button
            class="flex w-full items-center gap-1.5 rounded border px-1.5 py-0.5 text-left
                   font-mono text-[10px]
                   {project.conflicts > 0 || project.missing
              ? 'border-red-500/40 text-red-300 hover:bg-red-500/10'
              : 'border-amber-400/30 text-amber-300 hover:bg-amber-400/10'}"
            title="Find {nameOf(project.id)} on the grid"
            onclick={() => onfocusproject(project.id)}
          >
            <span class="shrink-0">{why.glyph}</span>
            <span class="truncate">{nameOf(project.id)}</span>
            <span class="ml-auto shrink-0 text-zinc-500">{why.detail}</span>
          </button>
        {/each}
      </div>
    {:else}
      <p class="mt-1 font-mono text-[10px] text-emerald-400/80">✓ everything committed</p>
    {/if}
  </div>

  <!-- Uncommitted work, split by area. -->
  <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
    <p class="font-mono text-[10px] uppercase tracking-wider text-zinc-500">uncommitted</p>
    <div class="mt-0.5 flex items-baseline gap-1.5">
      <span class="text-2xl font-bold leading-none text-zinc-100">{changes}</span>
      <span class="text-[11px] text-zinc-500">file{changes === 1 ? "" : "s"}</span>
    </div>
    <div class="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-zinc-800">
      {#each segments as segment (segment.label)}
        <div
          class="{segment.cls} h-full"
          style="width: {(segment.n / changes) * 100}%"
          title="{segment.n} {segment.label}"
        ></div>
      {/each}
    </div>
    <p class="mt-1 flex gap-2 font-mono text-[10px] text-zinc-500">
      <span class="text-blue-400" title="staged">+{staged}</span>
      <span class="text-amber-400" title="modified">~{unstaged}</span>
      <span class="text-zinc-400" title="untracked">?{untracked}</span>
      {#if conflicts > 0}<span class="text-red-400" title="conflicted">!{conflicts}</span>{/if}
      <span class="ml-auto text-blue-400" title="{ahead} to push, {behind} to pull">
        ↑{ahead} ↓{behind}
      </span>
    </p>
  </div>

  <!-- Four weeks of commits across every project. -->
  <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
    <p class="font-mono text-[10px] uppercase tracking-wider text-zinc-500">commits · 28d</p>
    <div class="mt-0.5 flex items-baseline gap-1.5">
      <span class="text-2xl font-bold leading-none text-zinc-100">{commits}</span>
      <span class="text-[11px] text-zinc-500">
        {#if lastActive === null}
          no activity
        {:else if lastActive === 0}
          today
        {:else}
          last {lastActive}d ago
        {/if}
      </span>
    </div>
    <div class="mt-1.5">
      <ActivityGrid {series} accent="emerald" cell={4} gap={1} />
    </div>
    <p class="mt-1 font-mono text-[10px] text-zinc-500">
      best day {best} · level {heatLevel(best)}
    </p>
  </div>

  <!-- What this app is for: how much of the portfolio an agent can be pointed
       at without being briefed first. -->
  <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
    <p class="font-mono text-[10px] uppercase tracking-wider text-zinc-500">agent ready</p>
    <div class="mt-0.5 flex items-baseline gap-1.5">
      <span class="text-2xl font-bold leading-none text-emerald-400">{agentReady}</span>
      <span class="text-[11px] text-zinc-500">
        with AGENTS.md / CLAUDE.md
      </span>
    </div>
    <div class="mt-1.5 flex flex-wrap gap-1">
      {#each $detectedAgents.slice(0, 4) as agent (agent.binary)}
        <span
          class="rounded bg-zinc-800 px-1 font-mono text-[10px] text-purple-400"
          title="{agent.binary} detected on PATH{agent.version ? ` · ${agent.version}` : ''}"
        >{agent.binary}</span>
      {/each}
      {#if !$detectedAgents.length}
        <span class="font-mono text-[10px] text-zinc-600">no agents found on PATH</span>
      {/if}
    </div>
    <p class="mt-1 flex flex-wrap gap-x-2 font-mono text-[10px] text-zinc-500">
      <span title="Linked git worktrees across all projects">
        <span class="text-purple-400">{worktrees}</span> worktrees
      </span>
      {#if untrusted > 0}
        <span class="text-amber-400" title="Folders you have not trusted; git is off for these">
          {untrusted} untrusted
        </span>
      {/if}
    </p>
  </div>
</div>
