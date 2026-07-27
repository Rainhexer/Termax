// Scroll position of editor panes, persisted across restarts.
//
// Deliberately kept out of the layout tree: scroll changes on every frame the
// user drags a scrollbar, and every layout write re-renders the whole grid and
// schedules a backend save. The view mode (edit/preview) changes only on a
// click, so that one does live in the layout next to `diff`.

/** Where a pane is scrolled to, in a form both views can honour. */
export interface PaneScroll {
  /** Fractional source line at the top of the viewport, 1-based. Set by views
   *  that can map pixels to source lines (Monaco, Markdown preview). */
  line?: number;
  /** Normalized 0..1 position, for views with no line mapping (html/svg/image). */
  pct?: number;
}

interface Entry extends PaneScroll {
  /** Last write, for evicting entries of panes that no longer exist. */
  t: number;
}

const KEY = "tmx.paneScroll";
/** Panes are closed without notice (project deleted, layout reset), so cap the
 *  map and drop the least recently used entries instead of growing forever. */
const MAX_ENTRIES = 500;
const WRITE_DELAY = 200;

let cache: Record<string, Entry> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function store(): Record<string, Entry> {
  if (!cache) {
    try {
      cache = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Entry>;
    } catch {
      cache = {};
    }
  }
  return cache;
}

/** Write the cache to localStorage now, dropping anything over the cap. */
export function flushPaneScroll() {
  clearTimeout(timer);
  timer = undefined;
  if (!cache) return;
  const ids = Object.keys(cache);
  if (ids.length > MAX_ENTRIES) {
    const stale = ids.sort((a, b) => cache![a].t - cache![b].t).slice(0, ids.length - MAX_ENTRIES);
    for (const id of stale) delete cache[id];
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // quota or private mode: scroll restore degrades, nothing else breaks
  }
}

export function getPaneScroll(paneId: string): PaneScroll {
  const entry = store()[paneId];
  return entry ? { line: entry.line, pct: entry.pct } : {};
}

export function setPaneScroll(paneId: string, scroll: PaneScroll) {
  store()[paneId] = { ...scroll, t: Date.now() };
  if (timer) return;
  timer = setTimeout(flushPaneScroll, WRITE_DELAY);
}

export function clearPaneScroll(paneId: string) {
  if (!(paneId in store())) return;
  delete store()[paneId];
  flushPaneScroll();
}

if (typeof window !== "undefined") {
  // The debounced write is short, but a window close can still land inside it.
  window.addEventListener("pagehide", flushPaneScroll);
}
