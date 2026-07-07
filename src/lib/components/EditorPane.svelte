<script lang="ts">
  import { get } from "svelte/store";
  import type { ChangeArea, PaneNode } from "../types";
  import { monaco, languageForPath } from "../monaco";
  import { ipc } from "../ipc";
  import { settings } from "../settings";
  import {
    changes,
    closePane,
    explorerLocked,
    focusedPaneId,
    fsTick,
    lockFlash,
    movePane,
    splitPaneAt,
    draggedPaneId,
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

  const focused = $derived($focusedPaneId === pane.id);
  const path = $derived(pane.file ?? "");
  const locked = $derived($explorerLocked);

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
    try {
      const file = await ipc.readFile(filePath);
      if (gen !== generation) return;
      if (file.binary) {
        binary = true;
        return;
      }
      loadedContent = file.content;
      model = monaco.editor.createModel(file.content, languageForPath(filePath));
      model.onDidChangeContent(() => {
        dirty = model!.getValue() !== loadedContent;
      });
      createPlainEditor();
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

  // (Re)create everything whenever this pane starts showing a different file.
  $effect(() => {
    const p = path;
    binary = false;
    error = null;
    externallyChanged = false;
    dirty = false;
    conflict = false;
    showDiff = false;
    saveError = null;
    load(p);
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
    if (model) reloadFromDisk();
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
    <span class="truncate font-mono text-[11px] {focused ? 'text-emerald-400' : 'text-zinc-400'}">
      {path}
    </span>
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
      <button
        class="rounded px-1.5 py-0.5 font-mono text-[11px] {showDiff
          ? 'bg-emerald-950/60 text-emerald-400'
          : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'}"
        title={showDiff ? "Hide changes" : "Show changes"}
        onclick={(e) => { e.stopPropagation(); toggleDiff(); }}
      >±</button>
      <button
        class="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-red-900/50 hover:text-red-300"
        title="Close editor"
        onclick={(e) => { e.stopPropagation(); closePane(pane.id); }}
      >✕</button>
    </div>
  </div>
  {#if binary}
    <div class="flex flex-1 items-center justify-center text-sm text-zinc-500">
      Binary or oversized file — cannot display.
    </div>
  {:else if error}
    <div class="flex flex-1 items-center justify-center px-4 text-center text-sm text-red-400">{error}</div>
  {:else}
    <div class="min-h-0 flex-1" bind:this={host}></div>
  {/if}
</div>
