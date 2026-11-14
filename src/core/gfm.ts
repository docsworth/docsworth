// GFM tables on commonmark.js: the parse the web app renders pages from
// (packages/ui/src/markdown.ts), and search's text snippets read (`plainText` in
// search.ts), so a snippet holds exactly the words the page shows.

import { Node, Parser } from "commonmark";

// commonmark.js reads a table as a paragraph of pipes. A paragraph's text is kept as it was
// written (container prefixes gone, reference definitions taken out) until its inlines are
// parsed, so the inline parser is wrapped to keep that text for paragraphs with a pipe. A
// paragraph that holds a table is then rebuilt as one, its cells parsed by the same inline
// parser (reference links resolve), into custom nodes whose only raw HTML is the fixed tags
// below. The cells' contents are ordinary nodes, so the rewriting that follows and safe
// mode apply to them as to any other text.
// A table is a block of its own in GFM, so any block start ends it, even one that can't
// interrupt a CommonMark paragraph (an ordered list from 2, indented code, an empty list
// item, an HTML tag alone on its line: `startsBlock`); so does a lazy line (an unprefixed
// line CommonMark adds to a paragraph in a quote or list), and a lazy header or delimiter
// makes no table. `addLine` is wrapped to note each line's indent and whether it was lazy, which
// the paragraph's text no longer shows. The lines after the table are parsed again as
// blocks. GitHub moves lazy lines out of the quote or list; here they stay in it.
// Nor does a table take a setext underline: CommonMark makes a paragraph followed by `---`
// or `===` a heading, so a heading that holds a table is rebuilt too, and its underline read
// as GitHub reads it: three or more dashes are a rule; anything else is one more row, or,
// after the table ended early, a paragraph of its own.
// `inlineParser` (and its `parseReference`), `addLine`, `processInlines`, `allClosed`,
// `indent`, `tip`, `refmap` and `_string_content` are commonmark.js internals (0.31). If they're ever missing, tables stay paragraphs as
// before; the table tests fail loudly on an upgrade.

type Align = "left" | "center" | "right" | null;
type InlineParser = { parse(block: Node): void; parseReference?: (s: string, refmap: Record<string, unknown>) => number };
type BlockParser = {
  inlineParser?: InlineParser;
  addLine?: () => void;
  processInlines?: (block: Node) => void;
  allClosed: boolean;
  indent: number;
  tip: Node;
  refmap: Record<string, unknown>;
};
/**
 * What a page may spend on its tables: characters parsed again after them (`left`), and cells
 * built (`cells`). Both are bounded by the page's length, because page text is untrusted.
 */
type Budget = { left: number; cells: number };

/** What a paragraph's line was, as it was added: lazily, and how far indented. */
type LineInfo = { lazy: boolean; indent: number };

/**
 * Whether a line, indented as it was, starts a block of its own: CommonMark's own grammar,
 * by parsing the line alone. A table row is a paragraph; a list item, indented code or an
 * HTML tag isn't, and in GFM it ends the table.
 */
function startsBlock(line: string, indent: number): boolean {
  const first = new Parser().parse(" ".repeat(indent) + line).firstChild;
  return first !== null && first.type !== "paragraph";
}
type RawBlock = Node & { _string_content: string | null };

/** A row's cells: outer pipes optional, `\|` is a pipe inside a cell (in code too, as GFM). */
function cellsOf(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** The alignments a delimiter row (`| :--- | ---: |`) sets, or null if the line isn't one. */
function delimiterRow(line: string): Align[] | null {
  if (!line.includes("|")) return null;
  const cells = cellsOf(line);
  if (!cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells.map((c) => (c.startsWith(":") ? (c.endsWith(":") ? "center" : "left") : c.endsWith(":") ? "right" : null));
}

/** A node that renders as the given fixed tags around its children. Blocks get their own line. */
function custom(type: "custom_block" | "custom_inline", onEnter: string, onExit: string): Node {
  const n = new Node(type);
  n.onEnter = onEnter;
  n.onExit = onExit;
  return n;
}

/**
 * Replace `block` (a paragraph, or a setext heading with its `underline`) with the table its
 * text holds, if it holds one. `info[i]` is what line i was.
 */
function rebuildTable(block: Node, text: string, info: readonly LineInfo[], underline: string, budget: Budget, inlines: (text: string) => Node, blocks: (text: string) => Node): void {
  const lines = text.replace(/\n$/, "").split("\n");
  const endsTable = (i: number) => info[i]?.lazy || startsBlock(lines[i]!, info[i]?.indent ?? 0);
  for (let h = 0; h + 1 < lines.length; h++) {
    if (info[h]?.lazy || info[h + 1]?.lazy) continue;
    const align = delimiterRow(lines[h + 1]!);
    if (!align || cellsOf(lines[h]!).length !== align.length) continue;
    let end = h + 2;
    while (end < lines.length && !endsTable(end)) end++;
    const setext = block.type === "heading";
    const rule = setext && /^-{3,}$/.test(underline);
    const early = end < lines.length;
    const bodyLines = [...lines.slice(h + 2, end), ...(setext && !rule && !early ? [underline] : [])];
    // Padding a short row costs no input, so a table's cells could outgrow the page by far
    // (800 header cells and 800 one-cell rows). A table past the page's budget stays text.
    const cells = align.length * (1 + bodyLines.length);
    if (cells > budget.cells) return;
    budget.cells -= cells;
    const row = (line: string, tag: "th" | "td") => {
      const tr = custom("custom_block", "<tr>", "</tr>");
      const cells = cellsOf(line);
      align.forEach((a, i) => {
        const cell = custom("custom_inline", a ? `<${tag} class="dw-align-${a}">` : `<${tag}>`, `</${tag}>`);
        const content = inlines(cells[i] ?? "");
        while (content.firstChild) cell.appendChild(content.firstChild);
        tr.appendChild(cell);
      });
      return tr;
    };
    const table = custom("custom_block", '<div class="dw-table-scroll"><table>', "</table></div>");
    const head = custom("custom_block", "<thead>", "</thead>");
    head.appendChild(row(lines[h]!, "th"));
    table.appendChild(head);
    if (bodyLines.length > 0) {
      const body = custom("custom_block", "<tbody>", "</tbody>");
      for (const line of bodyLines) body.appendChild(row(line, "td"));
      table.appendChild(body);
    }
    if (h > 0) block.insertBefore(inlines(lines.slice(0, h).join("\n")));
    block.insertBefore(table);
    if (early) {
      // The lines after the table, indented as they were, read as blocks again.
      const rest = blocks(lines.slice(end).map((line, i) => " ".repeat(info[end + i]?.indent ?? 0) + line).join("\n"));
      while (rest.firstChild) block.insertBefore(rest.firstChild);
    }
    if (rule) block.insertBefore(new Node("thematic_break"));
    else if (setext && early) block.insertBefore(inlines(underline));
    block.unlink();
    return;
  }
}

/**
 * commonmark.js's tree, with GFM tables as tables. `refmap`: link definitions from the page
 * this text was cut from (the blocks after a table), which its own may add to. `budget.left`:
 * how many more characters may be parsed again after tables, for the whole page. Tables chained
 * in one paragraph (each ended by a line that can't interrupt it) re-parse ever shorter tails,
 * which is quadratic, and nests a parse per table; page text is untrusted, so past eight
 * times the page's length, or 16 tables deep, the tail is read as plain CommonMark instead
 * (its tables as text). Real pages chain a table or two.
 */
function parse(markdown: string, refmap?: Record<string, unknown>, budget: Budget = { left: 8 * markdown.length, cells: markdown.length }, depth = 0): Node {
  const parser = new Parser();
  const internals = parser as unknown as BlockParser;
  const inline = internals.inlineParser;
  const { addLine, processInlines } = internals;
  if (typeof inline?.parse !== "function" || typeof addLine !== "function" || typeof processInlines !== "function") return parser.parse(markdown);
  internals.processInlines = function (this: BlockParser, block: Node) {
    // The tail's own definitions win: GitHub links a label defined again after a table to
    // that later definition.
    this.refmap = { ...refmap, ...this.refmap };
    processInlines.call(this, block);
  };
  // Each line a paragraph is given: whether it came lazily (its containers unmatched), and its
  // indent. Keyed by the paragraph's sourcepos array: commonmark.js updates it in place, and a
  // setext heading made from the paragraph is given the same array.
  const lineInfo = new WeakMap<object, LineInfo[]>();
  internals.addLine = function (this: BlockParser) {
    const key = this.tip.sourcepos;
    if (this.tip.type === "paragraph" && key) {
      let lines = lineInfo.get(key);
      if (!lines) lineInfo.set(key, (lines = []));
      lines.push({ lazy: !this.allClosed, indent: this.indent });
    }
    addLine.call(this);
  };
  // The placeholder is never a link definition: redacted, `[term](page.md): word` reads
  // `[restricted page]: word`, which CommonMark would take as one and drop from the page.
  const { parseReference } = inline;
  if (typeof parseReference === "function")
    inline.parseReference = (s, refmap) => (PLACEHOLDER_DEFINITION.test(s) ? 0 : parseReference.call(inline, s, refmap));
  const parseInlines = inline.parse.bind(inline);
  const raw = new Map<Node, string>();
  inline.parse = (block) => {
    const text = (block as RawBlock)._string_content;
    if ((block.type === "paragraph" || block.type === "heading") && text?.includes("|")) raw.set(block, text);
    parseInlines(block);
  };
  const doc = parser.parse(markdown);
  const inlines = (text: string) => {
    const p = new Node("paragraph") as RawBlock;
    p._string_content = text;
    parseInlines(p);
    return p;
  };
  const source = markdown.split(/\r\n|\n|\r/);
  for (const [block, text] of raw) {
    // Reference definitions are taken from the front of a paragraph: its last lines are the text's.
    const lines = text.replace(/\n$/, "").split("\n").length;
    // A setext heading ends on its underline's line, at the underline's last character.
    const [endLine = 0, endCol = 0] = block.sourcepos?.[1] ?? [];
    const underline = block.type === "heading" ? (/([=-]+)\s*$/.exec(source[endLine - 1]?.slice(0, endCol) ?? "")?.[1] ?? "") : "";
    const blocks = (rest: string) => {
      if (rest.length > budget.left || depth >= 16) return new Parser().parse(rest);
      budget.left -= rest.length;
      return parse(rest, internals.refmap, budget, depth + 1);
    };
    rebuildTable(block, text, ((block.sourcepos && lineInfo.get(block.sourcepos)) || []).slice(-lines), underline, budget, inlines, blocks);
  }
  return doc;
}

/**
 * `[restricted page]` (`RESTRICTED`, src/core/acl.ts): the placeholder redaction leaves for a
 * link to a page the caller can't see. Not imported: acl.ts would bring its dependencies into
 * the web app.
 */
const PLACEHOLDER = "[restricted page]";
const MAX_NESTING = 32;
const PLACEHOLDER_DEFINITION = /^\[\s*restricted\s+page\s*\]:/i;

/**
 * commonmark.js's tree for `markdown`, with GFM tables as tables (see above). The placeholder
 * is never a link or an image, whatever a page writes around it: a definition for it, a
 * `(target)` or `[label]` right after the link redaction replaced, or a link around it. A
 * link or image labelled "restricted page" becomes the placeholder's text, and one whose
 * label holds the placeholder becomes its label's text.
 */
export function parseGfm(markdown: string): Node {
  const doc = parse(markdown);
  // Links and images nested deeper than MAX_NESTING are read as their text. Each check below
  // walks what's inside a link, so unbounded nesting would make it quadratic (page text is
  // untrusted); 32 levels is far past anything a page means.
  const deep: Node[] = [];
  let nesting = 0;
  const outer = doc.walker();
  for (let e = outer.next(); e; e = outer.next()) {
    if (e.node.type !== "link" && e.node.type !== "image") continue;
    if (!e.entering) nesting--;
    else if (++nesting > MAX_NESTING) deep.push(e.node);
  }
  for (const n of deep) {
    while (n.firstChild) n.insertBefore(n.firstChild);
    n.unlink();
  }
  // Innermost first: a link is judged by its label once what's inside it is replaced, so an
  // image inside a link that becomes the placeholder takes the link's target away too.
  const links: Node[] = [];
  const walker = doc.walker();
  for (let e = walker.next(); e; e = walker.next()) if (!e.entering && (e.node.type === "link" || e.node.type === "image")) links.push(e.node);
  for (const n of links) {
    const label = textIn(n).replace(/\s+/g, " ").trim();
    const literal = `[${label.toLowerCase()}]` === PLACEHOLDER ? PLACEHOLDER : label.toLowerCase().includes(PLACEHOLDER) ? label : null;
    if (literal === null) continue;
    const text = new Node("text");
    text.literal = literal;
    n.insertBefore(text);
    n.unlink();
  }
  return doc;
}

/** The text and code inside `node`: a link's or image's label, as the reader sees it. */
export function textIn(node: Node): string {
  let out = "";
  const walker = node.walker();
  for (let e = walker.next(); e; e = walker.next()) if (e.entering && (e.node.type === "text" || e.node.type === "code")) out += e.node.literal ?? "";
  return out;
}

/** A table cell (`th` or `td`) in a tree from `parseGfm`; its children are the cell's content. */
export function isTableCell(node: Node): boolean {
  return node.type === "custom_inline" && /^<t[hd][\s>]/.test(node.onEnter ?? "");
}
