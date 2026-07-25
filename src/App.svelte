<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import {
    activeProject,
    layout,
    loadProjects,
    initListeners,
    refreshChanges,
    addPane,
    fsTick,
    cycleTab,
    moveActiveTab,
    paneAreaSize,
  } from "./lib/stores";
  import { loadSettings, settingsOpen } from "./lib/settings";
  import ProjectPicker from "./lib/components/ProjectPicker.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import TabBar from "./lib/components/TabBar.svelte";
  import TilingLayout from "./lib/components/TilingLayout.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";

  // Measured size of the tiling area; feeds automatic new-pane placement.
  let areaW = $state(0);
  let areaH = $state(0);
  $effect(() => paneAreaSize.set({ w: areaW, h: areaH }));

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
    const onKeydown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      // Ctrl+Z/X cycles tabs; adding Shift moves the active tab instead.
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) moveActiveTab(-1);
        else cycleTab(-1);
      } else if (key === "x") {
        e.preventDefault();
        if (e.shiftKey) moveActiveTab(1);
        else cycleTab(1);
      }
    };
    window.addEventListener("keydown", onKeydown, true);

    return () => {
      unlisten.then((fn) => fn());
      window.removeEventListener("keydown", onKeydown, true);
    };
  });
</script>

<div class="h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-200">
  {#if $activeProject}
    <div class="flex h-full">
      <Sidebar />
      <main class="flex min-w-0 flex-1 flex-col">
        <TabBar />
        <div class="min-h-0 flex-1 p-2">
          {#if $layout}
            <div class="h-full w-full" bind:clientWidth={areaW} bind:clientHeight={areaH}>
              <TilingLayout node={$layout} />
            </div>
          {:else}
            <div class="flex h-full flex-col items-center justify-center gap-3 text-zinc-600">
              <p class="text-sm">No panes open.</p>
              <button
                class="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-emerald-500 hover:text-emerald-400"
                onclick={() => addPane(null, "shell")}
              >Open shell</button>
            </div>
          {/if}
        </div>
      </main>
    </div>
  {:else}
    <ProjectPicker />
  {/if}

  {#if $settingsOpen}
    <SettingsModal />
  {/if}
</div>
