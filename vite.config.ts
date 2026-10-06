import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    svelte(),
    // Workaround: @sveltejs/vite-plugin-svelte <= 5.1.1 returns undefined from its
    // `load` hook when a .svelte component has no <style> block. Vite then reads
    // the .svelte source file as CSS, breaking Tailwind's CSS parser.
    {
      name: "fix-empty-svelte-css",
      enforce: "post",
      load(id) {
        if (id.includes("?svelte&type=style&lang.css")) {
          return { code: "", map: { mappings: "" } };
        }
      },
    },
    tailwindcss(),
  ],
  clearScreen: false,
  server: {
    // Bind IPv4 explicitly. Left to its default, Vite resolves "localhost"
    // through the OS and can end up listening on [::1] only, while
    // `tauri.conf.json`'s devUrl (`http://localhost:1420`) is resolved by
    // WebKitGTK to 127.0.0.1 — the connection is refused and the dev window
    // renders as a blank white page with nothing logged anywhere. Which address
    // Node picks varies between runs, so the failure looks intermittent.
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4096,
  },
});
