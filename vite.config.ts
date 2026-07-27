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
