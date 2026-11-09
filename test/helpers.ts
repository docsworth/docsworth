import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import type { Identity } from "../src/core/acl.js";
import { loadRepo, type Repo } from "../src/core/repo.js";

/** Pinned clock for every SLA-dependent test (AGENTS.md: tests never use real time). */
export const NOW = new Date("2026-11-02T12:00:00Z");
export const ACME = "examples/acme";

export const BASE_FM = {
  title: "A page",
  id: "a-page",
  type: "guide",
  status: "canonical",
  owner_team: "platform",
  last_verified: "2026-10-15",
  review_every: "90d",
};

export const DEFAULT_CONFIG = "format: 1\nknowledge_root: knowledge\ngithub:\n  org: acme\n";
export const DEFAULT_CODEOWNERS = "/knowledge/ @acme/platform\n";
export const INDEX = { "knowledge/index.md": page({ id: "index", title: "Index" }) };

/** Render a markdown page with frontmatter; `null` values drop a field. */
export function page(fm: Record<string, unknown> = {}, body = "# Body\n"): string {
  const merged = Object.fromEntries(Object.entries({ ...BASE_FM, ...fm }).filter(([, v]) => v !== null));
  return `---\n${stringify(merged)}---\n${body}`;
}

/** Write files into a fresh temp repo and load it through the real loader. */
export function makeRepo(files: Record<string, string>, opts: { config?: string; codeowners?: string | null } = {}): Repo & { cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "docsworth-test-"));
  const all: Record<string, string> = {
    ".knowledge/config.yaml": opts.config ?? DEFAULT_CONFIG,
    ...(opts.codeowners === null ? {} : { CODEOWNERS: opts.codeowners ?? DEFAULT_CODEOWNERS }),
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return Object.assign(loadRepo(root), { cleanup: () => rmSync(root, { recursive: true, force: true }) });
}

/** A disposable copy of the acme example, for tests that mutate it. */
export function copyAcme(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "docsworth-acme-"));
  // Not this machine's local state (a mirror cache from `npx tsx scripts/mirror-fixture.ts`,
  // or the usage log a local `docsworth` run writes, say): tests start from the tracked
  // example only, as they do in CI.
  cpSync(ACME, root, { recursive: true, filter: (src) => !/[\\/]\.knowledge[\\/](mirror|audit|cache|usage\.jsonl)([\\/]|$)/.test(src) });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The acme example with github.repo set, so GitHub (or FakeGitHub) is the ACL authority. */
export function acmeOnGitHub(repo = "acme/knowledge"): { root: string; cleanup: () => void } {
  const copy = copyAcme();
  const cfg = join(copy.root, ".knowledge/config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace("# repo: acme/knowledge", `repo: ${repo}`));
  return copy;
}

/** An identity source that always answers with the same identity (no GitHub). */
export function fixedIdentity(identity: Identity) {
  return { get: async () => identity, fresh: async () => identity, github: null };
}
