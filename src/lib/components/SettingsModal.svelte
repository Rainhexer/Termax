<script lang="ts">
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { ipc } from "../ipc";
  import { settings, settingsOpen, syncDetected, updateSettings } from "../settings";
  import LauncherSettings from "./LauncherSettings.svelte";
  import AppearanceSettings from "./AppearanceSettings.svelte";
  import logoUrl from "../assets/termax-logo.svg";

  type Section = "launchers" | "appearance" | "terminal" | "about";
  let section = $state<Section>("launchers");
  let appVersion = $state("");

  const SECTIONS: { id: Section; label: string }[] = [
    { id: "launchers", label: "Agents & Launchers" },
    { id: "appearance", label: "Appearance" },
    { id: "terminal", label: "Terminal" },
    { id: "about", label: "About" },
  ];

  const CURSOR_STYLES: { style: "block" | "underline" | "bar"; blink: boolean; label: string }[] = [
    { style: "block", blink: false, label: "Block" },
    { style: "block", blink: true, label: "Blink block" },
    { style: "underline", blink: false, label: "Underline" },
    { style: "underline", blink: true, label: "Blink underline" },
    { style: "bar", blink: false, label: "Bar" },
    { style: "bar", blink: true, label: "Blink bar" },
  ];

  const REPO_URL = "https://github.com/Rainhexer/Termax";

  function close() {
    settingsOpen.set(false);
  }

  onMount(() => {
    syncDetected();
    getVersion().then((v) => (appVersion = v)).catch(() => {});
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function setTerminal<K extends keyof typeof $settings.terminal>(key: K, value: (typeof $settings.terminal)[K]) {
    updateSettings((s) => ({ ...s, terminal: { ...s.terminal, [key]: value } }));
  }

  const cursorLabel = $derived(
    CURSOR_STYLES.find(
      (c) => c.style === $settings.terminal.cursorStyle && c.blink === $settings.terminal.cursorBlink,
    )?.label ?? "Blink underline",
  );

  function num(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onclick={close}>
  <div
    class="flex h-[560px] w-[720px] max-w-[92vw] max-h-[88vh] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
    onclick={(e) => e.stopPropagation()}
  >
    <!-- section nav -->
    <nav class="flex w-44 shrink-0 flex-col gap-0.5 border-r border-zinc-800 bg-zinc-900/40 p-2">
      <h2 class="mb-2 px-2 pt-1 text-sm font-semibold text-zinc-100">Settings</h2>
      {#each SECTIONS as s (s.id)}
        <button
          class="rounded-md px-2 py-1.5 text-left text-xs transition-colors {section === s.id
            ? 'bg-zinc-800 text-emerald-400'
            : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'}"
          onclick={() => (section = s.id)}
        >{s.label}</button>
      {/each}
    </nav>

    <!-- content -->
    <div class="relative min-w-0 flex-1 overflow-y-auto p-5">
      <button
        class="absolute right-3 top-3 rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title="Close settings"
        onclick={close}
      >✕</button>

      {#if section === "launchers"}
        <h2 class="mb-3 text-sm font-semibold text-zinc-100">Agents & Launchers</h2>
        <LauncherSettings />
      {:else if section === "appearance"}
        <h2 class="mb-3 text-sm font-semibold text-zinc-100">Appearance</h2>
        <AppearanceSettings />
      {:else if section === "terminal"}
        <h2 class="mb-3 text-sm font-semibold text-zinc-100">Terminal</h2>
        <div class="flex flex-col gap-4">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-zinc-400">Default shell <span class="text-zinc-600">(empty = auto-detect $SHELL)</span></span>
            <input
              class="w-72 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500"
              placeholder="/bin/bash"
              value={$settings.terminal.defaultShell}
              onchange={(e) => setTerminal("defaultShell", (e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-zinc-400">Scrollback lines <span class="text-zinc-600">(applies to new panes)</span></span>
            <input type="number" min="1000" max="100000" step="1000"
              class="w-32 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-500"
              value={$settings.terminal.scrollback}
              onchange={(e) => setTerminal("scrollback", Math.min(100000, Math.max(1000, num(e))))}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-zinc-400">Cursor style <span class="text-zinc-600">(applies to new panes)</span></span>
            <select
              class="w-56 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-500"
              value={cursorLabel}
              onchange={(e) => {
                const c = CURSOR_STYLES.find((x) => x.label === (e.target as HTMLSelectElement).value);
                if (!c) return;
                updateSettings((s) => ({
                  ...s,
                  terminal: { ...s.terminal, cursorStyle: c.style, cursorBlink: c.blink },
                }));
              }}
            >
              {#each CURSOR_STYLES as c (c.label)}
                <option value={c.label}>{c.label}</option>
              {/each}
            </select>
          </label>
          <p class="text-xs text-zinc-600">
            Cursor colour and the rest of the terminal palette live in
            <button class="text-emerald-400 hover:underline" onclick={() => (section = "appearance")}>Appearance</button>.
          </p>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-zinc-400">Oversized file limit (KB) <span class="text-zinc-600">— max file size for diff/snapshot tracking</span></span>
            <input type="number" min="64" max="65536" step="64"
              class="w-32 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-500"
              value={$settings.terminal.oversizedLimitKb}
              onchange={(e) => setTerminal("oversizedLimitKb", Math.max(1, num(e)))}
            />
          </label>
        </div>
      {:else}
        <h2 class="mb-3 text-sm font-semibold text-zinc-100">About</h2>
        <div class="flex flex-col gap-3 text-xs text-zinc-400">
          <div class="flex items-center">
            <img src={logoUrl} alt="Termax logo" class="h-5 w-5" />
            <span class="ml-1.5 text-sm font-semibold text-zinc-100">Termax</span>
            <span class="ml-2 font-mono text-zinc-500">v{appVersion || "0.1.0"}</span>
          </div>
          <p>Terminal multiplexer and project manager for AI coding agents.</p>
          <div class="flex gap-3">
            <button class="text-emerald-400 hover:underline" onclick={() => ipc.openUrl(REPO_URL)}>Repository</button>
            <button class="text-emerald-400 hover:underline" onclick={() => ipc.openUrl(`${REPO_URL}/issues`)}>Issue tracker</button>
          </div>
          <div class="mt-2">
            <h3 class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Built with</h3>
            <ul class="flex flex-col gap-0.5 text-zinc-500">
              <li>Tauri 2 — app shell &amp; Rust backend</li>
              <li>Svelte 5 — UI</li>
              <li>xterm.js — terminal emulation</li>
              <li>Monaco — editor &amp; diffs</li>
              <li>portable-pty, notify, similar — PTY, file watching, diffing</li>
            </ul>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
