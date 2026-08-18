<script lang="ts">
  import {
    detectedAgents,
    launcherVersions,
    settings,
    syncDetected,
    updateSettings,
    type Launcher,
  } from "../settings";
  import { ipc } from "../ipc";
  import TerminalIcon from "./TerminalIcon.svelte";

  const BUILTIN_ICONS = ["shell", "claude", "opencode", "pi", "robot", "sparkles", "gear"];

  // --- add / edit form state ---
  let formName = $state("");
  let formCommand = $state("");
  let formIcon = $state("robot");
  let editingId = $state<string | null>(null);
  let adding = $state(false);
  let warning = $state<string | null>(null);
  let confirmRemoveId = $state<string | null>(null);
  let iconPickerOpen = $state(false);
  let fileInput = $state<HTMLInputElement>();

  const launchers = $derived($settings.launchers);

  function resetForm() {
    formName = "";
    formCommand = "";
    formIcon = "robot";
    editingId = null;
    adding = false;
    warning = null;
    iconPickerOpen = false;
  }

  function startEdit(l: Launcher) {
    adding = false;
    editingId = l.id;
    formName = l.name;
    formCommand = l.command ?? "";
    formIcon = l.icon;
    warning = null;
  }

  async function submit() {
    const name = formName.trim();
    const command = formCommand.trim();
    if (!name || (!command && !editingId)) return;

    warning = null;
    if (command) {
      const ok = await ipc.validateCommand(command).catch(() => true);
      if (!ok) warning = `"${command}" not found on $PATH — saved anyway in case it gets installed later.`;
    }

    if (editingId) {
      const id = editingId;
      updateSettings((s) => ({
        ...s,
        launchers: s.launchers.map((l) =>
          l.id === id
            ? { ...l, name, command: l.command === null ? null : command || l.command, icon: formIcon }
            : l,
        ),
      }));
    } else {
      updateSettings((s) => ({
        ...s,
        launchers: [
          ...s.launchers,
          { id: crypto.randomUUID(), name, command, icon: formIcon, enabled: true },
        ],
      }));
    }
    const keepWarning = warning;
    resetForm();
    warning = keepWarning;
  }

  function toggle(l: Launcher) {
    if (l.command === null) return; // Shell always on
    updateSettings((s) => ({
      ...s,
      launchers: s.launchers.map((x) => (x.id === l.id ? { ...x, enabled: !x.enabled } : x)),
    }));
  }

  function remove(id: string) {
    updateSettings((s) => ({ ...s, launchers: s.launchers.filter((l) => l.id !== id) }));
    if (editingId === id) resetForm();
    confirmRemoveId = null;
  }

  // --- drag reorder ---
  let dragIndex = $state<number | null>(null);
  let dropIndex = $state<number | null>(null);

  function onDrop(e: DragEvent) {
    e.preventDefault();
    if (dragIndex === null || dropIndex === null || dragIndex === dropIndex) {
      dragIndex = dropIndex = null;
      return;
    }
    const from = dragIndex;
    const to = dropIndex;
    updateSettings((s) => {
      const list = [...s.launchers];
      const [moved] = list.splice(from, 1);
      list.splice(to > from ? to - 1 : to, 0, moved);
      return { ...s, launchers: list };
    });
    dragIndex = dropIndex = null;
  }

  function onSvgUpload(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    file.text().then((text) => {
      if (text.trimStart().startsWith("<svg")) {
        formIcon = text.trim();
        iconPickerOpen = false;
      } else {
        warning = "Not an SVG file.";
      }
    });
    (e.target as HTMLInputElement).value = "";
  }

  function versionFor(l: Launcher): string | null {
    return $launcherVersions[l.id] ?? null;
  }
</script>

<div class="flex flex-col gap-4">
  <!-- Detected on your system -->
  <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
    <div class="mb-2 flex items-center justify-between">
      <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Detected on your system</h3>
      <button
        class="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-emerald-500 hover:text-emerald-400"
        onclick={() => syncDetected()}
      >Re-scan</button>
    </div>
    {#if $detectedAgents.length === 0}
      <p class="text-xs text-zinc-600">No known AI coding agents found on $PATH.</p>
    {:else}
      <div class="flex flex-col gap-1">
        {#each $detectedAgents as agent (agent.binary)}
          <div class="flex items-center gap-2 text-xs text-zinc-300">
            <span class="text-emerald-400">✓</span>
            <span>{agent.label}</span>
            <span class="font-mono text-[10px] text-zinc-600">{agent.path}</span>
            {#if agent.version}
              <span class="ml-auto font-mono text-[10px] text-zinc-500">{agent.version}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Launcher list -->
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between px-1">
      <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Launchers</h3>
      <button
        class="rounded px-1.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
        title="Add custom launcher"
        onclick={() => { if (adding || editingId) resetForm(); else adding = true; }}
      >{adding || editingId ? "−" : "+"}</button>
    </div>

    {#each launchers as l, i (l.id)}
      {#if dropIndex === i && dragIndex !== null}
        <div class="h-0.5 rounded bg-emerald-400"></div>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="group flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5"
        class:opacity-50={dragIndex === i}
        ondragover={(e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'move'; dropIndex = i; }}
        ondrop={(e) => onDrop(e)}
      >
        <span
          class="cursor-grab select-none text-zinc-600 hover:text-zinc-400 active:cursor-grabbing"
          draggable="true"
          ondragstart={(e) => { e.dataTransfer!.setData('text/plain', ''); e.dataTransfer!.effectAllowed = 'move'; dragIndex = i; }}
          ondragend={() => { dragIndex = dropIndex = null; }}
          title="Drag to reorder"
        >⠿</span>

        {#if l.command === null}
          <span class="h-4 w-7 shrink-0 text-center text-[10px] leading-4 text-zinc-600" title="Shell is always available">on</span>
        {:else}
          <button
            class="relative h-4 w-7 shrink-0 rounded-full transition-colors {l.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}"
            title={l.enabled ? "Shown in sidebar" : "Hidden from sidebar"}
            onclick={() => toggle(l)}
          >
            <span class="absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all {l.enabled ? 'left-3.5' : 'left-0.5'}"></span>
          </button>
        {/if}

        <span class="text-emerald-400"><TerminalIcon type={l.icon} className="h-4 w-4" /></span>
        <span class="min-w-0 flex-1 truncate text-xs text-zinc-200">{l.name}</span>

        {#if versionFor(l)}
          <span class="font-mono text-[10px] text-zinc-500">{versionFor(l)}</span>
        {/if}

        {#if l.command !== null}
          <button
            class="hidden rounded px-1 text-[11px] text-zinc-600 hover:text-emerald-400 group-hover:block"
            title="Edit"
            onclick={() => startEdit(l)}
          >✎</button>
          {#if confirmRemoveId === l.id}
            <button
              class="rounded bg-red-900/60 px-1.5 text-[11px] text-red-300 hover:bg-red-800"
              onclick={() => remove(l.id)}
            >confirm</button>
            <button
              class="rounded px-1 text-[11px] text-zinc-500 hover:text-zinc-300"
              onclick={() => (confirmRemoveId = null)}
            >✕</button>
          {:else}
            <button
              class="hidden rounded px-1 text-[11px] text-zinc-600 hover:text-red-400 group-hover:block"
              title="Remove"
              onclick={() => (confirmRemoveId = l.id)}
            >✕</button>
          {/if}
        {/if}
      </div>
    {/each}
    {#if dropIndex === launchers.length && dragIndex !== null}
      <div class="h-0.5 rounded bg-emerald-400"></div>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="h-2"
      ondragover={(e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'move'; dropIndex = launchers.length; }}
      ondrop={(e) => onDrop(e)}
    ></div>
  </div>

  <!-- Add / edit form -->
  {#if adding || editingId}
    <form
      class="flex flex-col gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 p-2"
      onsubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {editingId ? "Edit launcher" : "Add custom launcher"}
      </span>
      <input
        class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-500"
        placeholder="Name (e.g. My Custom Agent)"
        bind:value={formName}
      />
      <input
        class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500"
        placeholder="Command (e.g. my-agent or /opt/bin/my-agent)"
        bind:value={formCommand}
        disabled={editingId !== null && launchers.find((l) => l.id === editingId)?.command === null}
      />
      <div class="relative">
        <button
          type="button"
          class="flex w-full items-center justify-between rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
          onclick={() => (iconPickerOpen = !iconPickerOpen)}
        >
          <span class="flex items-center gap-1.5">
            <span class="text-emerald-400"><TerminalIcon type={formIcon} className="h-3.5 w-3.5" /></span>
            Icon
          </span>
          <span class="text-zinc-500">▾</span>
        </button>
        {#if iconPickerOpen}
          <div class="absolute left-0 right-0 top-full z-50 mt-1 flex items-center gap-1 rounded border border-zinc-700 bg-zinc-950 p-2 shadow-lg">
            {#each BUILTIN_ICONS as icon (icon)}
              <button
                type="button"
                class="rounded p-1.5 text-emerald-400 hover:bg-zinc-800"
                class:bg-zinc-800={formIcon === icon}
                title={icon}
                onclick={() => { formIcon = icon; iconPickerOpen = false; }}
              >
                <TerminalIcon type={icon} className="h-4 w-4" />
              </button>
            {/each}
            <button
              type="button"
              class="ml-auto rounded border border-dashed border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:border-emerald-500 hover:text-emerald-400"
              onclick={() => fileInput?.click()}
            >Upload SVG…</button>
            <input type="file" accept=".svg,image/svg+xml" class="hidden" bind:this={fileInput} onchange={onSvgUpload} />
          </div>
        {/if}
      </div>
      <div class="flex gap-1.5">
        <button class="flex-1 rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500" type="submit">
          {editingId ? "Update" : "Add"}
        </button>
        <button class="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800" type="button" onclick={resetForm}>
          Cancel
        </button>
      </div>
    </form>
  {/if}

  {#if warning}
    <p class="rounded border border-amber-800/60 bg-amber-950/40 px-2 py-1 text-xs text-amber-400">⚠ {warning}</p>
  {/if}
</div>
