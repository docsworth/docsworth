import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { type Codeowners, loadCodeowners } from "./codeowners.js";
import { type Config, loadConfig } from "./config.js";
import { splitFrontmatter } from "./frontmatter.js";
import { type FieldIssue, type Frontmatter, validateFrontmatter } from "./schema.js";

export interface Page extends Frontmatter {
  /** Repo-relative posix path, e.g. `knowledge/runbooks/deploy.md`. */
  path: string;
  body: string;
  headings: string[];
  /** Relative markdown link targets as written (anchors stripped). */
  links: string[];
  sha256: string;
  unknownFields: string[];
}

export interface InvalidPage {
  path: string;
  /** The `id` field if present and a string, so lint can still report duplicates. */
  id?: string;
  issues: FieldIssue[];
}

export interface Repo {
  root: string;
  config: Config;
  codeowners: Codeowners;
  pages: Page[];
  invalid: InvalidPage[];
  byId: Map<string, Page>;
  byPath: Map<string, Page>;
}

// Linear without bounds on what a link may hold (main had none, and lint reads every link):
// each span stops where the next of its kind could start. Link text stops at a `[`, so `[a`
// repeated can't make each `[` scan on (to the end of the page: 1.1 s for 64 KB); the
// destination is matched once, in a lookahead, and never given back character by
// character (`[a](` repeated retried every length); an angle destination stops at `<`
// (CommonMark), a plain one at `[`. A title runs to its own closer; one in parentheses
// holds no unescaped `(` (CommonMark), so it stops there too. Only a definition's label is
// bounded, at CommonMark's 999 characters.
const TITLE = String.raw`(?:\s+(?:"[^"]*"|'[^']*'|\((?:[^()\\]|\\.)*\)))?`;
const LINK_RE = new RegExp(String.raw`!?\[[^\][]*\]\(\s*(?=(<[^<>\n]*>|[^)\s[]+))\1${TITLE}\s*\)`, "g");
const REF_DEF_RE = new RegExp(String.raw`^ {0,3}\[[^\][\n]{1,999}\]:[ \t]*(?=(<[^<>\n]*>|\S+))\1${TITLE}[ \t]*$`, "gm");
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Relative link targets (inline and reference definitions), without query or fragment. */
export function extractLinks(body: string): string[] {
  const out: string[] = [];
  for (const m of [...body.matchAll(LINK_RE), ...body.matchAll(REF_DEF_RE)]) {
    const target = m[1]!.replace(/^<|>$/g, "");
    if (EXTERNAL.test(target)) continue;
    const path = target.split(/[?#]/)[0]!;
    if (path) out.push(path);
  }
  return out;
}

export function extractHeadings(body: string): string[] {
  return body
    .split(/\r?\n/)
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^#{1,6}\s+/, "").trim());
}

/** Resolve a relative link from a page to a repo-relative posix path. */
export function resolveLink(fromPath: string, target: string): string {
  let t = target;
  try {
    t = decodeURI(target);
  } catch {
    /* malformed escape: resolve as written */
  }
  return t.startsWith("/") ? posix.normalize(t.slice(1)) : posix.normalize(posix.join(posix.dirname(fromPath), t));
}

function walkMarkdown(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const abs = join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith(".") ? [] : walkMarkdown(abs);
    return e.isFile() && e.name.endsWith(".md") ? [abs] : [];
  });
}

export function parsePage(path: string, text: string): Page | InvalidPage {
  const doc = splitFrontmatter(text);
  if (!doc.data) return { path, issues: [{ field: "(frontmatter)", message: doc.error ?? "missing frontmatter" }] };
  const rawId = typeof doc.data.id === "string" ? doc.data.id : undefined;
  const v = validateFrontmatter(doc.data);
  if (!v.ok) return { path, id: rawId, issues: v.issues };
  return {
    ...v.value,
    path,
    body: doc.body,
    headings: extractHeadings(doc.body),
    links: extractLinks(doc.body),
    sha256: createHash("sha256").update(text).digest("hex"),
    unknownFields: v.unknownFields,
  };
}

export function isPage(p: Page | InvalidPage): p is Page {
  return (p as Page).sha256 !== undefined;
}

/**
 * Load a knowledge repo from disk. Pages with invalid frontmatter are kept out of
 * `pages` (nothing downstream may serve them) and reported in `invalid` for the linter.
 */
export function loadRepo(root: string, config: Config = loadConfig(root)): Repo {
  const knowledgeDir = join(root, config.knowledge_root);
  const pages: Page[] = [];
  const invalid: InvalidPage[] = [];
  for (const abs of walkMarkdown(knowledgeDir).sort()) {
    const path = relative(root, abs).split(sep).join("/");
    const parsed = parsePage(path, readFileSync(abs, "utf8"));
    (isPage(parsed) ? pages : invalid).push(parsed as never);
  }
  const byId = new Map<string, Page>();
  for (const p of pages) if (!byId.has(p.id)) byId.set(p.id, p);
  return {
    root,
    config,
    codeowners: loadCodeowners(root),
    pages,
    invalid,
    byId,
    byPath: new Map(pages.map((p) => [p.path, p])),
  };
}

/** Latest mtime under the knowledge dir; the MCP server uses it to detect edits. */
export function knowledgeMtime(root: string, config: Config): number {
  return walkMarkdown(join(root, config.knowledge_root)).reduce((max, f) => Math.max(max, statSync(f).mtimeMs), 0);
}
