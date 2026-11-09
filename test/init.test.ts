import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { initRepo } from "../src/core/init.js";
import { lintRepo } from "../src/core/lint.js";
import { loadRepo } from "../src/core/repo.js";
import { NOW } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "docsworth-init-"));
  dirs.push(d);
  return d;
};

describe("docsworth init: R23", () => {
  it("scaffolds a repo that lints clean", () => {
    const root = fresh();
    // --ci needs a published package (test/package-name.test.ts); here, a stand-in name.
    const r = initRepo(root, { org: "Acme", team: "platform", ci: true, package: "@example/docsworth@^0.2", now: NOW });
    expect(r.created).toEqual([".knowledge/config.yaml", ".knowledge/.gitignore", "CODEOWNERS", "knowledge/index.md", "knowledge/glossary.md", "knowledge/guides/writing-pages.md", ".github/workflows/knowledge.yml"]);
    const result = lintRepo(loadRepo(root), NOW);
    expect(result).toMatchObject({ errors: 0, warnings: 0, pages: 3 });
    expect(loadRepo(root).config.github).toMatchObject({ org: "acme" });
  });

  it("never overwrites, and hints when an existing CODEOWNERS ignores knowledge/", () => {
    const root = fresh();
    writeFileSync(join(root, "CODEOWNERS"), "* @acme/everyone\n");
    const r = initRepo(root, { org: "acme", team: "platform", now: NOW });
    expect(r.skipped).toContain("CODEOWNERS");
    expect(readFileSync(join(root, "CODEOWNERS"), "utf8")).toBe("* @acme/everyone\n");
    expect(r.hints.join()).toMatch(/\/knowledge\/ @acme\/platform/);
    expect(initRepo(root, { org: "acme", team: "platform", now: NOW }).created).toEqual([]);
  });

  it("writes github.repo only when given", () => {
    const root = fresh();
    initRepo(root, { org: "acme", team: "platform", repo: "acme/kb", now: NOW });
    expect(loadRepo(root).config.github.repo).toBe("acme/kb");
  });

  it("ships a CI workflow that parses and never runs compile on pull requests", () => {
    const wf = parseYaml(readFileSync("templates/github/knowledge.yml", "utf8")) as { jobs: Record<string, { if: string; steps: { run?: string }[] }> };
    expect(wf.jobs.lint!.if).toBe("github.event_name == 'pull_request'");
    expect(wf.jobs.lint!.steps.map((s) => s.run).filter(Boolean)).toEqual(['npx -y "__DOCSWORTH_PACKAGE__" lint .', 'npx -y "__DOCSWORTH_PACKAGE__" compile . --dry-run']);
    expect(wf.jobs.compile!.if).toBe("github.event_name == 'push'");
  });

  it("pins every action by commit SHA, in customers' workflow and in each of this repo's workflows", () => {
    // Customers' CI runs the template with a token that can push; the release workflow
    // publishes to npm.
    const ours = readdirSync(".github/workflows").filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
    expect(ours).toContain(".github/workflows/release.yml");
    for (const file of ["templates/github/knowledge.yml", ...ours]) {
      const wf = parseYaml(readFileSync(file, "utf8")) as { jobs: Record<string, { steps: { uses?: string }[] }> };
      const uses = Object.values(wf.jobs).flatMap((j) => j.steps.map((st) => st.uses).filter((u): u is string => Boolean(u)));
      expect(uses.length, file).toBeGreaterThan(0);
      for (const u of uses) expect(u, `${file}: ${u}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });
});
