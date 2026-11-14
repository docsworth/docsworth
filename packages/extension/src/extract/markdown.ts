// The copy of a page as markdown (R6, R9): turndown, set up as pro's mirror sets it up (ATX
// headings, fenced code, `-` bullets), with rules of ours for code blocks, tables and
// strikethrough, and an escape that also covers what would start HTML or an entity. Pages
// render through commonmark.js, which has no tables; GitHub, where they're reviewed, does.

import TurndownService from "turndown";
import { clip, MAX_TEXT_BYTES } from "../contract.js";

const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_", hr: "---" });

// The page's text is text: `<div>` in it must not become a tag, nor `&amp;` an ampersand.
const escapeText = service.escape.bind(service);
service.escape = (s: string) => escapeText(s).replace(/<(?=[A-Za-z/!?])/g, "\\<").replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&");

// A code block: its text, in a fence longer than any run of backticks inside it. The copy
// (clean.ts) leaves a `pre` holding only text, and its language in data-lang.
service.addRule("code-block", {
  filter: "pre",
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const code = (el.textContent ?? "").replace(/\n+$/, "");
    const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `\n\n${fence}${el.getAttribute("data-lang") ?? ""}\n${code}\n${fence}\n\n`;
  },
});

// `strike` isn't in the DOM's typings (it's obsolete), so the filter is a function.
service.addRule("strikethrough", { filter: (node) => ["DEL", "S", "STRIKE"].includes(node.nodeName), replacement: (content) => `~~${content}~~` });

/** The rows of a table, in order, and not those of a table inside it. */
const rowsOf = (table: Element) => [...table.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr")];
/** A cell as one line of a GFM table. */
const cell = (el: Element) => service.turndown(el.cloneNode(true) as HTMLElement).replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|").trim();

// A GFM table, its first row as the header (GFM requires one), shorter rows padded.
service.addRule("table", {
  filter: "table",
  replacement: (_content, node) => {
    const table = node as Element;
    const rows = rowsOf(table).map((tr) => [...tr.children].filter((c) => c.localName === "td" || c.localName === "th").map(cell));
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (!width) return "";
    const line = (r: string[]) => `| ${[...r, ...Array<string>(width - r.length).fill("")].join(" | ")} |`;
    const caption = table.querySelector(":scope > caption");
    const head = caption ? `${cell(caption)}\n\n` : "";
    return `\n\n${head}${line(rows[0]!)}\n| ${Array<string>(width).fill("---").join(" | ")} |${rows
      .slice(1)
      .map((r) => `\n${line(r)}`)
      .join("")}\n\n`;
  },
});

/** The copy of a page, or of a selection, as markdown. */
export function toMarkdown(root: Node): string {
  // Turndown already joins blocks with one blank line; anything more is inside a code block.
  return service.turndown(root as HTMLElement).trim();
}

const bytes = (s: string) => new TextEncoder().encode(s).length;
const FENCE = /^(`{3,}|~{3,})/;

/** The fence of a code block `markdown` leaves open at its end, or null. */
function openFence(markdown: string): string | null {
  let open: string | null = null;
  for (const line of markdown.split("\n")) {
    const m = FENCE.exec(line);
    if (!m) continue;
    if (open === null) open = m[1]!;
    else if (m[1]![0] === open[0] && m[1]!.length >= open.length && line.trim() === m[1]) open = null;
  }
  return open;
}

/**
 * `markdown` within `max` bytes of UTF-8: whole, or cut at the last blank line in its second
 * half, so no paragraph or list is cut in half, and with a code block it cut open closed.
 * `cut` says whether anything was left out.
 */
export function cutMarkdown(markdown: string, max = MAX_TEXT_BYTES): { markdown: string; cut: boolean } {
  if (bytes(markdown) <= max) return { markdown, cut: false };
  const head = clip(markdown, max);
  const at = head.lastIndexOf("\n\n");
  let out = (at > head.length / 2 ? head.slice(0, at) : head).trimEnd();
  // Close a code block left open, making room for its fence (as long as its opening one):
  // cutting more may cut the opening fence away too, so look again each time.
  for (let open = openFence(out); open !== null; open = openFence(out)) {
    const close = `\n${open}`;
    if (bytes(out) + bytes(close) <= max) return { markdown: out + close, cut: true };
    out = clip(out, max - bytes(close)).trimEnd();
  }
  return { markdown: out, cut: true };
}
