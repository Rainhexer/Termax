<script module lang="ts">
  // Cursor, selection and folding survive the remounts caused by tab switches
  // and fullscreen toggles. This is session-only on purpose; the two things
  // that must survive a restart — view mode and scroll position — are
  // persisted in the layout (`PaneNode.view`) and in paneScroll.ts.
  type CodeViewState = import("monaco-editor").editor.ICodeEditorViewState;
  type DiffViewState = import("monaco-editor").editor.IDiffEditorViewState;
  const editorViewStateMap = new Map<string, CodeViewState | DiffViewState>();
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { get } from "svelte/store";
  import type { ChangeArea, PaneNode } from "../types";
  import { getMonaco, languageForPath, MONACO_THEME } from "../monaco";
  import { hasPreview, previewDocument, previewKindForPath, renderMarkdown } from "../preview";
  import { flushPaneScroll, getPaneScroll, setPaneScroll, type PaneScroll } from "../paneScroll";
  import { fontStack } from "../theme";
  import { ipc } from "../ipc";
  import { settings } from "../settings";
  import {
    activeRoot,
    changes,
    closePane,
    explorerLocked,
    focusedPaneId,
    fsTick,
    lockFlash,
    maximizedPaneId,
    sessionReady,
    setPaneDiff,
    setPaneView,
    toggleMaximizedPane,
  } from "../stores";
  import { dropTarget, startPaneDrag } from "../paneDrag";

  type CodeEditor = import("monaco-editor").editor.ICodeEditor;

  let { pane }: { pane: PaneNode } = $props();
  // TilingLayout keys panes by id, so this instance is bound to one id for its
  // whole life. Read it once: touching `pane` inside an $effect subscribes that
  // effect to the entire layout store, and every unrelated layout write (a
  // split drag, another pane opening) would then re-run it.
  const paneId = untrack(() => pane.id);
  let host: HTMLDivElement;
  let self: HTMLDivElement;
  /** Which edge of this pane the thing in hand would land on, if any. Drags are
   *  pointer-driven (see paneDrag.ts), so hit-testing is central rather than
   *  per-element `dragover`. */
  const currentZone = $derived(
    $dropTarget?.kind === "pane" && $dropTarget.paneId === paneId ? $dropTarget.zone : null,
  );
  let binary = $state(false);
  let error = $state<string | null>(null);
  /** Set when the file changed on disk and the view was reloaded. */
  let externallyChanged = $state(false);
  /** Unsaved edits in the buffer. */
  let dirty = $state(false);
  /** File changed on disk while the buffer had unsaved edits. */
  let conflict = $state(false);
  /** Diff view (changes vs git base / session snapshot) instead of plain content. */
  let showDiff = $state(false);
  let saveError = $state<string | null>(null);
  /** Bumped once the buffer model exists, so the diff-reconcile effect can run. */
  let modelReady = $state(0);
  /** "edit" = raw text (Monaco), "preview" = interpret the file. */
  let viewMode = $state<"edit" | "preview">(initialView());
  /** Live buffer text mirrored for markdown/html/svg previews. */
  let previewText = $state("");
  /** Debounced copy of `previewText` feeding the iframe: rebuilding srcdoc
   *  reloads the frame, so it must not happen on every keystroke. */
  let previewSrc = $state("");
  let previewSrcTimer: ReturnType<typeof setTimeout> | undefined;
  /** data: URL for raster-image previews. */
  let imageData = $state<string | null>(null);
  /** Kebab (⋯) menu open state. */
  let menuOpen = $state(false);
  /** Scroll containers of the preview views. */
  let previewEl: HTMLDivElement | undefined;
  let previewFrame: HTMLIFrameElement | undefined;
  let imageEl: HTMLDivElement | undefined;

  /** The one scroll position of this pane, shared by the edit and preview
   *  views and persisted across restarts. Plain, not `$state`: it is rewritten
   *  on every scroll frame and nothing renders from it. */
  let anchor: PaneScroll = {}; // loaded from storage by the (re)load effect
  /** Scroll events before this timestamp are our own doing — ignore them, or a
   *  restore would immediately overwrite the position it just restored. */
  let suppressUntil = 0;

  /** Image files have no edit view, so they always open in preview. */
  function initialView(): "edit" | "preview" {
    return untrack(() =>
      previewKindForPath(pane.file ?? "") === "image" ? "preview" : (pane.view ?? "edit"),
    );
  }

  const focused = $derived($focusedPaneId === paneId);
  const path = $derived(pane.file ?? "");
  const fileName = $derived(path.split("/").pop() ?? path);
  const dirName = $derived(path.slice(0, path.length - fileName.length).replace(/\/$/, ""));
  const locked = $derived($explorerLocked);
  const previewKind = $derived(previewKindForPath(path));
  const previewable = $derived(hasPreview(path));
  /** Image files have no editable text view. */
  const imageOnly = $derived(previewKind === "image");
  const markdownHtml = $derived(
    viewMode === "preview" && previewKind === "markdown" ? renderMarkdown(previewText) : "",
  );
  /** srcdoc for html/svg preview (rendered live in a sandboxed iframe). Built
   *  from the debounced text and kept mounted while editing, so the frame is
   *  not reloaded — and its scroll position lost — on every mode switch. */
  const frameDoc = $derived(
    (previewKind === "html" || previewKind === "svg") && previewSrc
      ? previewDocument(previewSrc)
      : "",
  );

  // The buffer model is shared between the plain and diff editors so text,
  // cursor-adjacent state and undo history survive view toggles.
  let model: import("monaco-editor").editor.ITextModel | undefined;
  let originalModel: import("monaco-editor").editor.ITextModel | undefined;
  let plainEditor: import("monaco-editor").editor.IStandaloneCodeEditor | undefined;
  let diffEditor: import("monaco-editor").editor.IStandaloneDiffEditor | undefined;
  let loadedContent: string | null = null;

  // Guards async loads against pane teardown / file switch mid-request.
  let generation = 0;

  const editorOptions = () => ({
    theme: MONACO_THEME,
    automaticLayout: true,
    readOnly: get(explorerLocked),
    lineNumbers: "off" as const,
    minimap: { enabled: false },
    fontSize: get(settings).appearance.theme.fonts.editorSize,
    fontFamily: fontStack(get(settings).appearance.theme.fonts.editor, "mono"),
    scrollBeyondLastLine: false,
  });

  // Live-apply editor font changes from the theme (colours come from Monaco's
  // themeing, which monaco.ts re-defines on every theme change).
  $effect(() => {
    const fonts = $settings.appearance.theme.fonts;
    const opts = { fontSize: fonts.editorSize, fontFamily: fontStack(fonts.editor, "mono") };
    plainEditor?.updateOptions(opts);
    diffEditor?.updateOptions(opts);
  });

  function saveEditorState() {
    // Only persist state when the editor is visible — a hidden editor
    // (preview mode) has zero dimensions and its view state is garbage.
    if (viewMode !== "edit") return;
    const state = plainEditor?.saveViewState() ?? diffEditor?.saveViewState();
    if (state) editorViewStateMap.set(paneId, state);
  }

  function restoreEditorState() {
    const saved = editorViewStateMap.get(paneId);
    if (!saved) return;
    // The plain and diff views store different shapes; a mismatch after a diff
    // toggle is harmless — Monaco ignores state it cannot read.
    if (plainEditor) plainEditor.restoreViewState(saved as CodeViewState);
    else if (diffEditor) diffEditor.restoreViewState(saved as DiffViewState);
  }

  // ---------------------------------------------------------------------------
  // Scroll position.
  //
  // Both views agree on a single `anchor` instead of each keeping its own
  // offset: capture it from whichever view is on screen, apply it to whichever
  // view becomes visible. Switching modes, remounting (tab switch, fullscreen),
  // resizing and restarting are then all the same operation, and edit/preview
  // stay on the same part of the document for free.
  //
  // A pixel offset would not survive any of that, so the anchor is a source
  // line where the content can be mapped back to one (Monaco, and Markdown via
  // the `data-line` attributes the renderer emits) and a fraction otherwise
  // (html/svg/image, which have no relationship to source lines).
  // ---------------------------------------------------------------------------

  /** The code editor on screen: plain, or the diff's editable right-hand side. */
  function codeEditor(): CodeEditor | undefined {
    return plainEditor ?? diffEditor?.getModifiedEditor();
  }

  /** Linear interpolation through a list of points sorted by `x`. */
  function interpolate(points: [number, number][], x: number): number {
    if (!points.length) return 0;
    if (x <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      if (x <= bx) return bx === ax ? by : ay + ((x - ax) / (bx - ax)) * (by - ay);
    }
    return points[points.length - 1][1];
  }

  /** Fractional source line shown at pixel offset `top` of the editor. */
  function editorLineAt(ed: CodeEditor, top: number): number {
    const count = ed.getModel()?.getLineCount() ?? 1;
    let lo = 1;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ed.getTopForLineNumber(mid) <= top) lo = mid;
      else hi = mid - 1;
    }
    const a = ed.getTopForLineNumber(lo);
    const b = lo < count ? ed.getTopForLineNumber(lo + 1) : ed.getContentHeight();
    return b > a ? lo + Math.min(0.999, (top - a) / (b - a)) : lo;
  }

  /** Pixel offset that puts fractional source `line` at the top of the editor. */
  function editorOffsetFor(ed: CodeEditor, line: number): number {
    const count = ed.getModel()?.getLineCount() ?? 1;
    const l = Math.max(1, Math.min(count, Math.floor(line)));
    const a = ed.getTopForLineNumber(l);
    const b = l < count ? ed.getTopForLineNumber(l + 1) : ed.getContentHeight();
    return a + Math.max(0, Math.min(1, line - l)) * (b - a);
  }

  /** (source line, pixel offset) points for the rendered Markdown blocks. */
  function markdownPoints(): [number, number][] {
    if (!previewEl) return [];
    const base = previewEl.getBoundingClientRect().top - previewEl.scrollTop;
    const points: [number, number][] = [];
    for (const el of previewEl.querySelectorAll<HTMLElement>("[data-line]")) {
      const line = Number(el.dataset.line);
      if (Number.isFinite(line)) points.push([line, el.getBoundingClientRect().top - base]);
    }
    points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    // Sentinel so a position past the last block maps to the end of the file
    // rather than clamping to the last block's line.
    const lines = model?.getLineCount() ?? 0;
    if (lines) points.push([lines + 1, previewEl.scrollHeight]);
    return points;
  }

  /** Read the scroll position out of the visible view, or null if it has none
   *  to give (hidden, still loading, or too short to scroll). */
  function readScroll(): PaneScroll | null {
    if (viewMode === "edit") {
      const ed = codeEditor();
      const height = ed?.getLayoutInfo().height ?? 0;
      if (!ed || height <= 0) return null;
      const max = ed.getScrollHeight() - height;
      if (max <= 0) return null;
      const top = ed.getScrollTop();
      return { line: editorLineAt(ed, top), pct: top / max };
    }
    if (previewKind === "markdown") {
      if (!previewEl?.clientHeight) return null;
      const max = previewEl.scrollHeight - previewEl.clientHeight;
      if (max <= 0) return null;
      const top = previewEl.scrollTop;
      const points = markdownPoints();
      return {
        line: interpolate(points.map(([l, t]) => [t, l]), top),
        pct: top / max,
      };
    }
    if (previewKind === "image") {
      if (!imageEl?.clientHeight) return null;
      const max = imageEl.scrollHeight - imageEl.clientHeight;
      return max > 0 ? { pct: imageEl.scrollTop / max } : null;
    }
    // html/svg report their own position over postMessage (see onFrameMessage).
    return null;
  }

  /** Store a position read from the visible view. Keeps the previous anchor
   *  when the view has nothing to say, so a short preview never resets a
   *  carefully scrolled editor. */
  function captureScroll() {
    if (performance.now() < suppressUntil) return;
    const next = readScroll();
    if (!next) return;
    anchor = next;
    setPaneScroll(paneId, next);
  }

  /** Scroll the visible view to the anchor. False when the view was not ready
   *  to take it (still hidden, not yet laid out, content not rendered). */
  function applyScroll(): boolean {
    if (anchor.line === undefined && anchor.pct === undefined) return true;
    suppressUntil = performance.now() + 250;
    if (viewMode === "edit") {
      const ed = codeEditor();
      const height = ed?.getLayoutInfo().height ?? 0;
      if (!ed || height <= 0) return false;
      const max = Math.max(0, ed.getScrollHeight() - height);
      ed.setScrollTop(
        anchor.line !== undefined ? editorOffsetFor(ed, anchor.line) : (anchor.pct ?? 0) * max,
      );
      return true;
    }
    if (previewKind === "markdown") {
      if (!previewEl?.clientHeight) return false;
      const max = previewEl.scrollHeight - previewEl.clientHeight;
      previewEl.scrollTop =
        anchor.line !== undefined
          ? interpolate(markdownPoints(), anchor.line)
          : (anchor.pct ?? 0) * max;
      return true;
    }
    if (previewKind === "image") {
      if (!imageEl?.clientHeight) return false;
      imageEl.scrollTop = (anchor.pct ?? 0) * Math.max(0, imageEl.scrollHeight - imageEl.clientHeight);
      return true;
    }
    const frame = previewFrame?.contentWindow;
    if (!frame) return false;
    frame.postMessage({ __tmx: "scrollTo", pct: anchor.pct ?? 0 }, "*");
    return true;
  }

  /** Apply over the next few frames. A view that was just unhidden has not been
   *  measured yet, and Monaco relayouts asynchronously, so the first attempt
   *  often lands before there is anything to scroll. */
  function applyScrollSoon(tries = 4) {
    requestAnimationFrame(() => {
      if (!applyScroll() && tries > 1) applyScrollSoon(tries - 1);
    });
  }

  /** Switch views, carrying the scroll position over. */
  function setViewMode(next: "edit" | "preview") {
    if (next === viewMode) return;
    captureScroll(); // from the view that is still on screen
    viewMode = next;
    setPaneView(paneId, next);
    if (next === "edit") {
      requestAnimationFrame(() => {
        codeEditor()?.layout();
        restoreEditorState();
        applyScrollSoon();
      });
    } else {
      applyScrollSoon();
    }
  }

  function onFrameMessage(e: MessageEvent) {
    if (!previewFrame || e.source !== previewFrame.contentWindow) return;
    const data = e.data as { __tmx?: string; pct?: number } | null;
    if (!data?.__tmx) return;
    if (data.__tmx === "ready") {
      // The frame stays mounted while editing, so only restore it when it is
      // the visible view; otherwise this would move the editor instead.
      if (viewMode === "preview") applyScroll();
    } else if (data.__tmx === "scroll" && viewMode === "preview") {
      if (performance.now() < suppressUntil) return;
      // No line mapping exists for a rendered page, so drop any stale line:
      // switching back to the editor must fall back to the fraction.
      anchor = { pct: data.pct ?? 0 };
      setPaneScroll(paneId, anchor);
    }
  }

  function createPlainEditor(m: typeof import("monaco-editor")) {
    if (!model) return;
    // A fresh editor fires scroll events while it lays out; none of them
    // describe where the user was, so keep them out of the anchor.
    suppressUntil = performance.now() + 300;
    plainEditor = m.editor.create(host, { ...editorOptions(), model });
    plainEditor.onDidScrollChange(() => {
      saveEditorState();
      captureScroll();
    });
    plainEditor.onDidChangeCursorPosition(() => saveEditorState());
    restoreEditorState();
    applyScrollSoon();
    plainEditor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, save);
    plainEditor.onDidAttemptReadOnlyEdit(() => lockFlash.update((n) => n + 1));
  }

  async function load(filePath: string) {
    const gen = generation;
    if (previewKindForPath(filePath) === "image") {
      viewMode = "preview";
      try {
        const url = await ipc.readFileDataUrl(filePath, $activeRoot ?? undefined);
        if (gen === generation) imageData = url;
      } catch (err) {
        if (gen === generation) error = String(err);
      }
      return;
    }
    try {
      const file = await ipc.readFile(filePath, $activeRoot ?? undefined);
      if (gen !== generation) return;
      if (file.binary) {
        binary = true;
        return;
      }
      loadedContent = file.content;
      previewText = file.content;
      previewSrc = file.content;
      const [m, lang] = await Promise.all([getMonaco(), languageForPath(filePath)]);
      if (gen !== generation) return;
      model = m.editor.createModel(file.content, lang);
      model.onDidChangeContent(() => {
        dirty = model!.getValue() !== loadedContent;
        previewText = model!.getValue();
        clearTimeout(previewSrcTimer);
        previewSrcTimer = setTimeout(() => (previewSrc = previewText), 300);
      });
      createPlainEditor(m);
      modelReady++;
    } catch (err) {
      if (gen === generation) error = String(err);
    }
  }

  /** Pick which change area to diff against, mirroring the Changes panel. */
  function pickArea(): ChangeArea | undefined {
    const list = get(changes).filter((c) => c.path === path);
    for (const area of ["unstaged", "staged", "untracked"] as const) {
      if (list.some((c) => c.area === area)) return area;
    }
    return list[0]?.area; // snapshot mode: undefined
  }

  /** Set while toggleDiff is mid-flight. The reconcile effect below re-runs on
   *  every layout write, and `showDiff` only flips once the diff has loaded —
   *  without this, a write landing in that window starts a second toggle and
   *  two editors end up fighting over the same host element. */
  let diffBusy = false;

  async function toggleDiff() {
    if (!model || diffBusy) return;
    diffBusy = true;
    try {
      await runToggleDiff();
    } finally {
      diffBusy = false;
    }
  }

  async function runToggleDiff() {
    if (!model) return;
    if (showDiff) {
      diffEditor?.dispose();
      diffEditor = undefined;
      originalModel?.dispose();
      originalModel = undefined;
      showDiff = false;
      setPaneDiff(paneId, false);
      const m = await getMonaco();
      createPlainEditor(m); // re-applies the scroll anchor to the new editor
      return;
    }
    const gen = generation;
    try {
      const [diff, m] = await Promise.all([ipc.getDiff(path, pickArea(), $activeRoot ?? undefined), getMonaco()]);
      if (gen !== generation || !model) return;
      originalModel = m.editor.createModel(diff.original, model.getLanguageId());
      plainEditor?.dispose();
      plainEditor = undefined;
      diffEditor = m.editor.createDiffEditor(host, {
        ...editorOptions(),
        originalEditable: false,
        renderSideBySide: true,
      });
      diffEditor.setModel({ original: originalModel, modified: model });
      diffEditor.getModifiedEditor().addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, save);
      diffEditor.getModifiedEditor().onDidAttemptReadOnlyEdit(() => lockFlash.update((n) => n + 1));
      diffEditor.getModifiedEditor().onDidScrollChange(() => {
        saveEditorState();
        captureScroll();
      });
      diffEditor.getModifiedEditor().onDidChangeCursorPosition(() => saveEditorState());
      showDiff = true;
      setPaneDiff(paneId, true);
      applyScrollSoon();
    } catch (err) {
      saveError = null;
      error = String(err);
    }
  }

  async function save() {
    if (!model || !dirty) return;
    const content = model.getValue();
    try {
      await ipc.writeFile(path, content, $activeRoot ?? undefined);
      loadedContent = content;
      dirty = false;
      conflict = false;
      externallyChanged = false;
      saveError = null;
    } catch (err) {
      saveError = String(err);
    }
  }

  async function reloadFromDisk() {
    const gen = generation;
    try {
      const file = await ipc.readFile(path, $activeRoot ?? undefined);
      if (gen !== generation || !model || file.binary) return;
      if (file.content !== loadedContent) {
        if (dirty) {
          conflict = true; // keep the user's edits; disk moved on
        } else {
          loadedContent = file.content;
          model.setValue(file.content);
          dirty = false;
          externallyChanged = true;
          // setValue scrolls Monaco back to the top — put it back.
          applyScrollSoon();
        }
      }
      if (showDiff && originalModel) {
        const diff = await ipc.getDiff(path, pickArea(), $activeRoot ?? undefined);
        if (gen === generation) originalModel.setValue(diff.original);
      }
    } catch {
      // file deleted mid-session: keep showing last content
    }
  }

  function openExternally() {
    menuOpen = false;
    ipc.openInDefaultApp(path, $activeRoot ?? undefined).catch((err) => (saveError = String(err)));
  }

  function revealInExplorer() {
    menuOpen = false;
    ipc.revealInFileManager(path, $activeRoot ?? undefined).catch((err) => (saveError = String(err)));
  }

  /** Re-run the load after a failure (session came up late, transient fs error). */
  function retry() {
    generation++;
    plainEditor?.dispose();
    plainEditor = undefined;
    model?.dispose();
    model = undefined;
    loadedContent = null;
    binary = false;
    error = null;
    imageData = null;
    previewSrc = "";
    load(path);
  }

  // (Re)create everything whenever this pane starts showing a different file.
  // Also re-runs when the session comes up: a restored layout mounts before
  // start_session resolves, and loading then would fail with "no active session".
  $effect(() => {
    const p = path;
    const ready = $sessionReady;
    binary = false;
    error = null;
    externallyChanged = false;
    dirty = false;
    conflict = false;
    showDiff = false;
    saveError = null;
    viewMode = initialView();
    anchor = getPaneScroll(paneId);
    previewText = "";
    previewSrc = "";
    imageData = null;
    menuOpen = false;
    if (ready) load(p);
    return () => {
      generation++;
      clearTimeout(previewSrcTimer);
      saveEditorState();
      captureScroll();
      flushPaneScroll();
      plainEditor?.dispose();
      plainEditor = undefined;
      diffEditor?.dispose();
      diffEditor = undefined;
      model?.dispose();
      model = undefined;
      originalModel?.dispose();
      originalModel = undefined;
      loadedContent = null;
    };
  });

  // Reconcile the view with the pane's persisted diff flag: opening from the
  // Changes panel (or flipping an already-open pane) sets pane.diff, and this
  // brings the live editor into that state once the model is ready.
  $effect(() => {
    modelReady; // re-run when the model becomes available
    const want = pane.diff ?? false;
    if (want !== showDiff && model) toggleDiff();
  });

  // The Explorer lock flips read-only on live editors.
  $effect(() => {
    const readOnly = $explorerLocked;
    plainEditor?.updateOptions({ readOnly });
    diffEditor?.updateOptions({ readOnly });
  });

  // Scroll the preview to the anchor once its content is actually laid out —
  // on mount, and again whenever a re-render moves the blocks around.
  $effect(() => {
    if (viewMode !== "preview") return;
    markdownHtml;
    imageData;
    applyScrollSoon();
  });

  // html/svg previews live in a cross-origin sandbox and talk over postMessage.
  $effect(() => {
    window.addEventListener("message", onFrameMessage);
    return () => window.removeEventListener("message", onFrameMessage);
  });

  // Resizing a pane reflows the preview and re-clamps the editor's scroll, so
  // re-anchor instead of letting a now-meaningless pixel offset stand.
  $effect(() => {
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => applyScroll());
    });
    observer.observe(self);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });

  // Reload from disk when the watcher reports changes.
  let lastTick = 0;
  $effect(() => {
    const tick = $fsTick;
    if (tick === lastTick) return;
    lastTick = tick;
    if (!$sessionReady) return;
    if (model) reloadFromDisk();
    else if (imageOnly) {
      const gen = generation;
      ipc.readFileDataUrl(path, $activeRoot ?? undefined).then((url) => {
        if (gen === generation) imageData = url;
      }).catch(() => {});
    }
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div
  bind:this={self}
  data-pane-id={paneId}
  class="relative flex h-full w-full min-w-0 min-h-0 flex-col overflow-hidden rounded-lg border pane-editor-bg transition-colors
    {currentZone && currentZone !== 'center' ? 'border-emerald-400' : focused ? 'border-emerald-500/60' : 'border-zinc-800'}"
  onmousedown={() => focusedPaneId.set(paneId)}
>
  {#if currentZone && currentZone !== "center"}
    <div class="pointer-events-none absolute inset-0 z-10 rounded-lg bg-emerald-500/5"></div>
    {#if currentZone === "top"}
      <div class="pointer-events-none absolute inset-x-3 top-0 z-10 h-[3px] rounded-t glow-accent"></div>
    {:else if currentZone === "bottom"}
      <div class="pointer-events-none absolute inset-x-3 bottom-0 z-10 h-[3px] rounded-b glow-accent"></div>
    {:else if currentZone === "left"}
      <div class="pointer-events-none absolute inset-y-3 left-0 z-10 w-[3px] rounded-l glow-accent"></div>
    {:else if currentZone === "right"}
      <div class="pointer-events-none absolute inset-y-3 right-0 z-10 w-[3px] rounded-r glow-accent"></div>
    {/if}
  {/if}
  <div
    class="flex h-7 shrink-0 touch-none cursor-grab items-center gap-1.5 border-b border-zinc-800 bg-zinc-950 px-2 active:cursor-grabbing"
    onpointerdown={(e) => startPaneDrag(e, paneId, fileName)}
  >
    <svg
      class="h-3.5 w-3.5 shrink-0 {focused ? 'text-emerald-400' : 'text-zinc-500'}"
      viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
    >
      <path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5Z" />
      <path d="M9 1.5V5.5H13" />
    </svg>
    <span class="flex min-w-0 items-baseline gap-1.5">
      <span class="truncate font-mono text-[11px] font-semibold {focused ? 'text-emerald-100' : 'text-zinc-300'}">{fileName}</span>
      {#if dirName}
        <span class="hidden truncate font-mono text-[10px] text-zinc-600 sm:inline">{dirName}</span>
      {/if}
    </span>
    {#if showDiff}
      <span class="shrink-0 rounded bg-emerald-950/60 px-1 py-px font-mono text-[9px] font-semibold uppercase tracking-wide text-emerald-400">diff</span>
    {/if}
    {#if conflict}
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400"
        title="File changed on disk while you have unsaved edits"
      ></span>
    {:else if dirty}
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300"
        title="Unsaved changes"
      ></span>
    {:else if externallyChanged}
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
        title="File changed on disk — content reloaded"
      ></span>
    {/if}
    {#if saveError}
      <span class="truncate text-[10px] text-red-400" title={saveError}>save failed</span>
    {/if}
    <div class="ml-auto flex items-center gap-0.5">
      {#if dirty}
        <button
          class="rounded px-1.5 py-0.5 text-[11px] text-emerald-400 hover:bg-zinc-800"
          title="Save (Ctrl+S)"
          onclick={(e) => { e.stopPropagation(); save(); }}
        >Save</button>
      {/if}
      {#if previewable}
        <!-- Edit / Preview mode switch -->
        <div class="flex items-center rounded bg-zinc-900 p-px">
          {#if !imageOnly}
            <button
              class="rounded px-1.5 py-0.5 text-[10px] font-semibold {viewMode === 'edit'
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-200'}"
              title="Edit raw text"
              onclick={(e) => { e.stopPropagation(); setViewMode("edit"); }}
            >Edit</button>
          {/if}
          <button
            class="rounded px-1.5 py-0.5 text-[10px] font-semibold {viewMode === 'preview'
              ? 'bg-zinc-700 text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-200'}"
            title="Rendered preview"
            onclick={(e) => { e.stopPropagation(); setViewMode("preview"); }}
          >Preview</button>
        </div>
      {/if}
      {#if !imageOnly && viewMode === "edit"}
        <button
          class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold {showDiff
            ? 'bg-emerald-950/60 text-emerald-400'
            : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'}"
          title={showDiff ? "Hide changes (show file)" : "Show changes (diff)"}
          onclick={(e) => { e.stopPropagation(); toggleDiff(); }}
        >± Diff</button>
      {/if}
      <!-- Kebab menu: open externally / reveal in explorer -->
      <div class="relative">
        <button
          class="rounded px-1.5 py-0.5 text-[13px] leading-none {menuOpen
            ? 'bg-zinc-800 text-zinc-200'
            : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'}"
          title="More actions"
          onclick={(e) => { e.stopPropagation(); menuOpen = !menuOpen; }}
        >⋯</button>
        {#if menuOpen}
          <div
            class="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
            role="menu"
            tabindex="-1"
            onmouseleave={() => (menuOpen = false)}
          >
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-zinc-200 hover:bg-zinc-800"
              onclick={(e) => { e.stopPropagation(); openExternally(); }}
            >
              <span class="text-zinc-400">↗</span> Open in default app
            </button>
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-zinc-200 hover:bg-zinc-800"
              onclick={(e) => { e.stopPropagation(); revealInExplorer(); }}
            >
              <span class="text-zinc-400">🗀</span> Reveal in file manager
            </button>
          </div>
        {/if}
      </div>
      <button
        class="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        title={$maximizedPaneId === paneId ? "Restore pane" : "Fullscreen pane"}
        onclick={(e) => { e.stopPropagation(); toggleMaximizedPane(paneId); }}
      >{$maximizedPaneId === paneId ? '⤡' : '⛶'}</button>
      <button
        class="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-red-900/50 hover:text-red-300"
        title="Close editor"
        onclick={(e) => { e.stopPropagation(); closePane(paneId); }}
      >✕</button>
    </div>
  </div>
  {#if !$sessionReady}
    <div class="flex flex-1 items-center justify-center px-4 text-center text-sm text-zinc-500">
      Opening session…
    </div>
  {:else if error}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
      <span class="text-sm text-red-400">{error}</span>
      <button
        class="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-emerald-500 hover:text-emerald-400"
        onclick={(e) => { e.stopPropagation(); retry(); }}
      >Retry</button>
    </div>
  {:else if imageOnly}
    <div bind:this={imageEl} class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--tmx-pv-bg)] p-4" onscroll={captureScroll}>
      {#if imageData}
        <img src={imageData} alt={fileName} class="max-h-full max-w-full object-contain" />
      {:else}
        <span class="text-sm text-zinc-500">Loading…</span>
      {/if}
    </div>
  {:else if binary}
    <div class="flex flex-1 items-center justify-center text-sm text-zinc-500">
      Binary or oversized file — cannot display.
    </div>
  {:else}
    <!-- Monaco host stays mounted so the buffer/undo survive mode switches. -->
    <div class="min-h-0 flex-1 {viewMode === 'preview' ? 'hidden' : ''}" bind:this={host}></div>
    <!-- Preview container stays in the DOM across view-mode toggles so the
         browser preserves its scroll position naturally. Only hidden via CSS. -->
    {#if previewKind === "markdown"}
      <div bind:this={previewEl} class:hidden={viewMode !== "preview"} class="min-h-0 flex-1 overflow-auto bg-[var(--tmx-pv-bg)]" onscroll={captureScroll}>
        <div class="md-preview">{@html markdownHtml}</div>
      </div>
    {:else if previewKind === "html" || previewKind === "svg"}
      <!-- The frame reports and restores its own scroll over postMessage; the
           sandbox has no allow-same-origin, so the parent cannot read it. -->
      <iframe
        bind:this={previewFrame}
        class:hidden={viewMode !== "preview"}
        class="min-h-0 flex-1 border-0 bg-[var(--tmx-pv-page)]"
        title="Preview of {fileName}"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        srcdoc={frameDoc}
      ></iframe>
    {/if}
  {/if}
</div>
