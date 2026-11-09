import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup-state.ts"],
    // The MCP e2e test spawns a real server process; give it room.
    testTimeout: 20_000,
  },
});
