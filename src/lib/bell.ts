import { get, writable } from "svelte/store";

/** Pane ids whose bell watch is on (mirror of `PaneNode.bell`, kept in sync by
 *  stores.ts so the terminal layer can check it without importing the layout). */
export const bellPanes = writable<Set<string>>(new Set());

/** Pane ids currently ringing: the command finished or the program wants input.
 *  Drives the pulsing pane border and the pulsing tab. */
export const attentionPanes = writable<Set<string>>(new Set());

export function setFocusedPane(id: string | null) {
  // Moving into a pane acknowledges whatever it was ringing about.
  if (id) clearAttention(id);
}

export function clearAttention(paneId: string) {
  attentionPanes.update((s) => {
    if (!s.has(paneId)) return s;
    const next = new Set(s);
    next.delete(paneId);
    return next;
  });
}

/** Ring for a pane: chime + start the glow. No-op when its bell is off. */
export function notifyPane(paneId: string) {
  if (!get(bellPanes).has(paneId)) return;
  let fresh = false;
  attentionPanes.update((s) => {
    if (s.has(paneId)) return s;
    fresh = true;
    return new Set(s).add(paneId);
  });
  // Already glowing: don't chime again until the user acknowledges it.
  if (fresh) chime();
}

/** Play the chime once, so switching the bell on confirms audio works. */
export function previewChime() {
  chime();
}

// Synthesized so no audio asset has to ship: a soft two-note ping.
let ctx: AudioContext | null = null;

function chime() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const start = ctx.currentTime;
    [880, 1318.5].forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = start + i * 0.11;
      // Exponential ramps need a non-zero floor, hence 0.0001 rather than 0.
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.45);
    });
  } catch {
    // No audio device / autoplay blocked: the visual pulse still fires.
  }
}
