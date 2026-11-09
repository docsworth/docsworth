import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The open-source core must stay separable from the paid tier. Pro is its own package:
// core's source, tests and scripts never import it, and the CLI finds it only by name, at
// run time.
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

/** Every module specifier a file imports, statically or dynamically, with its line. */
function specifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/(?:\bfrom\s+|\bimport\s+|\bimport\(\s*)(["'`])([^"'`]+)\1/g)].map((m) => `${file}: ${m[2]}`);
}

describe("layering", () => {
  it("core's source, tests and scripts never import pro", () => {
    const offenders = ["src", "test", "scripts"]
      .flatMap(tsFiles)
      .flatMap(specifiers)
      .filter((s) => /: (?:@docsworth-pro\/|.*\/pro\/|.*packages\/)/.test(s));
    expect(offenders).toEqual([]);
  });

  it("the host facade exports exactly the listed names, types included", () => {
    // Growing the facade grows what pro can depend on: change this list on purpose, and
    // raise HOST_API when a name goes or changes meaning. Read from the source, not from
    // the module, so type-only exports count too (merge gate, PR 15).
    const src = readFileSync("src/core/host.ts", "utf8");
    const reexported = [...src.matchAll(/^export\s+(type\s+)?\{([^}]*)\}\s+from/gm)].flatMap((m) =>
      m[2]!.split(",").map((n) => n.trim()).filter(Boolean).map((n) => (m[1] && !n.startsWith("type ") ? `type ${n}` : n)),
    );
    const declared = [...src.matchAll(/^export\s+(const|function|class|interface|type)\s+(\w+)/gm)].map((m) => (m[1] === "interface" || m[1] === "type" ? `type ${m[2]}` : m[2]!));
    expect([...reexported, ...declared].sort()).toEqual(
      [
        "ACL_INTERNAL", "CONFIG_PATH", "ConfigError", "GitHubError", "HOST_API", "INSTRUCTIONS", "KnowledgeService", "LOCAL_IDENTITY", "MIRROR_SOURCES",
        "SearchIndex", "ToolError", "UserError", "canSee", "canonicalDir", "computeCoverage", "formatDate", "insecureUrl", "isPage", "isUserError",
        "listStale", "loadMirror", "lstatExists", "matchRule", "mirrorRecordPath", "openPagePr", "ownedFiles", "ownedSpaceFiles", "pageStatus",
        "parsePage", "readDescription", "readOwned", "resolveLink", "resolveTeamOwner", "searchDescription", "sha256", "snippet", "splitFrontmatter",
        "tokenize", "urlForError", "utcToday", "visiblePages", "writeAll",
        "actorOf", "resolveAuditDir", "parseDuration", "subtractDuration", "IdentityProvider", "resolveToken",
        "type AuditEvent", "type AuditSink", "type Connector", "type Coverage", "type CoverageRow", "type FetchLike", "type GitHubClient", "type Identity",
        "type MirrorPage", "type MirrorSource", "type Page", "type PageType", "type PrResult", "type Repo", "type StaleEntry", "type SystemName",
        "type AuditActor", "type AuditLog", "type Config", "type CommandContext", "type ProCommands",
        "buildNewPage", "NEW_PAGE_PREFIX", "slugify",
      ].sort(),
    );
  });

  it("the host facade's values are what the module exports", async () => {
    const host = await import("../src/core/host.js");
    const src = readFileSync("src/core/host.ts", "utf8");
    const values = [
      ...[...src.matchAll(/^export\s+\{([^}]*)\}\s+from/gm)].flatMap((m) => m[1]!.split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type "))),
      ...[...src.matchAll(/^export\s+(?:const|function|class)\s+(\w+)/gm)].map((m) => m[1]!),
    ];
    expect(Object.keys(host).sort()).toEqual(values.sort());
  });

  it("the CLI finds pro only by package name: the handshake, then pro's commands", () => {
    // The CLI knows pro by core's contract alone. It names pro's package once, and reaches
    // three things in it: package.json (is pro installed?), its host API (the handshake) and
    // its commands, the last only inside pro(…), after the handshake.
    const src = readFileSync("src/cli.ts", "utf8");
    expect(src.match(/@docsworth-pro\/[\w/.-]*/g)).toEqual(["@docsworth-pro/pro"]);
    expect(src).toMatch(/^const PRO_PACKAGE = "@docsworth-pro\/pro";$/m);
    expect([...src.matchAll(/\$\{PRO_PACKAGE\}\/([\w.-]+)/g)].map((m) => m[1]).sort()).toEqual(["commands", "host-api", "package.json"]);
    expect(src).toMatch(/pro\(feature, async \(\) => \(\(await import\(`\$\{PRO_PACKAGE\}\/commands`\)\) as \{ commands: ProCommands \}\)\.commands\)/);
    expect(src).not.toMatch(/\.\/pro\//);
  });
});

describe("user errors", () => {
  it("are recognized by their brand, from core and from another copy of core", async () => {
    // Pro's errors extend UserError; pro's own tests check them.
    const [{ isUserError, UserError }, { ConfigError }] = await Promise.all([import("../src/core/errors.js"), import("../src/core/config.js")]);
    for (const E of [UserError, ConfigError]) expect(isUserError(new E("x")), E.name).toBe(true);
    // Pro built against another copy of core: a class of the same shape, not this one.
    class Elsewhere extends Error {
      readonly userError = true as const;
    }
    expect(isUserError(new Elsewhere("x"))).toBe(true);
    expect(isUserError(new Error("x"))).toBe(false);
    expect(isUserError({ userError: true, message: "x" })).toBe(false);
  });
});
