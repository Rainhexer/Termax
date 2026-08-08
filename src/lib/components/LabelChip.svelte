<script lang="ts">
  /** A GitHub label, in its own colour.
   *
   *  Labels are the one part of an issue whose colour carries meaning the user
   *  chose, so they are rendered in it rather than normalised into the sidebar's
   *  palette — a red `bug` and a green `good first issue` are recognisable at a
   *  glance in a way that six identical grey chips are not.
   *
   *  The text colour is computed rather than fixed: GitHub allows any hex, and a
   *  fixed foreground is unreadable on half the range. This is the same
   *  relative-luminance test GitHub itself uses, which is why a mid-yellow gets
   *  black text and a mid-blue gets white.
   */
  let {
    name,
    color,
    onclick = null,
    active = false,
    title = "",
  }: {
    name: string;
    /** Six-digit hex, no leading '#'. */
    color: string;
    /** Makes the chip a button — used by the filter bar. */
    onclick?: (() => void) | null;
    /** Filter chips: this label is part of the current query. */
    active?: boolean;
    title?: string;
  } = $props();

  /** sRGB relative luminance, per WCAG. */
  function luminance(hex: string): number {
    const clean = /^[0-9a-f]{6}$/i.test(hex) ? hex : "999999";
    const channel = (offset: number) => {
      const value = parseInt(clean.slice(offset, offset + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  }

  const bg = $derived(/^[0-9a-f]{6}$/i.test(color) ? `#${color}` : "#999999");
  // 0.4 rather than the usual 0.5: against this dark panel, a borderline colour
  // reads better with dark text than light.
  const fg = $derived(luminance(color) > 0.4 ? "#111111" : "#ffffff");
  const label = $derived(title || name);
</script>

{#if onclick}
  <button
    class="max-w-full shrink-0 truncate rounded-full px-1.5 text-[9px] font-medium leading-[14px] transition-opacity hover:opacity-100 {active
      ? 'opacity-100 ring-1 ring-zinc-100'
      : 'opacity-70'}"
    style="background-color: {bg}; color: {fg}"
    title={label}
    {onclick}
  >{name}</button>
{:else}
  <span
    class="max-w-full shrink-0 truncate rounded-full px-1.5 text-[9px] font-medium leading-[14px]"
    style="background-color: {bg}; color: {fg}"
    title={label}
  >{name}</span>
{/if}
