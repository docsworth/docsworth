import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

// The monorepo root: the view tests run core's server and test helpers from there.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  plugins: [preact()],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    env: { DOCSWORTH_REPO_ROOT: REPO_ROOT },
    // The view tests run the real core server in this process, against copies of examples/acme.
    setupFiles: ["test/setup.ts"],
    // setup.ts changes directory, which worker threads cannot.
    pool: "forks",
    testTimeout: 20_000,
  },
});
