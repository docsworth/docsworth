import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { matchRule } from "./codeowners.js";
import { CONFIG_PATH } from "./config.js";
import { pageStatus } from "./gate.js";
import { type Repo, resolveLink } from "./repo.js";

export type Severity = "error" | "warning";
export interface Diagnostic {
  severity: Severity;
  path: string;
  rule: string;
  message: string;
}

export interface LintResult {
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
  pages: number;
}

// Directories whose pages must be a given type; elsewhere any type is fine.
const DIR_TYPES: Record<string, string> = { runbooks: "runbook", decisions: "adr", services: "service" };
const ADR_FILENAME = /^ADR-\d{4}-[a-z0-9-]+\.md$/;

/** Lint a loaded knowledge repo. Errors fail CI; warnings never do (e.g. overdue pages). */
export function lintRepo(repo: Repo, now: Date): LintResult {
  const out: Diagnostic[] = [];
  const err = (path: string, rule: string, message: string) => out.push({ severity: "error", path, rule, message });
  const warn = (path: string, rule: string, message: string) => out.push({ severity: "warning", path, rule, message });
  const root = repo.config.knowledge_root;

  // Repo-level structure.
  if (!repo.codeowners.path) err("CODEOWNERS", "codeowners-missing", "no CODEOWNERS file (.github/, root or docs/)");
  for (const e of repo.codeowners.errors) err(repo.codeowners.path ?? "CODEOWNERS", "codeowners-syntax", `line ${e.line}: ${e.message}`);
  if (!repo.byPath.has(`${root}/index.md`) && !repo.invalid.some((p) => p.path === `${root}/index.md`))
    err(`${root}/index.md`, "index-missing", "the root map agents read first is missing");
  if (!repo.byPath.has(`${root}/glossary.md`)) warn(`${root}/glossary.md`, "glossary-missing", "no glossary for acronyms and codenames");

  // policy.admins: the team that must approve changes to the config and to CODEOWNERS
  // itself. Checked against the winning (last matching) rule, as GitHub applies it. It
  // only binds when branch protection requires code-owner review; lint can't see that.
  const admins = repo.config.policy.admins;
  if (admins) {
    const org = repo.config.github.org;
    for (const target of [CONFIG_PATH, repo.codeowners.path ?? "CODEOWNERS"]) {
      const rule = matchRule(repo.codeowners, target);
      const teams = (rule?.owners ?? []).filter((o) => o.kind === "team" && o.org === org).map((o) => o.team);
      if (!rule || !teams.includes(admins)) {
        const found = rule ? `line ${rule.line} names ${rule.owners.map((o) => o.raw).join(" ") || "no owners"}` : "no rule matches it";
        err(target, "policy-admins", `policy.admins is \`${admins}\`, but CODEOWNERS doesn't make @${org}/${admins} the owner of ${target} (${found}); add \`/${target} @${org}/${admins}\` as the last line`);
      } else if (rule.owners.length > 1)
        // Any one code owner's approval satisfies GitHub, so a co-owner bypasses the admins.
        err(target, "policy-admins", `CODEOWNERS line ${rule.line} also lets ${rule.owners.filter((o) => o.raw !== `@${org}/${admins}`).map((o) => o.raw).join(" ")} approve changes to ${target}; @${org}/${admins} must be its only owner`);
    }
  }

  // Local runtime state inside the checkout must be ignored by git, or one `git add -A`
  // commits the usage log (pages people read) or the mirror (copies of the old wiki).
  // Only the stores this config turns on, so a repo without them gets no noise.
  const mirrorDir = repo.config.mirror.out_dir.replace(/\/+$/, "");
  // A store is checked when the config turns it on, or when its files are on disk anyway
  // (the setting was switched off later, but the old files can still be committed).
  const present = (rel: string) => existsSync(join(repo.root, rel));
  const stores = [
    ...(repo.config.usage_log || present(".knowledge/usage.jsonl") ? [{ probe: ".knowledge/usage.jsonl", path: ".knowledge/usage.jsonl", what: ".knowledge/usage.jsonl" }] : []),
    ...(repo.config.mirror.sources.length || present(mirrorDir) ? [{ probe: `${mirrorDir}/x.md`, path: mirrorDir, what: `${repo.config.mirror.out_dir} (the mirror cache)` }] : []),
  ];
  for (const s of stores) {
    // An ignore rule doesn't untrack: files committed before it keep being committed.
    // Tracked is the worse state, so it's the one reported.
    const ls = spawnSync("git", ["-C", repo.root, "ls-files", "--", s.path], { encoding: "utf8" });
    if (ls.status !== 0) continue; // not a git checkout: nothing can be committed
    const tracked = ls.stdout.trim();
    if (tracked) {
      warn(s.path, "local-state-tracked", `${s.what} is already tracked by git (${tracked.split("\n").length} file(s)); untrack it with \`git rm -r --cached ${s.path}\``);
      continue;
    }
    const r = spawnSync("git", ["-C", repo.root, "check-ignore", "-q", s.probe], { encoding: "utf8" });
    if (r.status === 1) warn(".gitignore", "local-state-tracked", `${s.what} is not ignored by git; add it to .gitignore (docsworth init writes .knowledge/.gitignore for this)`);
  }

  // Frontmatter that failed validation.
  for (const inv of repo.invalid) for (const issue of inv.issues) err(inv.path, "frontmatter", issue.message);

  // Duplicate ids, across valid and invalid pages alike.
  const seen = new Map<string, string>();
  for (const p of [...repo.pages, ...repo.invalid]) {
    if (!p.id) continue;
    const first = seen.get(p.id);
    if (first) err(p.path, "duplicate-id", `id \`${p.id}\` is already used by ${first}`);
    else seen.set(p.id, p.path);
  }

  for (const page of repo.pages) {
    const status = pageStatus(page, repo, now);
    if (status.ownership_problem) err(page.path, "ownership", status.ownership_problem);

    for (const link of page.links) {
      const target = resolveLink(page.path, link);
      if (target.startsWith("..") || !existsSync(join(repo.root, target)))
        err(page.path, "broken-link", `link to \`${link}\` does not resolve (${target})`);
    }

    for (const id of page.supersedes ?? [])
      if (!seen.has(id)) warn(page.path, "supersedes-unknown", `supersedes \`${id}\`, which is not a page in this repo`);
    for (const f of page.unknownFields) warn(page.path, "unknown-field", `unknown frontmatter field \`${f}\``);

    const dir = page.path.slice(root.length + 1).split("/")[0] ?? "";
    const wantType = DIR_TYPES[dir];
    if (wantType && page.type !== wantType) warn(page.path, "type-dir", `pages under ${dir}/ should be type: ${wantType}`);
    if (page.type === "adr" && dir === "decisions" && !ADR_FILENAME.test(posix.basename(page.path)))
      warn(page.path, "adr-filename", "ADR files are named ADR-0001-<slug>.md");

    if (page.status === "canonical" && status.sla.state === "overdue")
      warn(page.path, "overdue", `past review date (due ${status.sla.due}); @${repo.config.github.org}/${page.owner_team} should verify it`);
  }

  const errors = out.filter((d) => d.severity === "error").length;
  return { diagnostics: out, errors, warnings: out.length - errors, pages: repo.pages.length + repo.invalid.length };
}

export function formatDiagnostics(result: LintResult): string {
  const lines = result.diagnostics.map((d) => `${d.path}: ${d.severity} [${d.rule}] ${d.message}`);
  lines.push(`${result.pages} pages, ${result.errors} errors, ${result.warnings} warnings`);
  return lines.join("\n");
}
