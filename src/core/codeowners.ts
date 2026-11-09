import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// CODEOWNERS with GitHub's semantics (docs: "About code owners"):
//  - the LAST matching rule wins;
//  - gitignore-style patterns, minus `!` negation and `[...]` ranges;
//  - a pattern containing a slash (other than a trailing one) is anchored to the root;
//  - a trailing slash matches a directory's contents;
//  - a pattern whose last segment is a wildcard (`docs/*`) matches only direct children,
//    while a literal last segment (`/apps/github`, `**/logs`) also matches everything
//    beneath it;
//  - a rule with no owners explicitly un-owns the path.

export const CODEOWNERS_LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export type OwnerKind = "team" | "user" | "email";
export interface Owner {
  raw: string;
  kind: OwnerKind;
  /** For teams: org and slug from `@org/slug`. */
  org?: string;
  team?: string;
}

export interface Rule {
  line: number;
  pattern: string;
  owners: Owner[];
  regex: RegExp;
}

export interface CodeownersParseError {
  line: number;
  message: string;
}

export interface Codeowners {
  path: string | null;
  rules: Rule[];
  errors: CodeownersParseError[];
}

export function parseOwner(raw: string): Owner {
  const team = /^@([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)$/.exec(raw);
  if (team) return { raw, kind: "team", org: team[1]!.toLowerCase(), team: team[2]!.toLowerCase() };
  if (raw.startsWith("@")) return { raw, kind: "user" };
  return { raw, kind: "email" };
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|\\*?[\]]/g, "\\$&");
}

/** Translate one CODEOWNERS pattern to a regex over repo-relative posix paths. */
export function patternToRegex(pattern: string): RegExp {
  if (pattern === "*" || pattern === "/*" || pattern === "**") return /^.*$/;

  let p = pattern;
  const dirOnly = p.endsWith("/") && !p.endsWith("\\/");
  if (dirOnly) p = p.slice(0, -1);
  const leadingSlash = p.startsWith("/");
  if (leadingSlash) p = p.slice(1);
  const anchored = leadingSlash || p.includes("/");

  const segments = p.split("/");
  const last = segments[segments.length - 1] ?? "";
  const lastIsWildcard = /(^|[^\\])[*?]/.test(last) && last !== "**";

  let body = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    if (seg === "**") {
      body += isLast ? ".*" : "(?:.*/)?";
      continue;
    }
    // A backslash makes the next character literal (`\ ` for spaces, `\#`, `\*`).
    for (let j = 0; j < seg.length; j++) {
      const c = seg[j]!;
      if (c === "\\" && j + 1 < seg.length) body += escapeRe(seg[++j]!);
      else body += c === "*" ? "[^/]*" : c === "?" ? "[^/]" : escapeRe(c);
    }
    if (!isLast) body += "/";
  }

  const prefix = anchored ? "^" : "^(?:.*/)?";
  const suffix = dirOnly ? "/.*$" : lastIsWildcard ? "$" : "(?:/.*)?$";
  return new RegExp(prefix + body + suffix);
}

export function parseCodeowners(text: string, path: string | null = null): Codeowners {
  const rules: Rule[] = [];
  const errors: CodeownersParseError[] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = i + 1;
    // Strip comments: a `#` at line start, or preceded by whitespace (not `\#`).
    const content = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (!content) return;
    // Split on unescaped whitespace only: `docs/team\ notes/` is one pattern.
    const [pattern, ...ownerTokens] = content.match(/(?:\\.|\S)+/g) ?? [];
    if (!pattern) return;
    if (pattern.startsWith("!") || /\[|\]/.test(pattern)) {
      errors.push({ line, message: `unsupported pattern syntax in \`${pattern}\` (GitHub ignores this line)` });
      return;
    }
    rules.push({ line, pattern, owners: ownerTokens.map(parseOwner), regex: patternToRegex(pattern) });
  });
  return { path, rules, errors };
}

export function loadCodeowners(repoRoot: string): Codeowners {
  for (const rel of CODEOWNERS_LOCATIONS) {
    const abs = join(repoRoot, rel);
    if (existsSync(abs)) return parseCodeowners(readFileSync(abs, "utf8"), rel);
  }
  return { path: null, rules: [], errors: [] };
}

/** The winning (last matching) rule for a repo-relative path, if any. */
export function matchRule(co: Codeowners, filePath: string): Rule | null {
  const p = filePath.replace(/^\/+/, "");
  for (let i = co.rules.length - 1; i >= 0; i--) {
    const rule = co.rules[i]!;
    if (rule.regex.test(p)) return rule;
  }
  return null;
}

export type OwnershipProblem =
  | { kind: "no_rule" }
  | { kind: "no_owners"; rule: Rule }
  | { kind: "multiple_owners"; rule: Rule }
  | { kind: "individual_owner"; rule: Rule; owner: Owner }
  | { kind: "foreign_org"; rule: Rule; owner: Owner };

export type Ownership = { ok: true; team: string; rule: Rule } | { ok: false; problem: OwnershipProblem };

/**
 * Resolve the single owning team of a path. Knowledge pages must be owned by exactly
 * one team of `org` — never by an individual (the Plaid lesson), never by several.
 */
export function resolveTeamOwner(co: Codeowners, filePath: string, org: string): Ownership {
  const rule = matchRule(co, filePath);
  if (!rule) return { ok: false, problem: { kind: "no_rule" } };
  if (rule.owners.length === 0) return { ok: false, problem: { kind: "no_owners", rule } };
  if (rule.owners.length > 1) return { ok: false, problem: { kind: "multiple_owners", rule } };
  const owner = rule.owners[0]!;
  if (owner.kind !== "team") return { ok: false, problem: { kind: "individual_owner", rule, owner } };
  if (owner.org !== org.toLowerCase()) return { ok: false, problem: { kind: "foreign_org", rule, owner } };
  return { ok: true, team: owner.team!, rule };
}

export function describeOwnershipProblem(p: OwnershipProblem, org: string): string {
  switch (p.kind) {
    case "no_rule":
      return "no CODEOWNERS rule matches this path";
    case "no_owners":
      return `CODEOWNERS line ${p.rule.line} (\`${p.rule.pattern}\`) leaves this path unowned`;
    case "multiple_owners":
      return `CODEOWNERS line ${p.rule.line} names ${p.rule.owners.length} owners; knowledge paths need exactly one team`;
    case "individual_owner":
      return `CODEOWNERS line ${p.rule.line} assigns individual owner ${p.owner.raw}; use a team (@${org}/<team>)`;
    case "foreign_org":
      return `CODEOWNERS line ${p.rule.line} assigns ${p.owner.raw}, which is not a team in org \`${org}\``;
  }
}
