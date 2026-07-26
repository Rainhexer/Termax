<script lang="ts">
  /**
   * Dropdown with a themed popup. Native <select> popups are drawn by the OS
   * and ignore the app's colours (white-on-white under a dark theme), so every
   * themed picker uses this instead. `previewFont` renders each row in the font
   * it names, which is what makes the font pickers useful.
   */
  import { fontStack } from "../theme";

  type Option = { value: string; label: string; group?: string };

  let {
    value,
    options,
    onselect,
    previewFont = false,
    placeholder = "Select…",
    sample = "",
    disabled = false,
  }: {
    value: string;
    options: Option[];
    onselect: (value: string) => void;
    previewFont?: boolean;
    placeholder?: string;
    sample?: string;
    disabled?: boolean;
  } = $props();

  /** Rows rendered at once; a long font list is filtered, not scrolled forever. */
  const MAX_ROWS = 120;

  let open = $state(false);
  let query = $state("");
  let highlight = $state(0);
  let trigger = $state<HTMLButtonElement>();
  let popup = $state<HTMLDivElement>();
  let searchEl = $state<HTMLInputElement>();
  /** Popup is positioned fixed so it escapes the settings pane's scroll clip. */
  let rect = $state({ left: 0, top: 0, width: 0, below: true });

  const current = $derived(options.find((o) => o.value === value));
  const label = $derived(current?.label ?? value ?? placeholder);
  const filtered = $derived(
    query.trim()
      ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
      : options,
  );
  const shown = $derived(filtered.slice(0, MAX_ROWS));
  const hidden = $derived(filtered.length - shown.length);

  function place() {
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 240 || r.top < 260;
    rect = {
      left: r.left,
      top: below ? r.bottom + 4 : r.top - 4,
      width: r.width,
      below,
    };
  }

  function toggle() {
    if (disabled) return;
    open = !open;
    if (!open) return;
    query = "";
    highlight = Math.max(0, shown.findIndex((o) => o.value === value));
    place();
    queueMicrotask(() => searchEl?.focus());
  }

  function choose(v: string) {
    onselect(v);
    open = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      // Close only the popup — the settings modal also listens for Escape.
      e.stopPropagation();
      open = false;
      trigger?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight = Math.min(highlight + 1, shown.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight = Math.max(highlight - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = shown[highlight];
      if (pick) choose(pick.value);
    }
  }

  $effect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (trigger?.contains(e.target as Node) || popup?.contains(e.target as Node)) return;
      open = false;
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  });

  // Keep the highlighted row in view while arrowing through a long list.
  $effect(() => {
    if (!open) return;
    highlight;
    popup?.querySelector("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  });
</script>

<button
  bind:this={trigger}
  type="button"
  {disabled}
  class="flex w-full items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-left text-xs text-zinc-200 outline-none hover:border-zinc-600 focus:border-emerald-500 disabled:opacity-50"
  onclick={toggle}
>
  <span class="min-w-0 flex-1 truncate" style={previewFont ? `font-family: ${fontStack(value)}` : ""}>
    {label}
  </span>
  {#if sample}
    <span class="hidden shrink-0 truncate text-[11px] text-zinc-500 sm:inline" style="font-family: {fontStack(value)}">
      {sample}
    </span>
  {/if}
  <span class="shrink-0 text-[10px] text-zinc-500">▾</span>
</button>

{#if open}
  <div
    bind:this={popup}
    class="fixed z-[100] flex max-h-72 flex-col overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/50"
    style="left: {rect.left}px; width: {Math.max(rect.width, 220)}px; {rect.below
      ? `top: ${rect.top}px`
      : `bottom: ${window.innerHeight - rect.top}px`}"
  >
    <input
      bind:this={searchEl}
      bind:value={query}
      onkeydown={onKey}
      placeholder="Search…"
      class="shrink-0 border-b border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
    />
    <div class="min-h-0 flex-1 overflow-y-auto py-1">
      {#each shown as option, i (option.value)}
        {#if option.group && (i === 0 || shown[i - 1].group !== option.group)}
          <div class="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            {option.group}
          </div>
        {/if}
        <button
          type="button"
          data-active={i === highlight}
          class="flex w-full items-center gap-2 px-2 py-1 text-left text-xs {option.value === value
            ? 'text-emerald-400'
            : 'text-zinc-200'} {i === highlight ? 'bg-zinc-800' : ''}"
          onmouseenter={() => (highlight = i)}
          onclick={() => choose(option.value)}
        >
          <span class="min-w-0 flex-1 truncate" style={previewFont ? `font-family: ${fontStack(option.value)}` : ""}>
            {option.label}
          </span>
          {#if option.value === value}<span class="shrink-0 text-[10px]">✓</span>{/if}
        </button>
      {/each}
      {#if shown.length === 0}
        <p class="px-2 py-2 text-[11px] text-zinc-500">No matches.</p>
      {:else if hidden > 0}
        <p class="px-2 py-1.5 text-[11px] text-zinc-600">{hidden} more — keep typing to narrow.</p>
      {/if}
    </div>
  </div>
{/if}
