import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { inRange, type ReleaseState, releaseProblems, tarballProblems } from "../scripts/release-guard.js";

// The release workflow publishes only what passes this: the tag, every version and the
// published package name agree, and the name is ours.
// Package specs are built from their parts: test/package-name.test.ts reads every tracked
// file for a fetch of a name we don't own (or ours, before it's published), and these are
// the guard's refusal cases, not instructions.
const spec = (name: string, range: string) => [name, range].join("@");
const ok: ReleaseState = { tag: "v0.2.0", name: "@docsworth/cli", version: "0.2.0", codeVersion: "0.2.0", pluginVersion: "0.2.0", published: spec("@docsworth/cli", "^0.2"), notes: true };

describe("release guard", () => {
  it("lets a consistent release through", () => {
    expect(releaseProblems(ok)).toEqual([]);
  });

  it.each([
    ["a tag that isn't the package version", { tag: "v0.2.1" }, /^the tag v0.2.1 isn't v0.2.0/],
    ["code behind the package", { codeVersion: "0.1.0" }, /^PACKAGE_VERSION \(0.1.0\)/],
    ["a plugin behind the package", { pluginVersion: "0.1.0" }, /^the plugin's version/],
    ["a name another publisher owns", { name: "agent-kb", published: spec("agent-kb", "0.2.0") }, /^package.json names agent-kb, not @docsworth\/cli, the package we publish$/m],
    ["the bare name, which nobody owns", { name: "docsworth", published: spec("docsworth", "^0.2") }, /^package.json names docsworth, not @docsworth\/cli/m],
    // Not a deny-list: a name that isn't the package is refused however it agrees with itself.
    ["any other name, consistently", { name: "@acme/other", published: spec("@acme/other", "^0.2") }, /^package.json names @acme\/other, not @docsworth\/cli/m],
    ["no published package yet", { published: null }, /^PUBLISHED_PACKAGE is null/],
    ["a published package that names something else", { published: spec("@docsworth/other", "^0.2") }, /names @docsworth\/other, but package.json is @docsworth\/cli/],
    ["a version outside the published range", { published: spec("@docsworth/cli", "^0.3") }, /isn't in PUBLISHED_PACKAGE's range \^0.3/],
    ["no release notes", { notes: false }, /no release notes at docs\/release-notes\/v0.2.0.md/],
    ["a prerelease", { tag: "v0.2.0-beta.1", version: "0.2.0-beta.1", codeVersion: "0.2.0-beta.1", pluginVersion: "0.2.0-beta.1" }, /isn't a plain major.minor.patch version/],
  ] as const)("refuses %s", (_what, change, message) => {
    expect(releaseProblems({ ...ok, ...change }).join("\n")).toMatch(message);
  });

  it("checks the packed tarball's own manifest", () => {
    expect(tarballProblems({ name: "@docsworth/cli", version: "0.2.0" }, "@docsworth/cli", "0.2.0")).toEqual([]);
    expect(tarballProblems({ name: "agent-kb", version: "0.2.1" }, "@docsworth/cli", "0.2.0")).toEqual([
      "the tarball's package.json names agent-kb, not @docsworth/cli",
      "the tarball's version is 0.2.1, not 0.2.0",
    ]);
  });

  it.each([
    ["0.2.0", "^0.2", true],
    ["0.2.7", "^0.2", true],
    ["0.3.0", "^0.2", false],
    ["0.1.9", "^0.2", false],
    ["1.4.2", "^1.2", true],
    ["2.0.0", "^1.2", false],
    ["1.4.5", "~1.4", true],
    ["1.5.0", "~1.4", false],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["0.2.9", "0.2.x", true],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
  ] as const)("%s in %s: %s", (version, range, expected) => {
    expect(inRange(version, range)).toBe(expected);
  });
});

describe("release workflow", () => {
  type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string>; id?: string };
  type Job = { permissions: Record<string, string>; environment?: string; needs?: string; steps: Step[] };
  const wf = parseYaml(readFileSync(".github/workflows/release.yml", "utf8")) as {
    on: { push: { tags: string[] } };
    permissions: Record<string, string>;
    jobs: { verify: Job; publish: Job };
  };
  const { verify, publish } = wf.jobs;
  const at = (job: Job, re: RegExp) => job.steps.findIndex((s) => re.test(s.run ?? ""));

  it("runs only on a version tag; verifying reads, and only publishing writes, from the release environment", () => {
    expect(wf.on).toEqual({ push: { tags: ["v*.*.*"] } });
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(verify.permissions).toEqual({ contents: "read" });
    expect(verify.environment).toBeUndefined();
    expect(publish.needs).toBe("verify");
    expect(publish.environment).toBe("release");
    expect(publish.permissions).toEqual({ contents: "write", "id-token": "write" });
  });

  it("verifies first: the guard, the suite, one tarball with its manifest checked, a clean install", () => {
    const guard = at(verify, /scripts\/release-guard\.ts "\$GITHUB_REF_NAME"$/);
    const test = at(verify, /^npm test$/);
    const pack = verify.steps.findIndex((s) => s.id === "pack");
    const smoke = at(verify, /scripts\/smoke-install\.ts "\$TARBALL"/);
    expect(guard).toBe(at(verify, /^npm ci$/) + 1); // right after npm ci
    expect([guard < test, test < pack, pack < smoke]).toEqual([true, true, true]);
    expect(verify.steps[pack]!.run).toMatch(/\[ "\$count" -eq 1 \]/);
    expect(verify.steps[pack]!.run).toMatch(/release-guard\.ts "\$GITHUB_REF_NAME" --tarball "\$tarball"/);
  });

  it("publishes only that tarball, and runs no install or project code with the token", () => {
    const runs = publish.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).not.toMatch(/npm (ci|install|run)|npx|tsx/);
    const check = at(publish, /\[ -f "\$TARBALL" \]/);
    const npm = at(publish, /npm publish "\$tarball"/);
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(npm);
    expect(publish.steps[npm]!.run).toContain('npm publish "$tarball" --ignore-scripts --provenance --access public');
    // Review of PR 12: npm reads a project's .npmrc, which could send the token elsewhere.
    const steps = publish.steps[npm]!.run!.split("\n");
    const refuse = steps.findIndex((l) => l.startsWith("[ ! -e .npmrc ] ||"));
    const away = steps.indexOf('cd "$RUNNER_TEMP"');
    const firstNpm = steps.findIndex((l) => /\bnpm (view|publish)\b/.test(l));
    expect([refuse === 0, refuse < away, away < firstNpm]).toEqual([true, true, true]);
    // The re-check wants the exact name in the tag's package.json, not just "not theirs".
    expect(publish.steps[check]!.run).toMatch(/m\.name !== repo\.name/);
    expect(publish.steps[check]!.run).toContain('if (m.name !== "@docsworth/cli") fail(');
    expect(publish.steps[npm]!.env!.TARBALL).toBe("${{ needs.verify.outputs.tarball }}");
  });

  // Review of PR 12: `npm ci` ran the tag's install scripts before anything refused it, and
  // a tag on a branch picked the code that ran.
  it("refuses a tag before installing anything: not a release, not package.json's version, not ours, no notes, not on main", () => {
    const pre = verify.steps.findIndex((s) => /Before installing anything/.test(s.name ?? ""));
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(pre).toBeLessThan(at(verify, /^npm ci$/));
    expect(verify.steps.slice(0, pre).every((s) => !s.run)).toBe(true);
    expect((verify.steps[0] as { with?: Record<string, unknown> }).with?.["fetch-depth"]).toBe(0);
    const run = verify.steps[pre]!.run!;
    expect(run.split("\n")[0]).toBe('git merge-base --is-ancestor "$GITHUB_SHA" origin/main || { echo "$GITHUB_REF_NAME isn\'t on main"; exit 1; }');
    // Run as the workflow runs it, but for the git line, in a copy of the repo's root files.
    const node = run.split("\n").slice(1).join("\n");
    const check = (tag: string, version: string, name = "@docsworth/cli", notes = true) => {
      const dir = mkdtempSync(join(tmpdir(), "docsworth-release-"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
      mkdirSync(join(dir, "docs/release-notes"), { recursive: true });
      if (notes) writeFileSync(join(dir, `docs/release-notes/${tag}.md`), "# notes\n");
      const r = spawnSync("bash", ["-c", node], { cwd: dir, env: { PATH: process.env.PATH ?? "", GITHUB_REF_NAME: tag }, encoding: "utf8" });
      rmSync(dir, { recursive: true, force: true });
      return r.status === 0 ? "ok" : r.stderr.trim();
    };
    expect(check("v0.2.0", "0.2.0")).toBe("ok");
    expect(check("v0.2.0", "0.1.0")).toBe("the tag v0.2.0 isn't v0.1.0, the version in package.json");
    expect(check("v1.0.0-rc.1", "1.0.0-rc.1")).toBe("v1.0.0-rc.1 isn't a release tag");
    for (const name of ["agent-kb", "docsworth", "@acme/other"]) expect(check("v0.2.0", "0.2.0", name)).toBe(`package.json names ${name}, not @docsworth/cli, the package we publish`);
    expect(check("v0.2.0", "0.2.0", "@docsworth/cli", false)).toBe("there are no release notes for v0.2.0");
  });

  // Review of PR 12, round 3: the clean install ran install scripts before the upload, and
  // the tarball's own publishConfig could move the publish.
  it("publishes the bytes verify checked, to npm, as latest", () => {
    const upload = verify.steps.findIndex((s) => /upload-artifact/.test(s.uses ?? ""));
    expect(upload).toBeLessThan(at(verify, /smoke-install/));
    expect(verify.steps.find((s) => s.id === "pack")!.run).toContain('echo "integrity=sha512-$(openssl dgst -sha512 -binary "$tarball" | base64 -w0)" >> "$GITHUB_OUTPUT"');
    const check = publish.steps[at(publish, /\[ -f "\$TARBALL" \]/)]!;
    expect(check.env!.INTEGRITY).toBe("${{ needs.verify.outputs.integrity }}");
    expect(check.run).toContain('[ "sha512-$(openssl dgst -sha512 -binary "$TARBALL" | base64 -w0)" = "$INTEGRITY" ] || { echo "$TARBALL isn\'t the bytes verify checked"; exit 1; }');
    expect(check.run).toContain('.filter((k) => !["access", "provenance"].includes(k));');
    expect(publish.steps[at(publish, /npm publish "\$tarball"/)]!.run).toContain("--registry https://registry.npmjs.org/ --tag latest");
  });

  it("can run again after a partial release: a tarball already on npm is checked, not published twice", () => {
    const run = publish.steps[at(publish, /npm publish "\$tarball"/)]!.run!;
    const view = run.indexOf('npm view "$spec" dist.integrity');
    expect(view).toBeGreaterThanOrEqual(0);
    expect(view).toBeLessThan(run.indexOf("npm publish"));
    // Published already: this tarball carries on, another is refused.
    const same = run.indexOf('elif [ "$theirs" = "$ours" ]; then');
    const other = run.indexOf('echo "$spec is on npm already, from a different tarball"; exit 1');
    expect([view < same, same < other, run.indexOf('echo "$spec is on npm already, from this tarball"') > same]).toEqual([true, true, true]);
    const release = publish.steps[at(publish, /gh release/)]!.run!;
    // Released already: its assets are replaced; otherwise it's created.
    const exists = release.indexOf('if gh release view "$GITHUB_REF_NAME"');
    const upload = release.indexOf('gh release upload "$GITHUB_REF_NAME" "$TARBALL" sbom.cdx.json --clobber');
    const create = release.indexOf('gh release create "$GITHUB_REF_NAME"');
    expect([exists === 0, exists < upload, upload < create]).toEqual([true, true, true]);
  });
});
