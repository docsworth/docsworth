/**
 * The block structure the polish guard needs: which lines are code, in what blocks, as
 * CommonMark reads them. It follows the spec's parsing strategy for containers (block
 * quotes and list items, matched line by line, with lazy paragraph continuation) and
 * for the two code leaves (fenced and indented). Other leaves only matter here for
 * whether a paragraph is open: a paragraph can't be interrupted by indented code, and
 * only by a list item that has text and, if ordered, starts at 1.
 *
 * Tabs count to the next multiple of four columns, and a tab a container consumes in
 * part leaves the rest as spaces, as CommonMark specifies.
 *
 * Raw HTML blocks aren't modelled: the guard refuses a page that has raw HTML.
 */

/** Left in the prose where a code block was. Not a letter, digit or markup. */
export const FENCE_MARK = "\u0002";

// A position in a line: `s[i]` sits at absolute column `col`, and `partial` columns of
// a tab partly consumed by a container are still to come before it.
type Cursor = {
  s: string;
  i: number;
  col: number;
  partial: number;
  /** The last character that isn't a space or tab (-1 for a blank line). */
  lastText: number;
  /** The last character that couldn't be in a thematic break (`*`, `-`, `_`, spaces). */
  lastOther: number;
};

function cursor(s: string): Cursor {
  let lastText = -1;
  let lastOther = -1;
  for (let k = s.length - 1; k >= 0 && (lastText < 0 || lastOther < 0); k--) {
    if (lastText < 0 && !isWs(s[k])) lastText = k;
    if (lastOther < 0 && !/[ \t*_-]/.test(s[k]!)) lastOther = k;
  }
  return { s, i: 0, col: 0, partial: 0, lastText, lastOther };
}

/** Where the whitespace ahead ends. */
const wsEnd = (c: Cursor) => {
  let j = c.i;
  while (isWs(c.s[j])) j++;
  return j;
};

const isWs = (ch: string | undefined) => ch === " " || ch === "\t";

/** Columns of whitespace ahead. */
function indent(c: Cursor): number {
  let n = c.partial;
  let col = c.col;
  for (let j = c.i; isWs(c.s[j]); j++) {
    const w = c.s[j] === "\t" ? 4 - (col % 4) : 1;
    n += w;
    col += w;
  }
  return n;
}

/** The text after the whitespace ahead. */
const afterWs = (c: Cursor) => {
  let j = c.i;
  while (isWs(c.s[j])) j++;
  return c.s.slice(j);
};

/** Consume up to `k` columns of whitespace. */
function consume(c: Cursor, k: number): void {
  const take = Math.min(c.partial, k);
  c.partial -= take;
  k -= take;
  while (k > 0 && isWs(c.s[c.i])) {
    const w = c.s[c.i] === "\t" ? 4 - (c.col % 4) : 1;
    c.i++;
    c.col += w;
    if (w > k) {
      c.partial = w - k;
      k = 0;
    } else k -= w;
  }
}

/** Consume one character that isn't whitespace (a marker). */
function step(c: Cursor, n = 1): void {
  c.i += n;
  c.col += n;
}

/** After `>`: one optional space, which may be a column of a tab. */
function optionalSpace(c: Cursor): void {
  if (c.partial > 0) c.partial--;
  else if (c.s[c.i] === " ") step(c);
  else if (c.s[c.i] === "\t") {
    const w = 4 - (c.col % 4);
    c.i++;
    c.col += w;
    c.partial = w - 1;
  }
}

const rest = (c: Cursor) => " ".repeat(c.partial) + c.s.slice(c.i);
const blankRest = (c: Cursor) => c.lastText < c.i;

const THEMATIC = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** A thematic break from the whitespace ahead to the line's end? Tested only when nothing else is left. */
const thematicAhead = (c: Cursor) => c.lastOther < wsEnd(c) && THEMATIC.test(c.s.slice(wsEnd(c)));
// A list marker where the whitespace ahead ends (sticky: no copy of the rest of the line).
const LIST_MARKER_AT = /(?:([-*+])|(\d{1,9})([.)]))(?=[ \t]|$)/y;
const ATX = /^#{1,6}(?:[ \t]|$)/;
const SETEXT = /^(?:=+|-+)[ \t]*$/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const LIST_MARKER = /^(?:([-*+])|(\d{1,9})([.)]))(?=[ \t]|$)/;

// HTML blocks (CommonMark §4.6): seven kinds, each with its start and end. Types 1 to 5
// run to a line holding their end marker, 6 and 7 to a blank line; 7 (a complete tag
// alone on its line) can't interrupt a paragraph. Lines in one aren't a paragraph's, so
// no reference definition hides in an HTML comment.
const BLOCK_TAGS = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const ATTR = String.raw`(?:[ \t\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:[^ \t\n"'=<>\x60]+|'[^']*'|"[^"]*"))?)`;
const HTML_KINDS: { start: RegExp; end: RegExp | null; interrupts: boolean }[] = [
  { start: /^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i, end: /<\/(?:script|pre|style|textarea)>/i, interrupts: true },
  { start: /^<!--/, end: /-->/, interrupts: true },
  { start: /^<\?/, end: /\?>/, interrupts: true },
  { start: /^<![A-Za-z]/, end: />/, interrupts: true },
  { start: /^<!\[CDATA\[/, end: /\]\]>/, interrupts: true },
  { start: new RegExp(`^</?(?:${BLOCK_TAGS})(?:[ \\t>]|/>|$)`, "i"), end: null, interrupts: true },
  { start: new RegExp(String.raw`^(?:<[A-Za-z][A-Za-z0-9-]*${ATTR}*[ \t]*/?>|</[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$`), end: null, interrupts: false },
];

const isPara = (leaf: Leaf | null, depth: number): boolean => leaf?.kind === "para" && leaf.depth === depth;

const fenceOpener = (t: string) => {
  const m = FENCE_OPEN.exec(t);
  return m && !(m[1]![0] === "`" && m[2]!.includes("`")) ? m : null;
};

type Container = { kind: "quote" } | { kind: "item"; indent: number; blankStart: boolean; content: boolean; first: boolean };
type Leaf =
  | { kind: "para"; depth: number; start: number }
  | { kind: "html"; depth: number; end: RegExp | null }
  | { kind: "fenced"; depth: number; ch: string; len: number; indent: number; info: string; lines: string[] }
  | { kind: "indented"; depth: number; lines: string[] };

/**
 * Would this line, with some containers unmatched, start a block rather than lazily
 * continue the paragraph? Any list item does here, even an empty one or one not
 * starting at 1: the interruption rule binds only inside the paragraph's own container
 * (commonmark.js: `> a` then `2. b` closes the quote and starts a list at 2).
 */
function startsBlock(c: Cursor): boolean {
  if (indent(c) >= 4) return false; // indented code can't interrupt a paragraph
  const t = afterWs(c);
  return t.startsWith(">") || THEMATIC.test(t) || ATX.test(t) || Boolean(fenceOpener(t)) || HTML_KINDS.some((k) => k.start.test(t)) || LIST_MARKER.test(t);
}

/**
 * Code blocks (fenced and indented) and the prose around them. Each block is its literal,
 * with its info string first when it has one; the prose keeps every other line as
 * written and a FENCE_MARK line where each block began.
 */
export type Blocks = {
  fences: string[];
  prose: string;
  /** Per prose line: characters of list markers (and the containers among them) that opened an item on it. */
  markers: number[];
  /** Per prose line: characters of container markers before its content. */
  content: number[];
  /** Per prose line: whether it's a paragraph's (first, continuing or lazy). */
  para: boolean[];
  /** Per prose line: whether it starts a paragraph (where a reference definition may begin). */
  paraStart: boolean[];
  /** Per prose line: whether it starts a list item's first paragraph (where a task box sits). */
  itemPara: boolean[];
};

export function codeBlocks(body: string): Blocks {
  const fences: string[] = [];
  const prose: string[] = [];
  // For each prose line, how many characters at its start are list markers that opened
  // an item on it (with the quote markers and spaces among them): an ordered marker's
  // number there is structure, not a number in the text.
  const markers: number[] = [];
  const content: number[] = [];
  const para: boolean[] = [];
  const paraStart: boolean[] = [];
  const itemPara: boolean[] = [];
  // A block starts in the innermost container: if that's a list item, it's no longer
  // waiting for its first block. Says whether it was (`-` then `  [ ] x` is a task:
  // the item's first paragraph starts on the line after its marker).
  const starts = () => {
    const top = stack.at(-1);
    if (top?.kind !== "item" || !top.first) return false;
    top.first = false;
    return true;
  };
  const stack: Container[] = [];
  // Where a blank line stops matching: the first quote, or the first item that began
  // blank and holds nothing yet. Kept as the stack changes, so a blank line under deep
  // nesting doesn't walk every container (`- - - … x` then blank lines took 15 s).
  let blockers: number[] = [];
  const push = (cont: Container) => {
    if (cont.kind === "quote" || (cont.blankStart && !cont.content)) blockers.push(stack.length);
    stack.push(cont);
  };
  const truncate = (n: number) => {
    stack.length = n;
    while (blockers.length && blockers.at(-1)! >= n) blockers.pop();
  };
  let leaf: Leaf | null = null;

  const finish = () => {
    // As CommonMark's literal: each line ends with a newline, so an empty block and
    // one blank line differ.
    if (leaf?.kind === "fenced") {
      const code = leaf.lines.map((l) => `${l}\n`).join("");
      fences.push(leaf.info ? `${leaf.info}\u0003${code}` : code);
    } else if (leaf?.kind === "indented") {
      // Trailing blank lines aren't part of an indented block; they stay prose.
      let n = leaf.lines.length;
      while (n > 0 && /^[ \t]*$/.test(leaf.lines[n - 1]!)) n--;
      fences.push(leaf.lines.slice(0, n).map((l) => `${l}\n`).join(""));
      for (let k = n; k < leaf.lines.length; k++) prose.push("");
    }
    leaf = null;
  };

  // A final newline ends the last line; it doesn't start another. (Callers normalize line
  // endings already; this keeps the pass right on its own.)
  const source = body.replace(/\r\n?/g, "\n").split("\n");
  if (source.length > 1 && source.at(-1) === "") source.pop();
  // Between two blocks the source didn't separate with a blank line, a blank one goes in,
  // so inline constructs (a code span, a link's title) can't run from one block into the
  // next, as CommonMark never lets them (found by differential fuzzing).
  const boundary = () => {
    if (prose.length && prose.at(-1)!.trim()) prose.push("");
  };
  for (const line of source) {
    const c = cursor(line);

    // 1. Match the open containers. Once what's left of the line is blank (a blank line,
    // or `>` alone in a quote), every item matches up to the next blocker, at once: its
    // whitespace goes with them, and deep nesting isn't walked container by container.
    let matched = 0;
    while (matched < stack.length) {
      const cont = stack[matched]!;
      if (cont.kind === "item" && blankRest(c)) {
        matched = blockers.find((b) => b >= matched) ?? stack.length;
        consume(c, indent(c));
        break;
      }
      if (cont.kind === "quote") {
        const n = indent(c);
        if (n > 3 || c.s[wsEnd(c)] !== ">") break;
        consume(c, n);
        step(c);
        optionalSpace(c);
      } else if (indent(c) >= cont.indent) consume(c, cont.indent);
      else break;
      matched++;
    }

    // 2. A code leaf whose containers all matched takes the line.
    if (leaf?.kind === "fenced" && matched === stack.length) {
      const n = indent(c);
      const close = /^(`{3,}|~{3,})[ \t]*$/.exec(afterWs(c));
      if (n <= 3 && close && close[1]![0] === leaf.ch && close[1]!.length >= leaf.len) {
        finish();
        prose.push("");
      } else {
        consume(c, Math.min(n, leaf.indent));
        leaf.lines.push(rest(c));
      }
      continue;
    }
    if (leaf?.kind === "indented" && matched === stack.length) {
      if (blankRest(c)) {
        consume(c, 4);
        leaf.lines.push(rest(c));
        continue;
      }
      if (indent(c) >= 4) {
        consume(c, 4);
        leaf.lines.push(rest(c));
        continue;
      }
      finish();
    }

    if (leaf?.kind === "html" && matched === stack.length) {
      if (leaf.end === null && blankRest(c)) finish(); // 6 and 7 end before a blank line
      else {
        prose.push(line);
        content[prose.length - 1] = c.i;
        if (leaf.end?.test(line.slice(c.i))) finish();
        continue;
      }
    }

    // 3. Unmatched containers: a lazy paragraph line keeps them open; otherwise they close.
    if (matched < stack.length) {
      if (leaf?.kind === "para" && !blankRest(c) && !startsBlock(c)) {
        prose.push(line);
        content[prose.length - 1] = c.i;
        para[prose.length - 1] = true;
        continue;
      }
      if (leaf && leaf.depth > matched) finish();
      truncate(matched);
    }
    if (!blankRest(c)) {
      // Every open item holds this line now, so only quotes still stop a blank line.
      for (const cont of stack) if (cont.kind === "item") cont.content = true;
      blockers = blockers.filter((k) => stack[k]!.kind === "quote");
    }

    // 4. New containers.
    let opened = 0;
    for (;;) {
      if (blankRest(c)) break;
      const n = indent(c);
      if (n >= 4) break;
      const at = wsEnd(c);
      const paraHere = isPara(leaf, stack.length);
      if (c.s[at] === ">") {
        consume(c, n);
        step(c);
        optionalSpace(c);
        if (leaf) finish();
        starts();
        push({ kind: "quote" });
        continue;
      }
      if (paraHere && SETEXT.test(c.s.slice(at))) break; // once a line: a new container ends the paragraph
      if (thematicAhead(c)) break;
      LIST_MARKER_AT.lastIndex = at;
      const m = LIST_MARKER_AT.exec(c.s);
      if (!m) break;
      const empty = c.lastText < at + m[0].length;
      if (paraHere && (empty || (m[3] && Number(m[2]) !== 1))) break;
      consume(c, n);
      step(c, m[0].length);
      const sp = indent(c);
      let width: number;
      if (empty) width = n + m[0].length + 1;
      else if (sp >= 5) {
        consume(c, 1);
        width = n + m[0].length + 1;
      } else {
        consume(c, sp);
        width = n + m[0].length + sp;
      }
      if (leaf) finish();
      starts();
      push({ kind: "item", indent: width, blankStart: empty, content: !empty, first: true });
      opened = c.i;
    }

    // 5. The leaf.
    if (blankRest(c)) {
      if (leaf?.kind === "para") finish();
      prose.push(line);
      markers[prose.length - 1] = opened;
      content[prose.length - 1] = c.i;
      continue;
    }
    const paraHere = isPara(leaf, stack.length);
    const n = indent(c);
    if (n >= 4) {
      if (paraHere) {
        prose.push(line); // continuation: indented code can't interrupt a paragraph
        markers[prose.length - 1] = opened;
        content[prose.length - 1] = c.i;
        para[prose.length - 1] = true;
        continue;
      }
      if (leaf) finish();
      consume(c, 4);
      leaf = { kind: "indented", depth: stack.length, lines: [rest(c)] };
      starts();
      boundary();
      prose.push(FENCE_MARK); // the mark alone: no markers to strip
      continue;
    }
    const t = afterWs(c);
    const fence = fenceOpener(t);
    if (fence) {
      if (leaf) finish();
      leaf = { kind: "fenced", depth: stack.length, ch: fence[1]![0]!, len: fence[1]!.length, indent: n, info: fence[2]!.trim(), lines: [] };
      starts();
      boundary();
      prose.push(FENCE_MARK); // the mark alone: no markers to strip
      continue;
    }
    const html: (typeof HTML_KINDS)[number] | undefined = n <= 3 ? HTML_KINDS.find((k) => k.start.test(t) && (k.interrupts || !paraHere)) : undefined;
    if (html) {
      if (leaf) finish();
      boundary();
      prose.push(line);
      markers[prose.length - 1] = opened;
      content[prose.length - 1] = c.i;
      if (!html.end?.test(t)) leaf = { kind: "html", depth: stack.length, end: html.end };
      starts();
      continue;
    }
    if ((paraHere && SETEXT.test(t)) || THEMATIC.test(t) || ATX.test(t)) {
      // A setext underline makes its paragraph a heading: not an item's first paragraph,
      // so no task (`- [ ] x` then `  -`; found by differential fuzzing).
      if (paraHere && SETEXT.test(t) && leaf?.kind === "para") delete itemPara[leaf.start];
      if (leaf) finish();
      if (!(paraHere && SETEXT.test(t))) {
        boundary(); // a setext underline belongs to its paragraph
        starts();
      }
      prose.push(line);
      markers[prose.length - 1] = opened;
      content[prose.length - 1] = c.i;
      continue;
    }
    if (!paraHere) {
      if (leaf) finish();
      leaf = { kind: "para", depth: stack.length, start: prose.length + (prose.length && prose.at(-1)!.trim() ? 1 : 0) };
      boundary();
      paraStart[prose.length] = true;
      if (starts()) itemPara[prose.length] = true;
    }
    prose.push(line);
    markers[prose.length - 1] = opened;
    content[prose.length - 1] = c.i;
    para[prose.length - 1] = true;
  }
  finish();
  return { fences, prose: prose.join("\n"), markers, content, para, paraStart, itemPara };
}
