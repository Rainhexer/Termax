<script lang="ts">
  import { activeProject, addPane, closeProject, sidebarCollapsed, runVaultCommand } from "../stores";
  import { TERMINAL_TYPES, terminalType } from "../terminalTypes";
  import CommandVault from "./CommandVault.svelte";
  import ChangesPanel from "./ChangesPanel.svelte";
  import TerminalIcon from "./TerminalIcon.svelte";

  const launchers = TERMINAL_TYPES;

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
  class="relative flex shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 transition-all duration-200"
  class:w-64={!$sidebarCollapsed}
  class:w-12={$sidebarCollapsed}
>
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

      <div class="h-px w-5 shrink-0 bg-zinc-800"></div>

      <div class="flex flex-col items-center gap-2 overflow-y-auto">
        {#each launchers as launcher (launcher.title)}
          <button
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-emerald-400 hover:bg-zinc-800"
            title={launcher.label}
            onclick={() => addPane(launcher.command, launcher.title)}
          >
            <TerminalIcon type={launcher.icon} className="h-4 w-4" />
          </button>
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
                  <span class="text-emerald-400"><TerminalIcon type={terminalType(cmd.terminalType).icon} className="h-3.5 w-3.5" /></span>
                  <span class="min-w-0 flex-1 truncate">{cmd.name}</span>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="flex items-center gap-1 p-1">
      <button
        class="rounded-md px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Back to projects"
        onclick={closeProject}
      >←</button>
      <button
        class="ml-auto rounded-md px-1 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Collapse sidebar"
        onclick={() => sidebarCollapsed.set(true)}
      >◀</button>
    </div>

    <div class="flex flex-1 flex-col gap-4 overflow-y-auto p-3 pt-0">
      <div class="flex items-center gap-2">
        <div class="min-w-0">
          <h1 class="truncate text-sm font-semibold text-zinc-100">{$activeProject?.name}</h1>
          <p class="truncate font-mono text-[10px] text-zinc-600">{$activeProject?.path}</p>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <h2 class="px-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Launch</h2>
        {#each launchers as launcher (launcher.title)}
          <button
            class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-left text-xs text-zinc-200 hover:border-emerald-600/50 hover:bg-zinc-800"
            onclick={() => addPane(launcher.command, launcher.title)}
          >
            <span class="inline-flex w-5 items-center justify-center text-emerald-400"><TerminalIcon type={launcher.icon} className="h-4 w-4" /></span>
            {launcher.label}
            <span class="ml-auto text-[10px] text-zinc-600">new pane</span>
          </button>
        {/each}
      </div>

      <CommandVault />
      <ChangesPanel />
    </div>
  {/if}
</aside>
