<script lang="ts">
  import { get } from "svelte/store";
  import { activeProject, projects, runVaultCommand, revealVaultCommand, vaultRuns } from "../stores";
  import type { VaultRun } from "../stores";
  import { enabledLaunchers, launcherById, settings } from "../settings";
  import TerminalIcon from "./TerminalIcon.svelte";
  import { ipc } from "../ipc";

  import type { VaultCommand } from "../types";

  /** Filling the sidebar's swap panel: the saved-command list scrolls in the
   *  height it is given rather than growing the whole sidebar. */
  let { fill = false }: { fill?: boolean } = $props();

  let name = $state("");
  let command = $state("");
  let type = $state("shell");
  let adding = $state(false);
  let editingId = $state<string | null>(null);
  let open = $state(false);
  let dropdownEl = $state<HTMLDivElement>();

  $effect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!dropdownEl?.contains(e.target as Node)) open = false;
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  });

  const vault = $derived($activeProject?.commands ?? []);
  const launcherList = $derived(enabledLaunchers($settings));

  function syncProject(update: (p: import("../types").Project) => import("../types").Project) {
    const current = get(activeProject);
    if (!current) return;
    const updated = update(current);
    activeProject.set(updated);
    projects.update((list) => list.map((p) => (p.id === updated.id ? updated : p)));
  }

  function resetForm() {
    name = "";
    command = "";
    type = "shell";
    adding = false;
    editingId = null;
  }

  function toggleAdd() {
    if (adding || editingId) resetForm();
    else adding = true;
  }

  function startEdit(cmd: VaultCommand) {
    editingId = cmd.id;
    adding = false;
    name = cmd.name;
    command = cmd.command;
    type = cmd.terminalType || "shell";
  }

  async function submit() {
    const project = get(activeProject);
    if (!project || !name.trim() || !command.trim()) return;
    if (editingId) {
      const cmd = await ipc.updateVaultCommand(project.id, editingId, name.trim(), command.trim(), type);
      syncProject((p) => ({ ...p, commands: p.commands.map((c) => (c.id === cmd.id ? cmd : c)) }));
    } else {
      const cmd = await ipc.addVaultCommand(project.id, name.trim(), command.trim(), type);
      syncProject((p) => ({ ...p, commands: [...p.commands, cmd] }));
    }
    resetForm();
  }

  /** Runs still in flight show a spinner instead of a dot. */
  const active = (run: VaultRun) => run.state === "starting" || run.state === "running";

  function dotClass(run: VaultRun): string {
    switch (run.state) {
      case "failed":
        return "bg-red-400";
      case "stopped":
        return "bg-zinc-500";
      default:
        return "bg-emerald-400";
    }
  }

  function textClass(run: VaultRun): string {
    switch (run.state) {
      case "starting":
      case "running":
        return "text-amber-400";
      case "failed":
        return "text-red-400";
      case "stopped":
        return "text-zinc-500";
      default:
        return "text-emerald-400";
    }
  }

  function statusLabel(run: VaultRun): string {
    switch (run.state) {
      case "starting":
        return "starting";
      case "running":
        return "running";
      case "failed":
        return run.exitCode === null ? "failed" : `exit ${run.exitCode}`;
      case "stopped":
        return "stopped";
      default:
        return "done";
    }
  }

  function statusTitle(run: VaultRun): string {
    switch (run.state) {
      case "starting":
        return "Waiting for the terminal to accept input";
      case "running":
        return "Running";
      case "failed":
        return run.exitCode === null ? "Failed to start" : `Finished with exit code ${run.exitCode}`;
      case "stopped":
        return "Terminal closed while the command was running";
      default:
        return run.exitCode === 0
          ? "Finished (exit code 0)"
          : "Finished — exit code unknown (shell has no OSC 133 integration)";
    }
  }

  async function remove(commandId: string) {
    const project = get(activeProject);
    if (!project) return;
    await ipc.removeVaultCommand(project.id, commandId);
    if (editingId === commandId) resetForm();
    syncProject((p) => ({ ...p, commands: p.commands.filter((c) => c.id !== commandId) }));
  }

</script>

<div class="flex min-h-0 flex-col gap-1 {fill ? 'flex-1' : ''}">
  <div class="flex items-center justify-between px-1">
    <h2 class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Command Vault</h2>
    <button
      class="rounded px-1.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
      title="Add command"
      onclick={toggleAdd}
    >{adding || editingId ? "−" : "+"}</button>
  </div>

  {#if adding || editingId}
    <form class="flex flex-col gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-2" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <input
        class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-500"
        placeholder="Name"
        bind:value={name}
      />
      <input
        class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500"
        placeholder="Command"
        bind:value={command}
      />
      <div class="relative" bind:this={dropdownEl}>
        <button
          type="button"
          class="flex w-full items-center justify-between rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-500"
          title="Terminal type"
          onclick={() => open = !open}
        >
          <span><TerminalIcon type={launcherById(type).icon} className="h-3.5 w-3.5" /> {launcherById(type).name}</span>
          <span class="text-zinc-500">▾</span>
        </button>
        {#if open}
          <div class="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded border border-zinc-700 bg-zinc-950 shadow-lg">
            {#each launcherList as t (t.id)}
              <button
                type="button"
                class="flex w-full items-center gap-1 px-2 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
                class:bg-zinc-800={type === t.id}
                onclick={() => { type = t.id; open = false; }}
              >
                <span class="text-emerald-400"><TerminalIcon type={t.icon} className="h-3.5 w-3.5" /></span> {t.name}
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <div class="flex gap-1.5">
        <button class="flex-1 rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500" type="submit">
          {editingId ? "Update" : "Save"}
        </button>
        {#if editingId}
          <button class="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800" type="button" onclick={resetForm}>
            Cancel
          </button>
        {/if}
      </div>
    </form>
  {/if}

  <div class="flex min-h-0 flex-col gap-1 {fill ? 'flex-1 overflow-y-auto' : ''}">
  {#if vault.length === 0 && !adding && !editingId}
    <p class="px-1 text-[11px] text-zinc-600">No saved commands.</p>
  {/if}

  {#each vault as cmd (cmd.id)}
    {@const link = $vaultRuns.get(cmd.id)}
    {@const run = link && link.state !== "idle" ? link : null}
    <div
      class="group flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-zinc-800/70"
      class:bg-zinc-800={editingId === cmd.id}
    >
      <button
        class="flex min-w-0 flex-1 flex-col items-start text-left"
        title={`${cmd.command}\n↳ ${launcherById(cmd.terminalType).name}`}
        onclick={() => runVaultCommand(cmd)}
      >
        <span class="flex w-full items-center gap-1">
          <span class="text-emerald-400"><TerminalIcon type={launcherById(cmd.terminalType).icon} className="h-3 w-3" /></span>
          <span class="min-w-0 flex-1 truncate text-xs text-zinc-200">{cmd.name}</span>
          {#if run && active(run)}
            <span
              class="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-zinc-700 border-t-amber-400"
              title={statusTitle(run)}
            ></span>
          {:else if run}
            <span class="h-1.5 w-1.5 shrink-0 rounded-full {dotClass(run)}" title={statusTitle(run)}></span>
          {/if}
        </span>
        <span class="flex w-full items-baseline gap-1">
          <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-500">{cmd.command}</span>
          {#if run}
            <span class="shrink-0 text-[10px] {textClass(run)}" title={statusTitle(run)}>{statusLabel(run)}</span>
          {/if}
        </span>
      </button>
      {#if link?.paneId}
        <button
          class="rounded px-1 text-[11px] text-zinc-500 hover:text-emerald-400"
          title="Jump to its terminal"
          onclick={() => revealVaultCommand(cmd.id)}
        >⤢</button>
      {/if}
      <button
        class="hidden rounded px-1 text-[11px] text-zinc-600 hover:text-emerald-400 group-hover:block"
        title="Edit"
        onclick={() => startEdit(cmd)}
      >✎</button>
      <button
        class="hidden rounded px-1 text-[11px] text-zinc-600 hover:text-red-400 group-hover:block"
        title="Delete"
        onclick={() => remove(cmd.id)}
      >✕</button>
    </div>
  {/each}
  </div>
</div>
                                                      