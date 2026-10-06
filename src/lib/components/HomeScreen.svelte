<script lang="ts">
  /** The screen Termax opens on.
   *
   *  Termax is a place to run coding agents across several checkouts, so the
   *  home screen's job is not "list folders" — it is to get you into the right
   *  project already knowing what state it is in, or straight to a file you can
   *  name a fragment of. Everything on it serves one of those two paths.
   *
   *  It has no tabs: one screen, always the same shape, so the card you want is
   *  in the place you left it. Every project stays on the grid — a window that
   *  cannot hold them all scrolls rather than hiding any of them behind
   *  search. */
  import { open } from "@tauri-apps/plugin-dialog";
  import { addPane, loadProjects, openFile, openProject, projects } from "../stores";
  import { enabledLaunchers, settings, settingsOpen } from "../settings";
  import { ipc } from "../ipc";
  import {
    clearSearch,
    copyText,
    loadStats,
    markOpened,
    matchesProject,
    projectStats,
    repoSubPage,
    searchQuery,
    sortProjects,
    statsPending,
    togglePin,
  } from "../home";
  import type { Project, SearchHit } from "../types";
  import logoUrl from "../assets/termax-logo.svg";
  import AsciiField from "./AsciiField.svelte";
  import HomeSearch from "./HomeSearch.svelte";
  import HomeStats from "./HomeStats.svelte";
  import ProjectCard from "./ProjectCard.svelte";
  import TerminalIcon from "./TerminalIcon.svelte";

  /** Grid geometry.
   *
   *  A card's aspect ratio is fixed. A project tile is a *thing* — a folder —
   *  and a thing that changes proportion as the window moves makes every card's
   *  contents land somewhere new each time, which is the fastest way to make a
   *  screen you cannot learn. So the width is clamped to a narrow band instead,
   *  the height follows from it, and the leftover space goes into the margins
   *  rather than into the cards.
   *
   *  The minimum width is the one at which the flap's two rows — git facts, then
   *  three labelled buttons — still fit side by side. */
  const ASPECT = 4 / 3;
  const MIN_CARD_W = 292;
  const MAX_CARD_W = 324;
  const MAX_COLS = 6;
  const GAP = 14;

  let error = $state<string | null>(null);
  let toast = $state<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  let gridW = $state(0);
  /** Height of the whole screen, used to decide whether the portfolio strip
   *  gets its tiles or its one-liner. Measured on the shell rather than on the
   *  grid, because the grid's height is the thing that decision changes — read
   *  the other way round it would oscillate. */
  let shellH = $state(0);

  /** Below this the four tiles wrap into a block taller than the cards they
   *  summarize. Roughly a header, two rows of cards, and the strip. */
  const STATS_TILES_MIN_H = 620;
  const roomyStats = $derived(shellH >= STATS_TILES_MIN_H);

  let menu = $state<{ project: Project; x: number; y: number } | null>(null);
  let renamingId = $state<string | null>(null);
  let focusIndex = $state(-1);
  let cardEls: (HTMLElement | null)[] = $state([]);
  let search = $state<HomeSearch | null>(null);

  const launchers = $derived(enabledLaunchers($settings).filter((l) => l.command !== null));

  const ordered = $derived(sortProjects($projects));
  /** Typing narrows the grid — but only while the query still names a project.
   *  Searching for a symbol matches no project name, and blanking the grid for
   *  it would replace the screen with an apology while the answer sits in the
   *  results panel above it. */
  const filtered = $derived.by(() => {
    const query = $searchQuery.trim();
    if (!query) return ordered;
    const matches = ordered.filter((p) => matchesProject(p, query));
    return matches.length ? matches : ordered;
  });

  /** How many columns of the fixed shape this window holds.
   *
   *  Everything follows from the width: as many columns as fit at the minimum
   *  card width (never more than there are projects, so four checkouts on a wide
   *  monitor sit as a centred block rather than a thin strip), then the largest
   *  card that fits those columns. Rows follow from the card count — the grid
   *  scrolls when the window cannot hold them all. */
  const layout = $derived.by(() => {
    const count = Math.max(1, filtered.length);
    const fitting = Math.max(1, Math.floor((gridW + GAP) / (MIN_CARD_W + GAP)));
    const cols = Math.min(MAX_COLS, fitting, count);
    const fair = (gridW - (cols - 1) * GAP) / cols;
    // The minimum wins over the space available: a card narrower than this
    // cannot hold its own contents, and half a dozen illegible thumbnails are
    // worth less than two cards you can read. Only a window narrower than one
    // card goes below it, and then the card is the window.
    const width = Math.max(1, Math.min(MAX_CARD_W, Math.max(MIN_CARD_W, fair), gridW));
    const height = width / ASPECT;
    return { cols, width, height };
  });

  const cols = $derived(layout.cols);
  const cardW = $derived(layout.width);
  const cardH = $derived(layout.height);

  const allStats = $derived(
    $projects.map((p) => $projectStats.get(p.id)).filter((s) => s !== undefined),
  );

  // Stats are read once per home-screen mount and refreshed when the project
  // list changes. Not polled: nothing here changes while you are looking at it
  // (the projects are all closed), and a background `git status` sweep every
  // few seconds across a dozen repositories is a real cost for no information.
  $effect(() => {
    const list = $projects;
    for (const project of list) {
      if (!$projectStats.has(project.id) && !$statsPending.has(project.id)) {
        void loadStats(project.id);
      }
    }
  });

  function flash(message: string) {
    toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2200);
  }

  async function addProject() {
    error = null;
    const dir = await open({ directory: true, title: "Select project directory" });
    if (!dir) return;
    const name = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? dir;
    try {
      const project = await ipc.addProject(name, dir);
      await loadProjects();
      void loadStats(project.id);
    } catch (err) {
      error = String(err);
    }
  }

  function enter(project: Project) {
    markOpened(project.id);
    clearSearch();
    void openProject(project);
  }

  /** Open a project and immediately put an agent in it — the "I know what I am
   *  going to do here" path, which is most of them. */
  async function enterWith(project: Project, command: string | null, title: string) {
    markOpened(project.id);
    clearSearch();
    await openProject(project);
    addPane(command, title);
  }

  async function openHit(hit: SearchHit) {
    const project = $projects.find((p) => p.id === hit.projectId);
    if (!project) return;
    markOpened(project.id);
    clearSearch();
    await openProject(project);
    // The editor opens the file; the line number is shown in the result row
    // rather than jumped to, because pane creation does not carry a cursor.
    openFile(hit.path);
  }

  async function act(fn: () => Promise<unknown> | unknown) {
    // Close the menu only after the action has read from it. The menu's
    // bindings (`{@const target = menu`, and the deriveds built on it) are live
    // reads of the `menu` state, so nulling `menu` first would make the closure
    // dereference null — `target.project` throws "null is not an object". The
    // next microtask still lands inside the same click, so the menu closes just
    // as fast as it did before.
    queueMicrotask(() => (menu = null));
    try {
      await fn();
    } catch (err) {
      error = String(err);
    }
  }

  async function removeProject(project: Project) {
    await ipc.removeProject(project.id);
    await loadProjects();
    flash(`Removed ${project.name} from Termax (the folder is untouched)`);
  }

  async function rename(project: Project, name: string) {
    renamingId = null;
    await ipc.renameProject(project.id, name).catch((err) => (error = String(err)));
    await loadProjects();
  }

  /** Point a project at a new folder — the fix for a card that reads "missing".
   *  Everything Termax knows about the project survives; only the path changes. */
  async function relink(project: Project) {
    const dir = await open({ directory: true, title: `Relink ${project.name} to…` });
    if (!dir) return;
    try {
      await ipc.relinkProject(project.id, dir);
      await loadProjects();
      void loadStats(project.id);
      flash(`Relinked ${project.name} to ${dir}`);
    } catch (err) {
      error = String(err);
    }
  }

  async function trust(project: Project) {
    await ipc.trustFolder(project.path);
    await loadStats(project.id);
  }

  function focusCard(index: number) {
    focusIndex = index;
    cardEls[index]?.focus();
  }

  /** Bring a project into view for the keyboard. Focusing it scrolls the grid to
   *  it; if a search filter currently hides it, the query box is the way
   *  there. */
  function reveal(id: string) {
    const index = filtered.findIndex((p) => p.id === id);
    if (index >= 0) {
      focusCard(index);
      return;
    }
    const project = $projects.find((p) => p.id === id);
    if (project) {
      searchQuery.set(project.name);
      search?.focus();
    }
  }

  function onWindowKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const typing = !!target?.closest("input, textarea, [contenteditable='true']");

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      search?.focus();
      return;
    }
    if (typing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      void addProject();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "/") {
      e.preventDefault();
      search?.focus();
      return;
    }
    if (e.key === "Escape") {
      if (menu) menu = null;
      else if (renamingId) renamingId = null;
      return;
    }
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: cols,
      ArrowUp: -cols,
    };
    if (e.key in step && filtered.length) {
      e.preventDefault();
      const next = focusIndex < 0 ? 0 : focusIndex + step[e.key];
      focusCard(Math.max(0, Math.min(filtered.length - 1, next)));
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} onclick={() => (menu = null)} />

<div class="relative flex h-full w-full flex-col overflow-hidden bg-zinc-950"
     bind:clientHeight={shellH}>
  <AsciiField />

  <!-- Header: identity, search, global actions. -->
  <header class="relative z-20 flex items-center gap-4 px-4 pb-3 pt-3">
    <div class="flex shrink-0 items-center gap-2">
      <img src={logoUrl} alt="" class="h-6 w-6" />
      <div class="leading-tight">
        <h1 class="text-sm font-bold tracking-tight text-zinc-100">Termax</h1>
        <p class="font-mono text-[10px] text-zinc-600">
          {$projects.length} project{$projects.length === 1 ? "" : "s"} ·
          {launchers.length} agent{launchers.length === 1 ? "" : "s"}
        </p>
      </div>
    </div>

    <div class="mx-auto w-full max-w-2xl">
      <HomeSearch
        bind:this={search}
        projects={ordered}
        onopenproject={enter}
        onopenhit={openHit}
      />
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <button
        class="rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300
               hover:border-emerald-500 hover:text-emerald-400"
        title="Add a project folder (Ctrl+N)"
        onclick={addProject}
      >+ Project</button>
      <button
        class="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Settings"
        onclick={() => settingsOpen.set(true)}
      >
        <TerminalIcon type="gear" className="h-4 w-4" />
      </button>
    </div>
  </header>

  {#if error}
    <p class="relative z-20 mx-4 mb-1 rounded border border-red-500/40 bg-red-950/40 px-2 py-1 text-[11px] text-red-300">
      {error}
    </p>
  {/if}

  <!-- The grid. One row per the window's width; when the rows outgrow the
       window the main area scrolls instead of hiding projects behind search. -->
  <main
    class="relative z-10 min-h-0 flex-1 overflow-y-auto px-4 py-1"
    bind:clientWidth={gridW}
  >
    {#if !$projects.length}
      <div class="flex h-full flex-col items-center justify-center gap-4">
        <pre class="select-none font-mono text-[11px] leading-tight text-zinc-700">{`   ┌───────────────────────────┐
   │  >_  no projects yet      │
   │                           │
   │  add a folder and Termax  │
   │  tiles terminals, tracks  │
   │  changes, and launches    │
   │  agents inside it.        │
   └───────────────────────────┘`}</pre>
        <button
          class="rounded-lg border border-dashed border-zinc-700 px-4 py-2 text-sm text-zinc-300
                 hover:border-emerald-500 hover:text-emerald-400"
          onclick={addProject}
        >+ Add your first project</button>
      </div>
    {:else}
      <!-- Fixed track sizes rather than `1fr`: a fraction would stretch the
           cards back out of shape the moment the window is wider than the grid
           needs. Centring on both axes is what turns that leftover width into
           even margins instead of a strip of cards pinned to the left. -->
      <div
        class="grid min-h-full content-center justify-center"
        style="grid-template-columns: repeat({cols}, {cardW}px);
               grid-auto-rows: {cardH}px; gap: {GAP}px"
      >
        {#each filtered as project, index (project.id)}
          <div bind:this={cardEls[index]} class="min-w-0 focus:outline-none" tabindex="-1">
            <ProjectCard
              {project}
              stats={$projectStats.get(project.id)}
              pending={$statsPending.has(project.id)}
              renaming={renamingId === project.id}
              onopen={() => enter(project)}
              onmenu={(e) => (menu = { project, x: e.clientX, y: e.clientY })}
              onrename={(name) => rename(project, name)}
              oncancelrename={() => (renamingId = null)}
              onopenurl={(url) => ipc.openUrl(url).catch((err) => (error = String(err)))}
              ontrust={() => trust(project)}
              onrelink={() => relink(project)}
            />
          </div>
        {/each}
      </div>
    {/if}
  </main>

  <!-- Portfolio readouts. -->
  {#if $projects.length}
    <footer
      class="relative z-20 shrink-0 border-t border-zinc-800/60 px-4
             {roomyStats ? 'pb-4 pt-3' : 'py-2'}"
    >
      <HomeStats projects={$projects} stats={allStats} compact={!roomyStats} onfocusproject={reveal} />
    </footer>
  {/if}

  {#if toast}
    <div
      class="pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md
             border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 shadow-xl"
    >{toast}</div>
  {/if}

  <!-- Project actions. -->
  {#if menu}
    {@const target = menu}
    {@const stats = $projectStats.get(target.project.id)}
    {@const issues = repoSubPage(stats?.remoteUrl ?? null, "issues")}
    {@const pulls = repoSubPage(stats?.remoteUrl ?? null, "pulls")}
    <div
      class="fixed z-50 min-w-56 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900
             py-1 text-xs shadow-2xl"
      style="left: min({target.x}px, calc(100vw - 15rem)); top: min({target.y}px, calc(100vh - 22rem))"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      oncontextmenu={(e) => e.preventDefault()}
      role="menu"
      tabindex="-1"
    >
      <p class="truncate border-b border-zinc-800 px-3 py-1.5 font-mono text-[10px] text-zinc-500">
        {target.project.path}
      </p>

      <button class="menu-item" onclick={() => act(() => enter(target.project))}>
        Open project
      </button>
      {#each launchers.slice(0, 4) as launcher (launcher.id)}
        <button
          class="menu-item"
          onclick={() => act(() => enterWith(target.project, launcher.command, launcher.name))}
        >Open with {launcher.name}</button>
      {/each}

      <div class="my-1 border-t border-zinc-800"></div>

      <button class="menu-item" onclick={() => act(() => togglePin(target.project).then(loadProjects))}>
        {target.project.pinned ? "Unpin from home" : "Pin to home"}
      </button>
      <button
        class="menu-item"
        onclick={() => {
          // Read the id while the menu is still open — `target` is a live
          // binding and would be null after `menu = null`.
          renamingId = target.project.id;
          menu = null;
        }}
      >Rename…</button>
      <button class="menu-item" onclick={() => act(() => relink(target.project))}>
        Relink to a new folder…
      </button>
      <button class="menu-item" onclick={() => act(() => loadStats(target.project.id))}>
        Refresh status
      </button>

      <div class="my-1 border-t border-zinc-800"></div>

      <button class="menu-item" onclick={() => act(() => ipc.openProjectFolder(target.project.id))}>
        Reveal in file manager
      </button>
      <button class="menu-item" onclick={() => act(() => ipc.openProjectTerminal(target.project.id))}>
        Open in external terminal
      </button>
      <button
        class="menu-item"
        onclick={() =>
          act(async () => {
            const ok = await copyText(target.project.path);
            flash(ok ? "Path copied" : "Could not reach the clipboard");
          })}
      >Copy path</button>
      {#if stats?.remoteUrl}
        <button
          class="menu-item"
          onclick={() =>
            act(async () => {
              const ok = await copyText(stats.remoteUrl!);
              flash(ok ? "Remote URL copied" : "Could not reach the clipboard");
            })}
        >Copy remote URL</button>

        <div class="my-1 border-t border-zinc-800"></div>

        <button class="menu-item" onclick={() => act(() => ipc.openUrl(stats.remoteUrl!))}>
          Open repository ↗
        </button>
        {#if issues}
          <button class="menu-item" onclick={() => act(() => ipc.openUrl(issues))}>
            Open issues ↗
          </button>
        {/if}
        {#if pulls}
          <button class="menu-item" onclick={() => act(() => ipc.openUrl(pulls))}>
            Open pull requests ↗
          </button>
        {/if}
      {/if}

      {#if stats && !stats.trusted && !stats.missing}
        <div class="my-1 border-t border-zinc-800"></div>
        <button class="menu-item text-amber-300" onclick={() => act(() => trust(target.project))}>
          Trust this folder (enable git)
        </button>
      {/if}

      <div class="my-1 border-t border-zinc-800"></div>
      <button
        class="menu-item text-red-300 hover:bg-red-900/40 hover:text-red-200"
        onclick={() => act(() => removeProject(target.project))}
      >Remove from Termax</button>
    </div>
  {/if}
</div>
