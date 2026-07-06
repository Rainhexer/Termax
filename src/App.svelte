<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import {
    activeProject,
    layout,
    diffTarget,
    loadProjects,
    initListeners,
    refreshChanges,
    addPane,
    fsTick,
  } from "./lib/stores";
  import { loadSettings, settingsOpen } from "./lib/settings";
  import ProjectPicker from "./lib/components/ProjectPicker.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import TilingLayout from "./lib/components/TilingLayout.svelte";
  import DiffModal from "./lib/components/DiffModal.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";

  onMount(() => {
    initListeners();
    loadSettings();
    loadProjects();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = listen("fs-changed", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshChanges();
        fsTick.update((n) => n + 1);
      }, 400);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  });
</script>

<div class="h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-200">
  {#if $activeProject}
    <div class="flex h-full">
      <Sidebar />
      <main class="min-w-0 flex-1 p-2">
        {#if $layout}
          <TilingLayout node={$layout} />
        {:else}
          <div class="flex h-full flex-col items-center justify-center gap-3 text-zinc-600">
            <p class="text-sm">No panes open.</p>
            <button
              class="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-emerald-500 hover:text-emerald-400"
              onclick={() => addPane(null, "shell")}
            >Open shell</button>
          </div>
        {/if}
      </main>
    </div>
  {:else}
    <ProjectPicker />
  {/if}

  {#if $diffTarget}
    <DiffModal target={$diffTarget} />
  {/if}

  {#if $settingsOpen}
    <SettingsModal />
  {/if}
</div>
