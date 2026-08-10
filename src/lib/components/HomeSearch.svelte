<script lang="ts">
  /** Global search across every registered project: file names and file text.
   *
   *  This is the home screen's second door. The first is "I know which project
   *  I want"; this one is "I know a filename, a function, a string in an error
   *  message" — which, for someone who works across a dozen checkouts, is more
   *  often how a session actually starts. */
  import { clearSearch, MIN_QUERY, matchesProject, queueSearch, searchQuery, searchResult, searching } from "../home";
  import type { Project, SearchHit } from "../types";

  let {
    projects,
    onopenproject,
    onopenhit,
  }: {
    projects: Project[];
    onopenproject: (project: Project) => void;
    onopenhit: (hit: SearchHit) => void;
  } = $props();

  /** Result caps. The screen does not scroll, so the list is cut to what fits
   *  and says how much it cut — better than a scrollbar that hides the rest. */
  const MAX_PROJECTS = 4;
  const MAX_FILES = 6;
  const MAX_TEXT = 8;

  let input = $state<HTMLInputElement | null>(null);
  /** Index into {@link rows}; -1 means "no selection", where Enter does nothing
   *  rather than guessing. */
  let cursor = $state(-1);

  const query = $derived($searchQuery.trim());
  const active = $derived(query.length >= MIN_QUERY);

  const projectMatches = $derived(
    active ? projects.filter((p) => matchesProject(p, query)).slice(0, MAX_PROJECTS) : [],
  );
  const files = $derived(($searchResult?.files ?? []).slice(0, MAX_FILES));
  const text = $derived(($searchResult?.text ?? []).slice(0, MAX_TEXT));

  const hiddenFiles = $derived(Math.max(0, ($searchResult?.files.length ?? 0) - files.length));
  const hiddenText = $derived(Math.max(0, ($searchResult?.text.length ?? 0) - text.length));

  /** One flat list so the arrow keys can walk the whole panel, not each
   *  section separately. */
  type Row =
    | { kind: "project"; project: Project }
    | { kind: "hit"; hit: SearchHit };
  const rows: Row[] = $derived([
    ...projectMatches.map((project) => ({ kind: "project", project }) as Row),
    ...files.map((hit) => ({ kind: "hit", hit }) as Row),
    ...text.map((hit) => ({ kind: "hit", hit }) as Row),
  ]);

  $effect(() => {
    // Any change to the result set invalidates the old position.
    rows.length;
    cursor = -1;
  });

  export function focus() {
    input?.focus();
    input?.select();
  }

  function choose(row: Row) {
    if (row.kind === "project") onopenproject(row.project);
    else onopenhit(row.hit);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) clearSearch();
      else input?.blur();
      return;
    }
    if (!rows.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor = (cursor + 1) % rows.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = cursor <= 0 ? rows.length - 1 : cursor - 1;
    } else if (e.key === "Enter") {
      e.preventDefault();
      // No selection yet: Enter takes the first row, which is what "I typed a
      // project name and hit return" means.
      choose(rows[cursor >= 0 ? cursor : 0]);
    }
  }

  /** Split a line around the match so the hit itself can be highlighted.
   *  Case-insensitive, plain substring — the same matching the backend did. */
  function parts(line: string): [string, string, string] {
    const index = line.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) return [line, "", ""];
    return [
      line.slice(0, index),
      line.slice(index, index + query.length),
      line.slice(index + query.length),
    ];
  }

  function rowIndexOfHit(hit: SearchHit): number {
    return rows.findIndex((row) => row.kind === "hit" && row.hit === hit);
  }
</script>

<div class="relative w-full">
  <div
    class="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2
           transition-colors focus-within:border-emerald-500/60"
  >
    <span class="font-mono text-xs text-emerald-400">&gt;</span>
    <input
      bind:this={input}
      class="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none
             placeholder:text-zinc-600"
      type="text"
      spellcheck="false"
      autocomplete="off"
      placeholder="Search projects, files and text…"
      value={$searchQuery}
      oninput={(e) => queueSearch(e.currentTarget.value)}
      onkeydown={onKeydown}
    />
    {#if $searching}
      <span class="animate-pulse font-mono text-[10px] text-zinc-500">scanning…</span>
    {:else if $searchQuery}
      <button
        class="rounded px-1 text-xs text-zinc-500 hover:text-zinc-200"
        title="Clear (Esc)"
        onclick={() => {
          clearSearch();
          focus();
        }}
      >✕</button>
    {:else}
      <kbd class="rounded border border-zinc-700 px-1 font-mono text-[10px] text-zinc-500">Ctrl K</kbd>
    {/if}
  </div>

  {#if active}
    <div
      class="absolute inset-x-0 top-full z-40 mt-1 overflow-hidden rounded-lg border
             border-zinc-800 bg-zinc-900 shadow-2xl"
    >
      {#if projectMatches.length}
        <p class="border-b border-zinc-800 px-3 py-1 font-mono text-[10px] text-zinc-500">projects</p>
        {#each projectMatches as project, index (project.id)}
          <button
            class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left
                   {cursor === index ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'}"
            onmouseenter={() => (cursor = index)}
            onclick={() => onopenproject(project)}
          >
            <span class="shrink-0 text-xs font-medium text-zinc-100">{project.name}</span>
            <span class="truncate font-mono text-[10px] text-zinc-500">{project.path}</span>
          </button>
        {/each}
      {/if}

      {#if files.length}
        <p class="border-y border-zinc-800 px-3 py-1 font-mono text-[10px] text-zinc-500">
          files{hiddenFiles ? ` · ${hiddenFiles} more` : ""}
        </p>
        {#each files as hit (hit.projectId + hit.path)}
          {@const index = rowIndexOfHit(hit)}
          <button
            class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left
                   {cursor === index ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'}"
            onmouseenter={() => (cursor = index)}
            onclick={() => onopenhit(hit)}
          >
            <span class="shrink-0 font-mono text-[10px] text-emerald-400">{hit.projectName}</span>
            <span class="truncate font-mono text-[11px] text-zinc-300">{hit.path}</span>
          </button>
        {/each}
      {/if}

      {#if text.length}
        <p class="border-y border-zinc-800 px-3 py-1 font-mono text-[10px] text-zinc-500">
          text{hiddenText ? ` · ${hiddenText} more` : ""}
        </p>
        {#each text as hit (hit.projectId + hit.path + hit.line)}
          {@const index = rowIndexOfHit(hit)}
          {@const segments = parts(hit.text ?? "")}
          <button
            class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left
                   {cursor === index ? 'bg-zinc-800' : 'hover:bg-zinc-800/60'}"
            onmouseenter={() => (cursor = index)}
            onclick={() => onopenhit(hit)}
          >
            <span class="shrink-0 font-mono text-[10px] text-emerald-400">{hit.projectName}</span>
            <span class="shrink-0 max-w-[38%] truncate font-mono text-[10px] text-zinc-500">
              {hit.path}:{hit.line}
            </span>
            <span class="truncate font-mono text-[11px] text-zinc-400">
              {segments[0]}<mark class="bg-emerald-500/25 text-emerald-300">{segments[1]}</mark>{segments[2]}
            </span>
          </button>
        {/each}
      {/if}

      {#if !rows.length}
        <p class="px-3 py-3 text-center text-xs text-zinc-500">
          {$searching ? "Searching…" : "No matches"}
        </p>
      {/if}

      {#if $searchResult?.skipped.length}
        <p class="border-t border-zinc-800 px-3 py-1 text-[10px] text-amber-400/80">
          Skipped (folder missing): {$searchResult.skipped.join(", ")}
        </p>
      {/if}
    </div>
  {/if}
</div>
