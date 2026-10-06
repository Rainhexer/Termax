<script lang="ts">
  /** One file-type glyph, drawn in the colour {@link ../fileIcons.ts} chose.
   *
   *  Hand-drawn paths rather than an icon font or an icon package: the whole
   *  set is two dozen shapes at one size, and a font would be a megabyte of
   *  webfont plus a build step to save a few hundred lines. The branch chain
   *  follows TerminalIcon.svelte — Svelte cannot select an element by name, and
   *  {@html} for markup this component owns would be worse, not shorter.
   *
   *  Every glyph is drawn in a 16×16 box with a 1.5px stroke so they sit on the
   *  same optical weight in a row of 11px text. */
  import type { Glyph } from "../fileIcons";

  let {
    glyph,
    color,
    className = "h-3.5 w-3.5",
  }: { glyph: Glyph; color: string; className?: string } = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 16 16"
  class="{className} shrink-0"
  style="color: {color}"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if glyph === "folder"}
    <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.4 1.6h6a1 1 0 0 1 1 1v6.9a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" fill="currentColor" fill-opacity="0.18" />
  {:else if glyph === "folder-open"}
    <path d="M1.75 12.75v-8.5a1 1 0 0 1 1-1h3.1l1.4 1.6h5.5a1 1 0 0 1 1 1v1.4" fill="currentColor" fill-opacity="0.18" />
    <path d="M1.75 12.75 3.6 7.9a1 1 0 0 1 .94-.65h9.4a.7.7 0 0 1 .66.94l-1.55 4.2a1 1 0 0 1-.94.66z" fill="currentColor" fill-opacity="0.18" />
  {:else if glyph === "code"}
    <path d="M9.25 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.25z" fill="currentColor" fill-opacity="0.14" />
    <path d="M9.25 1.75v3.5h3.5" />
    <path d="M6.9 8.6 5.6 9.9l1.3 1.3M9.1 8.6l1.3 1.3-1.3 1.3" />
  {:else if glyph === "braces"}
    <path d="M6.6 2.25c-1.4 0-1.6.9-1.6 2v1.4c0 .9-.5 1.6-1.5 1.6v1.5c1 0 1.5.7 1.5 1.6v1.4c0 1.1.2 2 1.6 2" />
    <path d="M9.4 2.25c1.4 0 1.6.9 1.6 2v1.4c0 .9.5 1.6 1.5 1.6v1.5c-1 0-1.5.7-1.5 1.6v1.4c0 1.1-.2 2-1.6 2" />
  {:else if glyph === "list"}
    <path d="M2.5 4h2.6M7.4 4h6.1M2.5 8h2.6M7.4 8h6.1M2.5 12h2.6M7.4 12h6.1" />
  {:else if glyph === "markdown"}
    <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1" fill="currentColor" fill-opacity="0.14" />
    <path d="M3.9 10.4V5.9l2 2.4 2-2.4v4.5" />
    <path d="M10.6 5.9v3.2M9.3 8.1l1.3 1.5 1.3-1.5" />
  {:else if glyph === "text"}
    <path d="M9.25 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.25z" fill="currentColor" fill-opacity="0.12" />
    <path d="M9.25 1.75v3.5h3.5" />
    <path d="M5.5 8.5h5M5.5 11h3.5" />
  {:else if glyph === "image"}
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.2" fill="currentColor" fill-opacity="0.14" />
    <circle cx="5.6" cy="6.2" r="1.05" />
    <path d="M2.1 12.1 5.9 8.6l2.4 2.2 2.2-2 3.4 3.1" />
  {:else if glyph === "media"}
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.6" fill="currentColor" fill-opacity="0.14" />
    <path d="M6.6 5.9 10.7 8l-4.1 2.1z" fill="currentColor" />
  {:else if glyph === "archive"}
    <path d="M1.75 4.4a1 1 0 0 1 1-1h10.5a1 1 0 0 1 1 1v1.35H1.75z" fill="currentColor" fill-opacity="0.2" />
    <path d="M2.9 5.75h10.2v6.85a1 1 0 0 1-1 1H3.9a1 1 0 0 1-1-1z" fill="currentColor" fill-opacity="0.12" />
    <path d="M6.6 8.5h2.8" />
  {:else if glyph === "lock"}
    <rect x="3.25" y="7" width="9.5" height="6.5" rx="1.3" fill="currentColor" fill-opacity="0.16" />
    <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" />
  {:else if glyph === "key"}
    <circle cx="5.4" cy="6.4" r="2.9" fill="currentColor" fill-opacity="0.16" />
    <path d="M7.5 8.5 13 14M11 12l1.3-1.3M9.6 10.6l1.3-1.3" />
  {:else if glyph === "terminal"}
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.4" fill="currentColor" fill-opacity="0.12" />
    <path d="M4.6 6.2 6.7 8l-2.1 1.8M8.4 10.3h3" />
  {:else if glyph === "database"}
    <ellipse cx="8" cy="4" rx="5.25" ry="2.25" fill="currentColor" fill-opacity="0.16" />
    <path d="M2.75 4v8c0 1.24 2.35 2.25 5.25 2.25S13.25 13.24 13.25 12V4" />
    <path d="M13.25 8c0 1.24-2.35 2.25-5.25 2.25S2.75 9.24 2.75 8" />
  {:else if glyph === "font"}
    <path d="M3.4 12.2 7 3.8l3.6 8.4M4.6 9.6h4.8M12.4 12.2V6.6" />
  {:else if glyph === "book"}
    <path d="M2.75 3a1.25 1.25 0 0 1 1.25-1.25h8.25a1 1 0 0 1 1 1v10.5a1 1 0 0 1-1 1H4a1.25 1.25 0 0 1-1.25-1.25z" fill="currentColor" fill-opacity="0.14" />
    <path d="M2.75 11.9a1.25 1.25 0 0 1 1.25-1.15h9.25M5.5 5h5" />
  {:else if glyph === "gear"}
    <circle cx="8" cy="8" r="2.1" />
    <path d="M12.6 9.9a1.15 1.15 0 0 0 .23 1.27l.04.04a1.4 1.4 0 1 1-1.98 1.98l-.04-.04a1.15 1.15 0 0 0-1.27-.23 1.15 1.15 0 0 0-.7 1.05v.12a1.4 1.4 0 1 1-2.8 0v-.06a1.15 1.15 0 0 0-.75-1.05 1.15 1.15 0 0 0-1.27.23l-.04.04a1.4 1.4 0 1 1-1.98-1.98l.04-.04a1.15 1.15 0 0 0 .23-1.27 1.15 1.15 0 0 0-1.05-.7h-.12a1.4 1.4 0 1 1 0-2.8h.06a1.15 1.15 0 0 0 1.05-.75 1.15 1.15 0 0 0-.23-1.27l-.04-.04a1.4 1.4 0 1 1 1.98-1.98l.04.04a1.15 1.15 0 0 0 1.27.23h.06a1.15 1.15 0 0 0 .7-1.05v-.12a1.4 1.4 0 1 1 2.8 0v.06a1.15 1.15 0 0 0 .7 1.05 1.15 1.15 0 0 0 1.27-.23l.04-.04a1.4 1.4 0 1 1 1.98 1.98l-.04.04a1.15 1.15 0 0 0-.23 1.27v.06a1.15 1.15 0 0 0 1.05.7h.12a1.4 1.4 0 1 1 0 2.8h-.06a1.15 1.15 0 0 0-1.05.7z" />
  {:else if glyph === "git"}
    <circle cx="4.6" cy="3.9" r="1.85" />
    <circle cx="4.6" cy="12.1" r="1.85" />
    <circle cx="11.4" cy="6.4" r="1.85" />
    <path d="M4.6 5.75v4.5M11.4 8.25c0 2-1.6 2.9-3.4 3.1" />
  {:else if glyph === "container"}
    <rect x="1.75" y="7.25" width="3.4" height="3.4" fill="currentColor" fill-opacity="0.2" />
    <rect x="5.9" y="7.25" width="3.4" height="3.4" fill="currentColor" fill-opacity="0.2" />
    <rect x="5.9" y="3.4" width="3.4" height="3.1" fill="currentColor" fill-opacity="0.2" />
    <path d="M9.9 10.65h4.35c0 2.2-1.7 3.6-4.2 3.6-3.5 0-6-1.5-7-3.6" />
  {:else if glyph === "flask"}
    <path d="M6.4 1.9v4.2L2.9 12a1.15 1.15 0 0 0 .98 1.75h8.24A1.15 1.15 0 0 0 13.1 12L9.6 6.1V1.9" fill="currentColor" fill-opacity="0.14" />
    <path d="M5.6 1.9h4.8M4.6 9.6h6.8" />
  {:else if glyph === "chip"}
    <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1" fill="currentColor" fill-opacity="0.16" />
    <path d="M6.4 1.9v2.35M9.6 1.9v2.35M6.4 11.75v2.35M9.6 11.75v2.35M1.9 6.4h2.35M1.9 9.6h2.35M11.75 6.4h2.35M11.75 9.6h2.35" />
  {:else if glyph === "hash"}
    <path d="M6.1 2.2 4.9 13.8M11.1 2.2 9.9 13.8M2.6 5.6h11M2.4 10.4h11" />
  {:else}
    <path d="M9.25 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.25z" fill="currentColor" fill-opacity="0.12" />
    <path d="M9.25 1.75v3.5h3.5" />
  {/if}
</svg>
