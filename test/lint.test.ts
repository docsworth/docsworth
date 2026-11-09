import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { lintRepo } from "../src/core/lint.js";
import { REQUIRED_FIELDS } from "../src/core/schema.js";
import { ACME, INDEX, makeRepo, NOW, page } from "./helpers.js";

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

  it("only warns about overdue canonical pages", () => {
    const r = lint({ "knowledge/x.md": page({ id: "x", last_verified: "2025-01-01" }) });
    expect(r.errors).toBe(0);
    expect(rules(r, "warning")).toContain("overdue");
  });
});
