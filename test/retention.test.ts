import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initRepo } from "../src/core/init.js";
import { lintRepo } from "../src/core/lint.js";
import { loadRepo } from "../src/core/repo.js";
import { copyAcme, NOW } from "./helpers.js";

// Pro's mirror cache (mirror-purge, and what a mirror run writes) is tested in pro.

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

describe("local state is never committed by accident", () => {
  const localStateWarnings = (root: string) => lintRepo(loadRepo(root), NOW).diagnostics.filter((d) => d.rule === "local-state-tracked");

  it("docsworth init writes .knowledge/.gitignore, and git then ignores the usage log, mirror and audit dirs", () => {
    const root = tmp("docsworth-git-");
    execFileSync("git", ["init", "-q", root]);
    initRepo(root, { org: "acme", team: "platform", now: NOW });
    expect(readFileSync(join(root, ".knowledge/.gitignore"), "utf8")).toBe("# Written by Docsworth at runtime; never commit these.\nusage.jsonl\nmirror/\ncache/\naudit/\n");
    for (const rel of [".knowledge/usage.jsonl", ".knowledge/mirror/confluence/eng/a.md", ".knowledge/audit/audit-2026-11-02.jsonl"])
      expect(spawnSync("git", ["-C", root, "check-ignore", "-q", rel]).status, rel).toBe(0);
    expect(localStateWarnings(root)).toEqual([]);
  });

  it("lint warns when the usage log or mirror cache would be committed", () => {
    const root = tmp("docsworth-git-");
    execFileSync("git", ["init", "-q", root]);
    initRepo(root, { org: "acme", team: "platform", now: NOW });
    rmSync(join(root, ".knowledge/.gitignore"));
    const cfg = join(root, ".knowledge/config.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8")}mirror:\n  sources:\n    - kind: notion\n`);
    expect(localStateWarnings(root).map((d) => d.message)).toEqual([
      ".knowledge/usage.jsonl is not ignored by git; add it to .gitignore (docsworth init writes .knowledge/.gitignore for this)",
      ".knowledge/mirror (the mirror cache) is not ignored by git; add it to .gitignore (docsworth init writes .knowledge/.gitignore for this)",
    ]);
  });

  // Codex merge gate, PR 1, round 10: an ignore rule doesn't untrack committed files.
  it("lint warns when the mirror cache already holds tracked files, even though it's ignored now", () => {
    const root = tmp("docsworth-git-");
    execFileSync("git", ["init", "-q", root]);
    initRepo(root, { org: "acme", team: "platform", now: NOW });
    const cfg = join(root, ".knowledge/config.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8")}mirror:\n  sources:\n    - kind: notion\n`);
    mkdirSync(join(root, ".knowledge/mirror/notion/root"), { recursive: true });
    writeFileSync(join(root, ".knowledge/mirror/notion/root/a--1.md"), "copy of a wiki page");
    execFileSync("git", ["-C", root, "add", "-f", ".knowledge/mirror/notion/root/a--1.md"]);
    expect(localStateWarnings(root).map((d) => d.message)).toEqual([
      ".knowledge/mirror (the mirror cache) is already tracked by git (1 file(s)); untrack it with `git rm -r --cached .knowledge/mirror`",
    ]);
  });

  it("lint warns when the usage log is already tracked, even though it's ignored now", () => {
    const root = tmp("docsworth-git-");
    execFileSync("git", ["init", "-q", root]);
    initRepo(root, { org: "acme", team: "platform", now: NOW });
    writeFileSync(join(root, ".knowledge/usage.jsonl"), "{}\n");
    execFileSync("git", ["-C", root, "add", "-f", ".knowledge/usage.jsonl"]);
    expect(localStateWarnings(root).map((d) => d.message)).toEqual([
      ".knowledge/usage.jsonl is already tracked by git (1 file(s)); untrack it with `git rm -r --cached .knowledge/usage.jsonl`",
    ]);
  });

  // Codex merge gate, PR 1, round 17: switching the setting off doesn't make old files safe.
  it("still warns about a tracked usage log after usage_log is turned off", () => {
    const root = tmp("docsworth-git-");
    execFileSync("git", ["init", "-q", root]);
    initRepo(root, { org: "acme", team: "platform", now: NOW });
    writeFileSync(join(root, ".knowledge/usage.jsonl"), "{}\n");
    execFileSync("git", ["-C", root, "add", "-f", ".knowledge/usage.jsonl"]);
    const cfg = join(root, ".knowledge/config.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("usage_log: true", "usage_log: false"));
    expect(localStateWarnings(root).map((d) => d.message)).toEqual([".knowledge/usage.jsonl is already tracked by git (1 file(s)); untrack it with `git rm -r --cached .knowledge/usage.jsonl`"]);
  });

  it("says nothing about a store the config doesn't use", () => {
    const root = tmp("docsworth-git-");
    execFileSync("git", ["init", "-q", root]);
    initRepo(root, { org: "acme", team: "platform", now: NOW });
    rmSync(join(root, ".knowledge/.gitignore"));
    const cfg = join(root, ".knowledge/config.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("usage_log: true", "usage_log: false"));
    expect(localStateWarnings(root)).toEqual([]);
  });

  it("says nothing outside a git checkout, where nothing can be committed", () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    expect(localStateWarnings(acme.root)).toEqual([]);
  });
});
