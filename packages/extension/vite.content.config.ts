import { defineConfig } from "vite";

// The Gmail content script: one classic script (content scripts can't be modules), with
// nothing of Preact in it. Built after vite.config.ts, into the same dist/.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    lib: { entry: "src/content/gmail.ts", formats: ["iife"], name: "docsworthGmail", fileName: () => "gmail.js" },
  },
});
