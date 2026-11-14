import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { createDocument } from "@mixmark-io/domino";
import { HtmlRenderer, Parser } from "commonmark";
import { decodeHTML } from "entities";
import { parse as parseYaml } from "yaml";
import { canSee, type Identity } from "../src/core/acl.js";
import type { Repo } from "../src/core/repo.js";

// A differential check for link redaction. CommonMark's reference parser (commonmark.js)
// says which links a page holds, the `entities` package decodes HTML attributes as a
// browser would, and an HTML5 parser (domino) says what a browser shows of the HTML
// commonmark.js writes; none shares code with `redactLinks`. A redacted text leaks when:
//
// - a link or image commonmark.js finds in it resolves to a page the caller can't see
// - an `href` or `src` in its raw HTML does
// - read as a person would (character references, escapes and percent-encoding
//   decoded), it still holds a hidden page's path: the repo path anywhere, or the path
//   under the knowledge root where a path could start
//
// Pages that failed to load count as hidden: their ACL can't be read. So does a link to a
// path under the knowledge root that is no page at all (a link, not a mention in text).
//
// And as a docs site serves a link (the owner's decision, 2026-11-13): by Docusaurus's
// routing, modelled below from its documentation alone (`siteModel`), a link reaches a
// hidden page when it names that page's route or file stem, and fails closed when it's a
// route no page has. A route mention in plain text isn't a link (the owner's scope); a URL
// on the docs site (`site_url`) is read wherever it stands, as a URL into the repo is.

/** The hidden paths, for `who` on `repo`: pages they can't see and pages that didn't load. */
export function hiddenPaths(repo: Repo, who: Identity): Set<string> {
  return new Set([...repo.pages.filter((p) => !canSee(p, who)).map((p) => p.path), ...repo.invalid.map((p) => p.path)]);
}

function percentDecode(s: string): string {
  // Sequence by sequence, so one malformed escape doesn't stop the rest decoding.
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq;
    }
  });
}

/** Where a link destination leads, as a repo path, or null for elsewhere. */
function target(dest: string, fromPath: string, root: string, hidden: Set<string>, repoUrls: string[] = []): string | null {
  const raw = dest.trim();
  // A URL, parsed as a browser parses it (WHATWG URL): its percent-encoding is decoded only
  // once the parser has found its parts, so `https:/%2Fgithub.com` is no URL at all.
  if (/^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(raw)) {
    let u: URL;
    try {
      u = new URL(/^[\\/]{2}/.test(raw) ? `https:${raw}` : raw);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null; // mailto: and the like
    // A URL names a hidden page when its path ends with that page's repo path.
    const path = posix.normalize(percentDecode(u.pathname));
    for (const h of hidden) if (path.endsWith(`/${h}`)) return h;
    return inRepo(u.href, root, repoUrls);
  }
  let d = percentDecode(raw.split(/[?#]/)[0]!).replace(/\\/g, "/");
  d = d.startsWith("/") ? posix.normalize(d.slice(1)) : posix.normalize(posix.join(posix.dirname(fromPath), d));
  return d.startsWith(`${root}/`) ? d : null;
}

/**
 * A GitHub URL into the knowledge repo (blob, tree, raw…, any branch): the path under the
 * root it names, or null. `repoUrls` are its prefixes, as `github.com/acme/knowledge/`.
 */
function inRepo(url: string, root: string, repoUrls: string[]): string | null {
  // Parsed as a browser parses it (WHATWG URL): port, userinfo and case don't matter.
  let host: string;
  let path: string;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url.replace(/^\/*/, "")}`);
    if (!/^https?:$/.test(u.protocol)) return null;
    host = u.hostname.replace(/\.$/, "").replace(/^www\./, "");
    path = percentDecode(u.pathname);
  } catch {
    return null;
  }
  const u = `${host}${path}`;
  const prefix = repoUrls.find((p) => u.startsWith(p));
  if (!prefix) return null;
  const at = u.indexOf(`/${root}/`, prefix.length - 1);
  return at < 0 ? null : posix.normalize(u.slice(at + 1));
}

/** A relative or root-relative destination as a browser resolves it on page `fromPath`, as a repo path; null for a URL. */
function browserPath(dest: string, fromPath: string): string | null {
  const raw = dest.trim().replace(/[\t\n\r]/g, "");
  // No path (`#x`, `?a=1`): this page itself, no other page's.
  if (!raw.split(/[?#]/)[0] || /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(raw)) return null;
  const base = new URL("https://repo.invalid/");
  base.pathname = fromPath;
  let at: URL;
  try {
    at = new URL(raw, base);
  } catch {
    return null;
  }
  if (at.host !== "repo.invalid") return null;
  return at.pathname.slice(1).split("/").map((seg) => percentDecode(seg)).join("/");
}

/** The URL prefixes of the knowledge repo, when it's on GitHub. */
export function repoUrls(repo: Repo): string[] {
  const name = repo.config.github.repo?.toLowerCase();
  if (!name) return [];
  const api = repo.config.github.api_url;
  const host = api ? new URL(api).host.toLowerCase() : "github.com";
  return host === "github.com" || host === "api.github.com" ? [`github.com/${name}/`, `raw.githubusercontent.com/${name}/`] : [`${host}/${name}/`, `${host}/raw/${name}/`];
}

const ATTR = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

/** Each way `text`, served as page `fromPath`, still reaches a hidden page; empty when none. */
export function leaks(text: string, fromPath: string, repo: Repo, who: Identity): string[] {
  const hidden = hiddenPaths(repo, who);
  if (!hidden.size) return [];
  const root = repo.config.knowledge_root;
  const out: string[] = [];
  const loaded = new Set(repo.pages.map((p) => p.path));
  const urls = repoUrls(repo);
  const site = siteModel(repo, who);
  const check = (what: string, dest: string) => {
    const t = target(dest, fromPath, root, hidden, urls);
    if (t && (hidden.has(t) || (t.endsWith(".md") && !loaded.has(t)))) out.push(`${what} ${JSON.stringify(dest)} → ${t}`);
    // As a browser resolves it, exactly (WHATWG URL): a markdown destination's `\\` reaches
    // the href as `%5C`, so `zz%5C../../x.md` climbs one directory, not two.
    const exact = browserPath(dest, fromPath);
    if (exact && hidden.has(exact)) out.push(`${what} ${JSON.stringify(dest)} → ${exact}, as a browser resolves it`);
    const on = siteTarget(dest, fromPath, site, what === "html");
    if (on === "hidden" || on === "nothing") out.push(`${what} ${JSON.stringify(dest)} → a route naming ${on === "hidden" ? "a hidden page" : "nothing"}`);
  };
  const walker = new Parser().parse(text).walker();
  for (let e = walker.next(); e; e = walker.next()) {
    const node = e.node;
    if (!e.entering) continue;
    if (node.type === "link" || node.type === "image") check(node.type, node.destination ?? "");
    if (node.type === "html_inline" || node.type === "html_block")
      for (const m of (node.literal ?? "").matchAll(ATTR)) check("html", decodeHTML(m[1] ?? m[2] ?? m[3] ?? "").replace(/[\t\n\r]/g, ""));
  }
  // And as rendered: each block's text as it shows, markup gone, a soft break a space
  // (`team/**x.md**` shows `team/x.md`).
  const shown: string[] = [];
  const rw = new Parser().parse(text).walker();
  let block = "";
  for (let e = rw.next(); e; e = rw.next()) {
    const n = e.node;
    if (e.entering && (n.type === "text" || n.type === "code")) block += n.literal ?? "";
    else if (e.entering && (n.type === "softbreak" || n.type === "linebreak")) block += " ";
    else if (e.entering && n.type === "code_block") shown.push(n.literal ?? "");
    // Raw HTML isn't added: its attributes don't show, and the source is read below anyway.
    else if (!e.entering && (n.type === "paragraph" || n.type === "heading")) {
      shown.push(block);
      block = "";
    }
  }
  // And as a browser shows the HTML: raw HTML ends where HTML ends it, which can be sooner
  // than CommonMark's end (`<?>x?>` shows `x?>`). A line break is a space, as above.
  if (text.includes("<")) shown.push(createDocument(new HtmlRenderer().render(new Parser().parse(text))).body.textContent!.replace(/\n/g, " "));
  // As a person reads it. A path under the root is a leak where a path could start (not
  // after a letter, digit or `/`: `team/security/x.md` may be another page's path), unless
  // the path it ends, read from this page, is a page the reader can see (from inside
  // `team space/`, `security/x.md` is `team space/security/x.md`).
  // A `\` left after the escapes reads as `/`, as it does to a browser.
  const unescaped = decodeHTML(text).replace(/\\([!-/:-@[-`{-~])/g, "$1");
  const read = `${percentDecode(unescaped)}\n${shown.join("\n")}`.replace(/\\/g, "/");
  const visible = new Set(repo.pages.filter((p) => canSee(p, who)).map((p) => p.path));
  // A GitHub URL into the repo, written out in text, to a path that is no page: every
  // token a browser's URL parser reads as one into the repo (`ｇithub.com` is github.com).
  for (const token of `${unescaped}\n${shown.join("\n")}`.split(/[\s"'<>`|[\]()]+/)) {
    if (!/[./]/.test(token)) continue;
    const t = inRepo(token.replace(/[).,;:!?*_~]+$/, ""), root, urls);
    if (t && t.endsWith(".md") && !loaded.has(t)) out.push(`text holds a URL to ${t}`);
  }
  // A URL on the docs site, written out: as an autolink shows it (whole, to a space or `<`)
  // and as GFM links it bare (trailing punctuation and an unpaired `)` cut). A hidden page's
  // route by either is a leak; a route naming nothing is, unless the other reading names a
  // visible page (a sentence's `.`).
  if (site.host) {
    // A URL on the docs site, written out, to a hidden page's route: wherever one starts in a
    // token, as a reader picks it out (at a scheme, at `//`, or at the site's host where a
    // host can start: `www.docs.example.com` is another host), as an autolink shows it
    // (whole) and as GFM links it bare (trailing punctuation and an unpaired `)` cut). One
    // naming nothing counts only as a link (above): text can cut a URL short.
    const host = site.host.replace(/:\d+$/, "").replace(/[.]/g, "\\.");
    const start = new RegExp(`[a-z][a-z0-9+.-]*:\\/\\/|\\/\\/|(?<![a-z0-9.-])${host}`, "gi");
    // Percent-decoded too: `https:%2F%2Fdocs.example.com/…` in another URL reads as the site's.
    for (const whole of `${unescaped}\n${shown.join("\n")}\n${percentDecode(unescaped)}`.split(/[\s<>"'`]+/)) {
      // From every place one starts, not the first only (code review, round 4: an archive's
      // URL can hold the host twice before the site's URL). And wherever a URL parser reads
      // the site's host, mapped as it maps one (fullwidth letters, IDNA's dots: round 8):
      // the token's start, or after a separator a URL holds before a host.
      const places = new Set([...whole.matchAll(start)].map((m) => m.index));
      for (const m of whole.matchAll(/(?:^|[/=?&:@(\\])(?=[^/=?&:@(\\])/g)) {
        const at = m.index + m[0].length;
        try {
          if (new URL(`https://${whole.slice(at)}`).hostname.replace(/\.$/, "") === site.host!.replace(/:\d+$/, "")) places.add(at);
        } catch {
          /* no host there */
        }
      }
      for (const at of places) {
        const token = whole.slice(at);
        const readings = [token, gfmTrim(token)].map((t) => (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(t) ? t : `https://${t}`)).map((t) => siteTarget(t, fromPath, site));
        if (readings.includes("hidden")) {
          out.push(`text holds a site URL ${JSON.stringify(token)}`);
          break;
        }
      }
    }
  }
  for (const h of hidden) {
    const under = h.slice(root.length + 1);
    if (read.includes(h)) {
      out.push(`text holds ${h}`);
      continue;
    }
    // And the path from this page's directory, which is how a sibling names it in text.
    const fromHere = posix.relative(posix.dirname(fromPath), h);
    for (const spelled of new Set([under, fromHere])) {
    if (!spelled.includes("/")) continue;
    for (const m of read.matchAll(new RegExp(`(?:^|[^\\w/])(${spelled.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "g"))) {
      const at = m.index + m[0].length - m[1]!.length;
      const token = /[^\s"'()<>[\]`*|=:]*$/.exec(read.slice(0, at))![0] + m[1]!;
      const t = token.replace(/\\/g, "/");
      if (!visible.has(t.startsWith("/") ? posix.normalize(t.slice(1)) : posix.normalize(posix.join(posix.dirname(fromPath), t)))) {
        out.push(`text holds ${spelled}`);
        break;
      }
    }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// A docs site's routes, as Docusaurus documents them. Nothing here comes from src/core: the
// frontmatter is read from disk with the `yaml` package, not taken from the loader.

/** What a docs site serves, for one reader: each page's route, hidden pages' file stems, and the site. */
export interface Site {
  /** Route (lower case, no outer slashes) → hidden; hidden wins a route two pages share. */
  routes: Map<string, boolean>;
  /** Hidden pages' paths under the root without `.md`, lower case. */
  stems: Set<string>;
  /** Each page's repo path → its route. */
  pageUrl: Map<string, string>;
  /** `site_url`'s host (port included unless it's the default) and path prefix, if set. */
  host?: string;
  prefix?: string;
  root: string;
  repoRoot: string;
}

// Docusaurus keeps a date's or a version's numbers (`2024-01-02-x`, `1.0-x`) and strips any
// other number prefix (`01-intro`, `2 - setup`) from file and directory names.
const KEPT_NUMBERS = /^(?:\d{4}[-_.]\d{1,2}[-_.]\d{1,2}|\d+[-_.]\d+)/;
const NUMBER_PREFIX = /^\d+\s*[-_.]+\s*([^-_.\s].*)$/;
const unnumbered = (name: string) => (KEPT_NUMBERS.test(name) ? name : (NUMBER_PREFIX.exec(name)?.[1] ?? name));
/** A path clamped at the site's root, without its outer slashes, in lower case. */
const siteClean = (p: string) => posix.normalize(`/${p}`).replace(/^\/+|\/+$/g, "").toLowerCase();

/**
 * Where Docusaurus serves a doc at `under` (its path under the docs root): its `slug`
 * (absolute, or relative to its directory); else, for a category index (`index`, `README`,
 * or named after its directory), its directory; else its directory and its `id`, or its
 * file name without a number prefix.
 */
export function docRoute(under: string, slug?: string, id?: string): string {
  const segs = under.replace(/\.md$/i, "").split("/");
  const file = segs.pop()!;
  const dirs = segs.map(unnumbered);
  const index = ["index", "readme", segs.at(-1)?.toLowerCase()].includes(file.toLowerCase());
  if (slug !== undefined) return siteClean(slug.startsWith("/") ? slug : [...dirs, slug].join("/"));
  return siteClean(index ? dirs.join("/") : [...dirs, id ?? unnumbered(file)].join("/"));
}

function frontmatter(repoRoot: string, path: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(repoRoot, path), "utf8"));
  try {
    const data = m ? parseYaml(m[1]!) : undefined;
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const MODELS = new WeakMap<Repo, Map<string, Site>>();
export function siteModel(repo: Repo, who: Identity): Site {
  const key = `${who.repoAccess}:${[...who.teams].sort()}`;
  let byWho = MODELS.get(repo);
  if (!byWho) MODELS.set(repo, (byWho = new Map()));
  const known = byWho.get(key);
  if (known) return known;
  const root = repo.config.knowledge_root;
  const hidden = hiddenPaths(repo, who);
  const site: Site = { routes: new Map(), stems: new Set(), pageUrl: new Map(), root, repoRoot: repo.root };
  for (const path of [...repo.pages.map((p) => p.path), ...repo.invalid.map((p) => p.path)]) {
    const fm = frontmatter(repo.root, path);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const under = path.slice(root.length + 1);
    const route = docRoute(under, str(fm.slug), str(fm.id));
    const isHidden = hidden.has(path);
    site.routes.set(route, (site.routes.get(route) ?? false) || isHidden);
    site.pageUrl.set(path, route);
    if (isHidden) site.stems.add(under.replace(/\.md$/i, "").toLowerCase());
  }
  if (repo.config.site_url) {
    const u = new URL(repo.config.site_url);
    site.host = `${u.hostname.replace(/\.$/, "")}${u.port ? `:${u.port}` : ""}`.toLowerCase();
    site.prefix = percentDecode(u.pathname).replace(/\/+$/, "").toLowerCase();
  }
  byWho.set(key, site);
  return site;
}

/** A bare URL as GFM links it: trailing punctuation and an unpaired `)` cut. */
function gfmTrim(t: string): string {
  for (;;) {
    const cut = t.replace(/[?!.,:*_~]+$/, "");
    if (cut.endsWith(")") && (cut.match(/\)/g) ?? []).length > (cut.match(/\(/g) ?? []).length) t = cut.slice(0, -1);
    else if (cut !== t) t = cut;
    else return t;
  }
}

/**
 * What a docs site serves at a link written on `fromPath` (its destination decoded as
 * CommonMark or HTML decodes it): "hidden" for a hidden page's route or file stem,
 * "visible" for a visible page's route, "nothing" for a route no page has (it fails
 * closed), or null when it isn't a route there: a file, a repo path outside the knowledge
 * root, a URL elsewhere.
 */
export function siteTarget(dest: string, fromPath: string, site: Site, html = false): "hidden" | "visible" | "nothing" | null {
  // A markdown destination's `\` reaches the href as `%5C`, which a browser keeps; in raw
  // HTML a browser reads it as `/`. That's where the link goes. Read as `/` anyway, it still
  // counts when it names a hidden page (the liberal reading, as `target` reads paths).
  const raw = dest.trim().replace(/[\t\n\r]/g, "");
  const as = siteReading(html ? raw.replace(/\\/g, "/") : raw, fromPath, site);
  if (as === "hidden" || html || !raw.includes("\\")) return as;
  return siteReading(raw.replace(/\\/g, "/"), fromPath, site) === "hidden" ? "hidden" : as;
}

function siteReading(raw: string, fromPath: string, site: Site): "hidden" | "visible" | "nothing" | null {
  let readings: string[];
  let route: string;
  let repoPath: string | undefined;
  if (/^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(raw)) {
    if (!site.host) return null;
    let u: URL;
    try {
      u = new URL(/^[\\/]{2}/.test(raw) ? `https:${raw}` : raw);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(u.protocol) || `${u.hostname.replace(/\.$/, "")}${u.port ? `:${u.port}` : ""}`.toLowerCase() !== site.host) return null;
    const path = percentDecode(u.pathname).toLowerCase();
    if (path !== site.prefix && !path.startsWith(`${site.prefix}/`)) return null;
    route = path.slice(site.prefix!.length) || "/";
    readings = [siteClean(route)];
  } else {
    const path = raw.split(/[?#]/)[0]!;
    route = percentDecode(path);
    if (!route) return null;
    // Resolved as a browser resolves it (WHATWG URL: `%2F` no separator, `%2e` a dot), then
    // decoded, as a server reads what it's sent (code review, round 7).
    // Its dot segments resolved again once decoded, as a server reads `a/..%2Fb` (`b`).
    const against = (base: string) => {
      try {
        return posix.normalize(percentDecode(new URL(path, `https://site.invalid${base}`).pathname));
      } catch {
        return undefined;
      }
    };
    if (path.startsWith("/")) {
      const r = siteClean(against("/") ?? route);
      readings = r === "docs" || r.startsWith("docs/") ? [r, siteClean(r.slice(4))] : [r];
      repoPath = (against("/") ?? `/${route}`).slice(1);
    } else {
      // Against the page's URL, which a site may serve with a trailing slash or without.
      const url = site.pageUrl.get(fromPath);
      readings = url === undefined ? [] : [against(`/${url}`), against(`/${url}/`)].filter((r): r is string => r !== undefined).map(siteClean);
      repoPath = against(`/${fromPath}`)?.slice(1);
    }
  }
  const named = readings.map((r) => site.routes.get(r));
  if (named.includes(true)) return "hidden";
  if (named.includes(false)) return "visible";
  const underRoot = repoPath !== undefined && (repoPath === site.root || repoPath.startsWith(`${site.root}/`));
  const stems = [...readings, ...(underRoot ? [repoPath!.slice(site.root.length + 1).toLowerCase()] : [])];
  if (stems.some((s) => site.stems.has(s))) return "hidden";
  const shaped = route.endsWith("/") || posix.extname(route).length <= 1;
  if (!shaped) return null;
  if (repoPath === undefined || underRoot) return "nothing";
  // A file or directory in the repo, outside the knowledge root: a link to that, neutral.
  const inside = !repoPath.startsWith("../") && repoPath !== ".." && !repoPath.startsWith("/");
  return inside && existsSync(join(site.repoRoot, repoPath)) ? null : "nothing";
}

// ---------------------------------------------------------------------------------------
// The generator: ways to write a reference to a page, as CommonMark, GFM and HTML allow.

export type Rng = () => number;
/** mulberry32: small, seeded, and the same on every machine. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** A path from `fromPath` to `to` (repo paths), in one of the forms a writer might use. */
function pathForm(r: Rng, fromPath: string, to: string, root: string): string {
  const rel = posix.relative(posix.dirname(fromPath), to);
  switch (Math.floor(r() * 10)) {
    case 0:
      return `./${rel}`;
    case 1:
      return `/${to}`; // root-relative
    case 2:
      return `zz/../${rel}`;
    case 3:
      return `https://github.com/acme/knowledge/blob/main/${to}`;
    case 4:
      return `//github.com/acme/knowledge/blob/main/${to}`;
    case 5:
      // A Windows path: a browser reads `\` as `/`. Not before punctuation, where CommonMark
      // reads it as an escape (`..\..` is `...`): a link nobody could follow.
      return rel.replace(/\/(?=[A-Za-z0-9])/g, "\\");
    case 6:
      return `${rel}${pick(r, ["#section", "?plain=1", "?a=1#b"])}`;
    case 7:
      return posix.join(posix.relative(posix.dirname(fromPath), root), "..", root, to.slice(root.length + 1));
    case 8:
      // The same GitHub URL as a browser still reads it: a port, userinfo, case.
      return pick(r, [
        `https://github.com:443/acme/knowledge/blob/main/${to}`,
        `https://someone@github.com/acme/knowledge/blob/main/${to}`,
        `HTTPS://GitHub.com./acme/knowledge/tree/main/${to}`,
        `https:github.com/acme/knowledge/blob/main/${to}`,
        // A host a URL parser maps to github.com: fullwidth, an ideographic full stop, encoded.
        `https://\uff47ithub.com/acme/knowledge/blob/main/${to}`,
        `https://github\u3002com/acme/knowledge/blob/main/${to}`,
        `https://%67ithub.com/acme/knowledge/blob/main/${to}`,
        `https://git\u00adhub.com/acme/knowledge/blob/main/${to}`,
      ]);
    default:
      return rel;
  }
}

const ENCODE: Record<string, string[]> = {
  ".": ["&period;", "&#46;", "&#x2E;", "%2E", "%2e", "\\.", "&#46"],
  "/": ["&sol;", "&#47;", "%2F", "\\/", "&#x2f;", "&bsol;", "&#92;"],
  "-": ["&#45;", "%2D", "\\-", "&#x2d;"],
  " ": ["%20", "&#32;"],
  e: ["%65", "&#101;"],
  é: ["%C3%A9", "&eacute;", "&#233;", "&#xE9;"],
};

/** Encode some characters of a destination the ways CommonMark and URLs decode them. */
function encode(r: Rng, dest: string, html: boolean): string {
  if (r() < 0.5) return dest;
  let out = "";
  for (const c of dest) {
    const ways = (ENCODE[c] ?? []).filter((w) => !html || !w.startsWith("\\")); // no escapes in HTML
    out += ways.length && r() < 0.3 ? pick(r, ways) : c;
  }
  return out;
}

const WORDS = ["alpha", "bravo", "see", "the", "runbook", "first", "then", "zulu"];
const words = (r: Rng, n: number) => Array.from({ length: n }, () => pick(r, WORDS)).join(" ");

/** One snippet of markdown that references `dest` (already a path form). */
function form(r: Rng, raw: string): string {
  const spaced = /\s/.test(raw);
  const plain = raw.replace(/ /g, "%20"); // a plain destination can't hold a space
  const d = encode(r, plain, false);
  const h = encode(r, raw, true);
  const t = words(r, 2);
  const forms: (() => string)[] = [
    () => `[${t}](${d})`,
    () => `[${t}](<${encode(r, raw, false)}>)`,
    () => `[${t}](${d} "${words(r, 1)}")`,
    () => `![${t}](${d})`,
    () => `[${t} [${words(r, 1)}] more](${d})`,
    () => `[${t} \\] more](${d})`,
    () => `[${t}](\n${d}\n)`,
    () => `[${t}][Ref]\n\n[ref]: ${d}`,
    () => `[ref][]\n\n[ref]: ${d} "title"`,
    () => `[ref]\n\n[ref]:\n${d}`,
    () => `[ref]\n\n[ref]: ${d}\n  'title'`,
    () => `> [ref]\n>\n> [ref]: ${d}`,
    () => `- [ref]: ${d}\n\n[ref]`,
    () => `1. item\n\n   [ref]: ${d}\n\n   [ref]`,
    () => `[ref]:${d}\n\n[ref]`,
    // Labels CommonMark matches as one though written apart: case folded as Unicode folds
    // it (`ß` is `SS`), an escaped bracket, runs of space, a line break (code review, round 2).
    () => {
      const [use, def] = pick(r, LABEL_PAIRS);
      return `[${use}]\n\n[${def}]: ${d}`;
    },
    () => {
      const [use, def] = pick(r, LABEL_PAIRS.filter(([u]) => !u.includes("\n")));
      return `> [${t}][${use}]\n>\n> [${def}]: ${d}`;
    },
    // After an escaped backslash, the bracket opens a reference (code review, round 3).
    () => `> \\\\[ref]\n>\n> [ref]: ${d}`,
    // A reference image, in a quote (merge gate, PR 53).
    () => `> ![${t}][ref]\n>\n> [ref]: ${d}`,
    // A full reference whose text wraps (merge gate, PR 53, round 2), and holds brackets of
    // its own (round 3).
    () => `> [${t}\n> y][ref]\n>\n> [ref]: ${d}`,
    // Text holding a code span with a bracket, which closes nothing (Codex, PR 54).
    () => `> ${pick(r, ["", "!"])}[${t} \`]\`\n> y][ref]\n>\n> [ref]: ${d}`,
    () => `> [${t} [x]\n> y][ref]\n>\n> [ref]: ${d}`,
    () => `<a href="${h}">${t}</a>`,
    () => `<a href='${h}'>${t}</a>`,
    () => `<a href=${spaced ? encode(r, plain, true) : h}>${t}</a>`,
    () => `<img src="${h}" alt="x">`,
    () => `<A HREF = "${h}">${t}</A>`,
    () => `<a\n  href="${h}">${t}</a>`,
    () => {
      const cut = Math.max(1, Math.floor(r() * h.length));
      return `<a href="${h.slice(0, cut)}\n${h.slice(cut)}">${t}</a>`;
    },
    () => `${words(r, 3)} \`${raw}\` ${words(r, 2)}`,
    () => {
      // Markup inside a URL's host: it renders away too (`git**hub.com**`).
      if (!raw.includes("github.com")) return `${words(r, 3)} ${raw} ${words(r, 2)}`;
      const split = pick(r, ["git**hub.com**", "git<b></b>hub.com", "github<!---->.com", "git_hub_.com"]);
      return `${words(r, 2)} ${raw.replace("github.com", split)} ${words(r, 2)}`;
    },
    () => {
      // Markup inside the path: it renders away (`team/**x.md**` shows `team/x.md`).
      const cut = raw.lastIndexOf("/") + 1 + Math.floor(r() * 3);
      const mark = pick(r, ["**", "*", "_", "~~", "`", "link"]);
      // An anchor: a destination naming no page (a route naming nothing fails closed).
      if (mark === "link") return `${words(r, 2)} [${raw.slice(0, cut)}](#x)${raw.slice(cut)} ${words(r, 2)}`;
      return `${words(r, 2)} ${raw.slice(0, cut)}${mark}${raw.slice(cut)}${mark} ${words(r, 2)}`;
    },
    () => {
      // Raw HTML inside the path, which shows as nothing: a comment, a processing
      // instruction, CDATA, a declaration or a tag, some ended sooner by a browser than by
      // CommonMark (`<?>x?>` shows `x?>`), and a comment opener inside a tag's quoted value.
      const cut = raw.lastIndexOf("/") + 1 + Math.floor(r() * 3);
      const [open, close] = pick(r, HTML_GAPS);
      return `${words(r, 2)} ${raw.slice(0, cut)}${open}${raw.slice(cut)}${close} ${words(r, 2)}`;
    },
    () => `${words(r, 3)} ${raw} ${words(r, 2)}`,
    () => `| a | [${t}](${d}) |\n| - | - |`,
    () => `*[${t}](${d})*`,
  ];
  return pick(r, forms)();
}

/** The indices of `a`'s lines that `b` keeps, in order: a longest common subsequence. */
function keptLines(a: readonly string[], b: readonly string[]): Set<number> {
  const n = a.length;
  const m = b.length;
  const longest = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) longest[i]![j] = a[i] === b[j] ? longest[i + 1]![j + 1]! + 1 : Math.max(longest[i + 1]![j]!, longest[i]![j + 1]!);
  const kept = new Set<number>();
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      kept.add(i++);
      j++;
    } else if (longest[i + 1]![j]! >= longest[i]![j + 1]!) i++;
    else j++;
  }
  return kept;
}

const LABEL_PAIRS: readonly (readonly [string, string])[] = [
  ["Straße", "STRASSE"],
  ["a\\]b", "A\\]B"],
  ["a\\[b", "A\\[B"],
  ["two  words", "TWO words"],
  ["wrapped\nlabel", "Wrapped Label"],
];

const HTML_GAPS: readonly (readonly [string, string])[] = [
  ["<!--x-->", ""],
  ["<!-->", "<!-- x -->"],
  ["<!--->", ""],
  ["<!-- a --!>", " -->"],
  ["<!-- a --!> b -->", ""],
  ["<!-- <![CDATA[ -->", " ]]>"],
  ["<?x?>", ""],
  ["<?>", "?>"],
  ["<![CDATA[x]]>", ""],
  ["<![CDATA[>", "]]>"],
  ["<!X y>", ""],
  ['<span title="a<b>">', ""],
  ['<span title="<!--">', '<span title="-->">'],
];

/** Wrap a snippet in a container now and then. */
function contain(r: Rng, s: string): string {
  switch (Math.floor(r() * 6)) {
    case 0:
      return s.replace(/^/gm, "> ");
    case 1:
      return `- ${s.replace(/\n/g, "\n  ")}`;
    case 2:
      return `${words(r, 4)}\n${s}`;
    default:
      return s;
  }
}

/** A body for page `fromPath` that references pages from `targets`, in random forms. */
export function body(r: Rng, fromPath: string, targets: readonly string[], root: string, snippets = 1 + Math.floor(r() * 3)): string {
  const parts: string[] = [];
  for (let i = 0; i < snippets; i++) parts.push(contain(r, form(r, pathForm(r, fromPath, pick(r, targets), root))));
  return parts.join(r() < 0.7 ? "\n\n" : "\n");
}

/**
 * A route form for `to` from page `fromPath`, as a docs site's writer might link it: `to` is a
 * page's repo path (linked by its route, from its URL or by its file's stem) or a route that
 * is no page's (`src`, `guides/gone`). Some are on the site at `site_url`, some on another
 * service that only looks like it (`docs-archive`, `www.`, another port).
 */
function routeForm(r: Rng, fromPath: string, to: string, site: Site): string {
  const route = site.pageUrl.get(to) ?? to;
  const here = site.pageUrl.get(fromPath) ?? "";
  // From the page's URL, without a trailing slash and with one.
  const rel = posix.relative(posix.dirname(`/${here}`), `/${route}`) || ".";
  const relSlash = posix.relative(`/${here}`, `/${route}`) || ".";
  const stem = to.endsWith(".md") ? posix.relative(posix.dirname(fromPath), to).replace(/\.md$/, "") : rel;
  return pick(r, [
    `/${route}`,
    `/${route}/`,
    `/docs/${route}`,
    `/${route}?tab=1`,
    rel,
    relSlash,
    `${rel}#part`,
    stem,
    `https://docs.example.com/docs/${route}`,
    `https://docs.example.com/docs/${route}/?a=1#b`,
    `HTTP://Docs.Example.com.:80/docs/${route}`,
    `//docs.example.com/docs/${route}`,
    `https://docs.example.com/docs-archive/${route}`,
    `https://www.docs.example.com/docs/${route}`,
    `https://docs.example.com:8443/docs/${route}`,
    // An archive's copy: another site's URL holding the site's (code review, rounds 3 and 4).
    `https://web.archive.org/web/2026/https://docs.example.com/docs/${route}`,
    `https://web.archive.org/web/docs.example.com/https://docs.example.com/docs/${route}`,
    `https://web.archive.org/web/docs%2eexample.com/docs/${route}`,
    // Userinfo between the scheme and the host (merge gate, PR 53, round 3).
    `https://web.archive.org/web/http://user@docs.example.com:80/docs/${route}`,
    // A host a URL parser maps, with no `//` before it (code review, round 8).
    `https://web.archive.org/web/\uff44\uff4f\uff43\uff53.example.com/docs/${route}`,
  ]);
}

/** A body for page `fromPath` that links `targets` (page paths, or routes no page has) in route forms. */
export function routeBody(r: Rng, fromPath: string, targets: readonly string[], site: Site, snippets = 1 + Math.floor(r() * 3)): string {
  const parts: string[] = [];
  for (let i = 0; i < snippets; i++) parts.push(contain(r, form(r, routeForm(r, fromPath, pick(r, targets), site))));
  return parts.join(r() < 0.7 ? "\n\n" : "\n");
}

/**
 * The labels of `original`'s link definitions (commonmark.js's, the first for each label)
 * that reach a hidden page, or a route naming nothing, whose references are left once
 * redacted (`out`): a definition gone and its reference left shows the reference's label.
 * Code review, rounds 1 and 2. Told exactly as CommonMark matches labels (case folded as
 * Unicode folds it, escapes, runs of space): a probe definition for each label goes before
 * `out`, and a reference left resolves to its probe.
 */
export function labelsLeft(original: string, out: string, fromPath: string, repo: Repo, who: Identity): string[] {
  const parser = new Parser();
  parser.parse(original);
  const refmap = (parser as unknown as { refmap: Record<string, { destination: string }> }).refmap;
  // A definition reaches a hidden page as a link to its destination would. The placeholder's
  // own label isn't one to probe: it stands in every redacted line.
  const bad = Object.entries(refmap)
    .filter(([label, d]) => label !== "RESTRICTED PAGE" && leaks(`[x](<${d.destination.replace(/[<>]/g, (c) => encodeURIComponent(c))}>)`, fromPath, repo, who).length)
    .map(([label]) => label);
  if (!bad.length) return [];
  // First: after the text, a fence it never closes would make them code. And first, a
  // probe wins over any definition of the same label left in the text.
  // The labels it references, read the same way in the text before and after: only one
  // the original references can leave a reference (a line redaction replaced can make text
  // a reference, `[ref]` under an `<img>` that started an HTML block, but it showed the same).
  // Each reference: its label's index, and its text as it renders.
  const references = (text: string) => {
    const found: string[] = [];
    const walker = new Parser().parse(`${bad.map((label, i) => `[${label}]: https://label.invalid/${i}`).join("\n")}\n\n${text}`).walker();
    for (let e = walker.next(); e; e = walker.next()) {
      // A link or an image (merge gate, PR 53: `![HSM]` is a reference too).
      const m = e.entering && (e.node.type === "link" || e.node.type === "image") ? /^https:\/\/label\.invalid\/(\d+)$/.exec(e.node.destination ?? "") : null;
      if (!m) continue;
      let shown = "";
      const inside = e.node.walker();
      for (let f = inside.next(); f; f = inside.next()) if (f.entering && f.node !== e.node) shown += f.node.literal ?? (f.node.type === "softbreak" ? "\n" : "");
      found.push(`${m[1]}:${shown}`);
    }
    return found;
  };
  // A reference left is one the original has, label and text alike: a line redaction
  // replaced can make text a reference, even of a label the original references elsewhere
  // (`[runbook][ref]` under an `<img>` that started an HTML block showed the same before).
  // One redaction changed part of is the line check's, below.
  const before = references(original);
  const index = (r: string) => Number(r.slice(0, r.indexOf(":")));
  const pool = [...before];
  const left = new Set<number>();
  for (const r of references(out)) {
    const k = pool.indexOf(r);
    if (k < 0) continue;
    pool.splice(k, 1);
    left.add(index(r));
  }
  const found = [...left].map((i) => `a reference's label shows: [${bad[i]}]`);
  // And no line `out` keeps holds part of one: its text shows (merge gate, PR 53, rounds 2
  // and 3: a full reference's text wrapped to the line before, or holding brackets of its
  // own). A line holds part of one where changing its letters changes one of those
  // references, or ends it: letters only, so the line's structure stays. A line kept is one
  // `out` holds in the same order (a longest common subsequence of lines): the sweep keeps
  // each line in its place, but the first pass can join a reference's lines into one.
  const lines = original.split("\n");
  const kept = keptLines(lines, out.split("\n"));
  lines.forEach((line, i) => {
    if (!kept.has(i) || !/[a-z]/i.test(line)) return;
    const changed = lines.map((l, j) => (j === i ? l.replace(/[a-z]/gi, (c) => (c.toLowerCase() === "q" ? "j" : "q")) : l)).join("\n");
    const after = references(changed);
    if (before.some((r) => !after.includes(r))) found.push(`a reference's text shows, on line ${i + 1}: ${JSON.stringify(line)}`);
  });
  return found;
}
