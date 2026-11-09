import { HtmlRenderer, Node, Parser } from "commonmark";

// Page markdown is untrusted text written by people. It renders through commonmark.js in
// safe mode (raw HTML dropped), after the tree is rewritten so that what reaches the page
// can only be text, in-app links and plain external links:
//   - an image becomes a link to it: nothing on a page is fetched by the viewer's browser
//   - a relative link that resolves to a page the viewer can see becomes an app route;
//     any other relative link becomes its text
//   - only http, https and mailto links stay links; every other scheme becomes its text
// The server has already replaced links to pages the viewer can't see with
// `[restricted page]`, which renders as that text.

export interface RenderOptions {
  /** The page's repo path, e.g. knowledge/runbooks/deploy-production.md. */
  pagePath: string;
  /** Visible pages by repo path, to turn relative links into app routes. */
  pageIds: ReadonlyMap<string, string>;
}

const EXTERNAL = /^(?:https?:|mailto:)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `target` resolved against `from`'s directory, as a repo path; null when it leaves the repo. */
export function resolveRelative(from: string, target: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** Where an app route for page `id` goes. */
export const pageRoute = (id: string) => `/p/${encodeURIComponent(id)}`;

function textOf(node: Node): string {
  let out = "";
  const walker = node.walker();
  for (let e = walker.next(); e; e = walker.next()) if (e.entering && e.node.literal && (e.node.type === "text" || e.node.type === "code")) out += e.node.literal;
  return out;
}

/** Replace `node` with its children, so a link becomes its text. */
function unwrap(node: Node): void {
  while (node.firstChild) node.insertBefore(node.firstChild);
  node.unlink();
}

/** The app route for a relative link, or null if it names no page the viewer can see. */
function routeFor(destination: string, opts: RenderOptions): string | null {
  const [pathPart, anchor] = destination.split("#", 2) as [string, string | undefined];
  if (!pathPart) return anchor !== undefined ? `#${anchor}` : null; // a link within the page
  let decoded: string;
  try {
    decoded = decodeURI(pathPart);
  } catch {
    return null;
  }
  const path = resolveRelative(opts.pagePath, decoded);
  const id = path ? opts.pageIds.get(path) : undefined;
  return id ? pageRoute(id) : null;
}

export function renderMarkdown(markdown: string, opts: RenderOptions): string {
  const doc = new Parser().parse(markdown);
  const links: Node[] = [];
  const images: Node[] = [];
  const walker = doc.walker();
  for (let e = walker.next(); e; e = walker.next()) {
    if (!e.entering) continue;
    if (e.node.type === "link") links.push(e.node);
    else if (e.node.type === "image") images.push(e.node);
  }
  // Images first: each becomes a link (to the same destination) labelled with its alt text.
  for (const img of images) {
    const link = new Node("link");
    link.destination = img.destination ?? "";
    const label = new Node("text");
    label.literal = `image: ${textOf(img) || img.destination || ""}`;
    link.appendChild(label);
    img.insertBefore(link);
    img.unlink();
    links.push(link);
  }
  for (const link of links) {
    const dest = (link.destination ?? "").trim();
    if (EXTERNAL.test(dest)) continue;
    const route = SCHEME.test(dest) || dest.startsWith("//") ? null : routeFor(dest, opts);
    if (route) link.destination = route;
    else unwrap(link);
  }
  const html = new HtmlRenderer({ safe: true }).render(doc);
  // External links open in a new tab and say nothing about where the reader came from.
  return html.replace(/<a href="((?:https?:|mailto:)[^"]*)"/gi, '<a href="$1" target="_blank" rel="noopener noreferrer"');
}
