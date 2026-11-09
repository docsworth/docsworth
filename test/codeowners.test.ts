import { describe, expect, it } from "vitest";
import { matchRule, parseCodeowners, patternToRegex, resolveTeamOwner } from "../src/core/codeowners.js";

const m = (pattern: string, path: string) => patternToRegex(pattern).test(path);

// Cases are the worked examples from GitHub's "About code owners" documentation.
describe("CODEOWNERS pattern semantics", () => {
  it("`*` matches everything", () => {
    expect(m("*", "README.md")).toBe(true);
    expect(m("*", "a/b/c.md")).toBe(true);
  });

  it("`*.js` matches by name at any depth", () => {
    expect(m("*.js", "app.js")).toBe(true);
    expect(m("*.js", "src/deep/app.js")).toBe(true);
    expect(m("*.js", "app.jsx")).toBe(false);
  });

  it("`/build/logs/` matches the root directory and all subdirectories", () => {
    expect(m("/build/logs/", "build/logs/a.log")).toBe(true);
    expect(m("/build/logs/", "build/logs/x/y.log")).toBe(true);
    expect(m("/build/logs/", "other/build/logs/a.log")).toBe(false);
  });

  it("`docs/*` matches direct children only", () => {
    expect(m("docs/*", "docs/getting-started.md")).toBe(true);
    expect(m("docs/*", "docs/build-app/troubleshooting.md")).toBe(false);
  });

  it("`apps/` matches an apps directory anywhere", () => {
    expect(m("apps/", "apps/x.ts")).toBe(true);
    expect(m("apps/", "src/apps/x.ts")).toBe(true);
    expect(m("apps/", "apps")).toBe(false); // a file named apps is not a directory
  });

  it("`**/logs` matches a logs directory at any depth", () => {
    for (const p of ["build/logs/a", "scripts/logs/b", "deeply/nested/logs/c", "logs/d"]) {
      expect(m("**/logs", p)).toBe(true);
    }
    expect(m("**/logs", "build/mylogs/a")).toBe(false);
  });

  it("a literal last segment also matches everything beneath it", () => {
    expect(m("/apps/github", "apps/github/x.ts")).toBe(true);
    expect(m("/apps/github", "apps/github")).toBe(true);
    expect(m("/apps/github", "apps/githubber/x.ts")).toBe(false);
  });

  it("escaped # is literal", () => {
    expect(m("\\#notes.md", "#notes.md")).toBe(true);
  });
});

describe("CODEOWNERS rule resolution", () => {
  const co = parseCodeowners(
    [
      "# comment",
      "*                       @acme/fallback",
      "/knowledge/             @acme/docs",
      "/knowledge/runbooks/    @acme/platform   # trailing comment",
      "/apps/                  @octocat",
      "/apps/github",
      "/knowledge/shared/      @acme/a @acme/b",
      "/knowledge/people/      @alice",
      "/knowledge/vendor/      @other-org/platform",
      "/knowledge/mail/        docs@example.com",
      "!negated                @acme/x",
    ].join("\n"),
  );

  it("last matching rule wins", () => {
    expect(matchRule(co, "knowledge/runbooks/deploy.md")?.owners[0]?.raw).toBe("@acme/platform");
    expect(matchRule(co, "knowledge/index.md")?.owners[0]?.raw).toBe("@acme/docs");
    expect(matchRule(co, "README.md")?.owners[0]?.raw).toBe("@acme/fallback");
  });

  it("an owner-less rule un-owns the path", () => {
    expect(matchRule(co, "apps/github/x")?.owners).toEqual([]);
    expect(matchRule(co, "apps/other/x")?.owners[0]?.raw).toBe("@octocat");
  });

  it("reports unsupported syntax instead of silently matching", () => {
    expect(co.errors).toHaveLength(1);
    expect(co.errors[0]?.line).toBe(11);
  });

  it("resolves exactly one team in the configured org", () => {
    expect(resolveTeamOwner(co, "knowledge/runbooks/deploy.md", "acme")).toMatchObject({ ok: true, team: "platform" });
  });

  it.each([
    ["knowledge/shared/x.md", "multiple_owners"],
    ["knowledge/people/x.md", "individual_owner"],
    ["knowledge/vendor/x.md", "foreign_org"],
    ["knowledge/mail/x.md", "individual_owner"],
    ["apps/github/x.md", "no_owners"],
  ])("rejects %s as %s", (path, kind) => {
    const r = resolveTeamOwner(co, path, "acme");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.kind).toBe(kind);
  });

  it("reports no_rule when nothing matches", () => {
    const empty = parseCodeowners("/src/ @acme/eng");
    const r = resolveTeamOwner(empty, "knowledge/x.md", "acme");
    expect(!r.ok && r.problem.kind).toBe("no_rule");
  });

  it("matches org case-insensitively", () => {
    const mixed = parseCodeowners("/knowledge/ @Acme/Platform");
    expect(resolveTeamOwner(mixed, "knowledge/x.md", "acme")).toMatchObject({ ok: true, team: "platform" });
  });
});
