import type { Theme } from "./theme";

let monacoModule: typeof import("monaco-editor") | undefined;
let monacoPromise: Promise<typeof import("monaco-editor")> | null = null;

async function loadMonaco(): Promise<typeof import("monaco-editor")> {
  if (monacoModule) return monacoModule;
  if (!monacoPromise) {
    monacoPromise = (async () => {
      const [m, WorkerClass] = await Promise.all([
        import("monaco-editor"),
        import("monaco-editor/esm/vs/editor/editor.worker?worker"),
      ]);
      (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
        getWorker: () => new (WorkerClass as unknown as { new(): Worker })(),
      };
      monacoModule = m;
      const { get } = await import("svelte/store");
      const { settings } = await import("./settings");
      const { monacoThemeData } = await import("./theme");
      m.editor.defineTheme(MONACO_THEME, monacoThemeData(get(settings).appearance.theme));
      m.editor.setTheme(MONACO_THEME);
      let applied: Theme | undefined;
      settings.subscribe((s) => {
        const theme = s.appearance.theme;
        if (theme === applied) return;
        applied = theme;
        m.editor.defineTheme(MONACO_THEME, monacoThemeData(theme));
        m.editor.setTheme(MONACO_THEME);
      });
      return m;
    })();
  }
  return monacoPromise;
}

export function getMonaco(): Promise<typeof import("monaco-editor")> {
  return loadMonaco();
}

export const MONACO_THEME = "termax";

export async function languageForPath(path: string): Promise<string> {
  const m = await loadMonaco();
  const ext = "." + (path.split(".").pop() ?? "").toLowerCase();
  for (const lang of m.languages.getLanguages()) {
    if (lang.extensions?.includes(ext)) return lang.id;
  }
  return "plaintext";
}
