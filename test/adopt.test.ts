import { execFileSync } from "node:child_process";
import { linkSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { redactLinks } from "../src/core/acl.js";
import { AdoptError, adoptRepo } from "../src/core/adopt.js";
import { verifyPages } from "../src/core/verify-pages.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { lintRepo } from "../src/core/lint.js";
import { pageStatus } from "../src/core/gate.js";
import { loadRepo } from "../src/core/repo.js";
import { KnowledgeService } from "../src/core/service.js";
import { DEFAULT_CONFIG, fixedIdentity, NOW } from "./helpers.js";
import { repoFixtures } from "./repo-fixture.js";

// `docsworth adopt`: the missing frontmatter (R1), route links (R2), and nothing outside the
// repo (R9).

const { tempDir, writeAll, fixture, snapshot } = repoFixtures();

const adopt = (root: string, opts: Partial<Parameters<typeof adoptRepo>[1]> = {}) => adoptRepo(root, { now: NOW, ...opts });
const reasons = (r: ReturnType<typeof adoptRepo>) => Object.fromEntries(r.left.map((l) => [l.path, l.reason]));

describe("adopt: the missing fields (R1)", () => {
  it("gives a page without frontmatter every required field, and keeps its body byte for byte", () => {
    const { root, read } = fixture({ "knowledge/guides/setup.md": "# Set up\n\nBody text.\n" });
    const r = adopt(root);
    expect(read("knowledge/guides/setup.md")).toBe(
      "---\ntitle: Set up\nid: setup\ntype: guide\nstatus: draft\nowner_team: platform\nlast_verified: 2026-11-02\nreview_every: 90d\n---\n# Set up\n\nBody text.\n",
    );
    expect(r.adopted).toEqual(["knowledge/guides/setup.md"]);
    const repo = loadRepo(root);
    expect(repo.invalid).toEqual([]);
    expect(repo.byId.get("setup")?.status).toBe("draft");
  });

  it("adds only what a page lacks, after the opening line: the page's own keys, order, comments, status and line endings stay", () => {
    // Its own canonical status comes with its own verification date (R5: adopt dates none).
    const before = '---\r\n# a comment\r\ntitle: "Mine"\r\nsidebar_position: 2\r\nstatus: canonical\r\nlast_verified: 2026-10-01\r\n---\r\nBody\r\n';
    const { root, read } = fixture({ "knowledge/runbooks/deploy.md": before });
    adopt(root, { reviewEvery: "30d" });
    expect(read("knowledge/runbooks/deploy.md")).toBe(
      '---\r\nid: deploy\r\ntype: runbook\r\nowner_team: platform\r\nreview_every: 30d\r\n# a comment\r\ntitle: "Mine"\r\nsidebar_position: 2\r\nstatus: canonical\r\nlast_verified: 2026-10-01\r\n---\r\nBody\r\n',
    );
  });

  it("changes nothing on a page that has every field", () => {
    const complete = "---\ntitle: T\nid: t\ntype: guide\nstatus: canonical\nowner_team: platform\nlast_verified: 2026-10-01\nreview_every: 90d\n---\n# T\n";
    const { root, read } = fixture({ "knowledge/t.md": complete });
    const r = adopt(root);
    expect(read("knowledge/t.md")).toBe(complete);
    expect(r).toMatchObject({ adopted: [], unchanged: ["knowledge/t.md"], left: [] });
  });
});

describe("adopt: id is the page's own, else its file name (R1, decision 5)", () => {
  it("keeps a page's own id, and takes the file name without Docusaurus's number prefix otherwise", () => {
    const { root } = fixture({
      "knowledge/mine.md": "---\nid: custom-one\n---\n# A\n",
      "knowledge/01-intro.md": "# Intro\n",
      "knowledge/guides/2_setup.md": "# Setup\n",
      "knowledge/guides/3. faq.md": "# FAQ\n",
      // Docusaurus keeps a date's or version's digits: so does adopt.
      "knowledge/2021-01-01-notes.md": "# Notes\n",
    });
    adopt(root);
    expect(loadRepo(root).pages.map((p) => [p.path, p.id])).toEqual([
      ["knowledge/01-intro.md", "intro"],
      ["knowledge/2021-01-01-notes.md", "2021-01-01-notes"],
      ["knowledge/guides/2_setup.md", "setup"],
      ["knowledge/guides/3. faq.md", "faq"],
      ["knowledge/mine.md", "custom-one"],
    ]);
  });

  it("leaves byte for byte a page whose id isn't valid, is taken, or can't come from its file name", () => {
    const files = {
      "knowledge/a.md": "---\nid: Bad_Id\n---\n# A\n",
      "knowledge/b.md": "---\nid: dup\n---\n# B\n",
      "knowledge/c.md": "---\nid: dup\n---\n# C\n",
      "knowledge/x/setup.md": "# X\n",
      "knowledge/y/setup.md": "# Y\n",
      "knowledge/own.md": "---\nid: taken-name\n---\n# Own\n",
      "knowledge/taken-name.md": "# Taken\n",
      "knowledge/google_chat.md": "# Google Chat\n",
      "knowledge/1.0-release.md": "# Release\n",
    };
    const { root, read } = fixture(files);
    const r = adopt(root);
    const left = reasons(r);
    // Each says how to keep the page's Docusaurus URL once its id is set by hand.
    const keep = (route: string) => ` and, on a Docusaurus site, \`slug: ${route}\` to keep its URL`;
    expect(left["knowledge/a.md"]).toBe(`its id \`Bad_Id\` isn't a Docsworth id (lowercase letters, digits and dashes): set one by hand${keep("/Bad_Id")}`);
    expect(left["knowledge/b.md"]).toBe(`its id \`dup\` is also on knowledge/c.md: set one by hand${keep("/dup")}`);
    expect(left["knowledge/c.md"]).toBe(`its id \`dup\` is also on knowledge/b.md: set one by hand${keep("/dup")}`);
    expect(left["knowledge/x/setup.md"]).toBe(`its file name makes the id \`setup\`, which knowledge/y/setup.md has or would get too: set an \`id\` by hand${keep("/x/setup")}`);
    expect(left["knowledge/y/setup.md"]).toBe(`its file name makes the id \`setup\`, which knowledge/x/setup.md has or would get too: set an \`id\` by hand${keep("/y/setup")}`);
    expect(left["knowledge/taken-name.md"]).toBe(`its file name makes the id \`taken-name\`, which knowledge/own.md has or would get too: set an \`id\` by hand${keep("/taken-name")}`);
    expect(left["knowledge/google_chat.md"]).toBe(`its file name doesn't make an id (\`google_chat\`: lowercase letters, digits and dashes only): set an \`id\` by hand${keep("/google_chat")}`);
    expect(left["knowledge/1.0-release.md"]).toMatch(/^its file name doesn't make an id \(`1\.0-release`.*`slug: \/1\.0-release`/);
    for (const path of Object.keys(left)) expect(read(path)).toBe(files[path as keyof typeof files]);
    // The page whose own id the other wanted is adopted.
    expect(r.adopted).toEqual(["knowledge/own.md"]);
  });

  it("counts a flow-style page's own id, though it leaves the page: no other page gets that id", () => {
    const flow = "---\n{title: T, id: setup, type: guide, status: canonical, owner_team: platform, last_verified: 2026-10-01, review_every: 90d}\n---\n# T\n";
    const { root, read } = fixture({ "knowledge/flow.md": flow, "knowledge/setup.md": "# Setup\n" });
    const left = reasons(adopt(root));
    expect(left["knowledge/setup.md"]).toMatch(/^its file name makes the id `setup`, which knowledge\/flow\.md has or would get too/);
    expect(read("knowledge/setup.md")).toBe("# Setup\n");
    expect(read("knowledge/flow.md")).toBe(flow);
  });

  it("leaves a category index, with the id and slug to set by hand", () => {
    const files = {
      "knowledge/index.md": "# Home\n",
      "knowledge/guides/index.md": "# Guides\n",
      "knowledge/ops/README.md": "# Ops\n",
      // Named after its directory as written (a real Docusaurus build, 2026-11-13: not
      // `02-features/features.md`, which it serves at `features/features`).
      "knowledge/02-features/02-features.md": "# Features\n",
    };
    const { root, read } = fixture(files);
    const left = reasons(adopt(root));
    const why = "a category index: Docusaurus routes it by its directory, so it takes no id from its file name. Set an `id` by hand";
    expect(left).toEqual({
      "knowledge/index.md": `${why} (say \`index\`) and, on a Docusaurus site, \`slug: /\` to keep its URL`,
      "knowledge/guides/index.md": `${why} (say \`guides\`) and, on a Docusaurus site, \`slug: /guides\` to keep its URL`,
      "knowledge/ops/README.md": `${why} (say \`ops\`) and, on a Docusaurus site, \`slug: /ops\` to keep its URL`,
      "knowledge/02-features/02-features.md": `${why} (say \`features\`) and, on a Docusaurus site, \`slug: /features\` to keep its URL`,
    });
    for (const [path, text] of Object.entries(files)) expect(read(path)).toBe(text);
  });
});

describe("adopt: title, type, owner and dates (R1)", () => {
  it("takes the title from the first level-one heading outside code, else the file name", () => {
    const { root, read } = fixture({
      "knowledge/a.md": "## Intro\n\n# The *real* `title`\n",
      "knowledge/b.md": "Setext\n======\n",
      "knowledge/c.md": "```\n# not a heading\n```\n\n## Only H2\n",
      "knowledge/d.md": "# Deploy: prod\n",
      "knowledge/e.md": "# 2026-01-05\n",
      "knowledge/f.md": "First line\nsecond line\n===========\n",
    });
    adopt(root);
    const titles = Object.fromEntries(loadRepo(root).pages.map((p) => [p.id, p.title]));
    expect(titles).toEqual({ a: "The real title", b: "Setext", c: "c", d: "Deploy: prod", e: "2026-01-05", f: "First line second line" });
    // Docusaurus reads YAML 1.1, where a bare 2026-01-05 is a date, and a title must be a string.
    expect(read("knowledge/e.md")).toMatch(/^---\ntitle: "2026-01-05"\n/);
  });

  it("takes the type from the path, else guide", () => {
    const { root } = fixture(
      Object.fromEntries(
        ["runbooks/r", "decisions/d", "adr/a", "services/s", "policies/p", "notes/n", "constructor/c", "runbooks/sub/deep"].map((p) => [`knowledge/${p}.md`, "# x\n"]),
      ),
    );
    adopt(root);
    const types = Object.fromEntries(loadRepo(root).pages.map((p) => [p.id, p.type]));
    expect(types).toEqual({ r: "runbook", d: "adr", a: "adr", s: "service", p: "policy", n: "guide", c: "guide", deep: "runbook" });
  });

  it("takes the owner from CODEOWNERS, else --team with the line to add, else leaves the page", () => {
    const owned = fixture({ "knowledge/x.md": "# x\n" });
    adopt(owned.root, { team: "docs" });
    expect(loadRepo(owned.root).byId.get("x")?.owner_team).toBe("platform");

    const unowned = fixture({ "knowledge/x.md": "# x\n" }, { codeowners: "/src/ @acme/platform\n" });
    const r = adopt(unowned.root, { team: "docs" });
    expect(loadRepo(unowned.root).byId.get("x")?.owner_team).toBe("docs");
    expect(r.hints).toEqual(["add `/knowledge/ @acme/docs` to CODEOWNERS: no rule there covers 1 adopted page, and lint needs one team for each"]);

    // A knowledge root with a space in its name: escaped, and the line does what it says.
    const spaced = fixture({ "team docs/x.md": "# x\n" }, { config: "format: 1\nknowledge_root: team docs\ngithub:\n  org: acme\n", codeowners: "/src/ @acme/platform\n" });
    const line = "/team\\ docs/ @acme/docs";
    expect(adopt(spaced.root, { team: "docs" }).hints).toEqual([`add \`${line}\` to CODEOWNERS: no rule there covers 1 adopted page, and lint needs one team for each`]);
    writeAll(spaced.root, { CODEOWNERS: `${line}\n` });
    expect(lintRepo(loadRepo(spaced.root), NOW).diagnostics.filter((d) => d.rule === "ownership")).toEqual([]);
    // One no CODEOWNERS line can name (GitHub ignores a pattern with brackets): no line offered.
    const bracketed = fixture({ "docs[v2]/x.md": "# x\n" }, { config: "format: 1\nknowledge_root: docs[v2]\ngithub:\n  org: acme\n", codeowners: "/src/ @acme/platform\n" });
    expect(adopt(bracketed.root, { team: "docs" }).hints).toEqual([
      "give `docs[v2]/` one team in CODEOWNERS: no line adopt can write matches it, and lint needs one team for each of 1 adopted page",
    ]);
    // A page's own owner_team is kept, and needs no CODEOWNERS rule or --team to be adopted.
    const own = fixture({ "knowledge/x.md": "---\nowner_team: docs\n---\n# x\n" }, { codeowners: null });
    const kept = adopt(own.root);
    expect([kept.adopted, kept.hints]).toEqual([["knowledge/x.md"], []]);
    expect(own.read("knowledge/x.md")).toContain("owner_team: docs\n");

    const neither = fixture({ "knowledge/x.md": "# x\n" }, { codeowners: null });
    expect(reasons(adopt(neither.root))).toEqual({
      "knowledge/x.md": "no owning team: no CODEOWNERS rule matches this path; pass --team <slug>, or give the path one team in CODEOWNERS",
    });
    expect(neither.read("knowledge/x.md")).toBe("# x\n");
  });

  it("dates a page by its last commit, else today", () => {
    const { root } = fixture({ "knowledge/old.md": "# Old\n" });
    const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { env: { ...process.env, GIT_AUTHOR_DATE: "2025-03-04T10:00:00Z" } });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "seed");
    writeAll(root, { "knowledge/new.md": "# New\n" });
    adopt(root);
    const dates = Object.fromEntries(loadRepo(root).pages.map((p) => [p.id, p.last_verified]));
    expect(dates).toEqual({ old: "2025-03-04", new: "2026-11-02" });
  });
});

describe("adopt: what it leaves alone", () => {
  it("leaves byte for byte frontmatter it can't add to, and says why", () => {
    const files = {
      "knowledge/flow.md": "---\n{title: x}\n---\n# x\n",
      "knowledge/broken.md": "---\ntitle: [\n---\n# x\n",
      "knowledge/open.md": "---\ntitle: x\n# x\n",
      "knowledge/indented.md": "---\n  title: x\n---\n# x\n",
      "knowledge/bom.md": "﻿---\ntitle: x\n---\n# x\n",
      "knowledge/tutorial.md": "---\ntype: tutorial\n---\n# x\n",
    };
    const { root, read } = fixture(files);
    const left = reasons(adopt(root));
    expect(left["knowledge/flow.md"]).toBe("its frontmatter is a flow mapping (`{…}`); adopt adds fields to a block mapping only");
    expect(left["knowledge/broken.md"]).toMatch(/^its frontmatter doesn't parse: invalid YAML: /);
    expect(left["knowledge/open.md"]).toBe("its frontmatter doesn't parse: unterminated frontmatter block");
    expect(left["knowledge/indented.md"]).toBe("adding fields to its frontmatter would change what the page's own keys say; add them by hand");
    expect(left["knowledge/bom.md"]).toBe("it starts with a byte-order mark, which Docsworth doesn't read frontmatter past; remove it, then rerun adopt");
    expect(left["knowledge/tutorial.md"]).toBe(`its own frontmatter isn't valid (\`type\`: Invalid option: expected one of "runbook"|"adr"|"service"|"guide"|"policy"); fix it, then rerun adopt`);
    for (const [path, text] of Object.entries(files)) expect(read(path)).toBe(text);
  });

  it("writes nothing on a dry run, and reports what a run would do", () => {
    const { root } = fixture({ "knowledge/a.md": "---\nsidebar_position: 1\n---\n# A\n", "knowledge/b_c.md": "# B\n" });
    const before = snapshot(root);
    const dry = adopt(root, { dryRun: true });
    expect(dry.extraFields).toEqual(["sidebar_position"]);
    expect(snapshot(root)).toEqual(before);
    const real = adopt(root);
    expect({ ...dry, dryRun: false }).toEqual(real);
    expect(dry.dryRun).toBe(true);
  });

  it("changes nothing on a second run", () => {
    const { root } = fixture({ "knowledge/a.md": "---\nsidebar_label: A\n---\n# A\n\n[g](guides) [s](/setup)\n", "knowledge/guides/index.md": "# G\n", "knowledge/setup.md": "# S\n" });
    adopt(root);
    const after = snapshot(root);
    const again = adopt(root);
    expect(snapshot(root)).toEqual(after);
    expect(again.adopted).toEqual([]);
    expect(again.unchanged).toEqual(["knowledge/a.md", "knowledge/setup.md"]);
    expect(again.linksRewritten).toBe(0);
    expect(again.extraFields).toEqual([]);
  });
});

describe("adopt: input and paths are checked before anything is read (R9)", () => {
  it("refuses a bad --team or --review-every, changing nothing", () => {
    const { root } = fixture({ "knowledge/a.md": "# A\n" });
    const before = snapshot(root);
    expect(() => adopt(root, { team: "@acme/docs" })).toThrow("--team `@acme/docs` isn't a team slug (like `platform`: no @, no org)");
    expect(() => adopt(root, { reviewEvery: "quarterly" })).toThrow("--review-every `quarterly` isn't a period like 30d, 12w, 6m or 1y");
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses a knowledge root that leads outside the repo, a sibling with the repo's name as prefix included", () => {
    // The config names roots below the repo only; a symbolic link is how one still leads out.
    const parent = tempDir();
    const outside = { "elsewhere/x.md": "# outside\n", "repo-other/x.md": "# sibling\n" };
    writeAll(parent, outside);
    for (const target of ["elsewhere", "repo-other"]) {
      const { root } = fixture({}, { root: join(parent, "repo"), config: "format: 1\nknowledge_root: kb\ngithub:\n  org: acme\n" });
      rmSync(join(root, "kb"), { force: true });
      symlinkSync(join(parent, target), join(root, "kb"));
      expect(() => adopt(root, { team: "docs" })).toThrow("knowledge_root `kb` is outside the repo; adopt writes only inside it");
    }
    expect(snapshot(parent)).toMatchObject(outside);
  });

  it("refuses an absolute knowledge root, even one that names a directory in the repo", () => {
    const { root } = fixture({ "knowledge/a.md": "# A\n" }, { config: "format: 1\nknowledge_root: /knowledge\ngithub:\n  org: acme\n" });
    const before = snapshot(root);
    expect(() => adopt(root)).toThrow("invalid .knowledge/config.yaml: knowledge_root: the knowledge root is a directory in the repo, named relative to it: not the repo itself (.), not above it (..), not absolute; such as `knowledge`");
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses a knowledge root that's a symbolic link, or under one: the loader names pages by the path it was given", () => {
    const { root } = fixture({ "docs/a.md": "# A\n" });
    symlinkSync(join(root, "docs"), join(root, "knowledge"));
    const before = snapshot(root);
    expect(() => adopt(root)).toThrow(/^knowledge_root `knowledge` is a symbolic link, or under one \(to .*docs\); set knowledge_root to the directory itself$/);
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses a config that leads outside the repo", () => {
    const parent = tempDir();
    writeAll(parent, { "shared/config.yaml": DEFAULT_CONFIG });
    const { root } = fixture({ "knowledge/a.md": "# A\n" }, { root: join(parent, "repo"), config: "unused" });
    rmSync(join(root, ".knowledge/config.yaml"));
    symlinkSync(join(parent, "shared/config.yaml"), join(root, ".knowledge/config.yaml"));
    expect(() => adopt(root)).toThrow(/^\.knowledge\/config\.yaml leads outside the repo \(to .*shared\/config\.yaml\); adopt writes only inside it$/);
    expect(readFileSync(join(root, "knowledge/a.md"), "utf8")).toBe("# A\n");
  });

  it("leaves a page or a config with another hard link: writing it would change the file elsewhere too", () => {
    const parent = tempDir();
    writeAll(parent, { "out/page.md": "# outside\n", "out/config.yaml": DEFAULT_CONFIG });
    const { root, read } = fixture({ "knowledge/b.md": "---\nsidebar_position: 1\n---\n# B\n" }, { root: join(parent, "repo") });
    linkSync(join(parent, "out/page.md"), join(root, "knowledge/a.md"));
    rmSync(join(root, ".knowledge/config.yaml"));
    linkSync(join(parent, "out/config.yaml"), join(root, ".knowledge/config.yaml"));
    const r = adopt(root);
    expect(reasons(r)).toEqual({ "knowledge/a.md": "it has 2 hard links: adopt writes no file another path shares" });
    expect(r.adopted).toEqual(["knowledge/b.md"]);
    expect(r.hints).toEqual([
      "add `sidebar_position` to frontmatter.extra_fields in .knowledge/config.yaml by hand: it has 2 hard links, and adopt writes no file another path shares",
    ]);
    expect(snapshot(join(parent, "out"))).toEqual({ "page.md": "# outside\n", "config.yaml": DEFAULT_CONFIG });
    expect(read("knowledge/a.md")).toBe("# outside\n");
  });

  it("counts a hard-linked page's own id, though it leaves the page", () => {
    const parent = tempDir();
    writeAll(parent, { "out/shared.md": "---\nid: setup\n---\n# Shared\n" });
    const { root, read } = fixture({ "knowledge/setup.md": "# Setup\n" }, { root: join(parent, "repo") });
    linkSync(join(parent, "out/shared.md"), join(root, "knowledge/shared.md"));
    const left = reasons(adopt(root));
    expect(left["knowledge/setup.md"]).toMatch(/^its file name makes the id `setup`, which knowledge\/shared\.md has or would get too/);
    expect(read("knowledge/setup.md")).toBe("# Setup\n");
  });

  it("refuses a config whose real file is in the knowledge root: adopt would take it for a page", () => {
    const { root } = fixture({ "knowledge/config.md": DEFAULT_CONFIG }, { config: "unused" });
    rmSync(join(root, ".knowledge/config.yaml"));
    symlinkSync(join(root, "knowledge/config.md"), join(root, ".knowledge/config.yaml"));
    const before = snapshot(root);
    expect(() => adopt(root, { team: "docs" })).toThrow(
      /^\.knowledge\/config\.yaml is a file in the knowledge root \(.*knowledge\/config\.md\), which adopt would read as a page; keep it outside$/,
    );
    expect(() => verifyPages(root, ["knowledge"], { now: NOW })).toThrow(/is a file in the knowledge root .*, which verify would read as a page; keep it outside$/);
    expect(snapshot(root)).toEqual(before);
  });

  it("doesn't follow a symbolic link out of the knowledge root, to a file or a directory", () => {
    const parent = tempDir();
    const outside = { "out/page.md": "# outside\n", "out/dir/deep.md": "# deep\n" };
    writeAll(parent, outside);
    const { root } = fixture({ "knowledge/a.md": "# A\n" }, { root: join(parent, "repo") });
    symlinkSync(join(parent, "out/page.md"), join(root, "knowledge/link.md"));
    symlinkSync(join(parent, "out/dir"), join(root, "knowledge/linked"));
    const r = adopt(root);
    expect(snapshot(join(parent, "out"))).toEqual({ "page.md": "# outside\n", "dir/deep.md": "# deep\n" });
    expect(r.adopted).toEqual(["knowledge/a.md"]);
    expect(reasons(r)).toEqual({
      "knowledge/link.md": "a symbolic link: Docsworth reads no page through one, and adopt writes none",
      "knowledge/linked": "a symbolic link: Docsworth reads no page through one, and adopt writes none",
    });
  });
});

describe("adopt: route links become relative .md links (R2)", () => {
  const body = (read: (rel: string) => string, rel: string) => read(rel).replace(/^---\n[\s\S]*?\n---\n/, "");

  it("rewrites a link to the page file it names, keeping its fragment and query", () => {
    const { root, read } = fixture({
      "knowledge/guides/intro.md": "# Intro\n\n[a](/guides/setup) [b](/docs/guides/setup#install) [c](/knowledge/guides/setup?x=1) [d](setup/) [e](../ops) [f](/features) [g](../ops/deploy#top)\n",
      "knowledge/guides/setup.md": "# Setup\n",
      "knowledge/ops/README.md": "# Ops\n",
      "knowledge/ops/deploy.md": "# Deploy\n",
      "knowledge/features/features.md": "# Features\n",
    });
    const r = adopt(root);
    expect(body(read, "knowledge/guides/intro.md")).toBe(
      "# Intro\n\n[a](setup.md) [b](setup.md#install) [c](setup.md?x=1) [d](setup.md) [e](../ops/README.md) [f](../features/features.md) [g](../ops/deploy.md#top)\n",
    );
    expect(r.linksRewritten).toBe(7);
    expect(r.linksLeft).toEqual([]);
  });

  it("rewrites the definitions links use, and leaves code, HTML and unused definitions byte for byte", () => {
    const text = [
      "# P",
      "",
      "See [full][r], [Collapsed][], [shortcut] and [x](a) [y](b) on one line.",
      "",
      "`[span](a)` and `` [across](",
      "a) `` and <a href=\"a\">html</a> and <span title=\"[t](a)\">x</span>.",
      "",
      "    [indented](a)",
      "",
      "```",
      "[fenced](a)",
      "```",
      "",
      "[r]: a",
      "[collapsed]: b",
      "[shortcut]: <a>",
      "[unused]: b",
      "",
    ].join("\n");
    const { root, read } = fixture({ "knowledge/p.md": text, "knowledge/a.md": "# A\n", "knowledge/b.md": "# B\n" });
    const r = adopt(root);
    expect(body(read, "knowledge/p.md")).toBe(
      text
        .replace("[x](a) [y](b)", "[x](a.md) [y](b.md)")
        .replace("[r]: a", "[r]: a.md")
        .replace("[collapsed]: b", "[collapsed]: b.md")
        .replace("[shortcut]: <a>", "[shortcut]: <a.md>"),
    );
    expect(r.linksRewritten).toBe(5);
  });

  it("leaves, and lists, a link that names no page or could name two; lint fails each (R8b)", () => {
    const { root, read } = fixture({
      "knowledge/p.md": "# P\n\n[amb](/x) [none](/nowhere) [img](/img/logo.png) [ok](x.md) [web](https://e.com) [pdf](files/a.pdf)\n",
      "knowledge/x.md": "# X\n",
      "knowledge/x/index.md": "# X index\n",
      "knowledge/files/a.pdf": "%PDF",
    });
    const r = adopt(root);
    expect(r.linksLeft).toEqual([
      { path: "knowledge/p.md", link: "/x", why: "it could name knowledge/x.md or knowledge/x/index.md: link the one you mean" },
      { path: "knowledge/p.md", link: "/nowhere", why: "it names no page" },
      { path: "knowledge/p.md", link: "/img/logo.png", why: "it names no page" },
    ]);
    expect(body(read, "knowledge/p.md")).toBe("# P\n\n[amb](/x) [none](/nowhere) [img](/img/logo.png) [ok](x.md) [web](https://e.com) [pdf](files/a.pdf)\n");
    const broken = lintRepo(loadRepo(root), NOW).diagnostics.filter((d) => d.rule === "broken-link" && d.path === "knowledge/p.md");
    expect(broken.map((d) => d.message)).toEqual([
      "link to `/x` does not resolve (x)",
      "link to `/nowhere` does not resolve (nowhere)",
      "link to `/img/logo.png` does not resolve (img/logo.png)",
    ]);
  });

  it("rewrites a page's routes though a bare label sits before an HTML block on it", () => {
    const text = "# P\n\n[use][d]\n\n[d]:\n<div>\n\n[setup](/setup)\n";
    const { root, read } = fixture({ "knowledge/p.md": text, "knowledge/div.md": "# D\n", "knowledge/setup.md": "# S\n" });
    adopt(root);
    expect(body(read, "knowledge/p.md")).toBe(text.replace("(/setup)", "(setup.md)"));
  });

  it("rewrites a page's routes though a made-up link would share a real one's destination", () => {
    const text = "# P\n\n[x](div) [use][d]\n\n[d]:\n<div>\n\n[setup](/setup)\n";
    const { root, read } = fixture({ "knowledge/p.md": text, "knowledge/div.md": "# D\n", "knowledge/setup.md": "# S\n" });
    adopt(root);
    expect(body(read, "knowledge/p.md")).toBe(text.replace("(div)", "(div.md)").replace("(/setup)", "(setup.md)"));
  });

  it("rewrites nothing in a code span, whatever another candidate's text would do to it", () => {
    const text = "# P\n\nsee ](x`y) [b](/secret) `\n";
    const { root, read } = fixture({ "knowledge/p.md": text, "knowledge/secret.md": "# S\n" });
    adopt(root);
    expect(body(read, "knowledge/p.md")).toBe(text);
  });

  it("lists a link it can't locate in the source: a definition whose label spans lines", () => {
    const text = "# P\n\nSee [multi line].\n\n[multi\nline]: /setup\n";
    const { root, read } = fixture({ "knowledge/p.md": text, "knowledge/setup.md": "# S\n" });
    const r = adopt(root);
    expect(r.linksLeft).toEqual([{ path: "knowledge/p.md", link: "/setup", why: "adopt couldn't find where it's written: link it by hand" }]);
    expect(body(read, "knowledge/p.md")).toBe(text);
  });

  it("converts a route lint resolves to a directory or extensionless file outside the knowledge root, where it names one page", () => {
    const { root, read } = fixture({
      "knowledge/p.md": "# P\n\n[g](/guides) [t](/tools) [m](/src/main.ts)\n",
      "knowledge/guides.md": "# Guides\n",
      "guides/notes.txt": "repo dir\n",
      "tools/run.sh": "repo dir, no page\n",
      "src/main.ts": "code\n",
    });
    const r = adopt(root);
    expect(body(read, "knowledge/p.md")).toBe("# P\n\n[g](guides.md) [t](/tools) [m](/src/main.ts)\n");
    expect(r.linksLeft).toEqual([]);
  });

  it("leaves a route a page's slug or id answers to elsewhere: a file name alone would point it at another page", () => {
    const { root, read } = fixture({
      "knowledge/p.md": "# P\n\n[x](/setup) [y](/install) [z](/guides)\n",
      // On the site, /setup is next.md (its slug), not setup.md (moved to /legacy).
      "knowledge/setup.md": "---\nslug: /legacy\n---\n# Setup\n",
      "knowledge/next.md": "---\nslug: /setup\n---\n# Next\n",
      // install.md's own id moves it to /setup-guide.
      "knowledge/install.md": "---\nid: setup-guide\n---\n# Install\n",
      // A slug that keeps the page where its file is changes nothing.
      "knowledge/guides/index.md": "---\nid: guides\nslug: /guides\n---\n# Guides\n",
      // On a page a slug moves, a relative route follows the slug's URL.
      "knowledge/deep/moved.md": "---\nslug: /elsewhere/moved\n---\n# Moved\n\n[n](next)\n",
    });
    const r = adopt(root);
    expect(body(read, "knowledge/p.md")).toBe("# P\n\n[x](/setup) [y](/install) [z](guides/index.md)\n");
    expect(r.linksLeft).toEqual([
      { path: "knowledge/deep/moved.md", link: "next", why: "its page's slug gives it another URL, which a relative route follows: link it by hand" },
      { path: "knowledge/p.md", link: "/setup", why: "it could name knowledge/next.md or knowledge/setup.md: link the one you mean" },
      { path: "knowledge/p.md", link: "/install", why: "knowledge/install.md has a slug or an id that gives it another URL: link it by hand" },
    ]);
  });

  it("lists a route lint resolves outside the root when a page answers to it only through a number prefix", () => {
    const { root, read } = fixture({
      "knowledge/p.md": "# P\n\n[o](/ops)\n",
      "knowledge/02-ops/index.md": "---\nid: ops\n---\n# Ops\n",
      "ops/run.sh": "repo dir\n",
    });
    const r = adopt(root);
    expect(body(read, "knowledge/p.md")).toBe("# P\n\n[o](/ops)\n");
    expect(r.linksLeft).toEqual([
      { path: "knowledge/p.md", link: "/ops", why: "on a docs site it's the route of knowledge/02-ops/index.md, through a number prefix adopt doesn't follow: link it by hand" },
    ]);
  });

  it("reads a relative route as the site does too: a page a slug puts there is named", () => {
    // From /main, `01-intro` reaches /01-intro: other.md's slug, not 01-intro.md (at /intro).
    const { root, read } = fixture({
      "knowledge/main.md": "# Main\n\n[i](01-intro) [g](guides/setup)\n",
      "knowledge/01-intro.md": "# Intro\n",
      "knowledge/other.md": "---\nslug: /01-intro\n---\n# Other\n",
      "knowledge/guides/setup.md": "# Setup\n",
      // A category index's URL is /guides: from there, `old` reaches /old, which x.md's slug is.
      "knowledge/guides/index.md": "---\nid: guides\n---\n# Guides\n\n[o](old)\n",
      "knowledge/x.md": "---\nslug: /old\n---\n# X\n",
    });
    const r = adopt(root);
    expect(body(read, "knowledge/main.md")).toBe("# Main\n\n[i](01-intro) [g](guides/setup.md)\n");
    expect(r.linksLeft).toEqual([
      { path: "knowledge/guides/index.md", link: "old", why: "knowledge/x.md has a slug or an id that gives it another URL: link it by hand" },
      { path: "knowledge/main.md", link: "01-intro", why: "it could name knowledge/01-intro.md or knowledge/other.md: link the one you mean" },
    ]);
  });

  it("lists a route a slug answers to, and lint fails it, though it also names a repo directory", () => {
    const hidden = "---\ntitle: HSM\nid: hsm\ntype: runbook\nstatus: canonical\nowner_team: platform\nlast_verified: 2026-10-01\nreview_every: 90d\nacl: security\nslug: /vault\n---\n# HSM\n";
    const { root } = fixture({ "knowledge/p.md": "# P\n\n[key ceremony](/vault)\n", "knowledge/sec/hsm.md": hidden, "vault/notes.txt": "repo dir\n" });
    const r = adopt(root);
    expect(r.linksLeft.map((l) => `${l.path} ${l.link}`)).toEqual(["knowledge/p.md /vault"]);
    expect(lintRepo(loadRepo(root), NOW).diagnostics.filter((d) => d.rule === "broken-link").map((d) => `${d.path} ${d.message.slice(0, 22)}`)).toEqual([
      "knowledge/p.md link to `/vault` names",
    ]);
  });

  it("says which static directory a docs site serves a page's root-relative files from, and stops listing them once it's in the config", () => {
    // Read as CommonMark reads them: an escaped slash and an encoded dot are the same files.
    const files = {
      "knowledge/p.md": "# P\n\n![shot](/img/shot.png) ![logo](/img/logo.svg) ![esc](\\/img/shot.png) ![enc](/img/shot%2Epng)\n",
      "website/static/img/shot.png": "png",
      "website/static/img/logo.svg": "svg",
    };
    const { root } = fixture(files);
    const r = adopt(root);
    expect(r.linksLeft.map((l) => l.link)).toEqual(["/img/shot.png", "/img/logo.svg", "\\/img/shot.png", "/img/shot%2Epng"]);
    expect(r.hints).toEqual([
      "add `static_dirs: [website/static]` to .knowledge/config.yaml: 4 links name files a docs site serves from website/static, and lint reads them there once it's listed",
    ]);
    const listed = fixture(files, { config: `${DEFAULT_CONFIG}static_dirs: [website/static]\n` });
    const again = adopt(listed.root);
    expect([again.linksLeft, again.hints]).toEqual([[], []]);
    // A link that climbs out of the static directory gets no hint: lint wouldn't read it there.
    // Nor does a page: lint serves no `.md` from a static directory, so the hint wouldn't help it.
    const climbing = fixture({
      "knowledge/p.md": "# P\n\n[pkg](/../../package.json) [back](/../static/a.png) [nested](/x/../../static/a.png) [guide](/guide.md)\n",
      "package.json": "{}",
      "website/static/a.png": "png",
      "website/static/guide.md": "a page outside the knowledge root\n",
    });
    expect(adopt(climbing.root).hints).toEqual([]);
    // A static directory however deep it sits.
    const deep = fixture({ "knowledge/p.md": "# P\n\n![x](/img/x.png)\n", "a/b/c/d/e/static/img/x.png": "png" });
    expect(adopt(deep.root).hints).toEqual([
      "add `static_dirs: [a/b/c/d/e/static]` to .knowledge/config.yaml: 1 link names a file a docs site serves from a/b/c/d/e/static, and lint reads them there once it's listed",
    ]);
    // One inside another directory named static could be a monorepo's `static` package holding a
    // site, or a site root's own `static/` asset folder: the hint says so, and asks.
    const nested = fixture({ "knowledge/p.md": "# P\n\n![x](/img/x.png)\n", "packages/static/docs/static/img/x.png": "png" });
    expect(adopt(nested.root).hints).toEqual([
      "if your docs site serves packages/static/docs/static at its root (it's inside packages/static, which may be the root instead), add `static_dirs: [packages/static/docs/static]` to .knowledge/config.yaml: 1 link names a file there",
    ]);
    // A directory whose name YAML would split in a flow list is quoted: the hint's list is the one
    // that parses back.
    const comma = fixture({ "knowledge/p.md": "# P\n\n![x](/img/x.png)\n", "website/a,b/static/img/x.png": "png" });
    const [hint] = adopt(comma.root).hints;
    expect(hint).toMatch(/^add `static_dirs: \["website\/a,b\/static"\]` to /);
    expect(parseYaml(/`([^`]+)`/.exec(hint!)![1]!)).toEqual({ static_dirs: ["website/a,b/static"] });
    // With a list there already, the hint gives the whole list: a second key would be invalid.
    const other = fixture(files, { config: `${DEFAULT_CONFIG}static_dirs: [docs/static]\n` });
    expect(adopt(other.root).hints).toEqual([
      "set `static_dirs: [docs/static, website/static]` in .knowledge/config.yaml: 4 links name files a docs site serves from website/static, and lint reads them there once it's listed",
    ]);
  });

  it("reads an index page's relative links against its directory and its URL's parent", () => {
    const { root, read } = fixture({
      "knowledge/guides/index.md": "---\nid: guides\n---\n# Guides\n\n[s](setup) [t](top) [both](shared)\n",
      "knowledge/guides/setup.md": "# Setup\n",
      "knowledge/top.md": "# Top\n",
      "knowledge/shared.md": "# Shared\n",
      "knowledge/guides/shared.md": "# Shared here\n",
    });
    const r = adopt(root);
    expect(body(read, "knowledge/guides/index.md")).toBe("# Guides\n\n[s](setup.md) [t](../top.md) [both](shared)\n");
    expect(r.linksLeft).toEqual([
      { path: "knowledge/guides/index.md", link: "shared", why: "it could name knowledge/guides/shared.md or knowledge/shared.md: link the one you mean" },
    ]);
  });

  it("escapes a file name so CommonMark and lint read the link as that file, and lists one no link can name", () => {
    const { root, read } = fixture({
      "knowledge/p.md": "# P\n\n[a](/with%20space) [b](/café) [c](</paren (1)>) [d](/50%25) [e](/x&amp;amp;y) [f](/with%20space&#35;x) [g](/café\\#here) [h](/web:notes) [i](/t%60ick) and `code`\n",
      "knowledge/with space.md": "# A\n",
      "knowledge/café.md": "# B\n",
      "knowledge/paren (1).md": "# C\n",
      "knowledge/50%.md": "# D\n",
      "knowledge/x&amp;y.md": "# E\n",
      // A name that would read as a URL scheme, and one that would open a code span.
      "knowledge/web:notes.md": "# F\n",
      "knowledge/t`ick.md": "# G\n",
    });
    const r = adopt(root);
    expect(body(read, "knowledge/p.md")).toBe(
      "# P\n\n[a](with%20space.md) [b](café.md) [c](<paren%20%281%29.md>) [d](/50%25) [e](/x&amp;amp;y) [f](/with%20space&#35;x) [g](café.md\\#here) [h](./web:notes.md) [i](t%60ick.md) and `code`\n",
    );
    const cannot = "adopt couldn't write a link that names it: link it by hand";
    expect(r.linksLeft).toEqual([
      { path: "knowledge/p.md", link: "/50%25", why: "its page's path holds `%`, `#` or `?`, which no link here can name: rename the file, or link it by hand" },
      // CommonMark reads an entity in a destination: the name can't be written back as it is,
      { path: "knowledge/p.md", link: "/x&amp;amp;y", why: cannot },
      // and neither can a fragment written as one.
      { path: "knowledge/p.md", link: "/with%20space&#35;x", why: cannot },
    ]);
    const broken = lintRepo(loadRepo(root), NOW).diagnostics.filter((d) => d.rule === "broken-link");
    expect(broken.map((d) => d.message)).toEqual([
      "link to `/50%` does not resolve (50%)",
      "link to `/x&amp;y` does not resolve (x&amp;y)",
      "link to `/with space` does not resolve (with space)",
    ]);
  });

  it("leaves byte for byte a page with every field whose id is invalid or taken, or whose values aren't valid", () => {
    const complete = (id: string, extra = "") => `---\ntitle: T\nid: ${id}\ntype: guide\nstatus: canonical\nowner_team: platform\nlast_verified: 2026-10-01\nreview_every: 90d\n${extra}---\n[s](/setup)\n`;
    const files = {
      "knowledge/bad.md": complete("Bad_Id"),
      "knowledge/d1.md": complete("dup"),
      "knowledge/d2.md": complete("dup"),
      "knowledge/tutorial.md": complete("tutorial").replace("type: guide", "type: tutorial"),
      "knowledge/setup.md": "# S\n",
    };
    const { root, read } = fixture(files);
    const r = adopt(root);
    expect(Object.keys(reasons(r)).sort()).toEqual(["knowledge/bad.md", "knowledge/d1.md", "knowledge/d2.md", "knowledge/tutorial.md"]);
    expect(reasons(r)["knowledge/d1.md"]).toMatch(/^its id `dup` is also on knowledge\/d2\.md: set one by hand/);
    expect(reasons(r)["knowledge/tutorial.md"]).toMatch(/^its own frontmatter isn't valid \(`type`: /);
    for (const path of Object.keys(reasons(r))) expect(read(path)).toBe(files[path as keyof typeof files]);
    expect(r.adopted).toEqual(["knowledge/setup.md"]);
  });

  it("leaves a page that says canonical but carries no verification date: adopt dates no verification it didn't see (R5)", () => {
    const files = {
      "knowledge/claims.md": "---\nstatus: canonical\n---\n# Claims\n",
      "knowledge/carried.md": "---\nstatus: canonical\nlast_verified: 2026-10-01\n---\n# Carried\n",
    };
    const { root, read } = fixture(files);
    const r = adopt(root);
    expect(reasons(r)).toEqual({
      "knowledge/claims.md":
        "it says `status: canonical` but carries no `last_verified`, and adopt dates no verification it didn't see: set `status: draft`, or verify it by hand",
    });
    expect(read("knowledge/claims.md")).toBe(files["knowledge/claims.md"]);
    // Only a page that carried its own verification is citable after adopt.
    const repo = loadRepo(root);
    expect(repo.pages.filter((p) => pageStatus(p, repo, NOW).citable).map((p) => p.id)).toEqual(["carried"]);
  });

  it("converts the links on a page that already has every field", () => {
    const complete = "---\ntitle: T\nid: t\ntype: guide\nstatus: canonical\nowner_team: platform\nlast_verified: 2026-10-01\nreview_every: 90d\n---\n[s](/setup)\n";
    const { root, read } = fixture({ "knowledge/t.md": complete, "knowledge/setup.md": "# S\n" });
    const r = adopt(root);
    expect(read("knowledge/t.md")).toBe(complete.replace("(/setup)", "(setup.md)"));
    expect(r.adopted).toEqual(["knowledge/setup.md", "knowledge/t.md"]);
  });

  it("makes a route link to a hidden page one redaction hides", () => {
    const hidden = "---\ntitle: HSM key ceremony\nid: hsm\ntype: runbook\nstatus: canonical\nowner_team: platform\nlast_verified: 2026-10-01\nreview_every: 90d\nacl: security\n---\n# HSM\n";
    const { root } = fixture({ "knowledge/ops.md": "# Ops\n\nSee the [ceremony](/sec/hsm) and [again](sec/hsm).\n", "knowledge/sec/hsm.md": hidden });
    adopt(root);
    const repo = loadRepo(root);
    const out = redactLinks(repo.byId.get("ops")!.body, "knowledge/ops.md", repo, LOCAL_IDENTITY);
    expect(out).not.toMatch(/sec\/|hsm|ceremony/);
    expect(out.match(/\[restricted page\]/g)).toHaveLength(2);
  });
});

describe("adopt: a site generator's keys go in the config (R3)", () => {
  it("adds the unknown keys of the pages it adopted to frontmatter.extra_fields, keeping the config's comments", () => {
    const config = "# Our config.\nformat: 1\nknowledge_root: knowledge\ngithub:\n  org: acme # the org\n";
    const complete = "---\ntitle: T\nid: t\ntype: guide\nstatus: canonical\nowner_team: platform\nlast_verified: 2026-10-01\nreview_every: 90d\ncustom: 1\n---\n# T\n";
    const { root, read } = fixture(
      { "knowledge/a.md": "---\nsidebar_position: 2\nsidebar_label: A\n---\n# A\n", "knowledge/b.md": "---\nsidebar_position: 3\n---\n# B\n", "knowledge/t.md": complete },
      { config },
    );
    const r = adopt(root);
    expect(r.extraFields).toEqual(["sidebar_label", "sidebar_position"]);
    expect(read(".knowledge/config.yaml")).toBe(`${config}frontmatter:\n  extra_fields:\n    - sidebar_label\n    - sidebar_position\n`);
    // The complete page wasn't adopted, so its key wasn't taken for a site generator's.
    const warned = lintRepo(loadRepo(root), NOW).diagnostics.filter((d) => d.rule === "unknown-field");
    expect(warned.map((d) => `${d.path}: ${d.message}`)).toEqual(["knowledge/t.md: unknown frontmatter field `custom`"]);
  });

  it("adds only the keys the list lacks, to the list there", () => {
    const config = `${DEFAULT_CONFIG}frontmatter:\n  # Docusaurus's.\n  extra_fields:\n    - sidebar_label\n`;
    const { root, read } = fixture({ "knowledge/a.md": "---\nsidebar_label: A\nslug: /a\n---\n# A\n" }, { config });
    expect(adopt(root).extraFields).toEqual(["slug"]);
    expect(read(".knowledge/config.yaml")).toBe(`${config}    - slug\n`);
  });

  it("appends the list as text to a config YAML wouldn't write back byte for byte, and leaves one it can't append to", () => {
    const page = { "knowledge/a.md": "---\nsidebar_position: 1\n---\n# A\n" };
    const config = "format: 1\nknowledge_root: knowledge\ngithub: {org: acme}  # flow\n";
    const appended = fixture(page, { config });
    expect(adopt(appended.root).extraFields).toEqual(["sidebar_position"]);
    expect(appended.read(".knowledge/config.yaml")).toBe(`${config}frontmatter:\n  extra_fields:\n    - sidebar_position\n`);
    expect(lintRepo(loadRepo(appended.root), NOW).diagnostics.filter((d) => d.rule === "unknown-field")).toEqual([]);

    // A config that ends its document with `...`: nothing can follow it; the hint, not a crash.
    const ended = fixture(page, { config: "format: 1\nknowledge_root: knowledge\ngithub: {org: acme}\n...\n" });
    const e = adopt(ended.root);
    expect(ended.read(".knowledge/config.yaml")).toBe("format: 1\nknowledge_root: knowledge\ngithub: {org: acme}\n...\n");
    expect(e.hints).toEqual(["add `sidebar_position` to frontmatter.extra_fields in .knowledge/config.yaml by hand: adopt couldn't add them and keep a config that loads, the same but for them"]);

    const flow = "{format: 1, knowledge_root: knowledge, github: {org: acme}}\n";
    const left = fixture(page, { config: flow });
    const r = adopt(left.root);
    expect(left.read(".knowledge/config.yaml")).toBe(flow);
    expect(r.extraFields).toEqual([]);
    expect(r.hints).toEqual([
      "add `sidebar_position` to frontmatter.extra_fields in .knowledge/config.yaml by hand: YAML wouldn't write this config back byte for byte, and adopt can't append to it",
    ]);
  });
});

describe("adopt: a config it can't add to", () => {
  it("leaves the config when the result wouldn't load: an empty key can't be listed", () => {
    const { root, read } = fixture({ "knowledge/a.md": '---\n"": x\n---\n# A\n' });
    const r = adopt(root);
    expect(read(".knowledge/config.yaml")).toBe(DEFAULT_CONFIG);
    expect(r.hints).toEqual(["add `` to frontmatter.extra_fields in .knowledge/config.yaml by hand: adopt couldn't add them and keep a config that loads, the same but for them"]);
  });
});

describe("adopt changes only files in the working tree (R4)", () => {
  it("leaves HEAD, the index, every ref, the remote, and other changes as they were", () => {
    const { root, read } = fixture({ "knowledge/a.md": "---\nsidebar_position: 1\n---\n# A\n\n[b](/b)\n", "knowledge/b.md": "# B\n", "notes.txt": "one\n", "other.txt": "one\n" });
    const remote = tempDir();
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trimEnd();
    git(remote, "init", "-q", "--bare");
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "seed");
    git(root, "tag", "v0");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "origin", "main", "v0");
    // A staged change, an unstaged one and an untracked file: adopt must leave each as it is.
    writeAll(root, { "notes.txt": "two\n" });
    git(root, "add", "notes.txt");
    writeAll(root, { "other.txt": "two\n", "new.txt": "untracked\n" });
    const state = () => ({
      head: git(root, "rev-parse", "HEAD"),
      index: git(root, "write-tree"),
      refs: git(root, "for-each-ref"),
      remote: git(remote, "for-each-ref"),
      sentinels: ["notes.txt", "other.txt", "new.txt"].map(read),
    });
    const before = state();
    adopt(root, { dryRun: true });
    expect(state()).toEqual(before);
    const r = adopt(root);
    expect(state()).toEqual(before);
    // It did change the working tree: two pages and the config, none of them staged.
    expect(r.adopted).toEqual(["knowledge/a.md", "knowledge/b.md"]);
    expect(git(root, "status", "--porcelain").split("\n").sort()).toEqual([" M .knowledge/config.yaml", " M knowledge/a.md", " M knowledge/b.md", " M other.txt", "?? new.txt", "M  notes.txt"]);
  });
});

describe("git reads the knowledge root as a path, not a pathspec", () => {
  // A root whose name git would read as pathspec magic (a leading `:`), as some do: `:(attr:x)`
  // matches only files with that attribute (none), `:(glob)**` every file in the repo. (Brackets
  // are no case: git tries a pathspec literally before as a pattern.)
  const configFor = (root: string) => `format: 1\nknowledge_root: "${root}"\ngithub:\n  org: acme\n`;
  const page = (title: string) => `---\ntitle: ${title}\nid: a\ntype: guide\nstatus: canonical\nowner_team: platform\nlast_verified: 2026-10-01\nreview_every: 90d\n---\n# ${title}\n`;
  const git = (root: string, ...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      env: { ...process.env, GIT_AUTHOR_DATE: "2025-03-04T10:00:00Z" },
      encoding: "utf8",
    });
  const seed = (root: string) => {
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "seed");
  };

  it("dates a page by its last commit", () => {
    const { root } = fixture({ ":(attr:x)kb/old.md": "# Old\n" }, { config: configFor(":(attr:x)kb"), codeowners: "/src/ @acme/platform\n" });
    seed(root);
    adopt(root, { team: "docs" });
    expect(loadRepo(root).byId.get("old")?.last_verified).toBe("2025-03-04");
  });

  it("calls the tree dirty for a change under the root, and not for one outside it", () => {
    const { root } = fixture({ ":(glob)**/a.md": page("A"), "README": "x\n" }, { config: configFor(":(glob)**") });
    seed(root);
    const dirty = () => new KnowledgeService(root, fixedIdentity(LOCAL_IDENTITY), () => NOW).snapshot().dirty;
    writeAll(root, { README: "changed\n" });
    expect(dirty()).toBe(false);
    writeAll(root, { ":(glob)**/a.md": page("A, changed") });
    expect(dirty()).toBe(true);
  });
});

describe("adopt --dates-from: copied pages keep their real dates", () => {
  /** git in `dir`, each commit's author and committer dates pinned (committer defaults to author). */
  const gitIn = (dir: string) => (date: string | { author: string; committer: string }, ...args: string[]) => {
    const { author, committer } = typeof date === "string" ? { author: date, committer: date } : date;
    return execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: `${author}T12:00:00Z`, GIT_COMMITTER_DATE: `${committer}T12:00:00Z` },
    });
  };
  /** A source repo whose commits, in order, write `files` on the pinned date. */
  const source = (commits: { date: string | { author: string; committer: string }; files: Record<string, string> }[], init: string[] = []) => {
    const dir = tempDir();
    const git = gitIn(dir);
    git("2025-01-01", "init", "-q", ...init);
    for (const c of commits) {
      writeAll(dir, c.files);
      git(c.date, "add", "-A");
      git(c.date, "commit", "-qm", "c");
    }
    return dir;
  };
  const dates = (root: string) => Object.fromEntries(loadRepo(root).pages.map((p) => [p.path, p.last_verified]));
  const A = "# Alpha\n\nThe steps.\n";
  const B = "# Alpha\n\nOther steps.\n";

  it("dates a copied page by the source commit that has its content, under any name", () => {
    const src = source([{ date: "2025-01-10", files: { "docs/alpha.md": A } }]);
    const { root } = fixture({ "knowledge/runbooks/renamed.md": A });
    const r = adopt(root, { datesFrom: [src] });
    expect(dates(root)).toEqual({ "knowledge/runbooks/renamed.md": "2025-01-10" });
    expect(r.datedFrom).toEqual([{ repo: realpathSync(src), pages: 1 }]);
    expect(r.datedToday).toEqual([]);
  });

  it("dates today, and lists, a copy whose content no commit has: untracked, or tracked and edited", () => {
    const src = source([{ date: "2025-01-10", files: { "docs/alpha.md": A } }]);
    const { root } = fixture({ "knowledge/tracked.md": B });
    const git = gitIn(root);
    git("2025-06-01", "init", "-q");
    git("2025-06-01", "add", "-A");
    git("2025-06-01", "commit", "-qm", "copies");
    writeFileSync(join(root, "knowledge/tracked.md"), `${B}Edited after the commit.\n`);
    // Untracked: written after the commit.
    writeFileSync(join(root, "knowledge/edited.md"), `${A}One more line.\n`);
    const r = adopt(root, { datesFrom: [src] });
    expect(dates(root)).toEqual({ "knowledge/edited.md": "2026-11-02", "knowledge/tracked.md": "2026-11-02" });
    expect(r.datedToday).toEqual(["knowledge/edited.md", "knowledge/tracked.md"]);
  });

  it("without --dates-from, a tracked copy keeps the path's last commit date, as before", () => {
    const { root } = fixture({ "knowledge/tracked.md": B });
    const git = gitIn(root);
    git("2025-06-01", "init", "-q");
    git("2025-06-01", "add", "-A");
    git("2025-06-01", "commit", "-qm", "copies");
    writeFileSync(join(root, "knowledge/tracked.md"), `${B}Edited after the commit.\n`);
    const r = adopt(root);
    expect(dates(root)).toEqual({ "knowledge/tracked.md": "2025-06-01" });
    // The new fields appear only with the option, so --json without it is as it was.
    expect(Object.keys(r)).not.toContain("datedFrom");
    expect(Object.keys(r)).not.toContain("datedToday");
    expect(Object.keys(adopt(fixture({ "knowledge/x.md": A }).root, { datesFrom: [] }))).not.toContain("datedFrom");
  });

  it("gives content that came back the date it last came back", () => {
    const src = source([
      { date: "2025-01-01", files: { "docs/alpha.md": A } },
      { date: "2025-02-01", files: { "docs/alpha.md": B } },
      { date: "2025-03-01", files: { "docs/alpha.md": A } },
    ]);
    const { root } = fixture({ "knowledge/a.md": A, "knowledge/b.md": B });
    adopt(root, { datesFrom: [src] });
    expect(dates(root)).toEqual({ "knowledge/a.md": "2025-03-01", "knowledge/b.md": "2025-02-01" });
  });

  it("takes the greatest author date, not the first commit git walks", () => {
    // The last commit (newest by committer date, walked first) is backdated by its author.
    const src = source([
      { date: { author: "2025-09-01", committer: "2025-09-01" }, files: { "docs/alpha.md": A } },
      { date: { author: "2025-09-15", committer: "2025-09-15" }, files: { "docs/alpha.md": B } },
      { date: { author: "2025-02-01", committer: "2025-10-01" }, files: { "docs/alpha.md": A } },
    ]);
    const { root } = fixture({ "knowledge/a.md": A });
    adopt(root, { datesFrom: [src] });
    expect(dates(root)).toEqual({ "knowledge/a.md": "2025-09-01" });
  });

  it("sees a merged branch's commits even when the merge's tree equals a parent's (--full-history)", () => {
    const src = source([{ date: "2025-01-01", files: { "docs/alpha.md": A } }]);
    const git = gitIn(src);
    git("2025-04-01", "checkout", "-qb", "feat");
    writeAll(src, { "docs/alpha.md": B });
    git("2025-04-01", "commit", "-qam", "b");
    writeAll(src, { "docs/alpha.md": A });
    git("2025-04-02", "commit", "-qam", "a again");
    git("2025-05-01", "checkout", "-q", "-");
    writeAll(src, { "other.txt": "x\n" });
    git("2025-05-01", "add", "-A");
    git("2025-05-01", "commit", "-qm", "diverge");
    git("2025-05-02", "merge", "-q", "--no-ff", "-m", "merge", "feat");
    const { root } = fixture({ "knowledge/a.md": A });
    adopt(root, { datesFrom: [src] });
    expect(dates(root)).toEqual({ "knowledge/a.md": "2025-04-02" });
  });

  it("doesn't count a permission-only change as new content", () => {
    const src = source([{ date: "2025-01-10", files: { "docs/alpha.md": A } }]);
    const git = gitIn(src);
    git("2025-06-01", "update-index", "--chmod=+x", "docs/alpha.md");
    git("2025-06-01", "commit", "-qm", "chmod only");
    const { root } = fixture({ "knowledge/a.md": A });
    adopt(root, { datesFrom: [src] });
    expect(dates(root)).toEqual({ "knowledge/a.md": "2025-01-10" });
  });

  it("matches content from the source's root commit with log.showRoot off (--root)", () => {
    const src = source([{ date: "2025-01-15", files: { "docs/alpha.md": A } }]);
    gitIn(src)("2025-01-15", "config", "log.showRoot", "false");
    const { root } = fixture({ "knowledge/a.md": A });
    adopt(root, { datesFrom: [src] });
    expect(dates(root)).toEqual({ "knowledge/a.md": "2025-01-15" });
  });

  it("indexes the whole repository when given a directory inside it", () => {
    const src = source([{ date: "2025-01-10", files: { "docs/alpha.md": A, "src/index.ts": "x\n" } }]);
    const { root } = fixture({ "knowledge/a.md": A });
    const r = adopt(root, { datesFrom: [join(src, "src")] });
    expect(dates(root)).toEqual({ "knowledge/a.md": "2025-01-10" });
    expect(r.datedFrom).toEqual([{ repo: realpathSync(src), pages: 1 }]);
  });

  it("matches a CRLF copy of a source git stores with LF", () => {
    const crlf = A.replace(/\n/g, "\r\n");
    const src = source([{ date: "2025-01-20", files: { ".gitattributes": "*.md text eol=crlf\n", "docs/alpha.md": crlf } }]);
    const { root } = fixture({ "knowledge/a.md": crlf });
    adopt(root, { datesFrom: [src] });
    expect(dates(root)).toEqual({ "knowledge/a.md": "2025-01-20" });
  });

  it("keeps a page's own last_verified", () => {
    const src = source([{ date: "2025-01-10", files: { "docs/alpha.md": A } }]);
    const { root } = fixture({ "knowledge/a.md": `---\nlast_verified: 2024-12-12\n---\n${A}` });
    const r = adopt(root, { datesFrom: [src] });
    expect(dates(root)).toEqual({ "knowledge/a.md": "2024-12-12" });
    // Every source is listed, even at 0: "dated 0 pages from <repo>" flags a wrong path.
    expect(r.datedFrom).toEqual([{ repo: realpathSync(src), pages: 0 }]);
    expect(r.datedToday).toEqual([]);
  });

  it("prefers the source's date to a later commit of the copy here, and dates from here what no source has", () => {
    const src = source([{ date: "2025-01-10", files: { "docs/alpha.md": A } }]);
    const { root } = fixture({ "knowledge/copy.md": A, "knowledge/own.md": B });
    const git = gitIn(root);
    git("2026-11-01", "init", "-q");
    git("2026-11-01", "add", "-A");
    git("2026-11-01", "commit", "-qm", "copies");
    const r = adopt(root, { datesFrom: [src] });
    expect(dates(root)).toEqual({ "knowledge/copy.md": "2025-01-10", "knowledge/own.md": "2026-11-01" });
    expect(r.datedFrom).toEqual([
      { repo: realpathSync(src), pages: 1 },
      { repo: realpathSync(root), pages: 1 },
    ]);
  });

  it("takes the newest date across several sources", () => {
    const older = source([{ date: "2025-01-01", files: { "a.md": A } }]);
    const newer = source([{ date: "2025-08-08", files: { "b.md": A } }]);
    const { root } = fixture({ "knowledge/a.md": A });
    const r = adopt(root, { datesFrom: [older, newer] });
    expect(dates(root)).toEqual({ "knowledge/a.md": "2025-08-08" });
    expect(r.datedFrom).toEqual([
      { repo: realpathSync(older), pages: 0 },
      { repo: realpathSync(newer), pages: 1 },
    ]);
  });

  it("ignores git variables in the environment that would redirect it or read the globs literally", () => {
    const src = source([{ date: "2025-04-04", files: { "docs/alpha.md": A } }]);
    const { root } = fixture({ "knowledge/a.md": A });
    const saved = { dir: process.env.GIT_DIR, literal: process.env.GIT_LITERAL_PATHSPECS };
    process.env.GIT_DIR = join(tempDir(), "nowhere.git");
    process.env.GIT_LITERAL_PATHSPECS = "1";
    try {
      adopt(root, { datesFrom: [src] });
    } finally {
      for (const [key, value] of [["GIT_DIR", saved.dir], ["GIT_LITERAL_PATHSPECS", saved.literal]] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    expect(dates(root)).toEqual({ "knowledge/a.md": "2025-04-04" });
  });

  it("works with a sha256 repository", () => {
    const src = source([{ date: "2025-03-03", files: { "docs/alpha.md": A } }], ["--object-format=sha256"]);
    const { root } = fixture({ "knowledge/a.md": A });
    adopt(root, { datesFrom: [src] });
    expect(dates(root)).toEqual({ "knowledge/a.md": "2025-03-03" });
  });

  it("refuses a path that isn't a git repository, or one with no commits, changing nothing", () => {
    const { root } = fixture({ "knowledge/a.md": A });
    const before = snapshot(root);
    const plain = tempDir();
    const empty = tempDir();
    gitIn(empty)("2025-01-01", "init", "-q");
    const refusal = (dir: string) => {
      try {
        adopt(root, { datesFrom: [dir] });
      } catch (err) {
        return err as Error;
      }
      throw new Error("adopt didn't refuse");
    };
    const notGit = refusal(plain);
    expect(notGit).toBeInstanceOf(AdoptError);
    expect(notGit.message).toBe(`--dates-from \`${plain}\` isn't a git repository`);
    const noCommits = refusal(empty);
    expect(noCommits).toBeInstanceOf(AdoptError);
    expect(noCommits.message).toBe(`--dates-from \`${empty}\` has no commits to date pages from`);
    expect(snapshot(root)).toEqual(before);
  });

  it("reports what it dated, through the real CLI", () => {
    const src = source([{ date: "2025-01-10", files: { "docs/alpha.md": A } }]);
    const { root } = fixture({ "knowledge/a.md": A, "knowledge/new.md": B });
    const cli = (...args: string[]) =>
      execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--as-of", "2026-11-02", "adopt", root, "--dates-from", src, "--dry-run", ...args], { encoding: "utf8" });
    const lines = cli().split("\n");
    expect(lines).toContain(`dated      1 page from ${realpathSync(src)}`);
    expect(lines).toContain("today      knowledge/new.md: no commit here or in --dates-from has this content");
    expect(JSON.parse(cli("--json"))).toMatchObject({ datedFrom: [{ repo: realpathSync(src), pages: 1 }], datedToday: ["knowledge/new.md"] });
    const plainLines = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--as-of", "2026-11-02", "adopt", root, "--dry-run"], { encoding: "utf8" }).split("\n");
    expect(plainLines.filter((l) => /^(dated|today) /.test(l))).toEqual([]);
  });
});
