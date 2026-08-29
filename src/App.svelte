<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { emit, listen } from "@tauri-apps/api/event";
  import {
    activeProject,
    activeRoot,
    closeProject,
    openProject,
    openFolderByPath,
    sessionError,
    layout,
    loadProjects,
    initListeners,
    refreshChanges,
    addPane,
    fsTick,
    cycleTab,
    focusedPaneId,
    moveActiveTab,
    paneAreaSize,
  } from "./lib/stores";
  import { savePaneFile } from "./lib/editorSave";
  import { loadSettings, settingsOpen } from "./lib/settings";
  import { initPrListeners } from "./lib/pr";
  import { initIssueListeners } from "./lib/issues";
  import { initWorktreeListeners } from "./lib/worktrees";
  import { initDiag } from "./lib/diag";
  import HomeScreen from "./lib/components/HomeScreen.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import TilingLayout from "./lib/components/TilingLayout.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";
  import ErrorBoundary from "./lib/components/ErrorBoundary.svelte";
  import TitleBar from "./lib/components/TitleBar.svelte";

  /** Whether a keystroke is being typed into an editable field.
   *
   *  xterm is deliberately *excluded* even though it focuses a hidden `<textarea>`:
   *  terminals are most of this app's surface, so treating them as text entry
   *  would disable tab cycling nearly everywhere. Inside a terminal the shortcut
   *  keeps its Termax meaning; in an editor or a form field it does not. */
  function isTextEntry(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== "function") return false;
    if (el.closest(".xterm")) return false;
    return !!el.closest("input, textarea, [contenteditable='true'], .monaco-editor");
  }

  // Measured size of the tiling area; feeds automatic new-pane placement.
  let areaW = $state(0);
  let areaH = $state(0);
  $effect(() => paneAreaSize.set({ w: areaW, h: areaH }));

  onMount(() => {
    initListeners();
    initWorktreeListeners();
    initPrListeners();
    // After the PR listeners: the issue panel reacts to the gh probe, which
    // `initPrListeners` is what kicks off.
    initIssueListeners();
    loadSettings();
    loadProjects();
    // Only samples when TERMAX_DIAG is set; see src/lib/diag.ts.
    void initDiag();

    // Folders the desktop shell asked us to open (KDE task-manager recents,
    // Windows jump lists, macOS Dock). The backend only emits after it heard
    // `frontend-ready`, so emit that only once this listener is registered.
    const openFolder = listen<string>("open-folder", (event) => openFolderByPath(event.payload));
    openFolder.then(() => emit("frontend-ready").catch(() => {}));

    // Debounced per root, not globally: with a worktree-bound tab open there are
    // several watchers, and one shared timer would let a busy root starve
    // another's refresh (and refresh the wrong one when it finally fired).
    //
    // Short, because the backend now coalesces filesystem notifications before
    // emitting (see FS_COALESCE in session.rs); this only absorbs the tail.
    const FS_DEBOUNCE_MS = 150;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const unlisten = listen<{ root: string }>("fs-changed", (event) => {
      const root = event.payload?.root;
      if (!root) return;
      clearTimeout(timers.get(root));
      timers.set(
        root,
        setTimeout(() => {
          timers.delete(root);
          refreshChanges(root);
          // The file tree and editor panes only ever show the active root, so a
          // background worktree's churn must not make them reload.
          if (root === get(activeRoot)) fsTick.update((n) => n + 1);
        }, FS_DEBOUNCE_MS),
      );
    });
    const onKeydown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      // Ctrl+Z and Ctrl+X are undo and cut everywhere else in computing, and this
      // listener runs in the capture phase with preventDefault — so without this
      // guard it silently stole both from the Monaco editor and from every text
      // field in the app.
      if (isTextEntry(e.target)) return;
      // Ctrl+Z/X cycles tabs; adding Shift moves the active tab instead.
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) moveActiveTab(-1);
        else cycleTab(-1);
      } else if (key === "x") {
        e.preventDefault();
        if (e.shiftKey) moveActiveTab(1);
        else cycleTab(1);
      } else if (key === "s" && !e.shiftKey) {
        // Save the file open in the focused pane. Skipped when the editor
        // itself has focus (Monaco handles its own Ctrl+S above via the
        // text-entry guard) and inside terminals, where Ctrl+S is XOFF flow
        // control. A non-editor focused pane leaves the key untouched.
        if (savePaneFile(get(focusedPaneId) ?? "")) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeydown, true);

    return () => {
      unlisten.then((fn) => fn());
      openFolder.then((fn) => fn());
      window.removeEventListener("keydown", onKeydown, true);
    };
  });
</script>

<div class="flex h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-200">
  <!-- Outermost net. The per-region boundaries below contain crashes to their
       own panel; this one only catches what falls through them (a throwing
       store read in this template, a broken region boundary) so the window
       still shows something instead of going white. -->
  <ErrorBoundary label="Termax">
  {#if $activeProject}
    <!-- The sidebar is the full height of the window; the title strip and the
         panes share the column beside it. -->
    <ErrorBoundary label="Sidebar">
      <Sidebar />
    </ErrorBoundary>
    <div class="flex min-w-0 flex-1 flex-col">
      <TitleBar />
      <main class="flex min-h-0 flex-1 flex-col">
        {#if $sessionError}
          <!-- Without this, a project whose folder was deleted or unmounted still
               rendered a complete, working-looking UI whose editor panes sat on
               "Opening session…" forever with nothing explaining why. -->
          <div class="flex items-start gap-2 border-b border-red-500/40 bg-red-950/40 px-3 py-2">
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold text-red-300">
                Couldn't open this project, so file and git features are unavailable.
              </p>
              <p class="mt-0.5 whitespace-pre-wrap break-words font-mono text-[10px] text-red-300/80">
                {$sessionError}
              </p>
            </div>
            <button
              class="shrink-0 rounded bg-red-500/20 px-2 py-0.5 text-[11px] font-semibold text-red-200 hover:bg-red-500/30"
              onclick={() => $activeProject && openProject($activeProject)}
            >Retry</button>
            <button
              class="shrink-0 rounded px-1 text-[11px] text-red-300/70 hover:bg-red-500/20"
              title="Back to projects"
              onclick={closeProject}
            >✕</button>
          </div>
        {/if}
        <div class="min-h-0 flex-1 p-2">
          {#if $layout}
            <div class="h-full w-full" bind:clientWidth={areaW} bind:clientHeight={areaH}>
              <ErrorBoundary label="Pane layout">
                <TilingLayout node={$layout} />
              </ErrorBoundary>
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
    <div class="flex min-w-0 flex-1 flex-col">
      <TitleBar />
      <div class="min-h-0 flex-1">
        <ErrorBoundary label="Home screen">
          <HomeScreen />
        </ErrorBoundary>
      </div>
    </div>
  {/if}

  {#if $settingsOpen}
    <ErrorBoundary label="Settings">
      <SettingsModal />
    </ErrorBoundary>
  {/if}
  </ErrorBoundary>
</div>
