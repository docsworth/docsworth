// A capture, made in the tab (R4, R7, R8): the live page copied as it's shown (clean.ts), its
// main content found (the page's own main element, else Readability), then markdown.
// This runs in the extension's isolated world: the page's own scripts can't reach it, but the
// page shapes everything it reads, so whoever receives the answer checks it (contract.ts).

import { isProbablyReaderable, Readability } from "@mozilla/readability";
import { type Extraction, MAX_TITLE, MAX_URL } from "../contract.js";
import { copySelection, copyVisible } from "./clean.js";
import { cleanUrl } from "./links.js";
import { cutMarkdown, toMarkdown } from "./markdown.js";
import { liveShown, type Shown } from "./visible.js";

export type Mode = "page" | "selection";

/** Around the main content, never part of it. */
const AROUND = "nav, aside, footer, [role=navigation], [role=search], [role=complementary], [role=contentinfo], [role=banner]";

/** `root`, copied, without what's around content: and, for a whole body, its header too. */
function without(root: Element, also = ""): Element {
  const copy = root.cloneNode(true) as Element;
  for (const el of copy.querySelectorAll(AROUND + also)) el.remove();
  return copy;
}

const count = (root: Element, selector: string) => root.querySelectorAll(selector).length;

/** The content's title, when it has exactly one top heading. */
function headingOf(root: Element): string {
  const h1 = root.querySelectorAll("h1");
  return h1.length === 1 ? (h1[0]!.textContent ?? "") : "";
}

/**
 * The page's main content.
 * - Where the page marks it, its `main` (or `[role=main]`) or its one `article`: a page that
 *   says where its content is knows better than a heuristic. Readability drops containers
 *   whose class says "header", and MDN keeps its title and intro in one. Inside main, its one
 *   article is the content when all of main's top headings are in it (a GitHub README; the
 *   rest of main is the repository's chrome); otherwise main is.
 * - Elsewhere Readability's (Firefox's Reader View), when Readability takes the page for an
 *   article, found something, and kept at least half the page's code blocks (it's tuned for
 *   articles, and docs are mostly code).
 * - Else the whole page, without its navigation, header and footer.
 */
function mainContent(doc: Document): { root: Element; title: string } {
  const main = doc.querySelector("main, [role=main]");
  const articles = (main ?? doc).querySelectorAll("article");
  // Inside main, its one article only when every top heading main has is in it: a heading
  // outside it says the article is part of the page (an embedded card), not the page.
  const only = articles.length === 1 ? articles[0]! : null;
  const headings = main ? [...main.querySelectorAll("h1")] : [];
  const one = only && (!main || (headings.length > 0 && headings.every((h) => only.contains(h)))) ? only : null;
  const marked = one ?? main;
  if (marked) {
    const root = without(marked);
    return { root, title: headingOf(root) };
  }
  const page = without(doc.body, ", header");
  if (!isProbablyReaderable(doc)) return { root: page, title: headingOf(page) };
  // Readability changes the document it reads, so it reads after the copy is taken.
  const article = new Readability(doc, { serializer: (el: Node) => el as Element }).parse();
  const content = article?.content ?? null;
  const usable = content && (content.textContent ?? "").trim() && count(content, "pre") * 2 >= count(page, "pre");
  return usable ? { root: content, title: article?.title?.trim() ?? "" } : { root: page, title: headingOf(page) };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The page's address as a source: without its tracking parameters. */
function sourceOf(win: Window): string {
  const href = win.location.href;
  return (cleanUrl(href) ?? href).slice(0, MAX_URL);
}

function extraction(win: Window, title: string, root: Node): Extraction {
  return { title: oneLine(title || win.document.title).slice(0, MAX_TITLE), url: sourceOf(win), ...cutMarkdown(toMarkdown(root)) };
}

/** The capture of `win`'s page or selection, or why there's none. */
export function captureIn(win: Window, mode: Mode, shown: Shown = liveShown(win)): Extraction | { error: string } {
  const doc = win.document;
  const out = doc.implementation.createHTMLDocument(doc.title);
  if (mode === "selection") {
    const sel = win.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return { error: "nothing is selected on this page" };
    const frag = out.createDocumentFragment();
    for (let i = 0; i < sel.rangeCount; i++) {
      const c = copySelection(sel.getRangeAt(i), out, shown);
      if (c) frag.append(c);
    }
    return extraction(win, doc.title, frag);
  }
  const body = doc.body ? copyVisible(doc.body, out, shown) : null;
  if (body) out.body.append(...body.childNodes);
  const { root, title } = mainContent(out);
  return extraction(win, title, root);
}
