<script lang="ts">
  import type { Snippet } from "svelte";

  // Wraps a region of the tree in a Svelte 5 <svelte:boundary>. A render or
  // $effect error inside `children` is caught here and replaced with a
  // fallback, so the rest of the window keeps running instead of unmounting.
  //
  // Caveat worth knowing before relying on this: boundaries only catch errors
  // raised while Svelte is rendering or running effects. Errors thrown from an
  // event handler, a store subscriber, a setTimeout, or a rejected promise
  // never pass through here — those still need their own try/catch.
  let {
    label = "This panel",
    compact = false,
    onerror,
    children,
  }: {
    /** Region name shown in the fallback and in the console log. */
    label?: string;
    /** Dense single-row fallback, for sidebar sections and other tight slots. */
    compact?: boolean;
    /** Extra handler called alongside the built-in console logging. */
    onerror?: (error: unknown) => void;
    children: Snippet;
  } = $props();

  function handle(error: unknown) {
    console.error(`[ErrorBoundary] ${label} crashed:`, error);
    onerror?.(error);
  }

  function describe(error: unknown): string {
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
</script>

<svelte:boundary onerror={handle}>
  {@render children()}

  {#snippet failed(error: unknown, reset: () => void)}
    {#if compact}
      <div class="flex items-center gap-2 border-y border-red-900/40 bg-red-950/20 px-2 py-1.5">
        <span class="min-w-0 flex-1 truncate text-[11px] text-red-400" title={describe(error)}>
          {label} failed: {describe(error)}
        </span>
        <button
          class="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-emerald-400"
          onclick={reset}>Retry</button>
      </div>
    {:else}
      <div class="flex h-full min-h-0 flex-1 items-center justify-center p-4">
        <div class="max-w-sm text-center">
          <p class="text-xs font-medium text-red-400">{label} crashed</p>
          <p class="mt-1 break-words text-[11px] text-zinc-500">{describe(error)}</p>
          <button
            class="mt-3 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-emerald-500 hover:text-emerald-400"
            onclick={reset}>Retry</button>
        </div>
      </div>
    {/if}
  {/snippet}
</svelte:boundary>
