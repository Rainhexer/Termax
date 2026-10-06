<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { activeProject, groupBarVisible } from "../stores";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import TabBar from "./TabBar.svelte";
  import WorktreeBar from "./WorktreeBar.svelte";

  const win = getCurrentWindow();

  /** Swaps the maximize glyph for restore while the window fills the screen.
   *  Resize events are the one signal that covers every path here — snapping,
   *  double-click on the drag region, WM keyboard shortcuts — so the state is
   *  re-read from them rather than tracked optimistically around our own
   *  toggle button. */
  let maximized = $state(false);

  onMount(() => {
    void win.isMaximized().then((m) => (maximized = m));
    const resized = win.onResized(() => {
      void win.isMaximized().then((m) => (maximized = m));
    });
    return () => {
      resized.then((fn) => fn());
    };
  });
</script>

<!-- The strip spans only the content area: the sidebar stretches to the top of
     the window beside it, so its own header is the window's top-left corner.
     Every pixel that is not a control carries `data-tauri-drag-region` — the
     attribute must sit on the exact element under the pointer, never inherited. -->
<header class="flex h-9 shrink-0 items-stretch border-b border-zinc-800 bg-zinc-950" data-tauri-drag-region>
  {#if $activeProject}
    <!-- One strip while the project root is the only tree in play — the look this
         bar has always had. Once a worktree is open the strip becomes the
         worktree row and the tabs move to their own row below (see App.svelte),
         so a tab always says which tree it belongs to without having to fit that
         into its own label. -->
    {#if $groupBarVisible}
      <ErrorBoundary label="Worktree bar" compact>
        <WorktreeBar />
      </ErrorBoundary>
    {:else}
      <ErrorBoundary label="Tab bar" compact>
        <TabBar inline />
      </ErrorBoundary>
    {/if}
  {/if}

  <!-- All leftover width is grabbable; without it the window could only be
       dragged by its edges once the tabs grew long. -->
  <div class="min-w-0 flex-1" data-tauri-drag-region></div>

  <div class="flex shrink-0 items-stretch">
    <button
      class="flex w-11 items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      title="Minimize"
      aria-label="Minimize"
      onclick={() => void win.minimize()}
    >
      <svg viewBox="0 0 12 12" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M2.5 8.5h7" />
      </svg>
    </button>
    <button
      class="flex w-11 items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      title={maximized ? "Restore" : "Maximize"}
      aria-label={maximized ? "Restore window" : "Maximize window"}
      onclick={() => void win.toggleMaximize()}
    >
      {#if maximized}
        <svg viewBox="0 0 12 12" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.2">
          <path d="M4.5 2.5h5v5H8" />
          <rect x="2.5" y="4.5" width="5" height="5" />
        </svg>
      {:else}
        <svg viewBox="0 0 12 12" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.2">
          <rect x="2.5" y="2.5" width="7" height="7" />
        </svg>
      {/if}
    </button>
    <button
      class="flex w-11 items-center justify-center text-zinc-500 transition-colors hover:bg-red-900/60 hover:text-red-300"
      title="Close"
      aria-label="Close window"
      onclick={() => void win.close()}
    >
      <svg viewBox="0 0 12 12" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M3 3l6 6M9 3L3 9" />
      </svg>
    </button>
  </div>
</header>
