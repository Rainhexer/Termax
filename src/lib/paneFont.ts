// Per-pane text zoom (Ctrl +/-/0).
//
// A pane stores an *offset* from the theme's font size (`PaneNode.fontDelta`),
// never an absolute size: a pane that was never zoomed has no offset at all, so
// new panes and untouched ones keep following the theme, and a later change to
// the theme's sizes still moves every pane by the same amount.

/** Smallest/largest size a zoomed pane may end up at, in px. */
const MIN_SIZE = 6;
const MAX_SIZE = 48;

/** Clamp bounds for the offset itself, so a delta grown against a large base
 *  font cannot leave a pane invisible after the theme is switched to a small
 *  one. Wide enough to reach both ends of the size range from any base. */
const MIN_DELTA = -MAX_SIZE;
const MAX_DELTA = MAX_SIZE;

/** One press of Ctrl+= / Ctrl+-, in px. */
export const FONT_STEP = 1;

export function clampDelta(delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  return Math.min(MAX_DELTA, Math.max(MIN_DELTA, Math.round(delta)));
}

/** The size a pane draws at: the theme's size plus the pane's offset. */
export function paneFontSize(base: number, delta: number | undefined): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, base + (delta ?? 0)));
}
