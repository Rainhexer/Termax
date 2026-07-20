<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { projects, openProject, loadProjects } from "../stores";
  import { settingsOpen } from "../settings";
  import { ipc } from "../ipc";
  import TerminalIcon from "./TerminalIcon.svelte";
  import logoUrl from "../assets/termax-logo.svg";

  let error = $state<string | null>(null);

  async function addProject() {
    error = null;
    const dir = await open({ directory: true, title: "Select project directory" });
    if (!dir) return;
    const name = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? dir;
    try {
      await ipc.addProject(name, dir);
      await loadProjects();
    } catch (err) {
      error = String(err);
    }
  }

  async function remove(id: string) {
    await ipc.removeProject(id);
    await loadProjects();
  }
</script>

<div class="relative flex h-full w-full items-center justify-center bg-zinc-950">
  <button
    class="absolute right-4 top-4 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
    title="Settings"
    onclick={() => settingsOpen.set(true)}
  >
    <TerminalIcon type="gear" className="h-4 w-4" />
  </button>
  <div class="w-[420px]">
    <div class="mb-6 text-center">
      <h1 class="flex items-center justify-center gap-2 text-2xl font-bold tracking-tight text-zinc-100">
        <img src={logoUrl} alt="Termax logo" class="h-7 w-7" /> Termax
      </h1>
      <p class="mt-1 text-xs text-zinc-500">Terminal multiplexer for AI coding agents</p>
    </div>

    <div class="flex flex-col gap-1.5">
      {#each $projects as project (project.id)}
        <div class="group flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 hover:border-emerald-600/50 hover:bg-zinc-900">
          <button class="min-w-0 flex-1 text-left" onclick={() => openProject(project)}>
            <div class="truncate text-sm font-medium text-zinc-100">{project.name}</div>
            <div class="truncate font-mono text-[10px] text-zinc-600">{project.path}</div>
          </button>
          <button
            class="hidden rounded px-1.5 text-xs text-zinc-600 hover:text-red-400 group-hover:block"
            title="Remove project"
            onclick={() => remove(project.id)}
          >✕</button>
        </div>
      {/each}

      <button
        class="mt-2 rounded-lg border border-dashed border-zinc-700 px-3 py-2.5 text-sm text-zinc-400 hover:border-emerald-500 hover:text-emerald-400"
        onclick={addProject}
      >+ Add project</button>

      {#if error}
        <p class="text-xs text-red-400">{error}</p>
      {/if}
    </div>
  </div>
</div>
