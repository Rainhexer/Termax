import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export { monaco };

export function languageForPath(path: string): string {
  const ext = "." + (path.split(".").pop() ?? "").toLowerCase();
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.includes(ext)) return lang.id;
  }
  return "plaintext";
}
