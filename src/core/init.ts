import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEOWNERS_LOCATIONS } from "./codeowners.js";
import { formatDate, utcToday } from "./duration.js";
import { UserError } from "./errors.js";
import { ownedPackage, PUBLISHED_PACKAGE } from "./version.js";

// `docsworth init`: scaffold a knowledge repo in an existing git repo. Never overwrites.

export interface InitOptions {
  org: string;
  team: string;
  repo?: string;
  ci?: boolean;
  now: Date;
  /** The package the CI workflow runs; defaults to PUBLISHED_PACKAGE (tests pass one). */
  package?: string;
}

export class InitError extends UserError {}

export interface InitResult {
  created: string[];
  skipped: string[];
  hints: string[];
}

/** owner/name from the origin remote, if it is a GitHub URL. */
export function githubRemote(root: string): { owner: string; name: string } | null {
  const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" });
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\s*$/.exec(r.stdout ?? "");
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

function page(fm: Record<string, string>, body: string): string {
  return `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;
}

/** `.knowledge/.gitignore`: local state that must never be committed. */
export const LOCAL_STATE_GITIGNORE = "# Written by Docsworth at runtime; never commit these.\nusage.jsonl\nmirror/\ncache/\naudit/\n";

export function initRepo(root: string, opts: InitOptions): InitResult {
  // Before anything is written: a workflow naming a package we don't own would run a
  // stranger's code in the customer's CI, with a token that can push.
  const pkg = opts.package ?? PUBLISHED_PACKAGE;
  if (opts.ci && !ownedPackage(pkg))
    throw new InitError(`--ci would run \`${pkg}\`, which isn't a plain npm package and range we own (\`@scope/name@^1.2\`)`);
  const today = formatDate(utcToday(opts.now));
  const res: InitResult = { created: [], skipped: [], hints: [] };
  const write = (rel: string, content: string) => {
    const abs = join(root, rel);
    if (existsSync(abs)) return void res.skipped.push(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    res.created.push(rel);
  };
  const base = { owner_team: opts.team, status: "canonical", last_verified: today };

  write(
    ".knowledge/config.yaml",
    [
      "# Docsworth configuration. See docs/format-spec.md in the Docsworth repo.",
      "format: 1",
      "knowledge_root: knowledge",
      "github:",
      `  org: ${opts.org.toLowerCase()}`,
      opts.repo ? `  repo: ${opts.repo}` : "  # repo: owner/name   # set to make GitHub the ACL authority and enable PR tools",
      "sla:",
      "  due_soon_days: 14",
      "usage_log: true",
      "skills:",
      "  out_dir: skills",
      "",
    ].join("\n"),
  );

  // Runtime state the CLI and server write next to the config. None of it belongs in git:
  // the usage log names pages people read, the mirror holds copies of the old wiki.
  write(".knowledge/.gitignore", LOCAL_STATE_GITIGNORE);

  const existingCodeowners = CODEOWNERS_LOCATIONS.find((l) => existsSync(join(root, l)));
  if (existingCodeowners) {
    res.skipped.push(existingCodeowners);
    if (!/^\/?knowledge\//m.test(readFileSync(join(root, existingCodeowners), "utf8")))
      res.hints.push(`add \`/knowledge/ @${opts.org}/${opts.team}\` to ${existingCodeowners}; every knowledge page needs exactly one owning team`);
  } else {
    write("CODEOWNERS", `# Knowledge ownership: exactly one team per path (enforced by \`docsworth lint\`).\n/knowledge/ @${opts.org}/${opts.team}\n`);
  }

  write(
    "knowledge/index.md",
    page(
      { title: "Engineering knowledge", id: "index", type: "guide", ...base, review_every: "90d", description: "Root map of this knowledge base. Agents read this first." },
      "# Engineering knowledge\n\nStart here. Each page has one owning team and a review date; agents only cite pages that are canonical and inside their review window.\n\n## Guides\n- [Writing and verifying pages](guides/writing-pages.md)\n\nSee also the [glossary](glossary.md).\n",
    ),
  );
  write(
    "knowledge/glossary.md",
    page({ title: "Glossary", id: "glossary", type: "guide", ...base, review_every: "180d", description: "Acronyms and codenames." }, "# Glossary\n\n- **Canonical**: a page agents may cite, once it is verified within its review period.\n"),
  );
  write(
    "knowledge/guides/writing-pages.md",
    page(
      { title: "Writing and verifying pages", id: "guide-writing-pages", type: "guide", ...base, review_every: "180d", description: "How to add, change and verify pages in this knowledge base." },
      [
        "# Writing and verifying pages",
        "",
        "## Adding a page",
        "1. Create a markdown file under `knowledge/` with the frontmatter fields `title`, `id`, `type`, `status`, `owner_team`, `last_verified` and `review_every`.",
        "2. Runbooks go in `knowledge/runbooks/` with the sections *When to use*, *Steps*, *Checks* and *Rollback*, so they compile into agent skills.",
        "3. Run `docsworth lint .` and open a pull request; the owning team in CODEOWNERS reviews it.",
        "",
        "## Keeping pages citable",
        "- A page is citable while `status: canonical` and today is on or before `last_verified + review_every`.",
        "- To re-verify, ask Claude Code to `verify` the page (owners only), or edit `last_verified` in a PR.",
        "- `docsworth stale .` lists overdue and unowned pages.",
        "",
      ].join("\n"),
    ),
  );

  if (opts.ci) {
    const template = join(dirname(fileURLToPath(import.meta.url)), "../../templates/github/knowledge.yml");
    write(".github/workflows/knowledge.yml", readFileSync(template, "utf8").replaceAll("__DOCSWORTH_PACKAGE__", pkg));
  }
  return res;
}
