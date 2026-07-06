<script lang="ts">
  import { activeProject, addPane, closeProject } from "../stores";
  import { TERMINAL_TYPES } from "../terminalTypes";
  import CommandVault from "./CommandVault.svelte";
  import ChangesPanel from "./ChangesPanel.svelte";
  import TerminalIcon from "./TerminalIcon.svelte";

  const launchers = TERMINAL_TYPES;
</script>

<aside class="flex w-64 shrink-0 flex-col gap-4 border-r border-zinc-800 bg-zinc-950 p-3">
  <div class="flex items-center gap-2">
    <button
      class="rounded-md px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
      title="Back to projects"
      onclick={closeProject}
    >←</button>
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
</aside>
