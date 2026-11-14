import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach } from "vitest";
import { DEFAULT_CONFIG } from "./helpers.js";

/**
 * Temp repos for the commands that change files (adopt, verify). Call once per test file: it
 * registers the cleanup, which removes only the directories it made.
 */
export function repoFixtures() {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  /** A fresh temp directory this test owns. */
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "docsworth-fixture-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  const writeAll = (root: string, files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
  };

  /** A repo holding `files`, with a config and a CODEOWNERS giving `knowledge/` to platform unless told otherwise. */
  const fixture = (files: Record<string, string>, opts: { config?: string; codeowners?: string | null; root?: string } = {}) => {
    const root = opts.root ?? tempDir();
    writeAll(root, {
      ".knowledge/config.yaml": opts.config ?? DEFAULT_CONFIG,
      ...(opts.codeowners === null ? {} : { CODEOWNERS: opts.codeowners ?? "/knowledge/ @acme/platform\n" }),
      ...files,
    });
    return { root, read: (rel: string) => readFileSync(join(root, rel), "utf8") };
  };

  /** Every file under `dir` (but `.git`), by path, with its bytes: to show what a run changed. */
  const snapshot = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === ".git") continue;
        const abs = join(d, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.isFile()) out[relative(dir, abs)] = readFileSync(abs, "latin1");
      }
    };
    walk(dir);
    return out;
  };

  return { tempDir, writeAll, fixture, snapshot };
}
