import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// Built into packages/web/dist, which the CLI's build copies to dist/web for `docsworth serve`.
// No source maps or external assets: the server's CSP allows only its own origin.
export default defineConfig({
  plugins: [preact()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
});
