import type { MirrorPage } from "./mirror-view.js";
import type { Page, Repo } from "./repo.js";
import { ACL_INTERNAL } from "./schema.js";
import { destinationHides, namingLines, type PageNames, pageNames, replaceLines } from "./references.js";

/**
 * Who is calling. In GitHub mode this comes from the caller's own token, so GitHub's
 * permissions are the ACL; in local mode (no github.repo) the filesystem is.
 */
export interface Identity {
  mode: "github" | "local";
  login: string | null;
  /** Team slugs (lowercase) in the configured org. */
  teams: ReadonlySet<string>;
  repoAccess: boolean;
  /** Push access to the knowledge repo: required to open PRs from a branch. */
  canWrite: boolean;
}

export function canSee(page: Pick<Page, "acl">, who: Identity): boolean {
  if (!who.repoAccess) return false;
  const acl = page.acl.toLowerCase();
  return acl === ACL_INTERNAL || who.teams.has(acl);
}

/** The ONLY way tools obtain pages. Everything downstream works on this filtered list. */
export function visiblePages(repo: Repo, who: Identity): Page[] {
  return repo.pages.filter((p) => canSee(p, who));
}

/** The mirrored pages `who` may see: the same rule as pages, on each space's `acl`. */
export function visibleMirror(mirror: readonly MirrorPage[], who: Identity): MirrorPage[] {
  return mirror.filter((m) => canSee(m, who));
}

export const RESTRICTED = "[restricted page]";
// Every span is bounded, and link text stops at a `[` (nested brackets are the sweep's):
// otherwise `[a` repeated (no `]`) made each `[` scan on, 1 s for 64 KB unbounded and
// still 270 ms on CI bounded. Longer link text or titles are left to the sweep after.
const TITLE = String.raw`(?:\s+(?:"[^"]{0,999}"|'[^']{0,999}'|\([^)]{0,999}\)))?`;
// The destination is matched once, in a lookahead, and never given back character by
// character: `[a](` repeated made each one retry 2,000 lengths. And it stops where it
// can't go on: an angle one at `<` (CommonMark), a plain one at `[` (rare in a real
// destination; the sweep after still reads one).
const INLINE = new RegExp(String.raw`!?\[([^\][]{0,999})\]\(\s*(?=(<[^<>\n]{0,999}>|[^)\s[]{1,2000}))\2${TITLE}\s*\)`, "g");
const REF_DEF = new RegExp(String.raw`^ {0,3}\[([^\][\n]{1,999})\]:[ \t]*(?=(<[^<>\n]{0,999}>|\S{1,2000}))\2${TITLE}[ \t]*$`, "gm");
// An anchor's opening tag, and its quoted href. Read in two steps, linear: one regex for
// the whole anchor backtracked between its parts (16 KB of `<a href="x">` took 1.7 s).
const A_OPEN = /<a\b[^<>]{0,999}>/gi;
// On one line: a value broken across lines (behind quote markers, say) is the sweep's.
const A_HREF = /\bhref\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/i;
const A_CLOSE = /<\/a\s*>/i;

/**
 * Is a link destination a page the caller may not see? Read as the URL it becomes:
 * escapes, character references and percent-encoding decoded, `\\` as `/`, query and
 * fragment cut, relative or root-relative. A URL counts when it ends with a hidden page's
 * path. Anything under the knowledge root that is not a loadable page fails closed: an
 * invalid page has no trustworthy ACL.
 */
function hidesPage(dest: string, fromPath: string, repo: Repo, who: Identity, html = false): boolean {
  return destinationHides(dest, fromPath, namesFor(repo, who), html);
}

/**
 * Rewrite every link to a page the caller cannot see, so a visible page (say the root
 * index) never reveals a hidden page's title or path: inline links and images, angle
 * destinations, reference-style links (full, collapsed and shortcut) with their
 * definitions, and HTML anchors.
 */
export function redactLinks(body: string, fromPath: string, repo: Repo, who: Identity): string {
  const hidden = (dest: string) => hidesPage(dest, fromPath, repo, who);

  // Reference definitions first: remember which labels point at hidden pages.
  const hiddenLabels = new Set<string>();
  let out = body.replace(REF_DEF, (whole, label: string, dest: string) => {
    if (!hidden(dest)) return whole;
    hiddenLabels.add(label.trim().toLowerCase());
    return "";
  });
  if (hiddenLabels.size) {
    // [text][label], [label][] and the shortcut form [label].
    out = out.replace(/\[([^\][]{0,999})\]\[([^\][]{0,999})\]/g, (whole, text: string, label: string) =>
      hiddenLabels.has((label || text).trim().toLowerCase()) ? RESTRICTED : whole,
    );
    out = out.replace(/\[([^\][]{1,999})\](?![(\[:])/g, (whole, label: string) => (hiddenLabels.has(label.trim().toLowerCase()) ? RESTRICTED : whole));
  }
  out = out.replace(INLINE, (whole, _text: string, dest: string) => (hidden(dest) ? RESTRICTED : whole));
  out = redactAnchors(out, (href) => hidesPage(href, fromPath, repo, who, true));
  // The passes above keep the rest of a line, but read only the common forms. The sweep
  // after them fails closed: a line that still names a hidden page, in any form a reader
  // resolves, goes whole (references.ts).
  return replaceLines(out, namingLines(out, fromPath, namesFor(repo, who)), RESTRICTED);
}

/** Each `<a href="…">…</a>` whose href is hidden, as the placeholder (its `</a>` within 4,000 characters). */
function redactAnchors(text: string, hidden: (href: string) => boolean): string {
  let out = "";
  let at = 0;
  for (const m of text.matchAll(A_OPEN)) {
    if (m.index < at) continue;
    const href = A_HREF.exec(m[0]);
    if (!href || !hidden(href[1] ?? href[2]!)) continue;
    const after = m.index + m[0].length;
    const close = A_CLOSE.exec(text.slice(after, after + 4000));
    if (!close) continue; // the sweep after still reads the tag
    out += text.slice(at, m.index) + RESTRICTED;
    at = after + close.index + close[0].length;
  }
  return out + text.slice(at);
}

// Per repo (a reload makes a new one) and per audience: the teams decide what's hidden.
const NAMES = new WeakMap<Repo, Map<string, PageNames>>();
function namesFor(repo: Repo, who: Identity): PageNames {
  const key = `${who.repoAccess}:${[...who.teams].sort().join(",")}`;
  let byAudience = NAMES.get(repo);
  if (!byAudience) NAMES.set(repo, (byAudience = new Map()));
  let names = byAudience.get(key);
  if (!names) byAudience.set(key, (names = pageNames(repo, (p) => !canSee(p, who))));
  return names;
}
