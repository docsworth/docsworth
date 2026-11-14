import { spawnSync } from "node:child_process";
import { linkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adoptRepo } from "../src/core/adopt.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { KnowledgeService } from "../src/core/service.js";
import { verifyPages } from "../src/core/verify-pages.js";
import { fixedIdentity, NOW } from "./helpers.js";
import { repoFixtures } from "./repo-fixture.js";

// `docsworth verify <path…>` (R6): a draft or canonical page becomes canonical, verified today.

const { tempDir, writeAll, fixture, snapshot } = repoFixtures();
const verify = (root: string, paths: string[], dryRun = false) => verifyPages(root, paths, { now: NOW, dryRun });
const reasons = (r: ReturnType<typeof verifyPages>) => Object.fromEntries(r.left.map((l) => [l.path, l.reason]));
/** A valid page with these values. */
const fm = (id: string, status: string, lastVerified: string) =>
  `---\ntitle: T\nid: ${id}\ntype: guide\nstatus: ${status}\nowner_team: platform\nlast_verified: ${lastVerified}\nreview_every: 90d\n---\n# T\n`;

describe("verify: draft and canonical pages become canonical, verified today (R6)", () => {
  it("changes only the two values: comments, quotes, the other keys, their order and line endings stay", () => {
    const before = "---\r\ntitle: \"A\"\r\nid: a\r\ntype: guide\r\nstatus: draft # adopted\r\nowner_team: platform\r\nlast_verified: '2025-01-01'\r\nreview_every: 90d\r\nsidebar_position: 1\r\n---\r\n# A\r\n";
    const { root, read } = fixture({ "knowledge/a.md": before });
    const r = verify(root, ["knowledge/a.md"]);
    expect(read("knowledge/a.md")).toBe(before.replace("status: draft # adopted", "status: canonical # adopted").replace("last_verified: '2025-01-01'", "last_verified: 2026-11-02"));
    expect(r).toEqual({ dryRun: false, verified: ["knowledge/a.md"], unchanged: [], left: [] });
  });

  it("moves a canonical page's date, and changes nothing on a page verified today, however its values are written", () => {
    const today = fm("today", "'canonical'", '"2026-11-02"');
    const { root, read } = fixture({ "knowledge/old.md": fm("old", "canonical", "2026-01-01"), "knowledge/today.md": today });
    const r = verify(root, ["knowledge"]);
    expect(read("knowledge/old.md")).toBe(fm("old", "canonical", "2026-11-02"));
    expect(read("knowledge/today.md")).toBe(today);
    expect(r).toMatchObject({ verified: ["knowledge/old.md"], unchanged: ["knowledge/today.md"] });
  });

  it("leaves byte for byte a deprecated page, an invalid one, and frontmatter it can't edit in place, and says why", () => {
    const files = {
      "knowledge/dep.md": fm("dep", "deprecated", "2025-01-01"),
      "knowledge/invalid.md": "---\ntitle: T\nid: invalid\nstatus: draft\n---\n# T\n",
      "knowledge/flow.md": "---\n{title: T, id: flow, type: guide, status: draft, owner_team: platform, last_verified: 2025-01-01, review_every: 90d}\n---\n# T\n",
      "knowledge/none.md": "# No frontmatter\n",
      // Another key aliases the status: writing over it would change that key too.
      "knowledge/alias.md": fm("alias", "&s draft", "2025-01-01").replace("review_every: 90d\n", "review_every: 90d\nnote: *s\n"),
      // And one whose date is an alias: there's no value of its own to write over.
      "knowledge/aliased.md": fm("aliased", "draft", "*d").replace("title: T\n", "title: &d 2025-01-01\n"),
    };
    const { root, read } = fixture(files);
    const r = verify(root, ["knowledge"]);
    expect(reasons(r)).toEqual({
      "knowledge/dep.md": "it's deprecated: verify doesn't make it citable again",
      "knowledge/invalid.md": "it isn't a valid page (missing required field `type`; missing required field `owner_team`; missing required field `last_verified`; missing required field `review_every`): run `docsworth adopt`, or fix it by hand",
      "knowledge/flow.md": "its frontmatter is a flow mapping (`{…}`); verify edits a block mapping only",
      "knowledge/none.md": "its frontmatter doesn't parse: missing frontmatter block",
      "knowledge/alias.md": "writing the two values would change what the page's other keys say: set them by hand",
      "knowledge/aliased.md": "its `last_verified` isn't a plain value verify can write over: set it by hand",
    });
    for (const [path, text] of Object.entries(files)) expect(read(path)).toBe(text);
  });

  it("verifies the pages under each path given, and only those", () => {
    const page = (id: string) => fm(id, "draft", "2025-01-01");
    const { root, read } = fixture({ "knowledge/guides/a.md": page("a"), "knowledge/guides/deep/b.md": page("b"), "knowledge/ops/c.md": page("c"), "knowledge/d.md": page("d") });
    const r = verify(root, ["knowledge/guides", "knowledge/d.md", join(root, "knowledge/d.md")]);
    expect(r.verified).toEqual(["knowledge/d.md", "knowledge/guides/a.md", "knowledge/guides/deep/b.md"]);
    expect(read("knowledge/ops/c.md")).toBe(page("c"));
  });

  it("writes nothing on a dry run, and changes nothing on a second run", () => {
    const { root } = fixture({ "knowledge/a.md": fm("a", "draft", "2025-01-01") });
    const before = snapshot(root);
    const dry = verify(root, ["knowledge"], true);
    expect(snapshot(root)).toEqual(before);
    expect({ ...dry, dryRun: false }).toEqual(verify(root, ["knowledge"]));
    const after = snapshot(root);
    expect(verify(root, ["knowledge"])).toMatchObject({ verified: [], unchanged: ["knowledge/a.md"] });
    expect(snapshot(root)).toEqual(after);
  });
});

describe("verify writes only pages under the knowledge root (R9)", () => {
  it("refuses a path outside the knowledge root, one that doesn't exist, and a file that isn't a page", () => {
    const parent = tempDir();
    writeAll(parent, { "outside/x.md": fm("x", "draft", "2025-01-01") });
    const { root } = fixture({ "knowledge/a.md": fm("a", "draft", "2025-01-01"), "knowledge/notes.txt": "x" }, { root: join(parent, "repo") });
    symlinkSync(join(parent, "outside/x.md"), join(root, "knowledge/link.md"));
    const before = snapshot(parent);
    expect(() => verify(root, ["../outside/x.md"])).toThrow("../outside/x.md is outside the knowledge root (knowledge); verify changes only pages there");
    expect(() => verify(root, [".knowledge/config.yaml"])).toThrow(".knowledge/config.yaml is outside the knowledge root (knowledge); verify changes only pages there");
    expect(() => verify(root, ["knowledge/gone.md"])).toThrow("knowledge/gone.md: no such file or directory");
    expect(() => verify(root, ["knowledge/notes.txt"])).toThrow("knowledge/notes.txt isn't a page (a .md file) or a directory of them");
    expect(() => verify(root, [])).toThrow("name the pages to verify: a page, or a directory of them");
    expect(snapshot(parent)).toEqual(before);
    // Named, a link is left as the walk leaves it, whether it leads out of the root or within it.
    symlinkSync(join(root, "knowledge/a.md"), join(root, "knowledge/inside.md"));
    const named = verify(root, ["knowledge/link.md", "knowledge/inside.md"]);
    expect(reasons(named)).toEqual({
      "knowledge/link.md": "a symbolic link: Docsworth reads no page through one, and verify writes none",
      "knowledge/inside.md": "a symbolic link: Docsworth reads no page through one, and verify writes none",
    });
    expect(named.verified).toEqual([]);
    expect(snapshot(parent)).toMatchObject({ "outside/x.md": before["outside/x.md"], "repo/knowledge/a.md": before["repo/knowledge/a.md"] });
    rmSync(join(root, "knowledge/inside.md"));
    // A dangling one too: it's a link, not a missing file.
    symlinkSync(join(root, "knowledge/gone.md"), join(root, "knowledge/dangling.md"));
    expect(reasons(verify(root, ["knowledge/dangling.md"]))).toEqual({ "knowledge/dangling.md": "a symbolic link: Docsworth reads no page through one, and verify writes none" });
    rmSync(join(root, "knowledge/dangling.md"));
    // A link that sits outside the knowledge root is refused, wherever it leads.
    symlinkSync(join(root, "knowledge/a.md"), join(root, "top.md"));
    expect(() => verify(root, ["top.md"])).toThrow("top.md is outside the knowledge root (knowledge); verify changes only pages there");
    rmSync(join(root, "top.md"));
    // A page with another hard link is left: writing it would change the other file too.
    linkSync(join(parent, "outside/x.md"), join(root, "knowledge/hard.md"));
    expect(reasons(verify(root, ["knowledge/hard.md"]))).toEqual({ "knowledge/hard.md": "it has 2 hard links: verify writes no file another path shares" });
    expect(snapshot(join(parent, "outside"))).toEqual({ "x.md": before["outside/x.md"] });
    rmSync(join(root, "knowledge/hard.md"));
    // Walking a directory, it follows no link.
    expect(reasons(verify(root, ["knowledge"]))).toEqual({ "knowledge/link.md": "a symbolic link: Docsworth reads no page through one, and verify writes none" });
    expect(snapshot(join(parent, "outside"))).toEqual({ "x.md": before["outside/x.md"] });
  });
});

describe("verify refuses an absolute knowledge root", () => {
  it("refuses it, even when it names a directory in the repo", () => {
    const { root } = fixture({ "knowledge/a.md": fm("a", "draft", "2025-01-01") }, { config: "format: 1\nknowledge_root: /knowledge\ngithub:\n  org: acme\n" });
    expect(() => verify(root, ["knowledge"])).toThrow("invalid .knowledge/config.yaml: knowledge_root: the knowledge root is a directory in the repo, named relative to it: not the repo itself (.), not above it (..), not absolute; such as `knowledge`");
  });
});

describe("adopt, then verify: search cites the pages (R5, R6)", () => {
  it("excludes an adopted page from search until its team verifies it", async () => {
    const { root } = fixture({ "knowledge/runbooks/rotate-keys.md": "# Rotate the signing keys\n\nRotate the signing keys every quarter.\n" });
    adoptRepo(root, { now: NOW });
    const search = async () => {
      const r = await new KnowledgeService(root, fixedIdentity(LOCAL_IDENTITY), () => NOW).search({ query: "rotate signing keys" });
      return { results: r.results.map((x) => x.id), excluded: r.excluded.map((x) => x.id) };
    };
    expect(await search()).toEqual({ results: [], excluded: ["rotate-keys"] });
    verify(root, ["knowledge"]);
    expect(await search()).toEqual({ results: ["rotate-keys"], excluded: [] });
  });
});

describe("the CLI: adopt, then verify", () => {
  it("adopts as drafts, says what it left and that nothing is committed; verify then makes the pages canonical", () => {
    const { root, read } = fixture({
      "knowledge/index.md": fm("index", "canonical", "2026-10-01").replace("title: T", "title: Home"),
      "knowledge/glossary.md": fm("glossary", "canonical", "2026-10-01"),
      "knowledge/guides/setup.md": "---\nsidebar_position: 1\n---\n# Set up\n\nSee [ops](/ops/deploy) and [gone](/nowhere).\n",
      "knowledge/ops/deploy.md": "# Deploy\n",
      "knowledge/ops/index.md": "# Ops\n",
    });
    const cli = (...args: string[]) => {
      const r = spawnSync("npx", ["tsx", "src/cli.ts", "--as-of", "2026-11-02", ...args], { encoding: "utf8" });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const adopted = cli("adopt", root, "--team", "docs");
    expect(adopted.code).toBe(0);
    expect(adopted.out).toBe(
      [
        "left       knowledge/ops/index.md: a category index: Docusaurus routes it by its directory, so it takes no id from its file name. Set an `id` by hand (say `ops`) and, on a Docusaurus site, `slug: /ops` to keep its URL",
        "link left  knowledge/guides/setup.md: `/nowhere` it names no page",
        "config     frontmatter.extra_fields gains sidebar_position",
        "",
        "Adopted 2 pages (2 unchanged, 1 left); 1 link rewritten, 1 left.",
        `Nothing is committed. Review the diff, run \`docsworth lint ${root}\`, and open a pull request: adopted pages are drafts, cited once their team runs \`docsworth verify\`.`,
        "",
      ].join("\n"),
    );
    expect(read("knowledge/guides/setup.md")).toContain("status: draft\n");

    const verified = cli("verify", join(root, "knowledge/guides"), join(root, "knowledge/ops/deploy.md"), "--dir", root);
    expect(verified.code).toBe(0);
    expect(verified.out).toBe("\nVerified 2 pages (0 already verified today, 0 left).\nNothing is committed: open a pull request, which the owning team reviews.\n");
    expect(read("knowledge/guides/setup.md")).toMatch(/status: canonical\nowner_team: platform\nlast_verified: 2026-11-02\n/);

    // A value a page holds is printed with its control characters escaped.
    writeAll(root, { "knowledge/red.md": '---\nid: "\\e[31mred"\n---\n# Red\n' });
    const shown = cli("adopt", root, "--dry-run");
    expect(shown.out).toContain("left       knowledge/red.md: its id `\\x1b[31mred` isn't a Docsworth id");
    expect(shown.out).not.toContain("\u001b");
    // In JSON too, and in an error: escaped, as JSON escapes or as text.
    writeAll(root, { "knowledge/rtl.md": '---\nid: "\\u202Ertl"\n---\n# RTL\n' });
    const json = cli("adopt", root, "--dry-run", "--json");
    expect(json.out).not.toMatch(/[\u202e\u001b]/);
    expect(JSON.parse(json.out).left.map((l: { reason: string }) => l.reason).join("\n")).toContain("\u202ertl");
    const error = cli("verify", join(root, "knowledge", "\u001b[2Jgone.md"), "--dir", root);
    expect(error.code).toBe(2);
    expect(error.err).toBe(`docsworth: ${join(root, "knowledge")}/\\x1b[2Jgone.md: no such file or directory\n`);

    const refused = cli("verify", join(root, ".knowledge"), "--dir", root);
    expect(refused).toMatchObject({ code: 2, out: "" });
    expect(refused.err).toBe(`docsworth: ${join(root, ".knowledge")} is outside the knowledge root (knowledge); verify changes only pages there\n`);
  });
});
