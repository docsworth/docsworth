import { defineConfig } from "vite";

// capture.js: what runs in a tab when a person saves its page or selection (src/extract), one
// classic script that the worker and the side panel inject with chrome.scripting. Built after
// vite.config.ts, into the same dist/. Turndown resolves to its browser build here.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    lib: { entry: "src/extract/main.ts", formats: ["iife"], name: "docsworthCaptureScript", fileName: () => "capture.js" },
  },
});
