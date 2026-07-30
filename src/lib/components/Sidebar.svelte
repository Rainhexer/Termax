<script lang="ts">
  import {
    activeProject,
    activeRoot,
    addPane,
    closeProject,
    focusedPaneId,
    newTab,
    paneInstances,
    revealPane,
    runVaultCommand,
    sidebarCollapsed,
  } from "../stores";
  import type { PaneInstance } from "../stores";
  import { enabledLaunchers, launcherById, settings, settingsOpen, updateSettings } from "../settings";
  import type { Launcher } from "../settings";
  import { activityLabel, activityTitle, cliStatus, loudest, statusFor } from "../cliStatus";
  import type { CliActivity } from "../cliStatus";
  import CommandVault from "./CommandVault.svelte";
  import PullRequests from "./PullRequests.svelte";
  import WorktreeChip from "./WorktreeChip.svelte";
  import ChangesPanel from "./ChangesPanel.svelte";
  import FileTree from "./FileTree.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import TerminalIcon from "./TerminalIcon.svelte";

  const MIN_WIDTH = 180;
  const MAX_WIDTH = 600;

  const launchers = $derived(enabledLaunchers($settings));
  /** Live width while dragging the edge; null when the stored width applies. */
  let dragWidth = $state<number | null>(null);
  const width = $derived(
    $sidebarCollapsed ? 48 : (dragWidth ?? $settings.appearance.sidebarWidth),
  );

  // Drag the right edge to resize. The width is only written to settings on
  // release, so a drag doesn't churn the store (and the debounced disk write)
  // on every pointer move; panes re-fit via their own ResizeObserver.
  function startResize(e: PointerEvent) {
    if ($sidebarCollapsed) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startWidth = $settings.appearance.sidebarWidth;
    handle.setPointerCapture(e.pointerId);
    dragWidth = startWidth;

    const onMove = (ev: PointerEvent) => {
      dragWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + ev.clientX - startX));
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      const final = dragWidth ?? startWidth;
      dragWidth = null;
      updateSettings((s) => ({ ...s, appearance: { ...s.appearance, sidebarWidth: final } }));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  // Open panes grouped under the launcher that opened them (matched on the
  // launch command, so a pane keeps its group across restarts and renames).
  const instancesOf = (launcher: Launcher): PaneInstance[] =>
    $paneInstances.filter((p) => p.launch === launcher.command);

  /** Collapsed groups, by launcher id. Groups start expanded. */
  let collapsedGroups = $state<Record<string, boolean>>({});
  const groupOpen = (id: string) => !collapsedGroups[id];
  const toggleGroup = (id: string) => (collapsedGroups[id] = !collapsedGroups[id]);

  /** Loudest state among a launcher's panes, for its badge. */
  const groupActivity = (instances: PaneInstance[]): CliActivity =>
    loudest(instances.map((i) => statusFor($cliStatus, i.paneId).activity));

  function dotClass(activity: CliActivity): string {
    switch (activity) {
      case "awaiting":
        return "bg-amber-400 animate-pulse";
      case "failed":
        return "bg-red-400";
      case "working":
        return "bg-emerald-400";
      default:
        return "bg-zinc-600";
    }
  }

  function textClass(activity: CliActivity): string {
    switch (activity) {
      case "awaiting":
        return "text-amber-400";
      case "failed":
        return "text-red-400";
      case "working":
        return "text-emerald-400";
      default:
        return "text-zinc-600";
    }
  }

  let vaultOpen = $state(false);
  let vaultTriggerEl = $state<HTMLElement>();
  let vaultPopoverEl = $state<HTMLDivElement>();

  const vault = $derived($activeProject?.commands ?? []);

  $effect(() => {
    if (!vaultOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (vaultTriggerEl?.contains(e.target as Node)) return;
      if (vaultPopoverEl?.contains(e.target as Node)) return;
      vaultOpen = false;
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  });
</script>

<aside
  class="relative flex shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 {dragWidth === null
    ? 'transition-all duration-200'
    : ''}"
  style="width: {width}px"
>
  {#if !$sidebarCollapsed}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="absolute -right-1 top-0 z-30 h-full w-2 cursor-col-resize hover:bg-emerald-500/40 {dragWidth !==
      null
        ? 'bg-emerald-500/60'
        : ''}"
      title="Drag to resize sidebar"
      onpointerdown={startResize}
      ondblclick={() =>
        updateSettings((s) => ({ ...s, appearance: { ...s.appearance, sidebarWidth: 256 } }))}
    ></div>
  {/if}
  {#if $sidebarCollapsed}
    <div class="flex flex-col items-center gap-2 py-2">
      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Back to projects"
        onclick={closeProject}
      >←</button>
      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Expand sidebar"
        onclick={() => sidebarCollapsed.set(false)}
      >▶</button>
      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-base text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
        title="New tab"
        onclick={() => newTab()}
      >+</button>
      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Settings"
        onclick={() => settingsOpen.set(true)}
      >
        <TerminalIcon type="gear" className="h-4 w-4" />
      </button>

      <div class="h-px w-5 shrink-0 bg-zinc-800"></div>

      <div class="flex flex-col items-center gap-2 overflow-y-auto">
        {#each launchers as launcher (launcher.id)}
          {@const instances = instancesOf(launcher)}
          <div class="relative shrink-0">
            <button
              class="flex h-7 w-7 items-center justify-center rounded-md text-emerald-400 hover:bg-zinc-800"
              title={instances.length
                ? `${launcher.name} — ${instances.length} open (${activityLabel(groupActivity(instances))})`
                : launcher.name}
              onclick={() => addPane(launcher.command, launcher.name)}
            >
              <TerminalIcon type={launcher.icon} className="h-4 w-4" />
            </button>
            {#if instances.length}
              <span
                class="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full px-0.5 text-[8px] font-semibold text-zinc-950 {dotClass(groupActivity(instances))}"
              >{instances.length}</span>
            {/if}
          </div>
        {/each}
      </div>

      <div class="h-px w-5 shrink-0 bg-zinc-800"></div>

      <div class="relative" bind:this={vaultPopoverEl}>
        <button
          bind:this={vaultTriggerEl}
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title="Command vault"
          onclick={() => vaultOpen = !vaultOpen}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </button>
        {#if vaultOpen}
          <div class="absolute left-full top-0 z-50 ml-1 w-56 rounded-md border border-zinc-800 bg-zinc-950 p-2 shadow-xl">
            <h3 class="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Command Vault</h3>
            {#if vault.length === 0}
              <p class="px-1 text-[11px] text-zinc-600">No saved commands.</p>
            {:else}
              {#each vault as cmd (cmd.id)}
                <button
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
                  onclick={() => { runVaultCommand(cmd); vaultOpen = false; }}
                >
                  <span class="text-emerald-400"><TerminalIcon type={launcherById(cmd.terminalType).icon} className="h-3.5 w-3.5" /></span>
                  <span class="min-w-0 flex-1 truncate">{cmd.name}</span>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="flex items-start gap-2 p-3 pb-2">
      <button
        class="mt-0.5 rounded-md px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Back to projects"
        onclick={closeProject}
      >←</button>
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-sm font-semibold text-zinc-100">{$activeProject?.name}</h1>
        <!-- Line two is the orientation zone: it already showed a path, so making
             it show the *active* root costs no vertical space and answers "which
             tree am I looking at" without a new panel. -->
        <div class="flex min-w-0 items-center gap-1">
          <p class="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-600">
            {$activeRoot ?? $activeProject?.path}
          </p>
          <WorktreeChip root={$activeRoot} compact />
        </div>
      </div>
      <div class="flex items-center gap-0.5">
        <button
          class="rounded-md px-1.5 py-0.5 text-base leading-none text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
          title="New tab"
          onclick={() => newTab()}
        >+</button>
        <button
          class="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title="Settings"
          onclick={() => settingsOpen.set(true)}
        >
          <TerminalIcon type="gear" className="h-3.5 w-3.5" />
        </button>
        <button
          class="rounded-md px-1 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title="Collapse sidebar"
          onclick={() => sidebarCollapsed.set(true)}
        >◀</button>
      </div>
    </div>

    <div class="flex flex-1 flex-col min-h-0">
      <div class="flex-1 overflow-y-auto px-3 min-h-0">
        <div class="flex flex-col gap-4 pb-3">

          <div class="flex flex-col gap-1">
            <h2 class="px-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Launch</h2>
            {#each launchers as launcher (launcher.id)}
              {@const instances = instancesOf(launcher)}
              <div class="overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/60">
                <div class="flex items-stretch">
                  <button
                    class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
                    onclick={() => addPane(launcher.command, launcher.name)}
                  >
                    <span class="inline-flex w-5 shrink-0 items-center justify-center text-emerald-400"><TerminalIcon type={launcher.icon} className="h-4 w-4" /></span>
                    <span class="truncate">{launcher.name}</span>
                    <span class="ml-auto shrink-0 text-[10px] text-zinc-600">new pane</span>
                  </button>
                  {#if instances.length}
                    <button
                      class="flex shrink-0 items-center gap-1 border-l border-zinc-800 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
                      title="{instances.length} open — {groupOpen(launcher.id) ? 'hide' : 'show'} instances"
                      onclick={() => toggleGroup(launcher.id)}
                    >
                      <span class="h-1.5 w-1.5 rounded-full {dotClass(groupActivity(instances))}"></span>
                      {instances.length}
                      <span class="text-zinc-600">{groupOpen(launcher.id) ? "▾" : "▸"}</span>
                    </button>
                  {/if}
                </div>

                {#if instances.length && groupOpen(launcher.id)}
                  <ul class="border-t border-zinc-800">
                    {#each instances as inst (inst.paneId)}
                      {@const status = statusFor($cliStatus, inst.paneId)}
                      <li>
                        <button
                          class="flex w-full flex-col gap-0.5 px-2 py-1 text-left hover:bg-zinc-800/70"
                          class:bg-zinc-800={$focusedPaneId === inst.paneId}
                          title={`${inst.title} — ${activityTitle(status.activity)}\n↳ ${inst.tabTitle}${status.model ? `\n↳ ${status.model}` : ""}`}
                          onclick={() => revealPane(inst.paneId)}
                        >
                          <span class="flex w-full items-center gap-1.5">
                            {#if status.activity === "working"}
                              <span class="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-zinc-700 border-t-emerald-400"></span>
                            {:else}
                              <span class="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full {dotClass(status.activity)}"></span>
                            {/if}
                            <span class="min-w-0 flex-1 truncate text-[11px] text-zinc-300">{inst.title}</span>
                            <span class="shrink-0 text-[10px] {textClass(status.activity)}">{activityLabel(status.activity)}</span>
                          </span>
                          <span class="flex w-full items-baseline gap-1.5 pl-4">
                            <!-- Which PR this agent is on, taken from the pane's real
                                 spawn root rather than its tab: a pane dragged to
                                 another tab keeps the shell it already had. -->
                            <WorktreeChip root={inst.root} compact />
                            <span class="min-w-0 flex-1 truncate text-[10px] text-zinc-500">
                              {status.task ?? inst.tabTitle}
                            </span>
                            {#if status.model}
                              <span class="shrink-0 rounded bg-zinc-800 px-1 font-mono text-[9px] text-zinc-400" title="Model in use">
                                {status.model}
                              </span>
                            {/if}
                          </span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/each}
          </div>

          <!-- Above the vault and the tree because starting work on a pull request
               is a sibling of launching an agent: both create panes. The two
               scrolling panels below it stay at the bottom. -->
          <ErrorBoundary label="Pull requests" compact>
            <PullRequests />
          </ErrorBoundary>
          <ErrorBoundary label="Command vault" compact>
            <CommandVault />
          </ErrorBoundary>
          <ErrorBoundary label="File tree" compact>
            <FileTree />
          </ErrorBoundary>

        </div>
      </div>
      <div class="px-3 pt-3 pb-3">
        <ErrorBoundary label="Changes" compact>
          <ChangesPanel />
        </ErrorBoundary>
      </div>
    </div>
  {/if}
</aside>
