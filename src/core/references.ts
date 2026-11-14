import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { type Node, Parser } from "commonmark";
import { pageLinks, pageRoute } from "./links.js";
import type { Page, Repo } from "./repo.js";

/**
 * Where a text still names a page, read the way its readers read it. Link redaction
 * (`redactLinks` in acl.ts) runs a precise pass first; this is the sweep after it, and it
 * fails closed: any line that names a hidden page, in any form, is redacted whole.
 *
 * "Names" means a link destination, an HTML attribute, a URL or a path in text that
 * resolves to the page, after the decoding a reader applies:
 *
 * - backslash escapes, and character references (`&#47;`, `&sol;`; numeric ones without
 *   their `;` too, as HTML reads them in attributes)
 * - percent-encoding, all of it (`%2F` included)
 * - `\` as `/`, as browsers read a relative URL
 * - a line break or tab inside a value, which URL parsing drops, and the quote and list
 *   markers before a continuation line
 *
 * A destination always ends with the page's file name, so the sweep looks only where a
 * hidden page's file name ends. From there it reads every place the reference could
 * start, as CommonMark and HTML allow: after any character that can't be part of a path,
 * back to whitespace (a plain destination holds none), and after the nearest `<`, `"`
 * and `'` before that (angle destinations and quoted attributes may hold spaces). It
 * redacts when any of those names a hidden page, either by resolving from the page as a
 * link would, or, for a URL or a path that resolves nowhere, by ending in a hidden page's
 * repo path, or its path under the knowledge root (two segments or more). The longest
 * such tail decides, so a URL to a visible `team/runbooks/x.md` isn't taken for a hidden
 * `runbooks/x.md`.
 *
 * Paths are folded before they're compared (`fold`): case, Unicode composition and
 * non-ASCII runs. A visible page whose path differs from a hidden one only there is
 * redacted as if hidden.
 *
 * Linear: each file name ending is read back at most REACH characters (past that, the line
 * is redacted without resolving), and what a text repeats is resolved once (`Memo`).
 *
 * A link to a path under the knowledge root that is no page (one that didn't load, or no
 * file at all) has no name to look for, so a second pass reads every link destination,
 * in any form, and refuses it as the precise pass does (`destinationLines`).
 */

/**
 * Stands for a run of non-ASCII characters, with the ASCII letter or digit a combining
 * mark sits on: one SUB however the run is written (composed or not, an astral character,
 * or a character reference this doesn't decode, which may stand for several). A path runs
 * through it (`café.md`), and one may also start right after it (a curly quote or a
 * no-break space before a path).
 */
const SUB = "\u001a";
// A combining mark: part of the character before it (`e` and U+0301 are `é`).
const MARK = /^\p{M}$/u;
// What a combining mark joins: an ASCII letter or digit.
const BASE = /^[A-Za-z0-9]$/;

/** Appends a non-ASCII character to `out`, as `fold` reads it. */
function foldWide(out: string[], ch: string): void {
  const last = out.length - 1;
  if (last >= 0 && out[last] === SUB) return; // the run goes on
  if (MARK.test(ch) && last >= 0 && BASE.test(out[last]!)) out[last] = SUB;
  else out.push(SUB);
}

/**
 * A text as the sweep compares it: NFC, ASCII letters in lower case (so a path differing
 * only in case, which a case-insensitive file system opens, matches), and each run of
 * other characters as one SUB. So `café` matches whether it's composed, decomposed, or
 * encoded either way. Page paths and texts are both read through this, and a visible
 * page whose path differs from a hidden one only inside such a run is taken for it.
 */
// Inline markup a renderer removes, where it pairs as a renderer pairs it: emphasis,
// strikethrough, code and link text. `knowledge/team/**secret.md**` shows
// `knowledge/team/secret.md`; a lone `_` (`_secret.md`) shows as written, and so does
// `_` between letters or digits (`on_call`), which is never emphasis. Not escaped ones.
// Spans are bounded, so a line of unpaired markers stays linear.
// A code span may hold spaces at its edges (`` on` call.md` `` shows `on call.md`);
// CommonMark strips one from each end when both have one.
// Each marker run is matched whole (no marker before or after it), so a long run isn't
// retried at every shorter length: a line of 64 KB of backticks took 1.7 s that way.
const PAIRED = /(?<![\\`])(`+)(?!`)([^`\n]{1,256}?)(?<!`)\1(?!`)|(?<![\\*])(\*+)(?![*\s])([^\n]{0,256}?\S)\3(?!\*)|(?<![\\~])(~+)(?![~\s])([^\n]{0,256}?\S)\5(?!~)|(?<![\\\p{L}\p{N}_])(_+)(?![_\s])([^\n]{0,256}?\S)\7(?![\p{L}\p{N}_])|(?<!\\)\[([^[\]\n]{0,256})\]/gu;
const codeText = (c: string) => (/^ [\s\S]* $/.test(c) && /\S/.test(c) ? c.slice(1, -1) : c);
/** The text with paired markup gone, to a nesting of a few levels (`**_x_**`). */
function unmark(s: string): string {
  for (let i = 0; i < 4; i++) {
    const next = s.replace(PAIRED, (_m, _a, code?: string, _c?: string, star?: string, _e?: string, tilde?: string, _g?: string, under?: string, link?: string) =>
      code !== undefined ? codeText(code) : (star ?? tilde ?? under ?? link ?? ""),
    );
    if (next === s) break;
    s = next;
  }
  return s;
}
// Syntax that renders as nothing: inline tags, comments (`team/<!--x-->secret.md` shows
// `team/secret.md`), processing instructions and declarations, on one line; a link's
// `](destination "title")` or `][label]`, and an image's `!` (`[team/sec](x)ret.md`).
// Invisible format characters too: a soft hyphen or a zero-width space inside a path.
const INVISIBLE = /\p{Cf}/gu;
// What renders as nothing, read left to right as CommonMark reads it, so the leftmost
// wins: a `<!--` inside a tag's quoted value is part of the tag, and a `<![CDATA[` inside a
// comment part of the comment. First the openers of comments, processing instructions,
// CDATA and declarations (`unshown` finds where each ends); then a tag, whose quoted value
// may hold `<` or `>` (`<span title="a<b">`), and any other `<…>` that starts like one. Each
// attribute starts after whitespace with a name character, so the attribute list can't
// backtrack against the trailing space.
const UNSHOWN = /<!--|<\?|<!\[CDATA\[|<![A-Za-z]|<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/?[A-Za-z][^<>]*>|\]\((?:<[^<>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)|\]\[[^\]\n]*\]|!(?=\[)/g;
/**
 * `fold`, as rendered text: paired markup gone first (page paths are read the same way),
 * so a run of non-ASCII characters split by markup is one run.
 */
const foldRendered = (s: string) => fold(unmark(s.replace(INVISIBLE, "")));

/**
 * A line as it shows: what renders as nothing gone (a link's tail leaves its `]`, so the
 * text pairs), then paired markup. A comment, processing instruction, CDATA section or
 * declaration goes however long it is (merge gate, PR 13: one over a bound of 999 was
 * kept, and its spaces cut the path in two), and only where CommonMark reads one: one with
 * no end is text. Where it ends: CommonMark's end, or with `shortest`, a browser's, which
 * can be sooner (a comment at `--!>`, a processing instruction or CDATA, bogus comments in
 * HTML, at its first `>`), so the rest shows. Linear: each end is found by `indexOf`, and
 * reused while the scan hasn't passed it.
 */
function unshown(line: string, shortest = false): string {
  const l = line.replace(INVISIBLE, "");
  const found = new Map<string, [number, number]>();
  const find = (needle: string, from: number): number => {
    const seen = found.get(needle);
    if (seen && from >= seen[0] && (seen[1] < 0 || from <= seen[1])) return seen[1];
    const at = l.indexOf(needle, from);
    found.set(needle, [from, at]);
    return at;
  };
  let out = "";
  let at = 0;
  UNSHOWN.lastIndex = 0;
  for (let m; (m = UNSHOWN.exec(l)); ) {
    const i = m.index;
    let end = i + m[0].length;
    if (m[0].startsWith("<!") || m[0] === "<?") {
      end = spanEnd(m[0], i, find, shortest);
      if (end < 0) {
        UNSHOWN.lastIndex = i + 1; // CommonMark reads it as text
        continue;
      }
      UNSHOWN.lastIndex = end;
    }
    out += l.slice(at, i) + (m[0].startsWith("]") ? "]" : "");
    at = end;
  }
  return unmark(out + l.slice(at));
}

/** Where the span `open` starts at `i` ends (see `unshown`), or -1 if it has no end. */
function spanEnd(open: string, i: number, find: (needle: string, from: number) => number, shortest: boolean): number {
  // `<!-->` and `<!--->` are whole comments, so `-->` is looked for from the opener's `--`.
  const [close, from] = open === "<!--" ? ["-->", i + 2] : open === "<?" ? ["?>", i + 2] : open === "<![CDATA[" ? ["]]>", i + 9] : [">", i + 2];
  const j = find(close, from);
  if (j < 0 || !shortest || close === ">") return j < 0 ? -1 : j + close.length;
  if (open !== "<!--") return find(">", i + 2) + 1;
  const k = find("--!>", i + 4);
  return k >= 0 && k < j ? k + 4 : j + 3;
}

/** Could a browser end a span sooner than CommonMark does in `text`? Then the sweep reads both. */
const SHORTER = /<\?|<!\[CDATA\[|--!>/;

function fold(s: string, lower = true): string {
  if (/^[\x00-\x7f]*$/.test(s)) return lower ? s.toLowerCase() : s; // most lines: nothing else to do
  const out: string[] = [];
  for (const ch of s.normalize("NFC")) {
    if (ch <= "\x7f") out.push(lower ? ch.toLowerCase() : ch);
    else foldWide(out, ch);
  }
  return out.join("");
}

/**
 * HTML's named character references that hold an ASCII character: all 49 of them. Every
 * other name stands for non-ASCII characters only. test/references.test.ts checks this
 * table against the `entities` package.
 */
export const ASCII_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&", AMP: "&", apos: "'", ast: "*", midast: "*", bsol: "\\", colon: ":", comma: ",", commat: "@",
  DiacriticalGrave: "`", grave: "`", dollar: "$", equals: "=", excl: "!", fjlig: "fj", gt: ">", GT: ">",
  Hat: "^", lbrace: "{", lcub: "{", lbrack: "[", lsqb: "[", lowbar: "_", UnderBar: "_", lpar: "(",
  lt: "<", LT: "<", NewLine: "\n", num: "#", percnt: "%", period: ".", plus: "+", quest: "?",
  quot: '"', QUOT: '"', rbrace: "}", rcub: "}", rbrack: "]", rsqb: "]", rpar: ")", semi: ";",
  sol: "/", Tab: "\t", verbar: "|", vert: "|", VerticalLine: "|",
  bne: `=${SUB}`, nvgt: `>${SUB}`, nvlt: `<${SUB}`,
};

/**
 * HTML's named references to invisible format characters only (soft hyphen, zero-width
 * space and joiners, word joiner, bidi marks): all 17. The rendered view drops them.
 * test/references.test.ts checks this list against the `entities` package.
 */
export const INVISIBLE_REFERENCES: ReadonlySet<string> = new Set([
  "af", "ApplyFunction", "ic", "InvisibleComma", "InvisibleTimes", "it", "lrm", "NegativeMediumSpace", "NegativeThickSpace",
  "NegativeThinSpace", "NegativeVeryThinSpace", "NoBreak", "rlm", "shy", "ZeroWidthSpace", "zwj", "zwnj",
]);

/** A reference as HTML reads one in an attribute: numeric ones with or without `;`. */
const REFERENCE = /&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]{0,31});)/y;
const PUNCT = /[!-/:-@[-`{-~]/;
const HEX = /^[0-9a-fA-F]$/;
// Quote and list markers before a line's content.
const CONTAINER = /^(?:[ \t]*(?:>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)))*[ \t]*/;
// Characters a path runs through. Anything else may come right before one starts.
const PATH_CHAR = /[A-Za-z0-9._~%/\-\u001a]/;
// The same as a table, for the loops: the views hold only ASCII and SUB.
const PATH_CODE = new Uint8Array(128);
for (let c = 0; c < 128; c++) PATH_CODE[c] = PATH_CHAR.test(String.fromCharCode(c)) ? 1 : 0;
/** Where a path may start after this character: anything a path can't hold, and SUB. */
const startsAfter = (D: string, k: number) => {
  const c = D.charCodeAt(k);
  return c === 0x1a || !PATH_CODE[c];
};
/** Whether `v` holds, as written, a character no URL holds, between `i` and `j`. */
const writtenDelimiter = (v: View, i: number, j: number) => {
  for (let k = i; k < j; k++) if (v.raw(k) && " \t\n\r\f\v\"'<>[]`".includes(v.text[k]!)) return true;
  return false;
};
/** Whitespace as written (not decoded from something else): it ends a plain path. */
const writtenSpace = (v: View, k: number) => {
  const c = v.text.charCodeAt(k);
  return (c === 32 || (c >= 9 && c <= 13)) && v.raw(k);
};

/**
 * Whether a `..` in a candidate cancels a segment holding a delimiter: whitespace or one
 * of the characters markdown and HTML put before a destination (a quote, `<`, `(`, `]`,
 * `=`, `:`, a backtick...). A start too early leaves such segments in front
 * (`"../../x.md`, or from a quote two lines up, `>see</a>text \`zz/../../x.md`), and
 * cancelling them would resolve the rest too deep. Such a start is read second
 * (`namesHidden`): only when no other start resolves to a page, since a directory may
 * hold a delimiter of its own (`(draft)/../../x.md`, `../scratch folder/../x.md`).
 */
const DELIMITER = /[\s"'<>()[\]{}=:`*|]/;
function cancelsJunk(token: string): boolean {
  const kept: boolean[] = []; // per segment kept so far: does it hold a delimiter?
  for (const seg of token.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (kept.pop()) return true;
      continue;
    }
    kept.push(DELIMITER.test(seg));
  }
  return false;
}

const REACH = 512;
const WORDS_BACK = 2;

/** The pages `who` can't see, as a sweep reads names. Built once per repo and audience. */
export interface PageNames {
  /** The knowledge root, without a trailing slash. */
  root: string;
  /** Skeleton of each repo path → whether it's hidden (hidden wins a collision). */
  paths: Map<string, boolean>;
  /** The same for each path under the knowledge root, when it has two segments or more. */
  under: Map<string, boolean>;
  /** Skeletons of hidden pages' file names, by length. */
  names: Map<number, Set<string>>;
  /** For each such file name, the hidden pages' repo paths. */
  spelled: Map<string, string[]>;
  /** For each such file name, the hidden pages' paths under the root (two segments or more). */
  spelledUnder: Map<string, string[]>;
  /** The most segments in a repo path: a longer tail can't name one. */
  depth: number;
  /** The knowledge repo's URL prefixes on GitHub (`github.com/acme/knowledge/`), if it's there. */
  repoUrls: string[];
  /** Each page's one route on a docs site (`pageRoute`) → whether it's hidden (hidden wins a shared route). */
  routes: Map<string, boolean>;
  /** Hidden pages' paths under the root without `.md`: a link by a file's stem (`sec/1.0-release`). */
  stems: Set<string>;
  /** For each loaded page's repo path, the directories its URL reads a relative link from. */
  urlDirs: Map<string, string[]>;
  /** `site_url`'s host (port included), path prefix (no trailing slash), host name, and where that name starts a token's URL. */
  site?: { host: string; prefix: string; name: string; at: RegExp };
  /** Whether a repo path, as written (not folded), is a file or directory in the repo. */
  exists: (repoPath: string) => boolean;
  /** The same, folded as rendered text (`foldRendered`), for the rendered view. */
  rendered?: PageNames;
}

export function pageNames(repo: Repo, hidden: (page: Page) => boolean): PageNames {
  const exists = existsIn(repo.root);
  return { ...buildNames(repo, hidden, fold, exists), rendered: buildNames(repo, hidden, foldRendered, exists) };
}

/** `exists` for a repo at `root`, memoized: false for a path that leaves it. */
function existsIn(root: string): (repoPath: string) => boolean {
  const seen = new Map<string, boolean>();
  return (repoPath) => {
    const p = posix.normalize(repoPath);
    if (p === ".." || p.startsWith("../") || p.startsWith("/")) return false;
    return memoized(seen, p, () => existsSync(join(root, p)));
  };
}

/** The route a page's frontmatter gives it, from its path under the root. */
const routeOf = (under: string, page: { slug?: string; id?: string }) => pageRoute(under, page.slug, page.id);

function buildNames(repo: Repo, hidden: (page: Page) => boolean, fold: (s: string) => string, exists: (repoPath: string) => boolean): PageNames {
  const root = fold(repo.config.knowledge_root.replace(/\/+$/, ""));
  const paths = new Map<string, boolean>();
  const under = new Map<string, boolean>();
  const names = new Map<number, Set<string>>();
  const spelled = new Map<string, string[]>();
  const spelledUnder = new Map<string, string[]>();
  const routes = new Map<string, boolean>();
  const stems = new Set<string>();
  const urlDirs = new Map<string, string[]>();
  let depth = 0;
  // Pages that didn't load count as hidden: their ACL can't be read.
  const all: [string, boolean, { slug?: string; id?: string }][] = [
    ...repo.pages.map((p): [string, boolean, Page] => [p.path, hidden(p), p]),
    ...repo.invalid.map((p): [string, boolean, { slug?: string; id?: string }] => [p.path, true, p]),
  ];
  const rawRoot = repo.config.knowledge_root.replace(/\/+$/, "");
  for (const [path, isHidden, page] of all) {
    const key = fold(path);
    if (path.startsWith(`${rawRoot}/`)) {
      // As a docs site serves it: its one route, and a relative link read from its URL,
      // with and without a trailing slash (a site may serve either).
      const route = fold(routeOf(path.slice(rawRoot.length + 1), page));
      routes.set(route, (routes.get(route) ?? false) || isHidden);
      if (isHidden) stems.add(fold(path.slice(rawRoot.length + 1).replace(/\.md$/, "")));
      urlDirs.set(key, [posix.dirname(route).replace(/^\.$/, ""), route]);
    }
    paths.set(key, (paths.get(key) ?? false) || isHidden);
    const rel = key.startsWith(`${root}/`) ? key.slice(root.length + 1) : key;
    if (rel.includes("/")) under.set(rel, (under.get(rel) ?? false) || isHidden);
    depth = Math.max(depth, key.split("/").length);
    if (!isHidden) continue;
    const name = posix.basename(key);
    if (!names.has(name.length)) names.set(name.length, new Set());
    names.get(name.length)!.add(name);
    if (!spelled.has(name)) spelled.set(name, []);
    spelled.get(name)!.push(key);
    if (!spelledUnder.has(name)) spelledUnder.set(name, []);
    if (rel !== key && rel.includes("/")) spelledUnder.get(name)!.push(rel);
  }
  return { root, paths, under, names, spelled, spelledUnder, depth, repoUrls: repoUrls(repo), routes, stems, urlDirs, site: siteOf(repo), exists };
}

/** `site_url`'s host (with any port) and its path prefix without a trailing slash. */
function siteOf(repo: Repo): PageNames["site"] {
  const at = repo.config.site_url ? webParse(repo.config.site_url) : undefined;
  // Where a host can start: not inside another (`www.docs.example.com`).
  // Every regex metacharacter escaped (code review, round 7: an IPv6 host's brackets).
  const name = at?.hostname.replace(/\.$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return at && { host: hostOf(at), prefix: fold(decodedPath(at)).replace(/\/+$/, ""), name: at.hostname.replace(/\.$/, ""), at: new RegExp(`(?<![a-z0-9.-])${name}`, "gi") };
}

/**
 * The host a URL names, with its port unless it's the scheme's default (the URL parser drops
 * that), a trailing dot cut. Not the scheme: `http://` to the site's host shows the same
 * route, so it's the site too. But `www.` and another port are other services (review,
 * round 4), so they stay.
 */
const hostOf = (at: URL) => `${at.hostname.replace(/\.$/, "")}${at.port ? `:${at.port}` : ""}`;

/**
 * The route a URL names on the docs site (`site_url`), as `/route` (folded); undefined for a
 * URL elsewhere. The prefix matches at a segment boundary: `/docs` isn't `/docs-archive`.
 */
function siteRouteOf(url: string, names: PageNames): string | undefined {
  if (!names.site) return undefined;
  const at = webParse(url);
  if (!at || hostOf(at) !== names.site.host) return undefined;
  const path = fold(decodedPath(at));
  const p = names.site.prefix;
  if (path !== p && !path.startsWith(`${p}/`)) return undefined;
  return path.slice(p.length) || "/";
}

/**
 * Whether URLs that may be one link (a URL read several ways: whole, its trailing
 * punctuation cut, cut at a parenthesis) name a hidden page on the docs site, or a route
 * there that names nothing: readings combine as `routeVerdict`'s do.
 */
function siteUrlHides(urls: string[], names: PageNames, failClosed = true): boolean {
  const routes = urls.map((u) => siteRouteOf(u, names)).filter((r): r is string => r !== undefined);
  if (!routes.length) return false;
  // The prefix says where the site is, so no `docs/` reading: a route as it stands.
  const verdict = routeVerdict(routes.map(clean), names);
  return verdict ?? (failClosed && routes.some(routeShaped));
}

/** A path clamped at the root (`..` past it stays there, as a browser reads it), without its outer slashes. */
const clean = (p: string) => posix.normalize(`/${p}`).replace(/^\/+|\/+$/g, "");

/**
 * Where a docs site serves a link written on page `from` (folded): a root-relative one as its
 * route, with and without a leading `docs/`; a relative one from the page's URL (`urlDirs`).
 */
function routeReadings(path: string, from: string, names: PageNames): string[] {
  // Each resolved, then any `%2F` left decoded (`slashes`), then read.
  if (path.startsWith("/")) {
    const r = clean(slashes(clean(path)));
    return r === "docs" || r.startsWith("docs/") ? [r, clean(r.slice("docs".length))] : [r];
  }
  return (names.urlDirs.get(from) ?? []).map((d) => clean(slashes(clean(posix.join(d, path)))));
}

/**
 * What route readings name. A hidden page's route by any reading: true. Else a visible
 * page's by any: false, kept. Else a hidden page's file stem, by those readings or `more`
 * (the path in the repo, under the root): true. Else undefined: nothing.
 */
function routeVerdict(readings: string[], names: PageNames, more: string[] = []): boolean | undefined {
  let visible = false;
  for (const r of readings) {
    const hidden = names.routes.get(r);
    if (hidden) return true;
    if (hidden === false) visible = true;
  }
  if (visible) return false;
  return readings.some((r) => names.stems.has(r)) || more.some((r) => names.stems.has(r)) ? true : undefined;
}

/** A link a site serves as a page, not a file: no extension (a lone trailing `.` is none), or a trailing `/`. */
const routeShaped = (path: string) => path.endsWith("/") || posix.extname(path).length <= 1;

/** The knowledge repo's web and raw URL prefixes, when `github.repo` says where it is. */
function repoUrls(repo: Repo): string[] {
  const name = repo.config.github.repo?.toLowerCase();
  if (!name) return [];
  const api = repo.config.github.api_url;
  // The host name alone: a URL's port is read past (`hostAndPath`), so this one is too.
  const host = api ? new URL(api).hostname.toLowerCase() : "github.com";
  if (host === "github.com" || host === "api.github.com") return [`github.com/${name}/`, `raw.githubusercontent.com/${name}/`];
  return [`${host}/${name}/`, `${host}/raw/${name}/`]; // GitHub Enterprise Server
}

interface View {
  text: string;
  /** The same text before lower case, at the same offsets: for names that keep case. */
  cased: string;
  /** The source line of the character at an offset. */
  lineOf: (k: number) => number;
  /** Whether the character at an offset stands as written (not decoded from something else). */
  raw: (k: number) => boolean;
}

/** Decoded characters, each with its source line and whether it stands as written. */
type Chars = { c: string[]; line: number[]; raw: boolean[] };
const chars = (): Chars => ({ c: [], line: [], raw: [] });
const put = (into: Chars, s: string, at: number, asWritten: boolean) => {
  for (const c of s) {
    into.c.push(c);
    into.line.push(at);
    into.raw.push(asWritten);
  }
};
/** A non-ASCII character (or an undecoded reference), as `fold` reads it, on line `at`. */
// Across lines too: the joined view reads a value broken mid-character as one.
const putWide = (into: Chars, ch: string, at: number) => {
  const last = into.c.length - 1;
  if (last >= 0 && into.c[last] === SUB) return; // the run goes on
  if (MARK.test(ch) && last >= 0 && BASE.test(into.c[last]!)) {
    into.c[last] = SUB;
    into.raw[last] = false;
  } else put(into, SUB, at, false);
};
/** A decoded reference: ASCII as is, SUB (a non-ASCII part) through `putWide`. */
// A `\` decoded from a reference (`&bsol;`, `&#92;`) is a `/` to a browser too.
const putDecoded = (into: Chars, s: string, at: number) => {
  for (const c of s) if (c === SUB) putWide(into, "\u00e9", at); else put(into, c === "\\" ? "/" : c, at, false);
};

/**
 * Character references decoded, as HTML reads them, and with `escapes` backslash escapes
 * too, as CommonMark reads them outside raw HTML. Non-ASCII characters (and references to
 * them) become SUB. Any other `\` is a `/`, as a browser reads it in a relative URL: in
 * raw HTML, `..\..\x.md` is `../../x.md`, where CommonMark reads `\.` as an escaped `.`.
 */
function unescapeInto(l: string, at: number, into: Chars, escapes: boolean, rendered = false): void {
  for (let i = 0; i < l.length; ) {
    const c = l[i]!;
    if (c === "\\") {
      const next = l[i + 1];
      if (escapes && next !== undefined && PUNCT.test(next) && next !== "\\") {
        put(into, next, at, false);
        i += 2;
      } else {
        put(into, "/", at, false);
        i += escapes && next === "\\" ? 2 : 1;
      }
      continue;
    }
    if (c === "&") {
      REFERENCE.lastIndex = i;
      const m = REFERENCE.exec(l);
      if (m) {
        const code = m[1] !== undefined ? Number(m[1]) : m[2] !== undefined ? Number.parseInt(m[2], 16) : undefined;
        // Rendered, a reference to an invisible character shows nothing.
        if (rendered && (code === undefined ? INVISIBLE_REFERENCES.has(m[3]!) : code <= 0x10ffff && /^\p{Cf}$/u.test(String.fromCodePoint(code)))) {
          i = REFERENCE.lastIndex;
          continue;
        }
        if (code === undefined) putDecoded(into, ASCII_REFERENCES[m[3]!] ?? SUB, at);
        else if (code > 0 && code < 0x80) putDecoded(into, String.fromCharCode(code), at);
        else putWide(into, code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd", at);
        i = REFERENCE.lastIndex;
        continue;
      }
    }
    if (c > "\x7f") {
      const ch = String.fromCodePoint(l.codePointAt(i)!);
      putWide(into, ch, at);
      i += ch.length;
      continue;
    }
    put(into, c, at, true);
    i++;
  }
}

/**
 * Percent-encoding, decoded after the references (`&#37;2F` is `%2F`, then `/`): all of
 * it, `%2F` included. A non-ASCII character's bytes become one SUB. With `dropBreaks`,
 * line breaks and tabs go, as URL parsing drops them from a value.
 */
function percentInto(written: Chars, into: Chars, dropBreaks: boolean): void {
  const keep = (c: string) => !dropBreaks || (c !== "\n" && c !== "\t" && c !== "\r");
  // A URL parser drops line breaks and tabs before it decodes: `%2`, a break, `E` is `.`.
  let from = written;
  if (dropBreaks && written.c.some((c) => !keep(c))) {
    from = chars();
    for (let k = 0; k < written.c.length; k++) if (keep(written.c[k]!)) put(from, written.c[k]!, written.line[k]!, written.raw[k]!);
  }
  for (let k = 0; k < from.c.length; ) {
    if (from.c[k] === "%" && HEX.test(from.c[k + 1] ?? "") && HEX.test(from.c[k + 2] ?? "")) {
      const byte = Number.parseInt(from.c[k + 1]! + from.c[k + 2]!, 16);
      const at = from.line[k]!;
      k += 3;
      if (byte < 0x80) {
        const c = byte === 0x5c ? "/" : String.fromCharCode(byte);
        if (keep(c)) put(into, c, at, false);
        continue;
      }
      // A UTF-8 sequence: its lead byte and the continuation bytes after it, as one
      // character (a stray continuation byte stands alone, as an invalid one).
      const bytes = [byte];
      while (byte >= 0xc0 && bytes.length < 4 && from.c[k] === "%" && /^[89ab]$/i.test(from.c[k + 1] ?? "") && HEX.test(from.c[k + 2] ?? "")) {
        bytes.push(Number.parseInt(from.c[k + 1]! + from.c[k + 2]!, 16));
        k += 3;
      }
      putWide(into, [...Buffer.from(bytes).toString("utf8")][0]!, at);
      continue;
    }
    if (keep(from.c[k]!)) put(into, from.c[k]!, from.line[k]!, from.raw[k]!);
    k++;
  }
}

/**
 * The text as a reader resolves it, with or without CommonMark's escapes, each line past
 * its container markers. As prose: a line break is a space (markdown renders a soft break
 * as one, so a path with spaces wrapped at one still reads whole). Or joined: line breaks
 * and tabs (written or decoded) are dropped, as URL parsing drops them from a value.
 */
function readerView(lines: string[], joined: boolean, escapes: boolean, rendered: Show | false = false, markers = false): View {
  const first = chars();
  lines.forEach((whole, at) => {
    const content = markers ? whole : whole.slice(CONTAINER.exec(whole)![0].length);
    unescapeInto((rendered ? rendered(content) : content).normalize("NFC"), at, first, escapes, !!rendered);
    if (!joined) put(first, " ", at, true);
  });
  const out = chars();
  percentInto(first, out, joined);
  // Lower case only changes ASCII letters here: offsets stay put.
  const cased = out.c.join("");
  return { text: cased.toLowerCase(), cased, lineOf: (k) => out.line[k]!, raw: (k) => out.raw[k]! };
}

/**
 * The same view for a text with nothing to decode (no `&`, `%` or `\`):
 * the text as written, non-ASCII as SUB, built in one pass. Most pages are like this.
 */
function plainView(lines: string[], joined: boolean, rendered: Show | false = false, markers = false): View {
  let parts = lines
    .map((l) => (markers ? l : l.slice(CONTAINER.exec(l)![0].length)))
    .map((l) => (rendered ? fold(rendered(l), false) : fold(joined ? l.replace(/[\t\r]/g, "") : l, false)));
  if (joined) {
    // A run of non-ASCII characters broken across lines is one run once they're joined.
    let lastSub = false;
    parts = parts.map((p) => {
      const q = lastSub && p.startsWith(SUB) ? p.slice(1) : p;
      if (q.length) lastSub = q.endsWith(SUB);
      return q;
    });
  }
  const starts: number[] = [];
  let at = 0;
  for (const p of parts) {
    starts.push(at);
    at += p.length + (joined ? 0 : 1);
  }
  const lineOf = (k: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= k) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // Lower case only changes ASCII letters here: offsets stay put.
  const cased = parts.join(joined ? "" : " ");
  return { text: cased.toLowerCase(), cased, lineOf, raw: () => true };
}
// Anything a reader might decode. Any `&` or `%`, not only a whole reference or `%XX`:
// joining lines can complete one (`index%2` then `emd` on the next line).
const ENCODED = /[&%\\]/;

/**
 * A link destination as the URL it becomes: references (and, in markdown, escapes)
 * decoded, query and fragment cut, then percent-decoded (non-ASCII as SUB).
 */
function readDestination(dest: string, html: boolean): string {
  const first = chars();
  unescapeInto(dest.normalize("NFC"), 0, first, !html);
  const cut = first.c.findIndex((c) => c === "?" || c === "#");
  if (cut >= 0) for (const a of [first.c, first.line, first.raw]) a.length = cut;
  const out = chars();
  percentInto(first, out, true);
  return out.c.join("").toLowerCase().trim();
}

/**
 * Whether a link destination, as written on page `from`, leads to a hidden page: one
 * that resolves to it, or a URL that ends with its path. A path under the knowledge root
 * that is no loaded page fails closed: a page that didn't load has no trustworthy ACL.
 * `html` for an attribute in raw HTML, where backslash escapes don't apply. `links`, the
 * text's CommonMark links (`linkPaths`): a route naming nothing fails closed only where it's
 * one of them (or an attribute's), not where only the liberal reading finds it (`[^1]: The
 * note`, `[term]: word`); a hidden page's route hides it wherever it stands.
 */
export function destinationHides(dest: string, from: string, names: PageNames, html = false, links?: ReadonlySet<string>): boolean {
  let d = dest.trim();
  if (!html && d.startsWith("<") && d.endsWith(">")) d = d.slice(1, -1);
  const path = readDestination(d, html);
  if (!path) return false;
  const fromKey = fold(from);
  // Where a browser goes, too: in markdown, CommonMark's reading (`x&#46md` is no reference
  // without its `;`, so its `#` starts a fragment and the link is to `x&`); in an attribute,
  // HTML's (`&#` then a line break is no reference either). The liberal reading (`x.md`)
  // still hides wherever it names a hidden page; a route naming nothing fails closed only by
  // the browser's reading of a link CommonMark parses (`links`), or of an attribute. And
  // only for routes: a `.md` the browser's reading finds no page (`..\x.md`, whose `\` a
  // renderer writes as `%5C`) is the liberal reading's to judge, as before.
  // (A markdown destination's `\` reaches the href as `%5C`, which a browser keeps.)
  const cm = commonmarkPath(html ? decodeText(d, false).replace(/\\/g, "/") : decodeText(d, true, true).replace(/\\/g, "%5C"));
  // Another reading where it differs (`/%2Fgithub.com/x` is a path, kept so: the liberal
  // reading's `//github.com/x` is a URL).
  const other = cm.folded && cm.folded !== path ? cm : undefined;
  const confirmed = (p: string) => html || !links || links.has(p);
  const byCommonMark = () =>
    !!other && (other.url ? urlHides(other.cased, fromKey, names, false, confirmed(other.folded)) : readingHides(other.folded, fromKey, names, confirmed(other.folded) ? repoPathOf(other.cased, from) : undefined, false));
  // `%2F` as written: a hidden page that way hides it; naming nothing doesn't.
  if (isUrlPath(path)) return urlHides(decodeText(d, !html), fromKey, names, html, confirmed(cm.folded), path) || byCommonMark();
  return readingHides(path, fromKey, names, !other && confirmed(path) ? writtenPath(d, html, from) : undefined) || byCommonMark();
}

const isUrlPath = (p: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(p);

/**
 * Whether a URL (decoded) names a hidden page: on the docs site, by its path's tail, or one
 * into the repo naming no page. `link` if it's a link (`destinationHides`'s `links`): then a
 * route on the docs site naming nothing fails closed too.
 */
function urlHides(url: string, fromKey: string, names: PageNames, html: boolean, link: boolean, path = readDestination(url, true)): boolean {
  return siteUrlHides([url], names, link) || namesHidden([path], fromKey, names) || namesNoPage(url, names, !html);
}

/**
 * Whether one reading of a destination (folded, not a URL) hides a page. `failClosed`, the
 * reading as written in the repo when it may fail closed: then a route naming nothing does,
 * unless it's a file or directory in the repo outside the knowledge root (`/src`), a link
 * to that, which hides no page. `liberal` for the liberal reading, which alone reads a `.md`
 * under the root that is no page, and a hidden page's path at the end of another, as hiding.
 */
function readingHides(path: string, fromKey: string, names: PageNames, failClosed?: string, liberal = true): boolean {
  // Resolved first, then any `%2F` left decoded (`commonmarkPath`).
  const resolved = slashes(path.startsWith("/") ? posix.normalize(path.slice(1)) : posix.normalize(posix.join(posix.dirname(fromKey), path)));
  const known = names.paths.get(resolved);
  if (known !== undefined) return known;
  const underRoot = resolved === names.root || resolved.startsWith(`${names.root}/`);
  if (liberal && underRoot && resolved.endsWith(".md")) return true;
  // As a docs site serves it (the owner's decision, 2026-11-13): a hidden page's route, or
  // its file's stem, hides it; a visible page's route keeps it.
  const route = routeVerdict(routeReadings(path, fromKey, names), names, underRoot ? [resolved.slice(names.root.length + 1)] : []);
  if (route || (liberal && namesHidden([path], fromKey, names))) return true;
  if (route === false || failClosed === undefined) return false;
  return routeShaped(slashes(path)) && (underRoot || !names.exists(slashes(failClosed)));
}

/**
 * A destination CommonMark has decoded (its references and escapes) as a path: cut at its
 * query or fragment, then percent-decoded. `folded` as the sweep compares paths, `cased` as
 * written in the repo. `url` if it's a URL, told before decoding, as a browser tells it:
 * `/%2Fgithub.com/x` is a path, not `//github.com/x`.
 */
function commonmarkPath(dest: string): { folded: string; cased: string; url: boolean } {
  const raw = dest.replace(/[\t\n\r]/g, "").trim();
  const url = isUrlPath(raw);
  // A browser resolves `..` before it decodes: `%2F` is no separator then (`zz%2F..` is one
  // segment, and `..` climbs out of it only), so it stays as written until the path is
  // resolved (`readingHides`); `%2e` is a dot to WHATWG URL, so it's decoded.
  const cased = (url ? raw : raw.split(/[?#]/)[0]!.split(/%2f/i).map(percentDecoded).join("%2F")).normalize("NFC").trim();
  return { folded: fold(cased).trim(), cased, url };
}

/**
 * A path a browser resolved with `%2F` kept, as a server reads it: decoded, then its dot
 * segments resolved again (`a/..%2Fb` is `b`). Unchanged where it holds no `%2F`.
 */
const slashes = (p: string) => (/%2f/i.test(p) ? posix.normalize(p.replace(/%2f/gi, "/")) : p);

const percentDecoded = (s: string) =>
  s.replace(/(?:%[0-9a-f]{2})+/gi, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq;
    }
  });

/** The paths of `text`'s links and images, as commonmark.js parses them (`commonmarkPath`). */
export function linkPaths(text: string): Set<string> {
  const out = new Set<string>();
  if (!text.includes("]") && !text.includes("<")) return out; // a link has a `]`, an autolink a `<`
  for (const dest of pageLinks(text)) {
    const { folded } = commonmarkPath(dest);
    if (folded) out.add(folded);
  }
  return out;
}

/** A destination as a repo path, with its case and characters as written (for `exists`). */
function writtenPath(d: string, html: boolean, from: string): string {
  let t = percentDecoded(decodeText(d, !html).replace(/[\t\n\r]/g, "").split(/[?#]/)[0]!);
  if (html) t = t.replace(/\\/g, "/"); // a browser reads `\` as `/` in raw HTML
  return repoPathOf(t.normalize("NFC").trim(), from);
}

const repoPathOf = (t: string, from: string) => (t.startsWith("/") ? posix.normalize(t.slice(1)) : posix.normalize(posix.join(posix.dirname(from), t)));

/**
 * The lines of `text` holding a link destination that `destinationHides` refuses, read
 * wherever a destination can stand, whatever surrounds it: after `](` (an inline link or
 * image, whatever its text), after `]:` (a definition in any container, its destination
 * on the next line or not), and in a tag's URL attributes, across lines. The name sweep
 * finds only pages that exist; this is how a path under the knowledge root that is no
 * page fails closed in every form, as it does in the common ones (merge gate, PR 13:
 * `[a [b] c](../security/not-loaded.md)` was kept).
 */
function destinationLines(text: string, from: string, names: PageNames, bases: string[] = [], links?: ReadonlySet<string>): Set<number> {
  const marked = new Set<number>();
  for (const d of destinations(text)) {
    // As written, and as a browser resolves it against each `<base href>` (merge gate, PR
    // 13: `<base href="../security/">` then `<a href="x.md">` is the hidden page's link).
    const hides = destinationHides(d.dest, from, names, d.html, links) || bases.some((b) => {
      const r = againstBase(b, d.dest, d.html, from);
      return r !== undefined && destinationHides(r, from, names, true);
    });
    if (hides) for (let l = d.lines[0]; l <= d.lines[1]; l++) marked.add(l);
  }
  return marked;
}

/** `marked`, and the lines holding a reference to a definition on a marked line: whatever took its line, it goes. */
function withLabels(text: string, marked: Set<number>, gone?: Set<string>): Set<number> {
  if ((!marked.size || !text.includes("]:")) && !gone?.size) return marked;
  // Any line it spans: its destination may stand on the line after its label.
  const spans = (d: Destination) => Array.from({ length: d.lines[1] - d.lines[0] + 1 }, (_, k) => d.lines[0] + k).some((l) => marked.has(l));
  const going = destinations(text).filter((d) => d.label !== undefined && spans(d));
  // A label goes when the definition CommonMark puts in effect for it goes (code review,
  // round 9): with the going lines replaced, as they will be, its definition changes or is
  // gone. Not for a `]:` inside a paragraph, which defines nothing, nor for a later
  // definition of a label in effect elsewhere. Where commonmark.js doesn't say, every one.
  let labels = going.map((d) => d.label!);
  if (labels.length) {
    const before = definitionsIn(text);
    const lines = new Set<number>();
    for (const d of going) for (let l = d.lines[0]; l <= d.lines[1]; l++) lines.add(l);
    const after = before && definitionsIn(replaceLines(text, lines, "[restricted page]"));
    if (before && after) {
      labels = labels.filter((label) => {
        const was = before.get(normalLabel(label));
        return was !== undefined && after.get(normalLabel(label)) !== was;
      });
    }
  }
  // Its references go, and those of the labels the first pass took the definitions of
  // (`gone`). Every other definition of the label goes with them (`labelLines`), so none
  // takes effect in a later pass.
  for (const l of labelLines(text, [...labels, ...(gone ?? [])])) marked.add(l);
  return marked;
}

/**
 * CommonMark's link definitions in `text`, the first for each label (keyed as `normalLabel`
 * keys a label) → its destination; undefined where commonmark.js doesn't say.
 */
export function definitionsIn(text: string): Map<string, string> | undefined {
  if (!text.includes("]:")) return new Map();
  const parser = new Parser();
  parser.parse(text);
  const refmap = (parser as unknown as { refmap?: Record<string, { destination?: string }> }).refmap;
  if (!refmap || typeof refmap !== "object") return undefined;
  return new Map(Object.entries(refmap).map(([label, d]) => [label, d.destination ?? ""]));
}

/**
 * The lines of `text` holding a reference to one of `labels` (definitions that go): left, a
 * reference shows its label as text, in whatever container (code review, round 1: `> [HSM]`
 * over `> [HSM]: …`), or before a `:` (`[ref]:` that can't start a definition is one).
 * Matched as CommonMark matches labels (case, runs of space, and space inside the brackets
 * aside), anywhere on a line.
 */
export function labelLines(text: string, labels: Iterable<string>): Set<number> {
  const marked = new Set<number>();
  const wanted = [...new Set([...labels].map(normalLabel).filter(Boolean))];
  if (!wanted.length || !text.includes("[")) return marked;
  const isWanted = new Set(wanted);
  // The candidates: each bracketed span holding a label (a label holds no unescaped bracket,
  // but may hold an escaped one: `[a\\]b]`), found on the text joined as a paragraph reads
  // it, so a label wrapped across lines is one, and placed back in the text as written.
  // Not one an odd run of backslashes escapes: it opens nothing (`\\[`, not `\\\\[`).
  const lines = text.split("\n");
  const lineStart: number[] = [];
  for (let o = 0, i = 0; i < lines.length; o += lines[i]!.length + 1, i++) lineStart.push(o);
  const { t, starts } = joins(lines)[0]!;
  const cut = (i: number) => lines[i]!.length - ((i + 1 < starts.length ? starts[i + 1]! : t.length) - starts[i]! - 1);
  // A full reference (`[text][label]`) is one reference from its text's `[`: its token goes
  // there, so the reference stays whole, and its lines run from its text to its label
  // (merge gate, PR 53, round 2: the text wrapped to the line before kept showing). Its
  // text may hold brackets of its own, balanced (round 3: `[HSM rotation [draft] details]`),
  // so each `]` is matched to its `[` as they nest, escapes aside: one pass. A label after a
  // `]` with no `[` to match (one a code span holds, say) gets no token, and its reference
  // takes its whole block.
  const opener = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\") i++;
    else if (t[i] === "[") open.push(i);
    else if (t[i] === "]" && open.length) opener.set(i, open.pop()!);
  }
  const closes = (i: number) => {
    let slashes = 0;
    while (t[i - slashes - 1] === "\\") slashes++;
    return t[i] === "]" && slashes % 2 === 0;
  };
  const candidates = new Map<number, [number, number]>();
  for (const m of t.matchAll(/\[((?:[^[\]\\]|\\[^]){0,999})\]/g)) {
    if (!isWanted.has(normalLabel(m[1]!))) continue;
    const from = closes(m.index - 1) ? opener.get(m.index - 1) : m.index;
    if (from === undefined) continue;
    const a = lineAt(starts, from);
    const at = lineStart[a]! + cut(a) + (from - starts[a]!);
    let slashes = 0;
    while (text[at - slashes - 1] === "\\") slashes++;
    if (text[at] !== "[" || slashes % 2 !== 0) continue;
    // A later label at the same `[` (`[ref][ref]`) ends later: its lines run further.
    candidates.set(at, [a, lineAt(starts, m.index + m[0].length - 1)]);
  }
  // Read once, whole, as CommonMark reads it (merge gate, PR 53: on its own a line loses a
  // code span opened on the line before): probe definitions for the labels, put first so
  // they win over any left in the text, and a token before each candidate, which changes
  // nothing CommonMark reads of a reference (letters and digits, before a `[`). Each link to
  // a probe (round 5: not an inline link whose text is the label) is the candidate whose
  // token stands right before it: its lines go. One with none (written some other way)
  // takes its whole block. A reference image is one (merge gate, PR 53): with a token after
  // its `!`, it reads as a link. So does a definition of the label, whose line no longer
  // starts with `[`: it goes too, so no other definition of the label takes effect later.
  // Absent from the text, short, and not one a page can be written to hold: a random 64-bit
  // nonce, as `linkSpans` takes (merge gate, PR 53, round 2: growing one a `q` at a time
  // until absent was quadratic). One scan, again only on a collision.
  let nonce: string;
  do nonce = `z${randomBytes(8).toString("hex")}q`;
  while (text.includes(nonce));
  const order = [...candidates.keys()].sort((x, y) => x - y);
  let tokened = "";
  let from = 0;
  order.forEach((at, k) => {
    tokened += `${text.slice(from, at)}${nonce}${k}x`;
    from = at;
  });
  tokened += text.slice(from);
  const head = wanted.length + 1; // the probes' lines and a blank one
  const token = new RegExp(`${nonce}(\\d+)x$`);
  const walker = new Parser().parse(`${wanted.map((label, i) => `[${label}]: ${PROBE}${i}`).join("\n")}\n\n${tokened}`).walker();
  for (let e = walker.next(); e; e = walker.next()) {
    const n = e.node;
    // An image too: one that got no token stays one (Codex, PR 54: `![HSM \`]\` …][ref]`),
    // and with no token before it, it takes its block.
    if (!e.entering || (n.type !== "link" && n.type !== "image") || !n.destination?.startsWith(PROBE)) continue;
    const k = n.prev?.type === "text" ? token.exec(n.prev.literal ?? "")?.[1] : undefined;
    const span = k === undefined ? undefined : candidates.get(order[Number(k)]!);
    if (span) {
      for (let l = span[0]; l <= span[1]; l++) marked.add(l);
      continue;
    }
    let b: Node | null = n;
    while (b && !b.sourcepos) b = b.parent;
    if (b?.sourcepos) for (let l = Math.max(b.sourcepos[0][0] - 1 - head, 0); l <= b.sourcepos[1][0] - 1 - head; l++) marked.add(l);
  }
  return marked;
}

const PROBE = "https://label.invalid/";

/** A label as CommonMark compares labels: runs of space one space, case folded as Unicode folds it (`ß` is `SS`: code review, round 2). */
export const normalLabel = (s: string) => s.replace(/[ \t\r\n]+/g, " ").trim().toLowerCase().toUpperCase();

/** A destination as written, whether it's an HTML attribute's, the lines it spans, and a definition's label. */
type Destination = { dest: string; html: boolean; lines: [number, number]; label?: string };

/** Every destination in `text`, wherever one can stand (see `destinationLines`). */
function destinations(text: string): Destination[] {
  const out: Destination[] = [];
  if (!text.includes("](") && !text.includes("]:") && !/<[A-Za-z]/.test(text)) return out;
  for (const { t, starts, raw } of joins(text.split("\n"))) {
    const span = (i: number, j: number): [number, number] => [lineAt(starts, i), lineAt(starts, Math.max(i, j - 1))];
    for (const opener of raw ? [] : ["](", "]:"]) {
      // The last `[` before a definition's `]:`, found going forward (linear): its label.
      let open = -1;
      let scanned = 0;
      for (let i = t.indexOf(opener); i >= 0; ) {
        // Read no further than the next opener, so no stretch is read twice.
        const next = t.indexOf(opener, i + 2);
        const [s, e] = destinationAt(t, i + 2, next < 0 ? t.length : next, opener === "](");
        if (opener === "]:") {
          // Not an escaped one: `[a\\[b]: …` is the label `a\\[b`. (CommonMark then says
          // whether it's a definition at all: `withLabels`.)
          for (; scanned < i; scanned++) if (t[scanned] === "[" && t[scanned - 1] !== "\\") open = scanned;
        }
        // A definition's label (CommonMark's at most 999 characters): what a reference to it
        // holds, which goes with it.
        const label = opener === "]:" && open >= 0 && i - open <= 1000 ? { label: t.slice(open + 1, i) } : {};
        if (e > s) out.push({ dest: t.slice(s, e), html: false, lines: span(i, e), ...label });
        i = next;
      }
    }
    for (const tag of tagsIn(t)) {
      for (const [name, value] of tag.attributes) {
        // A refresh's `content` navigates: `0; url=…`.
        const refresh = name === "content" && tag.name === "meta" ? REFRESH.exec(value) : null;
        if (!refresh && !URL_ATTRIBUTES.has(name)) continue;
        for (const u of refresh ? [refresh[1]!] : urlsIn(name, value)) out.push({ dest: u, html: true, lines: span(tag.at, tag.end) });
      }
    }
  }
  return out;
}

/** The `<base href>`s in `text`, as written: each moves what a relative URL resolves against. */
function basesIn(text: string): string[] {
  if (!/<base/i.test(text)) return [];
  const out = new Set<string>();
  for (const { t } of joins(text.split("\n"))) for (const tag of tagsIn(t)) if (tag.name === "base") for (const [name, value] of tag.attributes) if (name === "href") out.add(value);
  return [...out];
}

// Where a repo page sits, as a URL: what a `<base href>` is resolved against.
const PAGE_ORIGIN = "https://page.invalid";

/**
 * `dest` as a browser resolves it with `base` (an attribute's value, as written) in force,
 * on page `from`: a path in the repo as `/path`, or a URL elsewhere; undefined if it isn't
 * one. Parsed by the platform's URL parser, as a browser parses it.
 */
function againstBase(base: string, dest: string, html: boolean, from: string): string | undefined {
  const plain = (s: string, escapes: boolean) => decodeText(s.trim(), escapes);
  let d = dest.trim();
  if (!html && d.startsWith("<") && d.endsWith(">")) d = d.slice(1, -1);
  try {
    const at = new URL(plain(d, !html), new URL(plain(base, false), new URL(from, `${PAGE_ORIGIN}/`)));
    return at.origin === PAGE_ORIGIN ? at.pathname : at.href;
  } catch {
    return undefined;
  }
}

/**
 * For each line inside a raw HTML block, the block's first line's container markers (a
 * later line is read past them, as written); undefined elsewhere.
 * The starts and ends are CommonMark's (4.6), except that a lone tag (kind 7) is taken to
 * start one even where it can't interrupt a paragraph: that only reads more as written.
 */
function htmlBlockPrefixes(lines: string[]): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  let end: RegExp | undefined; // the open block's end, or /^$/ for "a blank line"
  let prefix = "";
  for (const l of lines) {
    if (end) {
      // Inside, only the block's own container markers are markers: the rest is HTML (a
      // `> ` is no blank line there). A line that leaves the container ends the block.
      const inside = l.startsWith(prefix) ? l.slice(prefix.length) : !prefix.includes(">") && /^[ \t]*$/.test(l.slice(0, prefix.length)) ? l.slice(prefix.length) : undefined;
      if (inside === undefined || (end.source === "^$" && !inside.trim())) end = undefined;
      else {
        out.push(prefix);
        if (end.source !== "^$" && end.test(inside)) end = undefined;
        continue;
      }
    }
    const p = CONTAINER.exec(l)![0];
    const content = l.slice(p.length);
    const kind = HTML_BLOCK_STARTS.find(([start]) => start.test(content));
    out.push(kind ? p : undefined);
    if (!kind) continue;
    prefix = p;
    end = kind[1].source !== "^$" && kind[1].test(content) ? undefined : kind[1];
  }
  return out;
}

const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
// Each kind of raw HTML block: how it starts, on a line past its container markers, and
// how it ends (on the line that holds the end, or, for /^$/, before a blank line).
const HTML_BLOCK_STARTS: [RegExp, RegExp][] = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:\s|>|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [new RegExp(`^ {0,3}<\\/?(?:${BLOCK_TAGS})(?:\\s|\\/?>|$)`, "i"), /^$/],
  [/^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/, /^$/],
];

/**
 * The text joined as HTML reads a value broken across lines: with each line's container
 * markers dropped, as CommonMark drops them in a paragraph; and, when there's a raw HTML
 * block, again with its lines as written past its first line's markers (`raw`), where the
 * next line's quote marker or indent is part of the value (`<img …>`, then `> <a
 * href="../x`, then `> y.md">`). Not as written elsewhere: in a paragraph that reading
 * makes a path that is no page, and that fails closed.
 */
function joins(lines: string[]): { t: string; starts: number[]; raw: boolean }[] {
  const block = htmlBlockPrefixes(lines);
  return (block.some((p) => p !== undefined) ? [false, true] : [false]).map((raw) => {
    const starts: number[] = [];
    let t = "";
    for (const [i, l] of lines.entries()) {
      starts.push(t.length);
      const p = raw ? block[i] : undefined;
      const cut = p === undefined ? CONTAINER.exec(l)![0].length : l.startsWith(p) ? p.length : /^[ \t]*$/.test(p) ? Math.min(p.length, /^[ \t]*/.exec(l)![0].length) : 0;
      t += `${l.slice(cut)}\n`;
    }
    return { t, starts, raw };
  });
}

/**
 * The lines of `text` holding an iframe whose `srcdoc` (decoded) `names`: a document a
 * browser shows in its own right, so each sweep reads it as one (merge gate, PR 13: a
 * path split by markup in it showed whole there, and the rendered view drops the tag).
 */
function srcdocLines(text: string, depth: number, names: (doc: string) => boolean): Set<number> {
  const marked = new Set<number>();
  if (!/srcdoc/i.test(text)) return marked;
  // Each document once, however many readings find its tag (both tag readers, both joins).
  const docs = new Map<string, [number, number][]>();
  for (const { t, starts } of joins(text.split("\n"))) {
    for (const tag of tagsIn(t)) {
      for (const [name, value] of tag.attributes) {
        if (name !== "srcdoc") continue;
        const doc = decoded(value);
        if (!docs.has(doc)) docs.set(doc, []);
        docs.get(doc)!.push([lineAt(starts, tag.at), lineAt(starts, tag.end - 1)]);
      }
    }
  }
  // Nested deeper than any page does, it fails closed: each level reads its document
  // again (merge gate, PR 13).
  for (const [doc, spans] of docs) if (depth >= SRCDOC_DEPTH || names(doc)) for (const [a, b] of spans) for (let l = a; l <= b; l++) marked.add(l);
  return marked;
}

const SRCDOC_DEPTH = 3;

/** The line holding offset `k`, given each line's start. */
function lineAt(starts: number[], k: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= k) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The destination after `](` or `]:` (at `at`), read no further than `end`, as [start,
 * end): past spaces and at most one line break, then `<…>`, or up to whitespace (and in
 * an inline link, a `)` that closes nothing).
 */
function destinationAt(t: string, at: number, end: number, inline: boolean): [number, number] {
  let k = at;
  while (k < end && (t[k] === " " || t[k] === "\t")) k++;
  if (k < end && t[k] === "\n") k++;
  while (k < end && (t[k] === " " || t[k] === "\t")) k++;
  const s = k;
  if (t[k] === "<") {
    for (k++; k < end && t[k] !== ">" && t[k] !== "<" && t[k] !== "\n"; k++) if (t[k] === "\\") k++;
    return k < end && t[k] === ">" ? [s, k + 1] : [s, s];
  }
  let depth = 0;
  for (; k < end; k++) {
    const c = t.charCodeAt(k);
    if (c <= 32) break;
    if (c === 92) k++; // `\`
    else if (inline && c === 40) depth++; // `(`
    else if (inline && c === 41 && depth-- === 0) break; // `)`
  }
  return [s, Math.min(k, end)];
}

type Tag = { at: number; end: number; name: string; attributes: [string, string][] };

/**
 * The tags in `t`, with their attributes: as CommonMark reads a tag (raw HTML in a
 * paragraph), and as a browser's tokenizer reads them in order (in a raw HTML block a
 * browser takes tags CommonMark wouldn't: `<a href="x" "y">`). The browser's reading
 * stops at a tag still open at the end, as a browser does; CommonMark's reads on.
 */
function tagsIn(t: string): Tag[] {
  const out: Tag[] = [];
  const named = (s: string): [string, string][] => [...s.matchAll(ATTRIBUTE)].map((a) => [a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4]!]);
  for (const m of t.matchAll(TAG)) out.push({ at: m.index, end: m.index + m[0].length, name: /^<([A-Za-z0-9-]+)/.exec(m[0])![1]!.toLowerCase(), attributes: named(m[0]) });
  // A browser's tokenizer, simplified: a tag is `<`, a letter and a name, then
  // attributes, each a name (to whitespace, `/`, `>` or `=`) and maybe `=` and a value,
  // quoted (across lines, `>` included) or up to whitespace or `>`.
  const space = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  const open = /<[A-Za-z]/g;
  for (let m = open.exec(t); m; m = open.exec(t)) {
    const at = m.index;
    let k = at + 1;
    while (k < t.length && !space(t[k]) && t[k] !== "/" && t[k] !== ">") k++;
    const tag: Tag = { at, end: -1, name: t.slice(at + 1, k).toLowerCase(), attributes: [] };
    while (k < t.length) {
      while (k < t.length && (space(t[k]) || t[k] === "/")) k++;
      if (t[k] === ">") {
        tag.end = k + 1;
        break;
      }
      const n = k++;
      while (k < t.length && !space(t[k]) && t[k] !== "/" && t[k] !== ">" && t[k] !== "=") k++;
      const name = t.slice(n, k).toLowerCase();
      let j = k;
      while (space(t[j])) j++;
      if (t[j] !== "=") {
        tag.attributes.push([name, ""]);
        continue;
      }
      for (j++; space(t[j]); j++);
      if (t[j] === '"' || t[j] === "'") {
        const close = t.indexOf(t[j]!, j + 1);
        if (close < 0) break;
        tag.attributes.push([name, t.slice(j + 1, close)]);
        k = close + 1;
      } else {
        for (k = j; k < t.length && !space(t[k]) && t[k] !== ">"; k++);
        tag.attributes.push([name, t.slice(j, k)]);
      }
    }
    if (tag.end < 0) break; // still open at the end: a browser drops it and reads no further
    out.push(tag);
    open.lastIndex = tag.end;
  }
  return out;
}

// A tag as CommonMark reads one (see UNSHOWN), and each of its attributes with its value.
const TAG = /<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/g;
const ATTRIBUTE = /\s([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const REFRESH = /^\s*[\d.]*\s*[;,]\s*(?:url\s*=\s*)?["']?([^"'\s]*)/i;
/** An attribute's value with its character references decoded. */
function decoded(value: string): string {
  return decodeText(value, false);
}
/**
 * The URLs an attribute's value holds: a list for some (`srcset` and `imagesrcset` by
 * commas, each URL then a descriptor; `ping` and `archive` by whitespace), one otherwise.
 */
function urlsIn(name: string, value: string): string[] {
  if (name === "srcset" || name === "imagesrcset") return value.split(",").map((u) => u.trim().split(/\s+/)[0]!);
  if (name === "ping" || name === "archive") return value.split(/\s+/).filter(Boolean);
  return [value];
}

// The attributes HTML reads as a URL.
const URL_ATTRIBUTES = new Set(["href", "src", "srcset", "imagesrcset", "action", "formaction", "data", "poster", "cite", "background", "longdesc", "usemap", "ping", "archive", "codebase", "manifest", "icon", "xlink:href"]);

/**
 * Whether a URL into the knowledge repo on GitHub (any branch; blob, tree, raw…) names a
 * path under the knowledge root that is no page here: a page on another branch, say,
 * which never loads, so its ACL can't be read. It fails closed as a relative link does.
 * A loaded visible page the URL may also be read as settles it (a branch can be named
 * `knowledge/…` too). A URL elsewhere can't be told from one to another site's page.
 */
function namesNoPage(url: string, names: PageNames, markdown = false): boolean {
  // A `\` is a `/` to a browser reading it as written (raw HTML, text), but a markdown
  // destination's reaches the href as `%5C` (renderers percent-encode it), which a
  // browser keeps: there each is a reading of its own.
  return (markdown && url.includes("\\") ? [url, url.replace(/\\/g, "%5C")] : [url]).some((u) => namesNoPageAs(u, names));
}

function namesNoPageAs(url: string, names: PageNames): boolean {
  const web = webUrl(url);
  if (!web) return false;
  const u = fold(`${web.host}${web.path}`);
  const prefix = names.repoUrls.find((p) => u.startsWith(p));
  if (!prefix) return false;
  let noPage = false;
  let readings = 0;
  for (let at = u.indexOf(`/${names.root}/`, prefix.length - 1); at >= 0; at = u.indexOf(`/${names.root}/`, at + 1)) {
    // Past a few readings it fails closed: no real branch name holds that many.
    if (++readings > READINGS) return u.endsWith(".md");
    const path = posix.normalize(u.slice(at + 1));
    if (names.paths.get(path) === false) return false;
    if (path.endsWith(".md")) noPage = true;
  }
  return noPage;
}
const READINGS = 8;

/**
 * A web URL's host and path as a browser reads them, by the platform's URL parser (merge
 * gate, PR 13: a port, then a fullwidth `ｇ`, got past a prefix): the host mapped as a
 * browser maps it (to ASCII, lower case, percent-decoded), without userinfo, port, a
 * trailing dot or `www.`; the path decoded, in lower case. Undefined if it isn't one.
 * Without a scheme it's read as one written in text (`github.com/acme/…`).
 */
function webUrl(url: string): { host: string; path: string } | undefined {
  const at = webParse(url);
  return at && { host: at.hostname.replace(/\.$/, "").replace(/^www\./, ""), path: decodedPath(at).toLowerCase() };
}

/** A web URL parsed as a browser parses it (`webUrl`), or undefined. */
function webParse(url: string): URL | undefined {
  // A URL parser drops tabs and line breaks first, wherever they are (`h` + break + `ttps:`).
  const u = url.replace(/[\t\n\r]/g, "").trim();
  try {
    const at = new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u.replace(/^[\\/]*/, "")}`);
    return at.protocol === "https:" || at.protocol === "http:" ? at : undefined;
  } catch {
    return undefined;
  }
}

/** A parsed URL's path, percent-decoded (as written where an escape is malformed). */
function decodedPath(at: URL): string {
  try {
    return decodeURIComponent(at.pathname);
  } catch {
    return at.pathname;
  }
}

/**
 * `s` with character references, and with `escapes` CommonMark's backslash escapes, decoded;
 * non-ASCII kept, for a URL parser to read. With `strict`, as CommonMark decodes them: a
 * numeric reference needs its `;` (HTML reads `&#46` in an attribute as `.`).
 */
function decodeText(s: string, escapes: boolean, strict = false): string {
  return s.replace(/\\([!-/:-@[-`{-~])|&(?:#(\d+)(;?)|#[xX]([0-9a-fA-F]+)(;?)|([A-Za-z][A-Za-z0-9]{0,31});)/g, (m, esc?: string, dec?: string, decEnd?: string, hex?: string, hexEnd?: string, name?: string) => {
    if (esc !== undefined) return escapes ? esc : m;
    if (strict && (decEnd === "" || hexEnd === "")) return m;
    const code = dec !== undefined ? Number(dec) : hex !== undefined ? Number.parseInt(hex, 16) : undefined;
    if (code !== undefined) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
    // One for a non-ASCII character this doesn't know stands for it as `fold` does: SUB.
    return ASCII_REFERENCES[name!] ?? SUB;
  });
}

/**
 * The lines of `text` (read as prose, decoded) holding a GitHub URL into the knowledge
 * repo that names no page (`namesNoPage`), however it's written: a bare URL, an autolink,
 * in code. Destinations are `destinationLines`', but a URL needs no link around it.
 */
function repoUrlLines(text: string, names: PageNames, links?: ReadonlySet<string>): Set<number> {
  const marked = new Set<number>();
  if (!names.repoUrls.length && !names.site) return marked;
  const lines = text.split("\n");
  const block = text.includes("\\") ? htmlBlockPrefixes(lines) : [];
  // Each line decoded (with CommonMark's escapes, but on a raw HTML block's lines without
  // them, as HTML reads them there), and again as it renders (markup inside a URL is gone
  // on screen), each with its paths' folding. Then every token that may be a URL is read
  // by the URL parser, which maps a host as a browser does (`ｇithub.com`, `github。com`).
  const readings: [(l: string, i: number) => string, PageNames][] = [[(l, i) => decodeText(l, block[i] === undefined), names]];
  // And with CommonMark's escapes on a raw HTML block's lines too, as the name sweep reads
  // both: a reader sees `broken\-route` there as the route `broken-route` (found by the fuzz).
  if (block.some((p) => p !== undefined)) readings.push([(l) => decodeText(l, true), names]);
  if (names.rendered) for (const show of renderings(text)) readings.push([(l) => decodeText(show(l), true), names.rendered]);
  for (const [read, folded] of readings) {
    lines.forEach((l, i) => {
      if (marked.has(i)) return;
      // Not normalized here: the parser maps a host itself, and NFKC would change a path
      // (`𝔄.md` is `A.md` to it).
      const line = read(l, i);
      if (folded.repoUrls.length) {
        for (const token of line.split(/[\s"'<>`|[\]()]+/)) {
          if (!urlish(token)) continue;
          if (namesNoPage(token.replace(/[).,;:!*_~]+$/, ""), folded)) {
            marked.add(i);
            return;
          }
        }
      }
      // And percent-decoded, as a hidden page's path is read in text (`…%2Fdocs/moved%2Fsecret`):
      // there a hidden page's route hides it, naming nothing doesn't (no link reads it so).
      if (folded.site && (siteUrlsHide(line, folded, links) || (line.includes("%") && siteUrlsHide(percentDecoded(line), folded, NO_LINKS)))) marked.add(i);
    });
  }
  return marked;
}
/**
 * Whether a line names a hidden page by a URL on the docs site, however it's written: an
 * autolink, a bare URL, in code. Each URL is read whole to the next space, quote or `<` (a
 * slug may hold `(old)` or end in `_`: review, round 4), and cut at a parenthesis, bracket
 * or `|`; each such reading also as GFM ends a bare URL (a sentence's `.` cut, a `)` only
 * while unpaired), the two read together. A route naming nothing fails closed only where it's a link CommonMark
 * reads (`links`, an autolink): a bare URL's or a piece's could be cut short by markup.
 */
function siteUrlsHide(line: string, names: PageNames, links?: ReadonlySet<string>): boolean {
  // As GFM ends a bare URL: trailing punctuation, and a `)` only while unpaired, so
  // `…/setup(old))` is `…/setup(old)`.
  // One pass from the end (code review, round 5: cutting one `)` at a time was quadratic).
  const paired = (t: string) => {
    let closes = 0;
    for (const c of t) closes += c === ")" ? 1 : c === "(" ? -1 : 0;
    let end = t.length;
    for (; end > 0; end--) {
      const c = t[end - 1]!;
      if (c === ")" && closes > 0) closes--;
      else if (!".,;:!?*_~".includes(c)) break;
    }
    return t.slice(0, end);
  };
  for (const wide of line.split(/[\s"'<>`]+/)) {
    for (const piece of new Set([wide, ...wide.split(/[|[\]()]+/)])) {
      // And from every place the site's host starts one: after a scheme a browser can't
      // parse (`https:%2F/docs.example.com/…`), or inside an archive's URL, even after the
      // host stood once already (code review, round 4), it's still the site's URL. Past a
      // few such places it fails closed, as a repo URL's readings do: linear.
      // The places a host starts: as written, or wherever one can (the token's start, after a
      // separator a URL holds before a host) and a URL parser reads the site's there, mapped
      // as it maps one: percent-encoded, fullwidth, IDNA's dots, what IDNA ignores (code
      // review, rounds 7 and 8: `https://ｄｏｃｓ.example.com/…`, `web/docs%2eexample.com/…`
      // inside an archive's URL). Past eight places (round 6: places, not the readings each
      // gives) it fails closed.
      const places = new Set([...piece.matchAll(names.site!.at)].map((m) => m.index));
      // Parsed only where the pattern can't see a host: one percent-encoded or not in ASCII
      // (an ASCII one it finds at the same places, in any case). Where each position's
      // authority ends, found in one pass from the end: linear.
      if (/[%\u0080-\uffff]/.test(piece)) {
        const stop = new Int32Array(piece.length + 1).fill(piece.length);
        for (let k = piece.length - 1; k >= 0; k--) stop[k] = "/\\?#".includes(piece[k]!) ? k : stop[k + 1]!;
        for (const m of piece.matchAll(/(?:^|[\/\\=?&:@(])(?=[^\/\\=?&:@(])/g)) {
          const at = m.index + m[0].length;
          if (stop[at]! - at <= HOST_LENGTH && /[%\u0080-\uffff]/.test(piece.slice(at, stop[at])) && hostAt(piece, at, stop[at]) === names.site!.name) places.add(at);
        }
      }
      if (places.size > HOST_READINGS) return true;
      // From each: the host, and the scheme before its `//`, which says what port is its
      // default (`HTTP://…:80`). Past any userinfo to that `//` (merge gate, PR 53, round 3:
      // `http://user@docs.example.com:80/…`): a host after an `@` starts at its authority's
      // start, where the last `/`, `\`, `?` or `#` before it ends. At most eight places: linear.
      const starts: number[] = [];
      for (const at of places) {
        starts.push(at);
        let from = at;
        if (piece[at - 1] === "@") while (from > 0 && !"/\\?#".includes(piece[from - 1]!)) from--;
        if (from < 2 || !/[\\/]{2}/.test(piece.slice(from - 2, from))) continue;
        const scheme = /[a-z][a-z0-9+.-]*:$/i.exec(piece.slice(Math.max(0, from - 34), from - 2));
        if (scheme && from - 2 > scheme[0].length) starts.push(from - 2 - scheme[0].length);
      }
      for (const u of [piece, ...starts.map((at) => piece.slice(at))]) {
        if (urlish(u) && siteUrlHides([u, paired(u)], names, !links || links.has(commonmarkPath(u).folded))) return true;
      }
    }
  }
  return false;
}

const HOST_READINGS = 8;
const HOST_LENGTH = 320;

const NO_LINKS: ReadonlySet<string> = new Set();

/** The host name starting at `at` in `s`, as a URL parser decodes it (to the next `/`, `\`, `?` or `#`; userinfo and port cut). Linear: it stops at the next separator. */
function hostAt(s: string, at: number, stopAt?: number): string {
  let end = stopAt ?? at;
  // No host is longer than DNS allows (253, a port and userinfo aside): linear, however
  // many places are tried.
  if (stopAt === undefined) while (end < s.length && !"/\\?#".includes(s[end]!)) if (++end - at > HOST_LENGTH) return "";
  const authority = s.slice(at, end);
  const at2 = webParse(`https://${authority.slice(authority.lastIndexOf("@") + 1)}/`);
  return at2 ? at2.hostname.replace(/\.$/, "") : "";
}

/**
 * Whether a token may be a URL with a path, for the URL parser to read: it has a scheme,
 * or its first part (past any slashes, as in `//github.com/…`) looks like a host and a
 * slash follows. Linear: a regex that tried every split backtracked on long tokens.
 */
function urlish(token: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(token)) return true;
  const start = token.search(/[^/\\]/);
  if (start < 0) return false;
  const slash = token.slice(start).search(/[/\\]/);
  return slash > 0 && /[.%\u3002\uff0e\uff61]/.test(token.slice(start, start + slash));
}

const AUTHORITY = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const isUrl = (t: string) => AUTHORITY.test(t.trim()) || SCHEME.test(t.trim());

/** Answers already worked out for one text: a dense text repeats the same tokens. */
type Memo = { to: Map<string, boolean | undefined>; tail: Map<string, { hidden: boolean; length: number } | undefined>; junk: Map<string, boolean> };
const memoized = <T>(m: Map<string, T>, key: string, f: () => T): T => {
  if (m.has(key)) return m.get(key) as T;
  const v = f();
  m.set(key, v);
  return v;
};

/**
 * The page a reference, as written from page `from`, resolves to as a link would: true if
 * hidden, false if visible, undefined for a URL or a path that is no page. Not cut at `?`
 * or `#`: the token ends with a hidden page's file name, so one before it is part of that
 * name (`%23`) or puts the path in a query (`?next=../x.md`).
 */
function resolvesTo(token: string, from: string, names: PageNames): boolean | undefined {
  const t = token.trim();
  if (isUrl(t)) return undefined;
  return names.paths.get(t.startsWith("/") ? posix.normalize(t.slice(1)) : posix.normalize(posix.join(posix.dirname(from), t)));
}

/**
 * The page a URL or an unresolved path names by what it ends with: the longest tail (two
 * segments or more) that is a page's repo path or its path under the root. Its length
 * says how specific the match is.
 */
function endsWith(token: string, names: PageNames): { hidden: boolean; length: number } | undefined {
  const t = token.trim();
  const authority = AUTHORITY.exec(t);
  const scheme = SCHEME.exec(t);
  const path = authority ? t.slice(authority[0].length) : scheme ? t.slice(scheme[0].length) : t;
  const segs = posix.normalize(path).split("/").filter((s) => s && s !== "." && s !== "..");
  for (let n = Math.min(segs.length, names.depth); n >= 2; n--) {
    const tail = segs.slice(-n).join("/");
    const hidden = names.paths.get(tail) ?? names.under.get(tail);
    if (hidden !== undefined) return { hidden, length: tail.length };
  }
  return undefined;
}

/**
 * Whether the references that may end at one place name a hidden page. One that resolves
 * to a hidden page as a link decides. One that resolves to a visible page says what a
 * relative path there means: `<../team space/x/y.md>` and, from inside `team space/`,
 * `x/y.md` are that page, not a hidden `x/y.md`, and a start one character earlier only
 * glues junk to it. A URL's tail still counts: a later start inside it (after a port's
 * `:`, say) can resolve to a visible page while the URL names a hidden one. (`url` says
 * which tokens are URLs; the sweep's leaves out spans no URL could be.) Of what's left,
 * the most specific tail decides.
 */
function namesHidden(tokens: string[], from: string, names: PageNames, memo?: Memo, url: (t: string) => boolean = isUrl, junk: string[] = []): boolean {
  const resolve = (t: string) => (memo ? memoized(memo.to, t, () => resolvesTo(t, from, names)) : resolvesTo(t, from, names));
  const tail = (t: string) => (memo ? memoized(memo.tail, t, () => endsWith(t, names)) : endsWith(t, names));
  let visible = false;
  for (const t of tokens) {
    const to = resolve(t);
    if (to === true) return true;
    if (to === false) visible = true;
  }
  // Starts that may only be junk in front (`cancelsJunk`), read when no other start
  // resolves to a page: `(draft)/../../x.md` is a directory's own name, `"../../x.md` isn't.
  if (!visible) for (const t of junk) if (resolve(t) === true) return true;
  let best: { hidden: boolean; length: number } | undefined;
  for (const t of tokens) {
    if (visible && !url(t)) continue;
    const e = tail(t);
    if (e && (!best || e.length > best.length || (e.length === best.length && e.hidden))) best = e;
  }
  return best?.hidden ?? false;
}


/** Marks the lines of `v` that name a hidden page. */
function scan(v: View, from: string, names: PageNames, marked: Set<number>): void {
  const D = v.text;
  const memo: Memo = { to: new Map(), tail: new Map(), junk: new Map() };
  // Each hidden page with a file name, as a path from this page's directory.
  const relative = new Map<string, string[]>();
  const relativeTo = (name: string) =>
    memoized(relative, name, () => (names.spelled.get(name) ?? []).map((path) => posix.relative(posix.dirname(from), path)).filter((r) => r.includes("/")));
  // For each offset, the nearest `<`, `"` and `'` as written at or before it (-1 for none),
  // built once on first use: a reference that may hold spaces starts after the nearest one
  // of its delimiter.
  let nearest: Int32Array[] | undefined;
  const quotes = (): Int32Array[] => {
    if (nearest) return nearest;
    const at = [new Int32Array(D.length), new Int32Array(D.length), new Int32Array(D.length)];
    const last = [-1, -1, -1];
    for (let i = 0; i < D.length; i++) {
      const c = D[i];
      const x = c === "<" ? 0 : c === '"' ? 1 : c === "'" ? 2 : -1;
      if (x >= 0 && v.raw(i)) last[x] = i;
      for (let y = 0; y < 3; y++) at[y]![i] = last[y]!;
    }
    return (nearest = at);
  };
  const mark = (i: number, j: number) => {
    for (let l = v.lineOf(i); l <= v.lineOf(j); l++) marked.add(l);
  };
  for (let e = D.indexOf(".md"); e >= 0; e = D.indexOf(".md", e + 1)) {
    const end = e + 3;
    // The hidden file names ending here that start a segment; s, the rightmost start.
    let s = -1;
    const ending: string[] = [];
    for (const [len, set] of names.names) {
      const at = end - len;
      if (at < 0 || !set.has(D.slice(at, end))) continue;
      if (at === 0 || D[at - 1] === "/" || startsAfter(D, at - 1)) {
        ending.push(D.slice(at, end));
        s = Math.max(s, at);
      }
    }
    if (s < 0) continue;
    // Where the reference could start: after any character a path can't hold, back to
    // whitespace as written; then after the nearest `<`, `"` and `'`.
    const starts: number[] = [];
    const floor = Math.max(0, s - REACH);
    let unsure = false;
    let k = s - 1;
    for (; k >= floor; k--) {
      const c = D[k]!;
      if (writtenSpace(v, k)) break; // a line break too: a space in the prose view
      if (startsAfter(D, k)) starts.push(k + 1);
    }
    if (k < floor && floor > 0) unsure = true; // ran past REACH
    starts.push(k + 1);
    if (!unsure && k >= 0) {
      // A path with spaces in prose or code (`knowledge/team space/x.md`): the starts of the
      // one or two words before, so the whole path is read too and can name a visible page.
      for (let q = k, words = 0; words < WORDS_BACK && q >= floor; words++) {
        while (q >= floor && writtenSpace(v, q)) q--;
        if (q < floor) break;
        for (; q >= floor && !writtenSpace(v, q); q--) if (startsAfter(D, q)) starts.push(q + 1);
        if (q < floor && floor > 0) break;
        starts.push(q + 1);
      }
      if (k > 0) for (const at of quotes()) if (at[k - 1]! >= floor) starts.push(at[k - 1]! + 1);
    }
    if (unsure) {
      mark(Math.max(floor, k + 1), end - 1);
      continue;
    }
    // A hidden page's path under the root, or from this page's directory, spelled out
    // (spaces and all) where a path can start: read from there too (with any `./` and
    // `../` before it), so it resolves from this page like any other start. Not as the
    // tail of a longer path (`team space/x/y.md`).
    // A hidden page's repo path spelled out, spaces and all, anywhere (a URL holds it too,
    // after its `/`): a start, so a visible page whose path ends with it still decides.
    for (const path of ending.flatMap((n) => names.spelled.get(n) ?? [])) if (end - path.length >= 0 && D.slice(end - path.length, end) === path) starts.push(end - path.length);
    for (const rel of ending.flatMap((n) => [...(names.spelledUnder.get(n) ?? []), ...relativeTo(n)])) {
      let j = end - rel.length;
      if (j < 0 || D.slice(j, end) !== rel) continue;
      for (;;) {
        if (D.startsWith("../", j - 3)) j -= 3;
        else if (D.startsWith("./", j - 2)) j -= 2;
        else break;
      }
      if (j === 0 || startsAfter(D, j - 1)) starts.push(j);
    }
    const isJunk = (j: number) => memoized(memo.junk, D.slice(j, end), () => cancelsJunk(D.slice(j, end)));
    const read = starts.filter((j) => !isJunk(j));
    const junk = starts.filter(isJunk);
    // A URL as written holds no space, quote, angle or square bracket, or backtick: a
    // "URL" spanning those is two things read as one (`…/a.md "title"[b](c/x.md`).
    const urls = new Set(read.filter((j) => isUrl(D.slice(j, end)) && !writtenDelimiter(v, j, end)).map((j) => D.slice(j, end)));
    if (namesHidden(read.map((j) => D.slice(j, end)), from, names, memo, (t) => urls.has(t), junk.map((j) => D.slice(j, end)))) mark(Math.min(...starts), end - 1);
  }
}

/** How a line shows: as CommonMark ends what renders as nothing and, where it differs, as a browser does. */
type Show = (line: string) => string;
const renderings = (text: string): Show[] => (SHORTER.test(text) ? [unshown, (l) => unshown(l, true)] : [unshown]);

/** The lines of `text`, on page `from`, that name a hidden page: see the module comment. */
export function namingLines(text: string, from: string, names: PageNames, depth = 0, inherited: string[] = [], liberal = false, gone?: Set<string>): Set<number> {
  // Destinations and URLs into the repo first, even with nothing hidden: one that names
  // no page fails closed. A srcdoc is a document of its own, with its parent's bases.
  const bases = [...inherited, ...basesIn(text)];
  // A srcdoc is HTML: there only an attribute is a link.
  // `liberal`: every route naming nothing fails closed, as if each were a link.
  const links = depth === 0 ? linkPaths(text) : new Set<string>();
  const marked = destinationLines(text, from, names, bases, liberal ? undefined : links);
  for (const l of repoUrlLines(text, names, liberal ? undefined : depth === 0 ? links : new Set())) marked.add(l);
  for (const l of srcdocLines(text, depth, (doc) => namingLines(doc, from, names, depth + 1, bases).size > 0)) marked.add(l);
  if (!names.names.size) return withLabels(text, marked, gone);
  const lines = text.split("\n");
  const fromKey = fold(from);
  // Read with CommonMark's escapes and without (as raw HTML reads `\`); the same text
  // when there's no backslash, and as written when there's nothing to decode at all.
  const encoded = ENCODED.test(text);
  for (const escapes of text.includes("\\") ? [true, false] : [true]) {
    scan(encoded ? readerView(lines, false, escapes) : plainView(lines, false), fromKey, names, marked);
    scan(encoded ? readerView(lines, true, escapes) : plainView(lines, true), fromKey, names, marked);
    // Joined again with every line as written: inside a value broken across lines, what
    // looks like a list marker is part of it (`href="../x/` then `1. secret.md">`).
    scan(encoded ? readerView(lines, true, escapes, false, true) : plainView(lines, true, false, true), fromKey, names, marked);
  }
  // As rendered prose: markup inside a path (`team/**secret.md**`) is gone on screen.
  if (names.rendered) {
    for (const show of renderings(text)) scan(encoded ? readerView(lines, false, true, show) : plainView(lines, false, show), foldRendered(from), names.rendered, marked);
  }
  return withLabels(text, marked, gone);
}

/**
 * The lines of `text` where `find`, run over each view the sweep reads (as prose and
 * joined, with and without CommonMark's escapes, and as rendered), reports a span. For
 * names that aren't paths: a mirrored page's id, say.
 */
export function linesWhere(text: string, find: (view: string, cased: string) => Iterable<[number, number]>, depth = 0, inherited: string[] = []): Set<number> {
  const marked = new Set<number>();
  const lines = text.split("\n");
  const encoded = ENCODED.test(text);
  const views: View[] = [];
  for (const escapes of text.includes("\\") ? [true, false] : [true]) {
    views.push(encoded ? readerView(lines, false, escapes) : plainView(lines, false));
    views.push(encoded ? readerView(lines, true, escapes) : plainView(lines, true));
    views.push(encoded ? readerView(lines, true, escapes, false, true) : plainView(lines, true, false, true));
  }
  for (const show of renderings(text)) views.push(encoded ? readerView(lines, false, true, show) : plainView(lines, false, show));
  for (const v of views) for (const [i, j] of find(v.text, v.cased)) for (let l = v.lineOf(i); l <= v.lineOf(Math.max(i, j - 1)); l++) marked.add(l);
  // A destination resolved against a `<base href>` (a relative `pages/900` under a wiki's
  // space URL), and a srcdoc as a document of its own, with its parent's bases.
  const bases = [...inherited, ...basesIn(text)];
  if (bases.length) {
    for (const d of destinations(text)) {
      for (const b of bases) {
        const r = againstBase(b, d.dest, d.html, ".knowledge/x.md");
        if (r !== undefined && [...find(r.toLowerCase(), r)].length) for (let l = d.lines[0]; l <= d.lines[1]; l++) marked.add(l);
      }
    }
  }
  for (const l of srcdocLines(text, depth, (doc) => linesWhere(doc, find, depth + 1, bases).size > 0)) marked.add(l);
  return marked;
}

/** `text` with each line in `lines` replaced by its container markers and `placeholder`. */
export function replaceLines(text: string, lines: Set<number>, placeholder: string): string {
  if (!lines.size) return text;
  return text
    .split("\n")
    .map((l, i) => (lines.has(i) ? `${CONTAINER.exec(l)![0]}${placeholder}` : l))
    .join("\n");
}
