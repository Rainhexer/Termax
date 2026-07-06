<script lang="ts">
  import { onMount } from "svelte";
  import { monaco, languageForPath } from "../monaco";
  import { ipc } from "../ipc";
  import { diffTarget } from "../stores";
  import type { DiffTarget } from "../types";

  let { target }: { target: DiffTarget } = $props();

  let host: HTMLDivElement;
  let binary = $state(false);
  let error = $state<string | null>(null);
  let diffEditor: import("monaco-editor").editor.IStandaloneDiffEditor | undefined;
  let plainEditor: import("monaco-editor").editor.IStandaloneCodeEditor | undefined;

  const areaLabel: Record<string, string> = {
    staged: "staged · vs HEAD",
    unstaged: "unstaged · vs index",
    untracked: "untracked · new file",
  };

  function close() {
    diffTarget.set(null);
  }

  onMount(() => {
    let disposed = false;

    (async () => {
      try {
        const diff = await ipc.getDiff(target.path, target.area);
        if (disposed) return;
        if (diff.binary) {
          binary = true;
          return;
        }
        const lang = languageForPath(target.path);
        if (target.area === "untracked") {
          plainEditor = monaco.editor.create(host, {
            value: diff.modified,
            language: lang,
            theme: "vs-dark",
            automaticLayout: true,
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
          });
          return;
        }
        diffEditor = monaco.editor.createDiffEditor(host, {
          theme: "vs-dark",
          automaticLayout: true,
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          fontSize: 12,
          scrollBeyondLastLine: false,
        });
        diffEditor.setModel({
          original: monaco.editor.createModel(diff.original, lang),
          modified: monaco.editor.createModel(diff.modified, lang),
        });
      } catch (err) {
        error = String(err);
      }
    })();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      const model = diffEditor?.getModel();
      diffEditor?.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      const plainModel = plainEditor?.getModel();
      plainEditor?.dispose();
      plainModel?.dispose();
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8" onclick={close}>
  <div
    class="flex h-full w-full flex-col overflow-hidden rounded-xl border border-zinc-700 bg-[#1e1e1e] shadow-2xl"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3">
      <span class="font-mono text-xs text-zinc-300">{target.path}</span>
      {#if target.area}
        <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{areaLabel[target.area] ?? target.area}</span>
      {/if}
      <button
        class="ml-auto rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        onclick={close}
      >✕ Close</button>
    </div>
    {#if binary}
      <div class="flex flex-1 items-center justify-center text-sm text-zinc-500">
        Binary or oversized file — no diff available.
      </div>
    {:else if error}
      <div class="flex flex-1 items-center justify-center text-sm text-red-400">{error}</div>
    {:else}
      <div class="min-h-0 flex-1" bind:this={host}></div>
    {/if}
  </div>
</div>
