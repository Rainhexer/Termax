<script lang="ts">
  import { get } from "svelte/store";
  import type { ChangeArea, PaneNode } from "../types";
  import { monaco, languageForPath } from "../monaco";
  import { hasPreview, previewKindForPath, renderMarkdown } from "../preview";
  import { ipc } from "../ipc";
  import { settings } from "../settings";
  import {
    changes,
    closePane,
    explorerLocked,
    focusedPaneId,
    fsTick,
    lockFlash,
    maximizedPaneId,
    movePane,
    sessionReady,
    setPaneDiff,
    splitPaneAt,
    draggedPaneId,
    toggleMaximizedPane,
  } from "../stores";

  type DropZone = "top" | "bottom" | "left" | "right" | "center";

  let { pane }: { pane: PaneNode } = $props();
  let host: HTMLDivElement;
  let self: HTMLDivElement;
  let currentZone = $state<DropZone | null>(null);
  let binary = $state(false);
  let error = $state<string | null>(null);
  /** Set when the file changed on disk and the view was reloaded. */
  let externallyChanged = $state(false);
  /** Unsaved edits in the buffer. */
  let dirty = $state(false);
  /** File changed on disk while the buffer had unsaved edits. */
  let conflict = $state(false);
  /** Diff view (changes vs git base / session snapshot) instead of plain content. */
  let showDiff = $state(false);
  let saveError = $state<string | null>(null);
  /** Bumped once the buffer model exists, so the diff-reconcile effect can run. */
  let modelReady = $state(0);
  /** "edit" = raw text (Monaco), "preview" = interpret the file. */
  let viewMode = $state<"edit" | "preview">("edit");
  /** Live buffer text mirrored for markdown/html/svg previews. */
  let previewText = $state("");
  /** data: URL for raster-image previews. */
  let imageData = $state<string | null>(null);
  /** Kebab (⋯) menu open state. */
  let menuOpen = $state(false);

  const focused = $derived($focusedPaneId === pane.id);
  const path = $derived(pane.file ?? "");
  const fileName = $derived(path.split("/").pop() ?? path);
  const dirName = $derived(path.slice(0, path.length - fileName.length).replace(/\/$/, ""));
  const locked = $derived($explorerLocked);
  const previewKind = $derived(previewKindForPath(path));
  const previewable = $derived(hasPreview(path));
  /** Image files have no editable text view. */
  const imageOnly = $derived(previewKind === "image");
  const markdownHtml = $derived(
    viewMode === "preview" && previewKind === "markdown" ? renderMarkdown(previewText) : "",
  );
  /** srcdoc for html/svg preview (rendered live in a sandboxed iframe). */
  const frameDoc = $derived(
    viewMode === "preview" && (previewKind === "html" || previewKind === "svg")
      ? previewText
      : "",
  );

  // The buffer model is shared between the plain and diff editors so text,
  // cursor-adjacent state and undo history survive view toggles.
  let model: import("monaco-editor").editor.ITextModel | undefined;
  let originalModel: import("monaco-editor").editor.ITextModel | undefined;
  let plainEditor: import("monaco-editor").editor.IStandaloneCodeEditor | undefined;
  let diffEditor: import("monaco-editor").editor.IStandaloneDiffEditor | undefined;
  let loadedContent: string | null = null;

  // Guards async loads against pane teardown / file switch mid-request.
  let generation = 0;

  function getDropZone(e: DragEvent): DropZone | null {
    const rect = self.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const edge = 0.25;
    if (y < edge) return "top";
    if (y > 1 - edge) return "bottom";
    if (x < edge) return "left";
    if (x > 1 - edge) return "right";
    return "center";
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    const zone = getDropZone(e);
    if (zone) currentZone = zone;
  }

  function onDragLeave(e: DragEvent) {
    const target = e.currentTarget as HTMLElement;
    const related = e.relatedTarget as HTMLElement | null;
    if (!related || !target.contains(related)) {
      currentZone = null;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    const fromId = e.dataTransfer?.getData("text/pane") ?? $draggedPaneId;
    const zone = currentZone;
    currentZone = null;
    draggedPaneId.set(null);
    if (!fromId) return;

    if (zone === "center") {
      movePane(fromId, pane.id);
    } else if (zone === "left") {
      splitPaneAt(fromId, pane.id, "row", true);
    } else if (zone === "right") {
      splitPaneAt(fromId, pane.id, "row", false);
    } else if (zone === "top") {
      splitPaneAt(fromId, pane.id, "col", true);
    } else if (zone === "bottom") {
      splitPaneAt(fromId, pane.id, "col", false);
    }
  }

  const editorOptions = () => ({
    theme: "vs-dark",
    automaticLayout: true,
    readOnly: get(explorerLocked),
    lineNumbers: "off" as const,
    minimap: { enabled: false },
    fontSize: get(settings).appearance.editorFontSize,
    scrollBeyondLastLine: false,
  });

  function createPlainEditor() {
    if (!model) return;
    plainEditor = monaco.editor.create(host, { ...editorOptions(), model });
    plainEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
    plainEditor.onDidAttemptReadOnlyEdit(() => lockFlash.update((n) => n + 1));
  }

  async function load(filePath: string) {
    const gen = generation;
    // Image files have no text buffer — load a data URL and show the preview.
    if (previewKindForPath(filePath) === "image") {
      viewMode = "preview";
      try {
        const url = await ipc.readFileDataUrl(filePath);
        if (gen === generation) imageData = url;
      } catch (err) {
        if (gen === generation) error = String(err);
      }
      return;
    }
    try {
      const file = await ipc.readFile(filePath);
      if (gen !== generation) return;
      if (file.binary) {
        binary = true;
        return;
      }
      loadedContent = file.content;
      previewText = file.content;
      model = monaco.editor.createModel(file.content, languageForPath(filePath));
      model.onDidChangeContent(() => {
        dirty = model!.getValue() !== loadedContent;
        previewText = model!.getValue();
      });
      createPlainEditor();
      modelReady++; // let the diff-reconcile effect run now the model exists
    } catch (err) {
      if (gen === generation) error = String(err);
    }
  }

  /** Pick which change area to diff against, mirroring the Changes panel. */
  function pickArea(): ChangeArea | undefined {
    const list = get(changes).filter((c) => c.path === path);
    for (const area of ["unstaged", "staged", "untracked"] as const) {
      if (list.some((c) => c.area === area)) return area;
    }
    return list[0]?.area; // snapshot mode: undefined
  }

  async function toggleDiff() {
    if (!model) return;
    if (showDiff) {
      diffEditor?.dispose();
      diffEditor = undefined;
      originalModel?.dispose();
      originalModel = undefined;
      showDiff = false;
      setPaneDiff(pane.id, false);
      createPlainEditor();
      return;
    }
    const gen = generation;
    try {
      const diff = await ipc.getDiff(path, pickArea());
      if (gen !== generation || !model) return;
      originalModel = monaco.editor.createModel(diff.original, model.getLanguageId());
      plainEditor?.dispose();
      plainEditor = undefined;
      diffEditor = monaco.editor.createDiffEditor(host, {
        ...editorOptions(),
        originalEditable: false,
        renderSideBySide: true,
      });
      diffEditor.setModel({ original: originalModel, modified: model });
      diffEditor.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
      diffEditor.getModifiedEditor().onDidAttemptReadOnlyEdit(() => lockFlash.update((n) => n + 1));
      showDiff = true;
      setPaneDiff(pane.id, true);
    } catch (err) {
      saveError = null;
      error = String(err);
    }
  }

  async function save() {
    if (!model || !dirty) return;
    const content = model.getValue();
    try {
      await ipc.writeFile(path, content);
      loadedContent = content;
      dirty = false;
      conflict = false;
      externallyChanged = false;
      saveError = null;
    } catch (err) {
      saveError = String(err);
    }
  }

  async function reloadFromDisk() {
    const gen = generation;
    try {
      const file = await ipc.readFile(path);
      if (gen !== generation || !model || file.binary) return;
      if (file.content !== loadedContent) {
        if (dirty) {
          conflict = true; // keep the user's edits; disk moved on
        } else {
          loadedContent = file.content;
          model.setValue(file.content);
          dirty = false;
          externallyChanged = true;
        }
      }
      if (showDiff && originalModel) {
        const diff = await ipc.getDiff(path, pickArea());
        if (gen === generation) originalModel.setValue(diff.original);
      }
    } catch {
      // file deleted mid-session: keep showing last content
    }
  }

  function openExternally() {
    menuOpen = false;
    ipc.openInDefaultApp(path).catch((err) => (saveError = String(err)));
  }

  function revealInExplorer() {
    menuOpen = false;
    ipc.revealInFileManager(path).catch((err) => (saveError = String(err)));
  }

  /** Re-run the load after a failure (session came up late, transient fs error). */
  function retry() {
    generation++;
    plainEditor?.dispose();
    plainEditor = undefined;
    model?.dispose();
    model = undefined;
    loadedContent = null;
    binary = false;
    error = null;
    imageData = null;
    load(path);
  }

  // (Re)create everything whenever this pane starts showing a different file.
  // Also re-runs when the session comes up: a restored layout mounts before
  // start_session resolves, and loading then would fail with "no active session".
  $effect(() => {
    const p = path;
    const ready = $sessionReady;
    binary = false;
    error = null;
    externallyChanged = false;
    dirty = false;
    conflict = false;
    showDiff = false;
    saveError = null;
    viewMode = "edit";
    previewText = "";
    imageData = null;
    menuOpen = false;
    if (ready) load(p);
    return () => {
      generation++;
      plainEditor?.dispose();
      plainEditor = undefined;
      diffEditor?.dispose();
      diffEditor = undefined;
      model?.dispose();
      model = undefined;
      originalModel?.dispose();
      originalModel = undefined;
      loadedContent = null;
    };
  });

  // Reconcile the view with the pane's persisted diff flag: opening from the
  // Changes panel (or flipping an already-open pane) sets pane.diff, and this
  // brings the live editor into that state once the model is ready.
  $effect(() => {
    modelReady; // re-run when the model becomes available
    const want = pane.diff ?? false;
    if (want !== showDiff && model) toggleDiff();
  });

  // The Explorer lock flips read-only on live editors.
  $effect(() => {
    const readOnly = $explorerLocked;
    plainEditor?.updateOptions({ readOnly });
    diffEditor?.updateOptions({ readOnly });
  });

  // Update font size reactively when editor settings change.
  $effect(() => {
    const size = $settings.appearance.editorFontSize;
    plainEditor?.updateOptions({ fontSize: size });
    diffEditor?.updateOptions({ fontSize: size });
  });

  // Reload from disk when the watcher reports changes.
  let lastTick = 0;
  $effect(() => {
    const tick = $fsTick;
    if (tick === lastTick) return;
    lastTick = tick;
    if (!$sessionReady) return;
    if (model) reloadFromDisk();
    else if (imageOnly) {
      const gen = generation;
      ipc.readFileDataUrl(path).then((url) => {
        if (gen === generation) imageData = url;
      }).catch(() => {});
    }
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div
  bind:this={self}
  class="relative flex h-full w-full min-w-0 min-h-0 flex-col overflow-hidden rounded-lg border bg-[#1e1e1e] transition-colors
    {currentZone && currentZone !== 'center' ? 'border-emerald-400' : focused ? 'border-emerald-500/60' : 'border-zinc-800'}"
  onmousedown={() => focusedPaneId.set(pane.id)}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  {#if currentZone && currentZone !== "center"}
    <div class="pointer-events-none absolute inset-0 z-10 rounded-lg bg-emerald-500/5"></div>
    {#if currentZone === "top"}
      <div class="pointer-events-none absolute inset-x-3 top-0 z-10 h-[3px] rounded-t bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.4)]"></div>
    {:else if currentZone === "bottom"}
      <div class="pointer-events-none absolute inset-x-3 bottom-0 z-10 h-[3px] rounded-b bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.4)]"></div>
    {:else if currentZone === "left"}
      <div class="pointer-events-none absolute inset-y-3 left-0 z-10 w-[3px] rounded-l bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.4)]"></div>
    {:else if currentZone === "right"}
      <div class="pointer-events-none absolute inset-y-3 right-0 z-10 w-[3px] rounded-r bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.4)]"></div>
    {/if}
  {/if}
  <div
    class="flex h-7 shrink-0 cursor-grab items-center gap-1.5 border-b border-zinc-800 bg-zinc-950 px-2 active:cursor-grabbing"
    draggable="true"
    ondragstart={(e) => { e.dataTransfer?.setData("text/pane", pane.id); draggedPaneId.set(pane.id); }}
    ondragend={() => draggedPaneId.set(null)}
  >
    <svg
      class="h-3.5 w-3.5 shrink-0 {focused ? 'text-emerald-400' : 'text-zinc-500'}"
      viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
    >
      <path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5Z" />
      <path d="M9 1.5V5.5H13" />
    </svg>
    <span class="flex min-w-0 items-baseline gap-1.5">
      <span class="truncate font-mono text-[11px] font-semibold {focused ? 'text-emerald-100' : 'text-zinc-300'}">{fileName}</span>
      {#if dirName}
        <span class="hidden truncate font-mono text-[10px] text-zinc-600 sm:inline">{dirName}</span>
      {/if}
    </span>
    {#if showDiff}
      <span class="shrink-0 rounded bg-emerald-950/60 px-1 py-px font-mono text-[9px] font-semibold uppercase tracking-wide text-emerald-400">diff</span>
    {/if}
    {#if conflict}
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400"
        title="File changed on disk while you have unsaved edits"
      ></span>
    {:else if dirty}
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300"
        title="Unsaved changes"
      ></span>
    {:else if externallyChanged}
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
        title="File changed on disk — content reloaded"
      ></span>
    {/if}
    {#if saveError}
      <span class="truncate text-[10px] text-red-400" title={saveError}>save failed</span>
    {/if}
    <div class="ml-auto flex items-center gap-0.5">
      {#if dirty}
        <button
          class="rounded px-1.5 py-0.5 text-[11px] text-emerald-400 hover:bg-zinc-800"
          title="Save (Ctrl+S)"
          onclick={(e) => { e.stopPropagation(); save(); }}
        >Save</button>
      {/if}
      {#if previewable}
        <!-- Edit / Preview mode switch -->
        <div class="flex items-center rounded bg-zinc-900 p-px">
          {#if !imageOnly}
            <button
              class="rounded px-1.5 py-0.5 text-[10px] font-semibold {viewMode === 'edit'
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-200'}"
              title="Edit raw text"
              onclick={(e) => { e.stopPropagation(); viewMode = 'edit'; }}
            >Edit</button>
          {/if}
          <button
            class="rounded px-1.5 py-0.5 text-[10px] font-semibold {viewMode === 'preview'
              ? 'bg-zinc-700 text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-200'}"
            title="Rendered preview"
            onclick={(e) => { e.stopPropagation(); viewMode = 'preview'; }}
          >Preview</button>
        </div>
      {/if}
      {#if !imageOnly && viewMode === "edit"}
        <button
          class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold {showDiff
            ? 'bg-emerald-950/60 text-emerald-400'
            : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'}"
          title={showDiff ? "Hide changes (show file)" : "Show changes (diff)"}
          onclick={(e) => { e.stopPropagation(); toggleDiff(); }}
        >± Diff</button>
      {/if}
      <!-- Kebab menu: open externally / reveal in explorer -->
      <div class="relative">
        <button
          class="rounded px-1.5 py-0.5 text-[13px] leading-none {menuOpen
            ? 'bg-zinc-800 text-zinc-200'
            : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'}"
          title="More actions"
          onclick={(e) => { e.stopPropagation(); menuOpen = !menuOpen; }}
        >⋯</button>
        {#if menuOpen}
          <div
            class="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
            role="menu"
            tabindex="-1"
            onmouseleave={() => (menuOpen = false)}
          >
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-zinc-200 hover:bg-zinc-800"
              onclick={(e) => { e.stopPropagation(); openExternally(); }}
            >
              <span class="text-zinc-400">↗</span> Open in default app
            </button>
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-zinc-200 hover:bg-zinc-800"
              onclick={(e) => { e.stopPropagation(); revealInExplorer(); }}
            >
              <span class="text-zinc-400">🗀</span> Reveal in file manager
            </button>
          </div>
        {/if}
      </div>
      <button
        class="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title={$maximizedPaneId === pane.id ? "Restore pane" : "Fullscreen pane"}
        onclick={(e) => { e.stopPropagation(); toggleMaximizedPane(pane.id); }}
      >{$maximizedPaneId === pane.id ? '⤡' : '⛶'}</button>
      <button
        class="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-red-900/50 hover:text-red-300"
        title="Close editor"
        onclick={(e) => { e.stopPropagation(); closePane(pane.id); }}
      >✕</button>
    </div>
  </div>
  {#if !$sessionReady}
    <div class="flex flex-1 items-center justify-center px-4 text-center text-sm text-zinc-500">
      Opening session…
    </div>
  {:else if error}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
      <span class="text-sm text-red-400">{error}</span>
      <button
        class="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-emerald-500 hover:text-emerald-400"
        onclick={(e) => { e.stopPropagation(); retry(); }}
      >Retry</button>
    </div>
  {:else if imageOnly}
    <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#1a1a1a] p-4">
      {#if imageData}
        <img src={imageData} alt={fileName} class="max-h-full max-w-full object-contain" />
      {:else}
        <span class="text-sm text-zinc-500">Loading…</span>
      {/if}
    </div>
  {:else if binary}
    <div class="flex flex-1 items-center justify-center text-sm text-zinc-500">
      Binary or oversized file — cannot display.
    </div>
  {:else}
    <!-- Monaco host stays mounted so the buffer/undo survive mode switches. -->
    <div class="min-h-0 flex-1 {viewMode === 'preview' ? 'hidden' : ''}" bind:this={host}></div>
    {#if viewMode === "preview"}
      {#if previewKind === "markdown"}
        <div class="min-h-0 flex-1 overflow-auto bg-[#1e1e1e]">
          <div class="md-preview">{@html markdownHtml}</div>
        </div>
      {:else if previewKind === "html" || previewKind === "svg"}
        <iframe
          class="min-h-0 flex-1 border-0 bg-white"
          title="Preview of {fileName}"
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
          srcdoc={frameDoc}
        ></iframe>
      {/if}
    {/if}
  {/if}
</div>
