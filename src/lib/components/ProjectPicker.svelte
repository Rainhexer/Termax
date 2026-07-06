<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { projects, openProject, loadProjects } from "../stores";
  import { ipc } from "../ipc";

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

<div class="flex h-full w-full items-center justify-center bg-zinc-950">
  <div class="w-[420px]">
    <div class="mb-6 text-center">
      <h1 class="text-2xl font-bold tracking-tight text-zinc-100">
        <span class="font-mono text-emerald-400">&gt;_</span> Termix
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
