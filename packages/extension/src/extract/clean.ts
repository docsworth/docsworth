// The live page, copied for a capture (R5, R6, R8): only what a person can see, only the
// elements and attributes a page of markdown can hold, built in another, inert document
// (nothing in it runs or loads). Everything after this step, Readability and the markdown,
// reads the copy and never the page.

import { cleanUrl } from "./links.js";
import { renderedParent, type Shown } from "./visible.js";

export type { Shown };

/** Never copied, with everything inside: nothing a reader of markdown could use. */
const DROP = new Set([
  "script", "style", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "canvas",
  "video", "audio", "source", "track", "map", "area", "input", "select", "textarea", "button", "option", "optgroup", "datalist",
  "output", "progress", "meter", "head", "link", "meta", "title", "base", "dialog", "portal",
]);

/** Copied as themselves. Anything else becomes a div or a span, as it's displayed. */
const KEEP = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "code", "strong", "b", "em", "i", "del", "s", "strike", "a",
  "br", "hr", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "dl", "dt", "dd", "div", "span", "section", "article",
  "main", "aside", "nav", "header", "footer", "figure", "figcaption", "details", "summary", "sup", "sub", "small", "mark", "abbr", "cite",
  "q", "time", "address", "form", "label", "fieldset", "legend",
]);
/** Shown as code. */
const CODE = new Set(["kbd", "samp", "tt", "var"]);
/** Parts of a structure that mean nothing on their own: a selection inside one starts from a div. */
const PART = new Set(["li", "tr", "td", "th", "thead", "tbody", "tfoot", "caption", "dt", "dd", "summary", "figcaption"]);

/**
 * Kept for Readability's scoring only (it reads class, id and role to tell an article from
 * navigation); the markdown never shows an attribute.
 */
const NAMES = ["class", "id", "role"];
/** A code block's language, as a fence's info string may hold it. */
const LANG = /(?:^|\s)(?:(?:language|lang|highlight-source|highlight)-|brush:\s*)([A-Za-z0-9_+#.-]{1,30})(?=[\s;]|$)/;
const SAFE_LANG = /^[A-Za-z0-9_+#.-]{1,30}$/;

/**
 * `here`: the page's own address without its fragment, so a link to another part of the same
 * page (a heading's anchor) keeps only its text: its fragment means nothing in a capture.
 */
type Ctx = { out: Document; shown: Shown; here: string | null; range?: Range };

/** Whether `node` is in the tree a selection's `range` lives in (the page's, not a shadow root's). */
const inRangeTree = (node: Node, range: Range) => node.getRootNode() === range.startContainer.getRootNode();

/**
 * Whether a selection's `range` leaves `node` out. A range lives in one tree (the page's): a
 * node there is in it only if the range reaches it. A node in a web component's shadow tree
 * can't be reached by it at all: the component is walked as it's rendered, keeping only the
 * way to its slots, which bring in the page's nodes for the range to decide on. Whatever else
 * only the shadow tree shows (its text, an image's alt) is left out, since the selection didn't
 * cover the whole component (copyElement).
 */
function outside(node: Node, range: Range | undefined): boolean {
  if (!range) return false;
  if (inRangeTree(node, range)) return !range.intersectsNode(node);
  return !(isElement(node) && (node.localName === "slot" || node.querySelector("slot") !== null));
}

const withoutHash = (u: string) => u.replace(/#.*$/, "");
const hereOf = (n: Node) => {
  const url = (n.ownerDocument ?? (n as Document)).URL;
  const clean = url ? cleanUrl(url) : null;
  return clean ? withoutHash(clean) : null;
};

const isText = (n: Node): n is Text => n.nodeType === 3;
const isElement = (n: Node): n is Element => n.nodeType === 1;

/** A text node's data, cut at the range's edges when it's where the range starts or ends. */
function textIn(t: Text, range?: Range): string {
  const start = range?.startContainer === t ? range.startOffset : 0;
  const end = range?.endContainer === t ? range.endOffset : t.data.length;
  return t.data.slice(start, end);
}

/**
 * The language of the code block `pre`, from it, its code, a wrapper (GitHub's
 * `highlight-source-*`), or the web component it's inside (MDN's `brush: http`).
 */
function languageOf(pre: Element): string {
  const host = (pre.getRootNode() as Partial<ShadowRoot>).host ?? null;
  const candidates = [pre, pre.querySelector(":scope > code"), pre.parentElement, pre.parentElement?.parentElement, host];
  for (const el of candidates) {
    if (!el) continue;
    const attr = el.getAttribute("data-lang") ?? el.getAttribute("data-language");
    if (attr && SAFE_LANG.test(attr)) return attr;
    const m = LANG.exec(el.getAttribute("class") ?? "");
    if (m && m[1] !== "source") return m[1]!;
  }
  return "";
}

/** What `el` shows inside it: a slot's assigned nodes (or its fallback), a host's shadow root, else its children. */
function shownChildren(el: Element): Node[] {
  if (el.localName === "slot") {
    const assigned = (el as HTMLSlotElement).assignedNodes?.({ flatten: true }) ?? [];
    if (assigned.length) return assigned;
  }
  return [...(el.shadowRoot ?? el).childNodes];
}

/** A code block as plain text: what's shown of it, a `<br>` as a line break. */
function codeText(el: Element, ctx: Ctx): string {
  let s = "";
  for (const n of shownChildren(el)) {
    if (outside(n, ctx.range)) continue;
    if (isText(n)) s += ctx.shown.text(n) ? textIn(n, ctx.range) : "";
    else if (isElement(n) && n.localName === "br") s += "\n";
    else if (isElement(n) && !DROP.has(n.localName) && ctx.shown.element(n)) s += codeText(n, ctx);
  }
  return s;
}

function copyPre(el: Element, ctx: Ctx): Element {
  const pre = ctx.out.createElement("pre");
  const lang = languageOf(el);
  if (lang) pre.setAttribute("data-lang", lang);
  pre.textContent = codeText(el, ctx);
  return pre;
}

function copyElement(el: Element, ctx: Ctx): Node | null {
  const tag = el.localName;
  if (DROP.has(tag) || !ctx.shown.element(el)) return null;
  if (tag === "img") {
    const alt = el.getAttribute("alt")?.replace(/\s+/g, " ").trim();
    return alt ? ctx.out.createTextNode(alt) : null;
  }
  if (tag === "pre") return copyPre(el, ctx);
  if (tag === "slot") {
    // In a shadow root: what's slotted into it, else its own fallback content.
    const assigned = (el as HTMLSlotElement).assignedNodes?.({ flatten: true }) ?? [];
    return copyChildren(assigned.length ? assigned : [...el.childNodes], ctx.out.createDocumentFragment(), ctx);
  }
  const copy = shell(el, ctx);
  // A web component shows its open shadow root, never its own children (only what its slots
  // bring in of them). A selection that covers the whole component takes all it shows; one
  // that starts or ends inside it keeps its edges, in what the slots bring in (outside()).
  if (!el.shadowRoot) return copyChildren([...el.childNodes], copy, ctx);
  // Only a component in the range's own tree can be seen to be covered: one nested in another's
  // shadow root can't contain the range's ends, though it may show them through its slots.
  const r = ctx.range;
  const covered = !r || (inRangeTree(el, r) && !(el.contains(r.startContainer) || el.contains(r.endContainer)));
  return copyChildren([...el.shadowRoot.childNodes], copy, covered ? { ...ctx, range: undefined } : ctx);
}

/** `el` as the copy holds it, without its contents: its tag or a div or span, and only the attributes kept. */
function shell(el: Element, ctx: Ctx): Element {
  const tag = el.localName;
  const name = KEEP.has(tag) ? tag : CODE.has(tag) ? "code" : /^(?:inline|none$)/.test(el.ownerDocument.defaultView?.getComputedStyle(el).display ?? "inline") ? "span" : "div";
  const copy = ctx.out.createElement(name);
  for (const a of NAMES) {
    const v = el.getAttribute(a);
    if (v !== null) copy.setAttribute(a, v.slice(0, 200));
  }
  if (tag === "a") {
    // The live element's href is already absolute; a link a reader shouldn't follow, or one to
    // another part of this page, keeps only its text.
    const href = cleanUrl((el as HTMLAnchorElement).href ?? "");
    if (href && !(href.includes("#") && withoutHash(href) === ctx.here)) copy.setAttribute("href", href);
  }
  if (tag === "ol") {
    const start = el.getAttribute("start");
    if (start && /^\d{1,6}$/.test(start)) copy.setAttribute("start", start);
  }
  return copy;
}

function copyChildren<T extends Node>(nodes: Node[], into: T, ctx: Ctx): T {
  for (const child of nodes) {
    const c = copyNode(child, ctx);
    if (c) into.appendChild(c);
  }
  return into;
}

function copyNode(node: Node, ctx: Ctx): Node | null {
  if (outside(node, ctx.range)) return null;
  if (isText(node)) return ctx.shown.text(node) ? ctx.out.createTextNode(textIn(node, ctx.range)) : null;
  return isElement(node) ? copyElement(node, ctx) : null;
}

/** `from` copied into `out`: only what's shown, only what markdown can hold. Null when none of it is. */
export function copyVisible(from: Node, out: Document, shown: Shown): Node | null {
  return copyNode(from, { out, shown, here: hereOf(from) });
}

/** Inline formatting a selection inside it keeps: a link, code, emphasis, a strikethrough. */
const WRAP = new Set(["a", "code", "kbd", "samp", "tt", "var", "strong", "b", "em", "i", "del", "s", "strike"]);
/** Inline elements a selection's formatting is looked for through. */
const INLINE = new Set([...WRAP, "span", "mark", "abbr", "cite", "q", "small", "sup", "sub", "time", "u", "font", "label"]);

/**
 * Whether `node` is inside something never copied or not shown, through the tree as it's
 * rendered (the slots it's shown through, and their shadow trees), as a page copy walks it.
 */
function insideHidden(node: Node, shown: Shown): boolean {
  for (let el = isElement(node) ? node : renderedParent(node); el; el = renderedParent(el)) {
    if (DROP.has(el.localName) || !shown.element(el)) return true;
  }
  return false;
}

/**
 * What `range` selects, copied as copyVisible copies a page. It starts from the element the
 * selection is inside, so a selection inside a code block, a link or a list item keeps its
 * form. A page's script can set the selection anywhere, hidden text included: a selection
 * inside anything a page copy would drop gives nothing.
 */
export function copySelection(range: Range, out: Document, shown: Shown): Node | null {
  const ctx: Ctx = { out, shown, here: hereOf(range.startContainer), range };
  const common = range.commonAncestorContainer;
  if (insideHidden(common, shown)) return null;
  const el = isElement(common) ? common : common.parentElement;
  const pre = el?.closest("pre");
  if (pre) return copyPre(pre, ctx);
  if (isText(common)) {
    let copy = copyNode(common, ctx);
    for (let a = common.parentElement; copy && a && INLINE.has(a.localName); a = a.parentElement) {
      if (!WRAP.has(a.localName)) continue;
      const wrap = shell(a, ctx);
      wrap.append(copy);
      copy = wrap;
    }
    return copy;
  }
  if (!el) return null;
  if (!PART.has(el.localName)) return copyNode(el, ctx);
  // A selection inside one list item or table cell: its contents, without the structure around it.
  return copyChildren([...el.childNodes], out.createElement("div"), ctx);
}
