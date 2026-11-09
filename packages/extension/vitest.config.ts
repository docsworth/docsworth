import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

// The monorepo root: the panel tests run core's `serve` CLI and test helpers from there.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  plugins: [preact()],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    env: { DOCSWORTH_REPO_ROOT: REPO_ROOT, DOCSWORTH_EXTENSION_ROOT: fileURLToPath(new URL("./", import.meta.url)) },
    setupFiles: ["test/setup.ts"],
    // setup.ts changes directory, which worker threads cannot.
    pool: "forks",
    testTimeout: 20_000,
  },
});
