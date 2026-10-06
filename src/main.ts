import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app")!;

// Errors that escape the component boundaries (event handlers, store
// subscribers, timers, rejected promises) do not unmount the app, but they do
// vanish silently in a packaged build. Log them so a crash leaves a trail.
window.addEventListener("error", (e) => {
  console.error("[uncaught]", e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[unhandled rejection]", e.reason);
});

// Last resort: if mounting itself throws there is no component tree left to
// hold a boundary, so paint a plain-DOM message instead of a white window.
let app: ReturnType<typeof mount> | undefined;
try {
  app = mount(App, { target });
} catch (err) {
  console.error("[mount failed]", err);
  target.innerHTML = "";
  const box = document.createElement("div");
  box.style.cssText =
    "display:flex;height:100vh;align-items:center;justify-content:center;" +
    "background:#09090b;color:#a1a1aa;font:13px system-ui,sans-serif;text-align:center;padding:1rem";
  box.textContent = `Termax failed to start: ${err instanceof Error ? err.message : String(err)}`;
  target.appendChild(box);
}

export default app;
