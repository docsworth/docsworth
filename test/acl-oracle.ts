import { posix } from "node:path";
import { createDocument } from "@mixmark-io/domino";
import { HtmlRenderer, Parser } from "commonmark";
import { decodeHTML } from "entities";
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
  const check = (what: string, dest: string) => {
    const t = target(dest, fromPath, root, hidden, urls);
    if (t && (hidden.has(t) || (t.endsWith(".md") && !loaded.has(t)))) out.push(`${what} ${JSON.stringify(dest)} → ${t}`);
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
      if (mark === "link") return `${words(r, 2)} [${raw.slice(0, cut)}](x)${raw.slice(cut)} ${words(r, 2)}`;
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
