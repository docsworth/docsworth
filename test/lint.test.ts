import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatDiagnostics, lintRepo } from "../src/core/lint.js";
import { loadRepo } from "../src/core/repo.js";
import { REQUIRED_FIELDS } from "../src/core/schema.js";
import { ACME, DEFAULT_CONFIG, INDEX, makeRepo, NOW, page } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function lint(files: Record<string, string>, opts?: Parameters<typeof makeRepo>[1]) {
  const repo = makeRepo({ ...INDEX, ...files }, opts);
  cleanups.push(repo.cleanup);
  return lintRepo(repo, NOW);
}
const rules = (r: ReturnType<typeof lintRepo>, severity = "error") =>
  r.diagnostics.filter((d) => d.severity === severity).map((d) => d.rule);

describe("lint: the acme example", () => {
  it("is clean (0 errors), and the CLI exits 0", () => {
    const out = execFileSync("npx", ["tsx", "src/cli.ts", "--as-of", "2026-11-02", "lint", ACME], { encoding: "utf8" });
    expect(out).toMatch(/24 pages, 0 errors, 3 warnings/);
  });
});

describe("lint: R1 required fields", () => {
  it.each(REQUIRED_FIELDS.map((f) => [f]))("fails when `%s` is missing", (field) => {
    const r = lint({ "knowledge/x.md": page({ id: "x", [field]: null }) });
    expect(r.errors).toBeGreaterThan(0);
    expect(r.diagnostics.some((d) => d.rule === "frontmatter" && d.message.includes(`\`${field}\``))).toBe(true);
  });

  it.each([
    ["type", "wiki"],
    ["status", "published"],
    ["last_verified", "2026-02-30"],
    ["review_every", "quarterly"],
    ["owner_team", "@acme/platform"],
    ["id", "Has Spaces"],
  ])("fails on invalid `%s: %s`", (field, value) => {
    expect(rules(lint({ "knowledge/x.md": page({ id: "x", [field]: value }) }))).toContain("frontmatter");
  });

  it("fails when the frontmatter block is missing", () => {
    expect(rules(lint({ "knowledge/x.md": "# no frontmatter\n" }))).toContain("frontmatter");
  });

  it("accepts pages without the optional fields", () => {
    expect(lint({ "knowledge/x.md": page({ id: "x" }) }).errors).toBe(0);
  });

  it("warns, never fails, on unknown fields", () => {
    const r = lint({ "knowledge/x.md": page({ id: "x", colour: "blue" }) });
    expect(r.errors).toBe(0);
    expect(rules(r, "warning")).toContain("unknown-field");
  });

  it("doesn't warn on the keys the config lists as a site generator's (frontmatter.extra_fields)", () => {
    const files = { "knowledge/x.md": page({ id: "x", sidebar_position: 3, colour: "blue" }) };
    const warned = (config?: string) => lint(files, config ? { config } : undefined).diagnostics.filter((d) => d.rule === "unknown-field").map((d) => d.message);
    expect(warned()).toEqual(["unknown frontmatter field `sidebar_position`", "unknown frontmatter field `colour`"]);
    expect(warned(`${DEFAULT_CONFIG}frontmatter:\n  extra_fields: [sidebar_position]\n`)).toEqual(["unknown frontmatter field `colour`"]);
    // A typo in the key is a config error, not a silently empty list.
    expect(() => lint(files, { config: `${DEFAULT_CONFIG}frontmatter:\n  extra_field: [sidebar_position]\n` })).toThrow(/extra_field/);
  });
});

describe("lint: R2 ownership against CODEOWNERS", () => {
  it("fails when owner_team differs from the CODEOWNERS team", () => {
    const r = lint({ "knowledge/x.md": page({ id: "x", owner_team: "payments" }) });
    expect(r.diagnostics.find((d) => d.rule === "ownership")?.message).toMatch(/assigns @acme\/platform/);
  });

  it.each([
    ["/knowledge/ @alice\n", /individual owner/],
    ["/knowledge/ @acme/a @acme/b\n", /exactly one team/],
    ["/knowledge/ @other/platform\n", /not a team in org/],
    ["/knowledge/\n", /unowned/],
    ["/src/ @acme/platform\n", /no CODEOWNERS rule/],
  ])("fails for CODEOWNERS %j", (codeowners, message) => {
    const r = lint({ "knowledge/x.md": page({ id: "x" }) }, { codeowners });
    expect(r.diagnostics.find((d) => d.rule === "ownership" && d.path === "knowledge/x.md")?.message).toMatch(message);
  });

  it("fails when there is no CODEOWNERS file at all", () => {
    expect(rules(lint({}, { codeowners: null }))).toContain("codeowners-missing");
  });

  it("fails on CODEOWNERS syntax GitHub would silently ignore", () => {
    expect(rules(lint({}, { codeowners: "/knowledge/ @acme/platform\n!secret @acme/x\n" }))).toContain("codeowners-syntax");
  });
});

describe("lint: R3 links", () => {
  it("fails on a broken relative link", () => {
    const r = lint({ "knowledge/x.md": page({ id: "x" }, "See [gone](runbooks/missing.md).\n") });
    expect(r.diagnostics.find((d) => d.rule === "broken-link")?.message).toMatch(/runbooks\/missing\.md/);
  });

  it("fails on a link escaping the repo", () => {
    expect(rules(lint({ "knowledge/x.md": page({ id: "x" }, "[up](../../../etc/passwd)\n") }))).toContain("broken-link");
  });

  it("reads links as CommonMark does: none in code or HTML, and through the definitions links use (R8)", () => {
    const codeOnly = [
      "```",
      "[fenced](missing.md)",
      "```",
      "",
      "    [indented](missing.md)",
      "",
      "A span `[x](missing.md)` and one across",
      "lines `` [y](\nmissing.md) `` here, and <a title=\"[z](missing.md)\">html</a>.",
      "",
      "[unused]: missing.md",
    ].join("\n");
    expect(lint({ "knowledge/x.md": page({ id: "x" }, codeOnly) }).errors).toBe(0);
    expect(rules(lint({ "knowledge/x.md": page({ id: "x" }, "[used][d]\n\n[d]: missing.md\n") }))).toContain("broken-link");
    expect(rules(lint({ "knowledge/x.md": page({ id: "x" }, "[deep](a_(b_(c)).md)\n"), "knowledge/a_(b_(c)).md": page({ id: "deep" }) })).filter((r) => r === "broken-link")).toEqual([]);
  });

  it("fails on a link to a directory or an extensionless file under the knowledge root: it names no page (R8b)", () => {
    const dir = lint({ "knowledge/x.md": page({ id: "x" }, "[guides](guides) and [also](guides/)\n"), "knowledge/guides/a.md": page({ id: "a" }) });
    expect(dir.diagnostics.filter((d) => d.rule === "broken-link").map((d) => d.message)).toEqual([
      "link to `guides` names a directory, not a page; link the page (`guides/….md`)",
      "link to `guides/` names a directory, not a page; link the page (`guides/….md`)",
    ]);
    const bare = lint({ "knowledge/x.md": page({ id: "x" }, "[notes](notes)\n"), "knowledge/notes": "plain text\n" });
    expect(bare.diagnostics.find((d) => d.rule === "broken-link")?.message).toBe("link to `notes` names a file with no extension, not a page; link a page (`.md`) or an attachment");
    // An attachment, and a directory outside the knowledge root, are fine as before.
    expect(lint({ "knowledge/x.md": page({ id: "x" }, "![d](d.png) [src](../src)\n"), "knowledge/d.png": "png", "src/a.ts": "x" }).errors).toBe(0);
  });

  it("fails on a link to a file whose name ends in a bare dot: it has no extension (R8b)", () => {
    const r = lint({ "knowledge/x.md": page({ id: "x" }, "[n](notes.)\n"), "knowledge/notes.": "plain text\n" });
    expect(r.diagnostics.find((d) => d.rule === "broken-link")?.message).toBe("link to `notes.` names a file with no extension, not a page; link a page (`.md`) or an attachment");
  });

  it("decodes a link's path once, as a browser does: %2520 names a file called %20", () => {
    const r = lint({ "knowledge/x.md": page({ id: "x" }, "[p](a%2520b.md)\n"), "knowledge/a%20b.md": page({ id: "ab" }) });
    expect(r.diagnostics.filter((d) => d.rule === "broken-link")).toEqual([]);
  });

  it("fails on a root-relative link that names a directory outside the knowledge root and, read from the root, a page too", () => {
    const r = lint({
      "knowledge/x.md": page({ id: "x" }, "[d](/docs) [t](/tools) [s](/src)\n"),
      "knowledge/docs.md": page({ id: "docs" }),
      "knowledge/tools/index.md": page({ id: "tools" }),
      "docs/notes.txt": "repo dir\n",
      "tools/run.sh": "repo dir\n",
      "src/main.ts": "repo dir, no page\n",
    });
    expect(r.diagnostics.filter((d) => d.rule === "broken-link").map((d) => d.message)).toEqual([
      // Without its `docs/`, `/docs` is the knowledge root's own index (a site under /docs/).
      "link to `/docs` names docs, outside the knowledge root, and on a docs site the page knowledge/docs.md or knowledge/index.md: link the one you mean, with its extension",
      "link to `/tools` names tools, outside the knowledge root, and on a docs site the page knowledge/tools/index.md: link the one you mean, with its extension",
    ]);
  });

  it("fails on such a route when its page is a number-prefixed category index or under a number-prefixed directory", () => {
    const r = lint({
      "knowledge/x.md": page({ id: "x" }, "[g](/guides) [o](/ops)\n"),
      // A category index by its name as written (a real Docusaurus build, 2026-11-13: not
      // `guides/01-index.md`, which it serves at `guides/index`).
      "knowledge/01-guides/01-guides.md": page({ id: "guides" }),
      "knowledge/02-ops/index.md": page({ id: "ops" }),
      "guides/notes.txt": "repo dir\n",
      "ops/run.sh": "repo dir\n",
    });
    expect(r.diagnostics.filter((d) => d.rule === "broken-link").map((d) => d.message)).toEqual([
      "link to `/guides` names guides, outside the knowledge root, and on a docs site the page knowledge/01-guides/01-guides.md: link the one you mean, with its extension",
      "link to `/ops` names ops, outside the knowledge root, and on a docs site the page knowledge/02-ops/index.md: link the one you mean, with its extension",
    ]);
  });

  it("fails on such a route when a page answers to it by its slug or id", () => {
    const r = lint({
      "knowledge/x.md": page({ id: "x" }, "[key ceremony](/vault) [guide](/handbook)\n"),
      "knowledge/sec/hsm.md": page({ id: "hsm", acl: "security", slug: "/vault" }),
      "knowledge/install.md": page({ id: "handbook" }),
      "vault/notes.txt": "repo dir\n",
      "handbook/notes.txt": "repo dir\n",
    });
    expect(r.diagnostics.filter((d) => d.rule === "broken-link").map((d) => d.message)).toEqual([
      "link to `/vault` names vault, outside the knowledge root, and on a docs site the page knowledge/sec/hsm.md: link the one you mean, with its extension",
      "link to `/handbook` names handbook, outside the knowledge root, and on a docs site the page knowledge/install.md: link the one you mean, with its extension",
    ]);
  });

  it("reads a root-relative attachment from the static directories the config lists, as a docs site serves them", () => {
    const files = {
      "knowledge/x.md": page({ id: "x" }, "![shot](/img/shot.png) [gone](/img/gone.png) [page](/guide.md)\n"),
      "website/static/img/shot.png": "png",
      "website/static/guide.md": "a page outside the knowledge root\n",
    };
    const broken = (config?: string) =>
      lint(files, config ? { config } : undefined).diagnostics.filter((d) => d.rule === "broken-link").map((d) => d.message);
    expect(broken()).toEqual([
      "link to `/img/shot.png` does not resolve (img/shot.png)",
      "link to `/img/gone.png` does not resolve (img/gone.png)",
      "link to `/guide.md` does not resolve (guide.md)",
    ]);
    // Listed, the image resolves there; a missing file, and a page, still don't.
    expect(broken(`${DEFAULT_CONFIG}static_dirs: [website/static/]\n`)).toEqual([
      "link to `/img/gone.png` does not resolve (img/gone.png)",
      "link to `/guide.md` does not resolve (guide.md)",
    ]);
    expect(() => lint(files, { config: `${DEFAULT_CONFIG}static_dirs: [../static]\n` })).toThrow(/static_dirs\.0: .*a directory in the repo, named relative to it/);
    // A path that climbs out of the static directory names nothing the site serves, written
    // plainly or percent-encoded; nor does a link inside it that leads out.
    const escape: Record<string, string> = { "knowledge/x.md": page({ id: "x" }, "[a](/../../package.json) [b](/%2e%2e/%2e%2e/package.json) [c](/out.txt)\n"), "package.json": "{}", "website/static/.keep": "" };
    const outside = mkdtempSync(join(tmpdir(), "docsworth-outside-"));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "out.txt"), "outside");
    const repo = makeRepo({ ...INDEX, ...escape }, { config: `${DEFAULT_CONFIG}static_dirs: [website/static]\n` });
    cleanups.push(repo.cleanup);
    symlinkSync(join(outside, "out.txt"), join(repo.root, "website/static/out.txt"));
    // And a static directory that is itself a link out of the repo serves nothing.
    writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync(outside, join(repo.root, "linked-static"));
    writeFileSync(join(repo.root, ".knowledge/config.yaml"), `${DEFAULT_CONFIG}static_dirs: [website/static, linked-static]\n`);
    // A path that leaves the static directory and comes back in names a file the site doesn't
    // serve there: a browser makes /../website/static/x.png /website/static/x.png.
    writeFileSync(join(repo.root, "website/static/back.png"), "png");
    writeFileSync(join(repo.root, "knowledge/x.md"), page({ id: "x" }, "[a](/../../package.json) [b](/%2e%2e/%2e%2e/package.json) [c](/out.txt) [d](/secret.txt) [e](/../static/back.png) [f](/%2e%2e/static/back.png)\n"));
    const r = lintRepo(loadRepo(repo.root), NOW);
    expect(r.diagnostics.filter((d) => d.rule === "broken-link").map((d) => d.message.slice(0, 40))).toEqual([
      "link to `/../../package.json` does not r",
      "link to `/../../package.json` does not r",
      "link to `/out.txt` does not resolve (out",
      "link to `/secret.txt` does not resolve (",
      "link to `/../static/back.png` does not r",
      "link to `/../static/back.png` does not r",
    ]);
  });

  it("fails on a link to a directory whose name ends in .md (R8b)", () => {
    const r = lint({ "knowledge/x.md": page({ id: "x" }, "[g](guide.md)\n"), "knowledge/guide.md/a.md": page({ id: "a" }) });
    expect(r.diagnostics.filter((d) => d.rule === "broken-link").map((d) => d.message)).toEqual([
      "link to `guide.md` names a directory, not a page; link the page (`guide.md/….md`)",
    ]);
  });

  it("escapes line and paragraph separators, and escapes in --json too", () => {
    const r = lint({ "knowledge/x.md": page({ id: "x" }, "[a](%E2%80%A8gone.md) [b](%E2%80%A9gone.md)" + "\n") });
    const out = formatDiagnostics(r);
    expect(out).toContain("link to `\\u2028gone.md` does not resolve");
    expect(out).toContain("link to `\\u2029gone.md` does not resolve");
    const repo = makeRepo({ ...INDEX, "knowledge/x.md": page({ id: "x" }, "[c](%E2%80%AEgone.md)" + "\n") });
    cleanups.push(repo.cleanup);
    const json = spawnSync("npx", ["tsx", "src/cli.ts", "--as-of", "2026-11-02", "lint", repo.root, "--json"], { encoding: "utf8" }).stdout;
    expect([...json].some((c) => c.codePointAt(0) === 0x202e)).toBe(false);
    expect(JSON.parse(json).diagnostics.some((d: { message: string }) => [...d.message].some((c) => c.codePointAt(0) === 0x202e))).toBe(true);
  });

  it("prints no control or bidirectional character a page holds: its report escapes them", () => {
    const r = lint({ "knowledge/x.md": page({ id: "x" }, "[a](%1B%5B2Jgone.md) [b](%E2%80%AEgone.md) [c](%E2%80%8Fgone.md)\n") });
    const out = formatDiagnostics(r);
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    expect(out).toContain("link to `\\u200fgone.md` does not resolve");
    expect(out).toContain("link to `\\x1b[2Jgone.md` does not resolve");
    expect(out).toContain("link to `\\u202egone.md` does not resolve");
  });

  it("accepts working links, anchors and external URLs", () => {
    const r = lint({
      "knowledge/x.md": page({ id: "x" }, "[y](y.md#part) [web](https://example.com) [top](#top)\n"),
      "knowledge/y.md": page({ id: "y" }),
    });
    expect(r.errors).toBe(0);
  });
});

describe("lint: R4 duplicate ids and structure", () => {
  it("fails on duplicate ids, including on otherwise-invalid pages", () => {
    const r = lint({
      "knowledge/a.md": page({ id: "same" }),
      "knowledge/b.md": page({ id: "same", status: "bogus" }),
    });
    expect(rules(r)).toContain("duplicate-id");
  });

  it("fails when the root index.md is missing", () => {
    const repo = makeRepo({ "knowledge/x.md": page({ id: "x" }) });
    cleanups.push(repo.cleanup);
    expect(rules(lintRepo(repo, NOW))).toContain("index-missing");
  });

  it("skips directories inside the knowledge root whose names start with a dot, as the format spec says", () => {
    const repo = makeRepo({
      ...INDEX,
      "knowledge/x.md": page({ id: "x" }),
      "knowledge/.dotted.md": page({ id: "dotted" }), // a dot-file is a page like any other
      "knowledge/.obsidian/workspace.md": "editor state, no frontmatter\n",
      "knowledge/.drafts/later.md": page({ id: "later" }),
      "knowledge/guides/.cache/deep.md": page({ id: "deep" }), // at any depth
    });
    cleanups.push(repo.cleanup);
    expect(repo.pages.map((p) => p.id).sort()).toEqual(["dotted", "index", "x"]);
    expect(repo.invalid).toEqual([]);
    const r = lintRepo(repo, NOW);
    expect(r.errors).toBe(0);
    expect(r.pages).toBe(3);
  });

  it.each([["knowledge/"], ["./knowledge"], ["knowledge//"]])("reads knowledge_root %j as `knowledge`: its index, its directories", (root) => {
    const r = lint({ "knowledge/runbooks/x.md": page({ id: "x", type: "guide" }) }, { config: `format: 1\nknowledge_root: ${root}\ngithub:\n  org: acme\n` });
    expect(r.errors).toBe(0);
    expect(r.diagnostics.map((d) => `${d.rule} ${d.path}`)).toContain("type-dir knowledge/runbooks/x.md");
  });

  it.each([["."], ["./"], [""], ["a/.."], ["/"], ["//"], ["/."], ["/knowledge"], [".."], ["../x"], ["C:/kb"], [".\\"], ["kb\\docs"]])(
    "refuses knowledge_root %j: it's the repo itself, above it, or not named relative to it",
    (root) => {
      expect(() => lint({}, { config: `format: 1\nknowledge_root: ${JSON.stringify(root)}\ngithub:\n  org: acme\n` })).toThrow(
        "invalid .knowledge/config.yaml: knowledge_root: the knowledge root is a directory in the repo, named relative to it: not the repo itself (.), not above it (..), not absolute; such as `knowledge`",
      );
    },
  );
  it.each([[".git"], ["docs/.git/x"], [".GIT"], [".knowledge"], [".knowledge/mirror"]])("refuses knowledge_root %j: git's own directory, or Docsworth's", (root) => {
    expect(() => lint({}, { config: `format: 1\nknowledge_root: ${JSON.stringify(root)}\ngithub:\n  org: acme\n` })).toThrow(
      "invalid .knowledge/config.yaml: knowledge_root: the knowledge root can't be in git's own directory (.git) or Docsworth's (.knowledge)",
    );
  });

  it("reads a knowledge root whose own name starts with a dot", () => {
    const repo = makeRepo(
      { ".kb/index.md": page({ id: "index", title: "Index" }), ".kb/x.md": page({ id: "x" }) },
      { config: "format: 1\nknowledge_root: .kb\ngithub:\n  org: acme\n", codeowners: "/.kb/ @acme/platform\n" },
    );
    cleanups.push(repo.cleanup);
    expect(repo.pages.map((p) => p.id).sort()).toEqual(["index", "x"]);
    expect(lintRepo(repo, NOW).errors).toBe(0);
  });

  it("only warns about overdue canonical pages", () => {
    const r = lint({ "knowledge/x.md": page({ id: "x", last_verified: "2025-01-01" }) });
    expect(r.errors).toBe(0);
    expect(rules(r, "warning")).toContain("overdue");
  });
});
