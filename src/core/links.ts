import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { type Node, Parser } from "commonmark";
import { applyEdits } from "./edits.js";
import { resolveLink } from "./repo.js";

// A page's links as CommonMark reads them (docs/format-spec.md, "Links"), for lint and for
// adopt's rewriting.
// commonmark.js decides: no link in code or HTML, destinations with nested parentheses,
// link text with nested brackets, reference links through the definitions they use.

/** Every link and image destination in `body`, in order, as commonmark.js parses it. */
export function pageLinks(body: string): string[] {
  return destinations(new Parser().parse(body));
}

function destinations(doc: Node): string[] {
  return linksIn(doc).map((l) => l.dest);
}

/** Each link and image in `doc`, in order: its destination, and what else tells it apart (kind, title, text). */
function linksIn(doc: Node): { dest: string; rest: string }[] {
  const out: { dest: string; rest: string }[] = [];
  const walker = doc.walker();
  for (let e = walker.next(); e; e = walker.next()) {
    if (!e.entering || (e.node.type !== "link" && e.node.type !== "image")) continue;
    // Its own text, not its subtree's: nested images would make that quadratic.
    let text = "";
    for (let c = e.node.firstChild; c; c = c.next) if (c.type === "text" || c.type === "code") text += c.literal ?? "";
    out.push({ dest: e.node.destination ?? "", rest: `${e.node.type}\0${e.node.title ?? ""}\0${text}` });
  }
  return out;
}

export interface LinkSpan {
  /** The destination as CommonMark reads it (escapes and entities applied, percent-encoded). */
  dest: string;
  /** The destination as written, `<` `>` aside: `start`/`end` delimit it in the body. */
  raw: string;
  start: number;
  end: number;
  /** Written in angle brackets (`<…>`), which stay outside start/end. */
  angle: boolean;
}

/**
 * Where each link's destination is written in `body`, for rewriting it in place. A liberal
 * scanner proposes candidates (after every `](`, and after a definition's `]:`); then
 * commonmark.js confirms them, all at once. Each candidate gets a token of its own written
 * just before it, the body is parsed once, and a candidate counts only if some link's or
 * image's destination is its token followed by what CommonMark reads the candidate as.
 * Text is only added, never taken away, so the page parses as it did: whatever CommonMark
 * doesn't link (code, HTML, a definition no link uses) is left out by its own rules, and
 * candidates may overlap.
 */
export function linkSpans(body: string, nonce: () => string = randomNonce): LinkSpan[] {
  const byStart = new Map<number, Candidate>();
  for (const c of [...inlineCandidates(body), ...definitionCandidates(body)]) if (!byStart.has(c.start)) byStart.set(c.start, c);
  const candidates = [...byStart.values()].sort((a, b) => a.start - b.start);
  if (!candidates.length) return [];
  // Tokens no destination the page already has could be mistaken for: absent from its text and
  // from what CommonMark reads (an entity can spell one).
  const original = linksIn(new Parser().parse(body));
  const prefix = markerPrefix(body, original.map((l) => l.dest), nonce);
  if (prefix === null) return [];
  const tokens = candidates.map((_, i) => `${prefix}${i}x`);
  const marked = applyEdits(body, candidates.map((c, i) => ({ start: c.start, end: c.start, insert: tokens[i]! })));

  // A token takes no text away, but it can make a link: the line under a bare label (`[d]:`
  // then `<div>`, or `---`) reads as its destination once a token starts it. So each link in
  // the tokened page must use up one of the page's own, the same but for the token (its
  // destination, kind, title and text); a candidate whose token makes one more is out.
  const own = new Map<string, number>();
  const key = (dest: string, rest: string) => `${dest}\0${rest}`;
  for (const l of original) own.set(key(l.dest, l.rest), (own.get(key(l.dest, l.rest)) ?? 0) + 1);
  const tokenAt = new RegExp(`^${prefix}(\\d+)x`);
  const anyToken = new RegExp(`${prefix}\\d+x`, "g");
  const seen = new Map<number, string>(); // candidate → the destination its token led
  const made = new Set<number>();
  for (const l of linksIn(new Parser().parse(marked))) {
    const m = tokenAt.exec(l.dest);
    const dest = m ? l.dest.slice(m[0].length) : l.dest;
    const k = key(dest, l.rest.replace(anyToken, ""));
    const left = own.get(k) ?? 0;
    if (left > 0) own.set(k, left - 1);
    if (!m) continue;
    const i = Number(m[1]);
    if (left === 0) made.add(i);
    seen.set(i, dest);
  }
  const spans = candidates.flatMap((c, i) => {
    const dest = readDestination(c.raw, c.angle);
    return seen.get(i) === dest && !made.has(i) ? [{ ...c, dest }] : [];
  });
  return nonOverlapping(spans);
}

type Candidate = { raw: string; start: number; end: number; angle: boolean };

const randomNonce = () => `dw${randomBytes(8).toString("hex")}m`;

/** A random marker prefix the page holds nowhere, in its text or its destinations; null after eight tries. */
function markerPrefix(body: string, already: string[], nonce: () => string): string | null {
  for (let tries = 0; tries < 8; tries++) {
    const prefix = nonce();
    if (!body.includes(prefix) && !already.some((d) => d.includes(prefix))) return prefix;
  }
  return null; // with 64 random bits a try, only a page built against a fixed nonce gets here
}

// Nested parentheses a destination may hold. CommonMark lets an implementation set a limit (at
// least 3); commonmark.js sets none, but without one each `](` on a run of them scanned on through
// every later `(`: 64 KB of `](` took 1.7 s. A deeper real destination is only unlocated, and
// lint judges it.
const MAX_PARENS = 32;

/** A destination at `at` (whitespace before it skipped), read as CommonMark reads one. */
function scanDestination(body: string, at: number): Candidate | null {
  let i = at;
  while (body[i] === " " || body[i] === "\t") i++;
  if (body[i] === "\r" && body[i + 1] === "\n") i++;
  if (body[i] === "\n") {
    i++;
    while (body[i] === " " || body[i] === "\t") i++;
  }
  if (body[i] === "<") {
    let j = i + 1;
    while (j < body.length && body[j] !== ">" && body[j] !== "\n" && body[j] !== "<") j += body[j] === "\\" ? 2 : 1;
    return body[j] === ">" ? { raw: body.slice(i + 1, j), start: i + 1, end: j, angle: true } : null;
  }
  let depth = 0;
  let j = i;
  for (; j < body.length; j++) {
    const c = body[j]!;
    if (c === "\\" && j + 1 < body.length) {
      j++;
      continue;
    }
    if (c <= " " || c === "\x7f") break;
    if (c === "(" && ++depth > MAX_PARENS) return null;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  return j > i && depth === 0 ? { raw: body.slice(i, j), start: i, end: j, angle: false } : null;
}

function inlineCandidates(body: string): Candidate[] {
  const out: Candidate[] = [];
  for (let i = body.indexOf("]("); i >= 0; i = body.indexOf("](", i + 2)) {
    const c = scanDestination(body, i + 2);
    if (c) out.push(c);
  }
  return out;
}

// A definition's label and colon, after any container markers: `>`, list items' bullets and
// numbers, and indentation.
const DEFINITION = /^(?:[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t])))*[ \t]*\[(?:[^\]\\\n]|\\.){1,999}\]:/gm;

function definitionCandidates(body: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of body.matchAll(DEFINITION)) {
    const c = scanDestination(body, m.index + m[0].length);
    if (c) out.push(c);
  }
  return out;
}

function nonOverlapping<C extends Candidate>(cs: C[]): C[] {
  const sorted = [...cs].sort((a, b) => a.start - b.start);
  const out: C[] = [];
  for (const c of sorted) if (!out.length || c.start >= out[out.length - 1]!.end) out.push(c);
  return out;
}

/** A destination as written, read by CommonMark: escapes and entities applied, encoded. */
export function readDestination(raw: string, angle: boolean): string {
  const link = new Parser().parse(`[x](${angle ? `<${raw}>` : raw})`).firstChild?.firstChild;
  return link?.type === "link" ? (link.destination ?? raw) : raw;
}

/** A destination that leaves the page's files: a scheme, `//`, or an in-page `#`. */
export const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** A destination's path: no query or fragment, still percent-encoded (`resolveLink` decodes it once). */
export function linkPath(dest: string): string {
  return dest.split(/[?#]/)[0]!;
}

/** A path from `linkPath`, decoded: to show, and to match against file names. */
export function shownPath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

export type LinkFault = "missing" | "directory" | "extensionless" | "route";

/**
 * How lint judges a link's path (from `linkPath`) on the page at `fromPath`: `missing` when it
 * resolves to nothing in the repo; under the knowledge root, `directory` or `extensionless`
 * when it names no page or attachment (R8b), since redaction couldn't tell which page it
 * means; otherwise null.
 */
export function linkFault(
  repoRoot: string,
  knowledgeRoot: string,
  fromPath: string,
  path: string,
  opts: {
    /** The pages a slug or an id puts at a route (`siteRoute`), by route. */
    aliases?: (route: string) => string[];
    /** Directories a docs site serves at its root (config `static_dirs`). */
    staticDirs?: readonly string[];
  } = {},
): { target: string; fault: LinkFault | null; underRoot: boolean; pages?: string[] } {
  const aliases = opts.aliases ?? (() => []);
  const target = resolveLink(fromPath, path);
  const abs = join(repoRoot, target);
  const rootDir = posix.normalize(knowledgeRoot).replace(/\/+$/, "");
  const underRoot = target === rootDir || target.startsWith(`${rootDir}/`);
  if (target.startsWith("..") || !existsSync(abs)) {
    // A root-relative attachment (`/img/x.png`) a docs site serves from a static directory. A page
    // isn't one: pages are under the knowledge root.
    const served = path.startsWith("/") && isAttachment(target) && (opts.staticDirs ?? []).some((d) => servedFrom(repoRoot, d, target));
    return { target, fault: served ? null : "missing", underRoot };
  }
  if (!underRoot) {
    // A root-relative route that names a directory or an extensionless file of the repo's, and,
    // read from the knowledge root as a docs site serves it, a page: redaction can't tell which.
    if (path.startsWith("/") && (statSync(abs).isDirectory() || posix.extname(target).length <= 1)) {
      const routes = [target, ...(target === "docs" || target.startsWith("docs/") ? [target.slice("docs/".length)] : [])];
      const pages = [...new Set([...routePages(repoRoot, rootDir, target), ...routes.flatMap(aliases)])].sort();
      if (pages.length) return { target, fault: "route", underRoot, pages };
    }
    return { target, fault: null, underRoot };
  }
  // A directory first: one can be named `guide.md`.
  if (statSync(abs).isDirectory()) return { target, fault: "directory", underRoot };
  // `notes.` has no extension: extname gives a bare dot.
  return { target, fault: target.endsWith(".md") || posix.extname(target).length > 1 ? null : "extensionless", underRoot };
}

/**
 * The page files under the knowledge root a root-relative route names on a docs site, with or
 * without a leading `docs/`: each segment a directory or, last, a page, by its name or without
 * its number prefix (`02-ops` is `ops`); a directory serves its category index. Lint fails a
 * route this finds that also names a file of the repo's, and adopt lists one only a number prefix
 * reaches. Dot-directories are skipped, as the loader skips them.
 */
export function routePages(repoRoot: string, rootDir: string, route: string): string[] {
  const named = (name: string, seg: string) => name === seg || unprefixed(name) === seg;
  const list = (dir: string) => {
    try {
      return readdirSync(join(repoRoot, dir), { withFileTypes: true }).filter((e) => !e.name.startsWith(".") || e.isFile());
    } catch {
      return [];
    }
  };
  const out = new Set<string>();
  const routes = [route, ...(route === "docs" || route.startsWith("docs/") ? [route.slice("docs".length)] : [])];
  for (const r of routes) {
    const segs = r.split("/").filter(Boolean);
    let dirs = [rootDir];
    segs.forEach((seg, i) => {
      const next: string[] = [];
      for (const d of dirs)
        for (const e of list(d)) {
          if (e.isDirectory() && named(e.name, seg)) next.push(posix.join(d, e.name));
          if (i === segs.length - 1 && e.isFile() && e.name.endsWith(".md") && named(e.name.slice(0, -3), seg)) out.add(posix.join(d, e.name));
        }
      dirs = next;
    });
    for (const d of dirs)
      for (const e of list(d)) if (e.isFile() && e.name.endsWith(".md") && isCategoryIndex(e.name.slice(0, -3), d === rootDir ? undefined : posix.basename(d))) out.add(posix.join(d, e.name));
  }
  return [...out].sort();
}

// Docusaurus's default number-prefix parser (plugin-content-docs, numberPrefix.ts): `01-intro`
// is `intro`, while a date's or version's digits (`2021-01-01-notes`, `1.0-x`) stay.
const IGNORED_PREFIX = /^\d+[-_.]\d+/;
const NUMBER_PREFIX = /^\d+\s*[-_.]+\s*([^-_.\s].*)$/;

/** A file or directory name as Docusaurus routes it: its number prefix removed. */
export function unprefixed(name: string): string {
  if (IGNORED_PREFIX.test(name)) return name;
  return NUMBER_PREFIX.exec(name)?.[1] ?? name;
}

/** Docusaurus's category index: `index`, `README`, or a file named after its directory. */
export function isCategoryIndex(stem: string, dir: string | undefined): boolean {
  // By the names as written, as Docusaurus compares them: `04-other/other.md` isn't one (a
  // real build served it at `…/other/other`, 2026-11-13).
  return ["index", "readme", dir?.toLowerCase()].includes(stem.toLowerCase());
}

/**
 * Where a page's file puts it on a Docusaurus site, as a route without a leading slash: its
 * path under the knowledge root without number prefixes, a category index at its directory.
 */
export function fileRoute(under: string): string {
  const parts = under.split("/");
  const stem = parts.pop()!.replace(/\.md$/, "");
  const index = isCategoryIndex(stem, parts.at(-1));
  return posix.join(...parts.map(unprefixed), index ? "" : unprefixed(stem)).replace(/^\.$/, "");
}

/** The one route a docs site serves a page at: its `siteRoute`, else its `fileRoute`. */
export function pageRoute(under: string, slug: unknown, id: unknown): string {
  return siteRoute(under, slug, id) ?? fileRoute(under);
}

/**
 * Where a page's own `slug`, or an `id` other than its file name, puts it on a Docusaurus site,
 * as a route without a leading slash; null when that's where its file is. `under` is its path
 * under the knowledge root. (A category index routes by its directory whatever its id.)
 */
export function siteRoute(under: string, slug: unknown, id: unknown): string | null {
  const parts = under.split("/");
  const stem = parts.pop()!.replace(/\.md$/, "");
  const dirs = parts.map(unprefixed);
  const index = isCategoryIndex(stem, parts.at(-1));
  const file = fileRoute(under);
  let route: string;
  if (typeof slug === "string") route = slug.startsWith("/") ? slug : posix.join(...dirs, slug);
  else if (typeof id === "string" && !index && id !== unprefixed(stem)) route = posix.join(...dirs, id);
  else return null;
  route = posix.normalize(route).replace(/^\/+|\/+$/g, "").replace(/^\.$/, "");
  return route === file ? null : route;
}

/**
 * Whether `target` is a file inside static directory `dir`, by real path: a path that climbs out
 * (`/../../package.json`), a link in it that leads out, or a directory that is itself a link out
 * of the repo, is nothing the site serves there.
 */
export function servedFrom(repoRoot: string, dir: string, target: string): boolean {
  // A path that climbs (`/../static/a.png`, or `/x/../../static/a.png` once normalized) names what
  // a browser would make of it, at the site's root: never this file, even when climbing out and
  // back in lands on it.
  const path = posix.normalize(target);
  if (path === ".." || path.startsWith("../")) return false;
  try {
    const repo = realpathSync(repoRoot);
    const base = realpathSync(join(repoRoot, dir));
    const file = realpathSync(join(base, path));
    return base.startsWith(`${repo}${sep}`) && file.startsWith(`${base}${sep}`) && statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A path a static directory can serve: a file with an extension, never a page (`.md`), which lives under the knowledge root. */
export function isAttachment(path: string): boolean {
  return !path.endsWith(".md") && posix.extname(path).length > 1;
}
