<script lang="ts">
  import { onMount } from "svelte";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import { ipc } from "../ipc";
  import { isMonospace, loadFonts, systemFonts } from "../fonts";
  import PickList from "./PickList.svelte";
  import {
    addTheme,
    allThemes,
    deleteTheme,
    patchTheme,
    revertTheme,
    saveThemeAs,
    selectTheme,
    settings,
    themeIsDirty,
    updateSavedTheme,
  } from "../settings";
  import {
    GENERIC_FONTS,
    PRESET_THEMES,
    isHex,
    themeFromJson,
    themeToJson,
    type ColorGroup,
    type Theme,
  } from "../theme";

  type Field = { key: string; label: string; hint?: string };
  type Section = { title: string; group: ColorGroup; fields: Field[] };

  const UI_SECTIONS: Section[] = [
    {
      title: "Surfaces",
      group: "ui",
      fields: [
        { key: "bg", label: "App background" },
        { key: "surface", label: "Panels", hint: "sidebar, modals, inputs" },
        { key: "elevated", label: "Elevated", hint: "buttons, hovers, subtle borders" },
        { key: "raised", label: "Lines", hint: "input borders, dividers, scrollbar" },
        { key: "scrim", label: "Overlay", hint: "modal backdrop and shadows" },
      ],
    },
    {
      title: "Text",
      group: "ui",
      fields: [
        { key: "textBright", label: "Headings" },
        { key: "text", label: "Body text" },
        { key: "textSoft", label: "Secondary" },
        { key: "textDim", label: "Dim" },
        { key: "textMuted", label: "Muted" },
        { key: "textFaint", label: "Faint", hint: "disabled, placeholders" },
      ],
    },
    {
      title: "Accent",
      group: "ui",
      fields: [
        { key: "accent", label: "Accent", hint: "active pane, links, highlights" },
        { key: "accentStrong", label: "Accent strong", hint: "focus borders, sliders" },
        { key: "accentDeep", label: "Accent deep", hint: "filled buttons" },
        { key: "accentSoft", label: "Accent soft", hint: "text on accent fills" },
        { key: "accentDim", label: "Accent tint" },
        { key: "accentDarkest", label: "Accent tint (darkest)" },
        { key: "onAccent", label: "On accent", hint: "text/knob over an accent fill" },
      ],
    },
    {
      title: "Warning (bell, pending state)",
      group: "ui",
      fields: [
        { key: "warn", label: "Warning" },
        { key: "warnStrong", label: "Warning strong" },
        { key: "warnSoft", label: "Warning soft" },
        { key: "warnLight", label: "Warning light" },
        { key: "warnDeep", label: "Warning deep" },
        { key: "warnDarkest", label: "Warning tint" },
      ],
    },
    {
      title: "Danger (errors, deletions)",
      group: "ui",
      fields: [
        { key: "danger", label: "Danger" },
        { key: "dangerStrong", label: "Danger strong" },
        { key: "dangerSoft", label: "Danger soft" },
        { key: "dangerDeep", label: "Danger deep" },
        { key: "dangerDim", label: "Danger tint" },
        { key: "dangerDarkest", label: "Danger tint (darkest)" },
      ],
    },
    {
      title: "Other",
      group: "ui",
      fields: [
        { key: "info", label: "Info", hint: "untracked files, links" },
        { key: "special", label: "Special", hint: "copied/renamed files" },
      ],
    },
  ];

  const TERMINAL_SECTIONS: Section[] = [
    {
      title: "Terminal base",
      group: "terminal",
      fields: [
        { key: "background", label: "Background" },
        { key: "foreground", label: "Foreground" },
        { key: "cursor", label: "Cursor" },
        { key: "cursorAccent", label: "Cursor text" },
        { key: "selection", label: "Selection" },
      ],
    },
    {
      title: "ANSI colours",
      group: "terminal",
      fields: [
        { key: "black", label: "Black" },
        { key: "brightBlack", label: "Bright black" },
        { key: "red", label: "Red" },
        { key: "brightRed", label: "Bright red" },
        { key: "green", label: "Green" },
        { key: "brightGreen", label: "Bright green" },
        { key: "yellow", label: "Yellow" },
        { key: "brightYellow", label: "Bright yellow" },
        { key: "blue", label: "Blue" },
        { key: "brightBlue", label: "Bright blue" },
        { key: "magenta", label: "Magenta" },
        { key: "brightMagenta", label: "Bright magenta" },
        { key: "cyan", label: "Cyan" },
        { key: "brightCyan", label: "Bright cyan" },
        { key: "white", label: "White" },
        { key: "brightWhite", label: "Bright white" },
      ],
    },
  ];

  const EDITOR_SECTIONS: Section[] = [
    {
      title: "Editor surface",
      group: "editor",
      fields: [
        { key: "background", label: "Background" },
        { key: "foreground", label: "Foreground" },
        { key: "lineHighlight", label: "Current line" },
        { key: "selection", label: "Selection" },
        { key: "insertedBg", label: "Diff added" },
        { key: "removedBg", label: "Diff removed" },
      ],
    },
    {
      title: "Syntax",
      group: "editor",
      fields: [
        { key: "comment", label: "Comments" },
        { key: "keyword", label: "Keywords" },
        { key: "string", label: "Strings" },
        { key: "number", label: "Numbers" },
        { key: "type", label: "Types" },
        { key: "function", label: "Functions" },
        { key: "variable", label: "Variables" },
        { key: "constant", label: "Constants" },
        { key: "operator", label: "Operators" },
        { key: "tag", label: "Tags" },
        { key: "attribute", label: "Attributes" },
      ],
    },
  ];

  const PREVIEW_SECTIONS: Section[] = [
    {
      title: "File preview",
      group: "preview",
      fields: [
        { key: "bg", label: "Background" },
        { key: "text", label: "Text" },
        { key: "heading", label: "Headings" },
        { key: "link", label: "Links" },
        { key: "code", label: "Inline code" },
        { key: "codeBg", label: "Code background" },
        { key: "border", label: "Rules & borders" },
        { key: "quoteBar", label: "Quote bar" },
        { key: "quoteBg", label: "Quote background" },
        { key: "muted", label: "Muted text" },
        { key: "page", label: "HTML/SVG page", hint: "background behind rendered pages" },
      ],
    },
  ];

  /** Shown next to a font name so its shape is visible before picking it. */
  const FONT_SAMPLE = "AaBbGg 0123 {}";

  let monoOnly = $state(true);
  let msg = $state<{ kind: "ok" | "err"; text: string } | null>(null);
  let saveName = $state("");
  let showSaveAs = $state(false);
  let pasteText = $state("");
  let showPaste = $state(false);

  const themes = $derived(allThemes($settings));
  const activeId = $derived($settings.appearance.themeId);
  const dirty = $derived(themeIsDirty($settings));
  const activeIsCustom = $derived($settings.appearance.customThemes.some((t) => t.id === activeId));

  const themeOptions = $derived([
    ...PRESET_THEMES.map((t) => ({ value: t.id, label: t.name, group: "Presets" })),
    ...$settings.appearance.customThemes.map((t) => ({ value: t.id, label: t.name, group: "My themes" })),
  ]);

  onMount(loadFonts);

  /**
   * Font choices for one picker. Code fonts are filtered to monospaced families
   * (measured, not guessed); whatever is currently set always stays listed even
   * if it is filtered out or not installed.
   */
  function fontOptions(kind: "mono" | "any", current: string) {
    const families = $systemFonts.filter(
      (f) => !GENERIC_FONTS.includes(f) && (kind === "any" || !monoOnly || isMonospace(f)),
    );
    const options = [
      ...GENERIC_FONTS.map((f) => ({ value: f, label: f, group: "Generic" })),
      ...families.map((f) => ({ value: f, label: f, group: "Installed" })),
    ];
    if (!options.some((o) => o.value === current)) {
      options.unshift({ value: current, label: current, group: "Current" });
    }
    return options;
  }

  function flash(kind: "ok" | "err", text: string) {
    msg = { kind, text };
    setTimeout(() => (msg = null), 3000);
  }

  function colorOf(group: ColorGroup, key: string): string {
    return ($settings.appearance.theme[group] as unknown as Record<string, string>)[key] ?? "#000000";
  }

  function setColor(group: ColorGroup, key: string, value: string) {
    if (!isHex(value)) return;
    patchTheme((t) => {
      (t[group] as unknown as Record<string, string>)[key] = value.trim().toLowerCase();
      return t;
    });
  }

  function setFont<K extends keyof Theme["fonts"]>(key: K, value: Theme["fonts"][K]) {
    patchTheme((t) => {
      t.fonts = { ...t.fonts, [key]: value };
      return t;
    });
  }

  function num(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }

  function doSaveAs() {
    const saved = saveThemeAs(saveName);
    showSaveAs = false;
    saveName = "";
    flash("ok", `Saved “${saved.name}”`);
  }

  function doDelete() {
    const name = themes.find((t) => t.id === activeId)?.name ?? "theme";
    deleteTheme(activeId);
    flash("ok", `Deleted “${name}”`);
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(themeToJson($settings.appearance.theme));
      flash("ok", "Theme JSON copied to clipboard");
    } catch (err) {
      flash("err", `Copy failed: ${err}`);
    }
  }

  async function exportFile() {
    const theme = $settings.appearance.theme;
    const suggested = theme.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "theme";
    try {
      const path = await save({
        title: "Export theme",
        defaultPath: `${suggested}.json`,
        filters: [{ name: "Theme", extensions: ["json"] }],
      });
      if (!path) return;
      await ipc.writeThemeFile(path, themeToJson(theme));
      flash("ok", `Exported to ${path}`);
    } catch (err) {
      flash("err", `Export failed: ${err}`);
    }
  }

  function applyImported(text: string, source: string) {
    try {
      const theme = themeFromJson(text);
      addTheme(theme);
      flash("ok", `Imported “${theme.name}” from ${source}`);
      return true;
    } catch (err) {
      flash("err", `Import failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  async function importFile() {
    try {
      const path = await open({
        title: "Import theme",
        multiple: false,
        filters: [{ name: "Theme", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      applyImported(await ipc.readThemeFile(path), "file");
    } catch (err) {
      flash("err", `Import failed: ${err}`);
    }
  }

  function doPaste() {
    if (applyImported(pasteText, "clipboard")) {
      pasteText = "";
      showPaste = false;
    }
  }
</script>

{#snippet colorRow(group: ColorGroup, field: Field)}
  <div class="flex items-center gap-2">
    <input
      type="color"
      class="h-6 w-9 shrink-0 cursor-pointer rounded border border-zinc-700 bg-zinc-900"
      value={colorOf(group, field.key)}
      oninput={(e) => setColor(group, field.key, (e.target as HTMLInputElement).value)}
      aria-label={field.label}
    />
    <input
      class="w-[4.75rem] shrink-0 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 font-mono text-[11px] text-zinc-300 outline-none focus:border-emerald-500"
      value={colorOf(group, field.key)}
      onchange={(e) => {
        const el = e.target as HTMLInputElement;
        if (isHex(el.value)) setColor(group, field.key, el.value);
        else el.value = colorOf(group, field.key);
      }}
      aria-label="{field.label} hex value"
    />
    <span class="min-w-0 truncate text-xs text-zinc-400">
      {field.label}
      {#if field.hint}<span class="text-zinc-600"> — {field.hint}</span>{/if}
    </span>
  </div>
{/snippet}

{#snippet colorSection(section: Section)}
  <div class="flex flex-col gap-2">
    <h4 class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{section.title}</h4>
    <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {#each section.fields as field (field.key)}
        {@render colorRow(section.group, field)}
      {/each}
    </div>
  </div>
{/snippet}

{#snippet group(title: string, sections: Section[], openByDefault = false)}
  <details class="rounded-md border border-zinc-800 bg-zinc-900/40" open={openByDefault}>
    <summary class="cursor-pointer select-none px-3 py-2 text-xs font-medium text-zinc-200 hover:text-emerald-400">
      {title}
    </summary>
    <div class="flex flex-col gap-4 border-t border-zinc-800 px-3 py-3">
      {#each sections as section (section.title)}
        {@render colorSection(section)}
      {/each}
    </div>
  </details>
{/snippet}

{#snippet fontRow(
  label: string,
  familyKey: "ui" | "terminal" | "editor" | "preview" | "previewCode",
  kind: "mono" | "any",
)}
  <div class="flex flex-col gap-1">
    <span class="text-xs text-zinc-400">{label}</span>
    <PickList
      value={$settings.appearance.theme.fonts[familyKey]}
      options={fontOptions(kind, $settings.appearance.theme.fonts[familyKey])}
      onselect={(v) => setFont(familyKey, v)}
      previewFont
      sample={FONT_SAMPLE}
    />
  </div>
{/snippet}

{#snippet sizeRow(label: string, key: "uiSize" | "terminalSize" | "editorSize" | "previewSize", min: number, max: number)}
  <label class="flex flex-col gap-1">
    <span class="text-xs text-zinc-400">{label} — {$settings.appearance.theme.fonts[key]}px</span>
    <input
      type="range" {min} {max} class="accent-emerald-500"
      value={$settings.appearance.theme.fonts[key]}
      oninput={(e) => setFont(key, num(e))}
    />
  </label>
{/snippet}

<div class="flex flex-col gap-5">
  <!-- theme picker -->
  <section class="flex flex-col gap-2">
    <div class="flex items-end gap-2">
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="text-xs text-zinc-400">Theme</span>
        <PickList value={activeId} options={themeOptions} onselect={selectTheme} />
      </div>
      {#if dirty}
        <span class="mb-1 shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">Edited</span>
      {/if}
    </div>

    <div class="flex flex-wrap gap-1.5">
      <button
        class="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400"
        onclick={() => {
          saveName = `${themes.find((t) => t.id === activeId)?.name ?? "Theme"} copy`;
          showSaveAs = true;
        }}
      >Save as…</button>
      {#if activeIsCustom}
        <button
          class="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400 disabled:opacity-40"
          disabled={!dirty}
          onclick={() => { updateSavedTheme(activeId); flash("ok", "Theme updated"); }}
        >Save changes</button>
      {/if}
      <button
        class="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400 disabled:opacity-40"
        disabled={!dirty}
        onclick={revertTheme}
      >Revert edits</button>
      {#if activeIsCustom}
        <button
          class="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-red-500 hover:text-red-400"
          onclick={doDelete}
        >Delete</button>
      {/if}
      <span class="flex-1"></span>
      <button
        class="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400"
        onclick={copyJson}
      >Copy JSON</button>
      <button
        class="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400"
        onclick={exportFile}
      >Export…</button>
      <button
        class="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400"
        onclick={importFile}
      >Import…</button>
      <button
        class="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400"
        onclick={() => (showPaste = !showPaste)}
      >Paste JSON</button>
    </div>

    {#if showSaveAs}
      <div class="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
        <input
          class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-emerald-500"
          placeholder="Theme name"
          bind:value={saveName}
          onkeydown={(e) => { if (e.key === "Enter") doSaveAs(); if (e.key === "Escape") showSaveAs = false; }}
        />
        <button class="rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500" onclick={doSaveAs}>Save</button>
        <button class="rounded px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200" onclick={() => (showSaveAs = false)}>Cancel</button>
      </div>
    {/if}

    {#if showPaste}
      <div class="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
        <textarea
          class="h-24 w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200 outline-none focus:border-emerald-500"
          placeholder="Paste exported theme JSON here"
          bind:value={pasteText}
        ></textarea>
        <div class="flex gap-2">
          <button class="rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500" onclick={doPaste}>Import</button>
          <button class="rounded px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200" onclick={() => (showPaste = false)}>Cancel</button>
        </div>
      </div>
    {/if}

    {#if msg}
      <p class="text-[11px] {msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}">{msg.text}</p>
    {/if}
    <p class="text-[11px] text-zinc-600">
      Edits apply live and are kept per theme. Presets stay intact — save a copy to keep your changes under their own name.
    </p>
  </section>

  <!-- fonts -->
  <section class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <h3 class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Fonts</h3>
      <label class="flex items-center gap-1.5 text-[11px] text-zinc-500">
        <input type="checkbox" class="accent-emerald-500" bind:checked={monoOnly} />
        Monospace only for code fonts
      </label>
    </div>
    {@render fontRow("Terminal font", "terminal", "mono")}
    {@render sizeRow("Terminal font size", "terminalSize", 8, 32)}
    {@render fontRow("Editor font", "editor", "mono")}
    {@render sizeRow("Editor font size", "editorSize", 8, 32)}
    {@render fontRow("Interface font", "ui", "any")}
    {@render sizeRow("Interface scale", "uiSize", 12, 22)}
    {@render fontRow("File preview font", "preview", "any")}
    {@render fontRow("File preview code font", "previewCode", "mono")}
    {@render sizeRow("File preview font size", "previewSize", 10, 24)}
    <p class="text-[11px] text-zinc-600">
      Interface scale sets the root font size; every chrome element and its spacing scales with it.
    </p>
  </section>

  <!-- colours -->
  <section class="flex flex-col gap-2">
    <h3 class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Colours</h3>
    {@render group("Interface", UI_SECTIONS, true)}
    {@render group("Terminal", TERMINAL_SECTIONS)}
    {@render group("Editor & syntax", EDITOR_SECTIONS)}
    {@render group("File preview", PREVIEW_SECTIONS)}
  </section>

  <p class="text-[11px] text-zinc-600">Sidebar width is set by dragging its right edge.</p>
</div>
