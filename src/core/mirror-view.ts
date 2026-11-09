import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { stateDir } from "./audit-log.js";
import { splitFrontmatter } from "./frontmatter.js";
import { linesWhere, replaceLines } from "./references.js";

// Reading the mirror cache (v0.2 L2). The connectors that write it are Docsworth pro's;
// reading it is core, so the MCP server can serve mirrored pages as
// context without the proprietary tier. A file counts as mirror output only while a
// record in this user's state directory (outside the repo, so a checkout can't forge
// it) says one of their runs wrote it, with exactly this content.

/** Every source a mirror run writes, one directory each under mirror.out_dir. */
export const MIRROR_SOURCES = ["confluence", "notion"] as const;
export type MirrorSource = (typeof MIRROR_SOURCES)[number];

/** One page read from a source wiki, already converted to markdown. */
export interface MirrorPage {
  /** Stable mirror id: `mirror:<source>:<space>:<native id>`. */
  id: string;
  source: MirrorSource;
  native_id: string;
  space: string;
  title: string;
  url: string;
  markdown: string;
  created: string;
  last_edited: string;
  /** Total versions when the source exposes it (Confluence); null otherwise (Notion). */
  versions: number | null;
  /** Team named by a `team-<slug>`/`owner-<slug>` label or Owner/Team property. */
  owner_team: string | null;
  labels: string[];
  acl: string;
  /** Titles or native ids of pages this page links to, for inbound-link counts. */
  links_to: string[];
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** The directory's canonical path, so /var/… and /private/var/… (macOS) name one record. */
export const canonicalDir = (dir: string) => (existsSync(dir) ? realpathSync(dir) : resolve(dir));

/** Where the record of a space's mirror output lives, in this user's state directory. */
export function mirrorRecordPath(repoRoot: string, spaceDir: string): string {
  return join(stateDir(repoRoot), "mirror", `${sha256(canonicalDir(spaceDir)).slice(0, 24)}.json`);
}

/** name → sha256 of what the run wrote, or null when no run of this user's wrote there. */
export function readOwned(repoRoot: string, spaceDir: string): Map<string, string> | null {
  const p = mirrorRecordPath(repoRoot, spaceDir);
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, "utf8")) as { dir?: unknown; files?: Record<string, unknown> };
    if (r.dir !== canonicalDir(spaceDir) || !r.files || typeof r.files !== "object") return null;
    return new Map(Object.entries(r.files).filter((e): e is [string, string] => typeof e[1] === "string" && /^[a-z0-9_][a-z0-9._-]*$/i.test(e[0]) && !/^\.\.?$/.test(e[0])));
  } catch {
    return null;
  }
}

/** existsSync follows symlinks; a dangling one still has to be seen. */
export function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The files in a space that one of this user's mirror runs wrote and that still hold
 * exactly what it wrote. The record lives in the user's state directory (ownership.ts),
 * so nothing a checkout contains can make a file count as mirror output.
 */
export function ownedFiles(repoRoot: string, spaceDir: string): string[] {
  const owned = readOwned(repoRoot, spaceDir);
  if (!owned) return [];
  return [...owned]
    .filter(([name, hash]) => {
      const p = join(spaceDir, name);
      if (!lstatExists(p)) return false;
      const st = lstatSync(p);
      return st.isFile() && sha256(readFileSync(p)) === hash;
    })
    .map(([name]) => name);
}

/** The owned files of every space under out_dir (see ownedFiles). */
/** Every space directory under out_dir: real directories only, never through a symlink. */
function spaceDirs(outDir: string): string[] {
  if (!lstatExists(outDir) || lstatSync(outDir).isSymbolicLink()) return [];
  const out: string[] = [];
  for (const source of MIRROR_SOURCES) {
    const sdir = join(outDir, source);
    if (!lstatExists(sdir) || lstatSync(sdir).isSymbolicLink() || !lstatSync(sdir).isDirectory()) continue;
    for (const space of readdirSync(sdir)) {
      const dir = join(sdir, space);
      const st = lstatSync(dir);
      if (!st.isSymbolicLink() && st.isDirectory()) out.push(dir);
    }
  }
  return out;
}

export function ownedSpaceFiles(outDir: string, repoRoot: string): { dir: string; files: string[] }[] {
  return spaceDirs(outDir).map((dir) => ({ dir, files: ownedFiles(repoRoot, dir) }));
}

/** Every mirrored page this user's runs wrote and that's unchanged since (never a planted file). */
/** Where each loaded page came from, and what that file held when it was read. */
const SOURCES = new WeakMap<MirrorPage, { file: string; sha: string }>();

export function loadMirror(outDir: string, repoRoot: string): MirrorPage[] {
  const out: MirrorPage[] = [];
  for (const dir of spaceDirs(outDir)) {
    const owned = readOwned(repoRoot, dir);
    if (!owned) continue;
    for (const [f, hash] of owned) {
      if (!f.endsWith(".md")) continue;
      // Read once, and check that same content: checking one read and parsing another
      // would let a file swapped in between pass as owned.
      const file = join(dir, f);
      let raw: Buffer;
      try {
        if (!lstatSync(file).isFile()) continue;
        raw = readFileSync(file);
      } catch {
        continue;
      }
      if (sha256(raw) !== hash) continue;
      const doc = splitFrontmatter(raw.toString("utf8"));
      const meta = doc.data?.mirror as Omit<MirrorPage, "markdown"> | undefined;
      if (!meta?.id) continue;
      const page = { ...meta, markdown: doc.body.trim() };
      SOURCES.set(page, { file, sha: hash });
      out.push(page);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Whether a loaded page's file still holds what it held when loaded: a server keeps
 * pages in memory, and an owned file edited or deleted since must stop being served.
 */
export function stillOwned(page: MirrorPage): boolean {
  const src = SOURCES.get(page);
  if (!src) return false;
  try {
    return lstatSync(src.file).isFile() && sha256(readFileSync(src.file)) === src.sha;
  } catch {
    return false;
  }
}

/**
 * The mirror the MCP server serves (`mirror.serve: true`): mirror.out_dir, which must
 * resolve inside the repo, read through the ownership records like every other reader.
 * Anything wrong yields an empty mirror and a warning, never a failed search.
 */
export function servedMirror(repoRoot: string, outDir: string, warn: (msg: string) => void = (m) => process.stderr.write(`docsworth: ${m}\n`)): MirrorPage[] {
  const root = canonicalDir(repoRoot);
  const dir = resolve(repoRoot, outDir);
  const real = canonicalDir(dir);
  const rel = relative(root, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    warn(`mirror.out_dir ${outDir} resolves outside the repository; serving no mirrored pages`);
    return [];
  }
  try {
    return loadMirror(dir, repoRoot);
  } catch (err) {
    warn(`couldn't read the mirror at ${outDir} (${(err as Error).message}); serving no mirrored pages`);
    return [];
  }
}

const normUrl = (u: string) => u.trim().replace(/^<|>$/g, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

const BARE_URL = /<?\bhttps?:\/\/[^\s<>\]"'`)]+>?/gi;
// A reference definition, its destination possibly on the next line, any title after.
// Quote markers then the label, with no two adjacent runs that could share the same
// spaces: `[ \t]*(?:>[ \t]?)*[ \t]*` backtracked between them (64 KB of spaces and
// tabs took 2.3 s).
const REF_DEF_LINE = /^[ \t]*(?:>[ \t]*)*\[((?:\\.|[^\[\]\\\n])+)\]:[ \t]*(?:\n[ \t>]*)?(<[^>\n]*>|\S+)[^\n]*(?:\n[ \t>]+["'(][^\n]*)?$/gm;

/** For every `]`, its matching `[` (escapes honoured, reset at a blank line). */
function bracketMatches(text: string): Map<number, number> {
  const match = new Map<number, number>();
  const open: number[] = [];
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === "\\") k++;
    else if (c === "[") open.push(k);
    else if (c === "]") {
      const start = open.pop();
      if (start !== undefined) match.set(k, start);
    } else if (c === "\n" && text[k + 1] === "\n") open.length = 0;
  }
  return match;
}

/**
 * Every markdown link (or image) whose destination `hidden` accepts, as a span from its
 * `[` (or `!`) to its closing `)`: found from each `](`, back to the matching bracket,
 * so link text with escaped or nested brackets is covered too.
 */
const DEST_REACH = 512;
function hiddenLinkSpans(text: string, hidden: (dest: string) => boolean): [number, number][] {
  const match = bracketMatches(text);
  const out: [number, number][] = [];
  for (let i = text.indexOf("]("); i >= 0; i = text.indexOf("](", i + 1)) {
    let j = i + 2;
    while (/[ \t]/.test(text[j] ?? "")) j++;
    let dest: string;
    // Unbounded, `(]` repeated made each `](` scan to the end of the text (9 s for 64 KB);
    // a destination now ends at a bracket too, and an angle one at `<`, so no scan passes
    // the next `](`. A title is read at most DEST_REACH characters.
    if (text[j] === "<") {
      // An angle destination can't hold `<` (CommonMark), so the scan stops at one.
      const m = /^<([^<>\n]*)>/.exec(text.slice(j, j + DEST_REACH));
      if (!m) continue;
      dest = m[1]!;
      j += m[0].length;
    } else {
      const from = j;
      let depth = 0;
      for (; j < text.length; j++) {
        const c = text.charCodeAt(j);
        // Whitespace ends a destination; so does a bracket here (rare in a real one, and
        // the id sweep after still reads it), so `(]` repeated can't make each scan long.
        if (c === 32 || (c >= 9 && c <= 13) || c === 91 || c === 93) break;
        if (c === 92) j++; // `\`
        else if (c === 40) depth++; // `(`
        else if (c === 41 && depth-- === 0) break; // `)`
      }
      dest = text.slice(from, j);
    }
    if (!hidden(dest)) continue;
    // Past a title ("t", 't' or (t), escapes honoured) to the link's `)`; without one,
    // the destination's end, so nothing after the link is swallowed.
    let k = j;
    while (/[ \t\n]/.test(text[k] ?? "")) k++;
    const opener = text[k];
    if (k > j && (opener === '"' || opener === "'" || opener === "(")) {
      const closer = opener === "(" ? ")" : opener;
      const limit = k + DEST_REACH;
      for (k++; k < text.length && k < limit && text[k] !== closer; k++) if (text[k] === "\\") k++;
      k++;
      while (/[ \t\n]/.test(text[k] ?? "")) k++;
    }
    const end = text[k] === ")" ? k + 1 : text[j] === ")" ? j + 1 : j;
    let start = match.get(i) ?? i;
    if (text[start - 1] === "!") start--;
    out.push([start, end]);
  }
  return out;
}

/**
 * A mirrored page's text with every link to a mirrored page the caller can't see
 * replaced by `placeholder`: markdown links and bare URLs pointing at it (compared
 * case-insensitively, without query or fragment), and the Confluence form (the
 * converter writes a page link as its title in emphasis; `links_to` names it by title
 * or native id).
 */
/**
 * The page a link names, whatever form it takes: a Confluence page by id (absolute,
 * relative, with or without its title slug, or `viewpage.action?pageId=`), a Notion
 * page by its 32-hex id, and anything else by its normalised URL.
 */
function pageKey(u: string): string {
  const confluence = /\/pages\/(\d+)(?:[/?#]|$)|[?&]pageId=(\d+)/i.exec(u);
  if (confluence) return `confluence:${confluence[1] ?? confluence[2]}`;
  // A Notion id anywhere: in a notion.so or notion.site URL, a relative link, or alone.
  const notion = /(?:^|[/=-])([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?:[/?#]|$)/i.exec(u);
  if (notion) return `notion:${notion[1]!.replace(/-/g, "").toLowerCase()}`;
  return normUrl(u);
}
const keyOf = (h: MirrorPage) => (h.source === "confluence" ? `confluence:${h.native_id}` : `notion:${h.native_id.replace(/-/g, "").toLowerCase()}`);
// A Confluence page path written out without a scheme: `/wiki/spaces/SEC/pages/900/…`.
// Or the old `viewpage.action?pageId=` form. And a Notion id written bare.
const RELATIVE_PAGE = /(?<![\w/])\/(?:wiki\/)?(?:spaces\/[^\s/)\]]+\/pages\/\d+|pages\/viewpage\.action\?pageId=\d+)[^\s)\]<>"'`]*/gi;
const BARE_NOTION_ID = /(?<![\w-])[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}(?![\w-])/gi;

/**
 * `text` with every link to one of `hidden` (mirrored pages the reader can't see)
 * replaced by `placeholder`. For a repo page as much as a mirrored one: a visible page
 * never shows a hidden one's link. `linksTo` adds the Confluence linked-title form.
 */
export function redactHiddenLinks(text: string, hidden: readonly MirrorPage[], placeholder: string, linksTo: readonly string[] = []): string {
  if (!hidden.length) return text;
  const keys = new Set([...hidden.map(keyOf), ...hidden.map((h) => pageKey(h.url))]);
  const isHidden = (u: string) => keys.has(pageKey(u.replace(/[.,;:!?]+$/, "")));
  // Reference-style links first: a definition pointing at a hidden page goes (title and
  // all), and so does every use of its label (`[text][label]`, `[label][]`, `[label]`).
  const labels = new Set<string>();
  let source = text.replace(REF_DEF_LINE, (whole, label: string, dest: string) => {
    if (!isHidden(dest.replace(/^<|>$/g, ""))) return whole;
    labels.add(label.trim().replace(/\s+/g, " ").toLowerCase());
    return "";
  });
  if (labels.size) {
    const named = (l: string) => labels.has(l.trim().replace(/\s+/g, " ").toLowerCase());
    source = source.replace(/\[((?:\\.|[^\[\]\\]|\[(?:\\.|[^\[\]\\])*\])*)\]\[((?:\\.|[^\[\]\\])*)\]/g, (whole, shown: string, l: string) => (named(l || shown) ? placeholder : whole));
    source = source.replace(/\[((?:\\.|[^\[\]\\])+)\](?![(\[:])/g, (whole, l: string) => (named(l) ? placeholder : whole));
  }
  let out = "";
  let at = 0;
  for (const [i, j] of hiddenLinkSpans(source, isHidden)) {
    if (i < at) continue;
    out += source.slice(at, i) + placeholder;
    at = j;
  }
  out += source.slice(at);
  const bare = (u: string) => {
    const tail = /[.,;:!?]*$/.exec(u)![0]; // sentence punctuation stays
    return isHidden(u) ? placeholder + tail : u;
  };
  out = out.replace(BARE_URL, bare).replace(RELATIVE_PAGE, bare).replace(BARE_NOTION_ID, bare);
  const linked = new Set(linksTo);
  for (const h of hidden)
    if (linked.has(h.title) || linked.has(h.native_id))
      for (const mark of ["_", "*"]) out = out.split(`${mark}${h.title}${mark}`).join(placeholder);
  // Then fail closed, as for repo pages: a line that still names a hidden page's id, in
  // any form a reader decodes (`&#47;`, `%2F`, `\`, a value broken across lines) or a
  // renderer shows (`/pages/**900**`), goes whole (references.ts).
  const confluence = new Set(hidden.filter((h) => h.source === "confluence").map((h) => h.native_id));
  const notion = new Set(hidden.filter((h) => h.source === "notion").map((h) => keyOf(h).slice("notion:".length)));
  return replaceLines(out, linesWhere(out, (view, cased) => idSpans(view, cased, confluence, notion)), placeholder);
}

/**
 * A Confluence page's tiny link id (`/wiki/x/<id>`, what "Copy link" gives): the page id
 * as little-endian bytes (four at least), base64 with `-` and `_`, padding and trailing
 * `A`s dropped. Checked against 25 live `_links.tinyui` values.
 */
export function tinyId(pageId: string): string {
  let n = BigInt(pageId);
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.push(Number(n & 0xffn));
  while (bytes.length < 4) bytes.push(0);
  return Buffer.from(bytes).toString("base64").replace(/\//g, "-").replace(/\+/g, "_").replace(/=+$/, "").replace(/A+$/, "");
}

/** Where a view (decoded; lower case, and `cased` as written) names one of these pages: by id, or a tiny link. */
function* idSpans(view: string, cased: string, confluence: Set<string>, notion: Set<string>): Iterable<[number, number]> {
  if (confluence.size) for (const m of view.matchAll(/(?:\/pages\/|pageid=)(\d+)(?!\d)/g)) if (confluence.has(m[1]!)) yield [m.index, m.index + m[0].length];
  // A tiny id is base64, so its case counts (`aQ` is page 105, `AQ` page 1): read as written.
  const tiny = new Set([...confluence].filter((id) => /^\d+$/.test(id)).map(tinyId));
  if (tiny.size) for (const m of cased.matchAll(/\/[xX]\/([A-Za-z0-9_-]+)/g)) if (tiny.has(m[1]!)) yield [m.index, m.index + m[0].length];
  if (notion.size)
    for (const m of view.matchAll(/(?<![0-9a-f])[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}(?![0-9a-f])/g))
      if (notion.has(m[0].replace(/-/g, ""))) yield [m.index, m.index + m[0].length];
}

export function redactMirror(page: MirrorPage, hidden: readonly MirrorPage[], placeholder: string): string {
  return redactHiddenLinks(page.markdown, hidden, placeholder, page.links_to);
}
