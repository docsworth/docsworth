import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The extension's pages (the side panel and the options page) and its service worker, as ES
// modules, into dist/ with public/manifest.json. The Gmail content script can't be a module:
// vite.content.config.ts builds it into the same dist/ as one classic script.
// No source maps, inline scripts or remote code: the manifest's CSP allows only the extension.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { sidepanel: "sidepanel.html", options: "options.html", background: "src/background.ts" },
      // The manifest names the worker by path.
      output: { entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js") },
    },
  },
});
