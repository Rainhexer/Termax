<script lang="ts">
  /** Decorative glyph field behind the home screen.
   *
   *  A terminal multiplexer's home screen should look like it belongs to a
   *  terminal. This paints a sparse grid of dim punctuation with a handful of
   *  accent-coloured glyphs — the texture of a roguelike map read at a glance,
   *  not a picture of one.
   *
   *  Deliberately static and generated once from a fixed seed: an animated or
   *  re-randomising background behind a screen you use to *find* something is
   *  motion competing with the content. It is also `aria-hidden` and
   *  `pointer-events-none` — nothing here is content. */

  let { seed = 1337, density = 0.42 }: { seed?: number; density?: number } = $props();

  const GLYPHS = "#+*/\\<>[]{}$;:!?&%~^=|_.,'`\"".split("");
  /** Only theme-mapped colours, so a custom theme recolours the decoration too.
   *  Weighted towards the dimmest entries: this sits *under* real text. */
  const COLORS = [
    "text-zinc-800",
    "text-zinc-800",
    "text-zinc-700",
    "text-zinc-700",
    "text-zinc-600/60",
    "text-emerald-400/35",
    "text-blue-400/35",
    "text-purple-400/35",
    "text-amber-400/35",
  ];

  const COLS = 64;
  const ROWS = 30;

  /** Mulberry32: a two-line PRNG. `Math.random()` would repaint differently on
   *  every hot reload and every re-render, which is exactly what a background
   *  must not do. */
  function rng(state: number) {
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const cells = (() => {
    const next = rng(seed);
    const out: { glyph: string; color: string }[] = [];
    for (let i = 0; i < COLS * ROWS; i++) {
      if (next() > density) {
        out.push({ glyph: " ", color: "" });
        continue;
      }
      out.push({
        glyph: GLYPHS[Math.floor(next() * GLYPHS.length)],
        color: COLORS[Math.floor(next() * COLORS.length)],
      });
    }
    return out;
  })();
</script>

<div
  class="pointer-events-none absolute inset-0 overflow-hidden select-none"
  aria-hidden="true"
>
  <div
    class="grid h-full w-full place-items-center font-mono text-[11px] leading-none opacity-90"
    style="grid-template-columns: repeat({COLS}, 1fr); grid-template-rows: repeat({ROWS}, 1fr)"
  >
    {#each cells as cell, i (i)}
      <span class={cell.color}>{cell.glyph}</span>
    {/each}
  </div>
  <!-- Fade the field out towards the middle so it never competes with the
       cards sitting on top of it. The class lives in app.css: component-scoped
       <style> blocks break the Tailwind dev-server transform here (see the note
       above .menu-item). -->
  <div class="ascii-field-fade absolute inset-0"></div>
</div>
