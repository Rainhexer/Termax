import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { settings } from "./settings";
import { monacoThemeData, type Theme } from "./theme";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export { monaco };

/** Theme name editors are created with; its contents follow the app theme. */
export const MONACO_THEME = "termax";

// Re-define and re-apply on every theme change; Monaco picks the new colours up
// on all live editors without recreating them.
let applied: Theme | undefined;
settings.subscribe((s) => {
  const theme = s.appearance.theme;
  if (theme === applied) return;
  applied = theme;
  monaco.editor.defineTheme(MONACO_THEME, monacoThemeData(theme));
  monaco.editor.setTheme(MONACO_THEME);
});

export function languageForPath(path: string): string {
  const ext = "." + (path.split(".").pop() ?? "").toLowerCase();
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.includes(ext)) return lang.id;
  }
  return "plaintext";
}
