// The polish guard (v0.2 L1). `propose_edit` with `polish: true` may restructure and
// reword a page, but not change the things a reader acts on. This is a structural check,
// not proof that the meaning is unchanged. It compares:
//   - the frontmatter, byte for byte
//   - code blocks (fenced and indented, as CommonMark finds them), in order
//   - inline code, effective link targets and bare URLs, as multisets
//   - struck-through text, as a multiset
//   - each number (with its sign) and the word after it ("5 minutes"), so swaps show
//   - the count of each negation and modal word ("not", "never", "must", ...)
// What it can't see (a renamed service, two same-unit numbers trading places, a command
// in plain prose, a reworded sentence that now means something else) is why the PR
// still goes to the owner team.

import { type Blocks, FENCE_MARK, codeBlocks } from "./blocks.js";

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
// An HTML comment renders as nothing, so it's compared on its own and kept out of every
// other fact: a fact moved into a comment has left the page a reader sees.
/**
 * Spans from `open` to the next `close`, found with indexOf: linear, where a lazy regex
 * would rescan to the end for every unclosed opener. Once a close is missing, no later
 * opener can be closed either, so the scan stops.
 */
function spans(text: string, open: string, close: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = text.indexOf(open); i >= 0; ) {
    const j = text.indexOf(close, i + open.length);
    if (j < 0) break;
    out.push([i, j + close.length]);
    i = text.indexOf(open, j + close.length);
  }
  return out;
}
const cut = (text: string, ss: [number, number][], keep: (s: string) => string) => {
  let out = "";
  let at = 0;
  for (const [i, j] of ss) {
    if (i < at) continue; // inside one already cut
    out += text.slice(at, i) + keep(text.slice(i, j));
    at = j;
  }
  return out + text.slice(at);
};
// A code span: a run of backticks, closed by a run of the same length. It may wrap onto
// the next line, but not across a blank one (that ends the paragraph).
const INLINE_CODE = /(?<!`)(`+)(?!`)((?:[^\n]|\n(?![ \t]*\n))+?)(?<!`)\1(?!`)/g;
// A reference definition; its destination may sit on the next line (CommonMark).
// Not a footnote (`[^1]: …`), whose text renders and so is read like any other.
// Container markers (quotes, list items) may come first, on the line and on its
// continuation lines: `> [x]: safe.md` defines a link too. A title must close, and
// nothing may follow it: otherwise the line isn't a definition, renders as text, and is
// compared as text.
// Each space has one place to match: the spaces before a marker go with it, and the
// pattern after the markers takes the rest. (`>[ \t]?` then `[ \t]*` could split a
// space two ways per marker, and `> > > …` backtracked exponentially.) A list marker
// still needs a space after it; four spaces or a tab anywhere in the prefix refuses the
// polish (definitionSpans), so `[ \t]{0,3}` after the markers loses nothing.
const CONTAINER = String.raw`(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*`;
const CONTINUE = String.raw`(?:[ \t]*>)*`;
const REF_DEF = new RegExp(
  String.raw`^${CONTAINER}[ \t]{0,3}\[(?!\^)((?:\\.|[^\[\]\\\n])+)\]:[ \t]*(?:\n${CONTINUE}[ \t]*)?(<(?:\\.|[^<>\\\n])*>|\S+)(?:(?:[ \t]+|[ \t]*\n${CONTINUE}[ \t]+)("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\((?:\\.|[^()\\\n])*\)))?[ \t]*$`,
  "gm",
);
// Raw HTML tags. Markdown can't hide text; HTML can (`<span hidden>`, a style, a
// <template>), so a polish may not add, drop or change a single tag.
// Every raw HTML form CommonMark passes through: tags, processing instructions
// (`<? … ?>`), declarations (`<!DOCTYPE …>`) and CDATA. Comments are compared on their own.
// Every raw HTML opener, closed or not: an unclosed `<!--`, `<?` or `<div` hides what
// follows it, so openers are counted whether or not a closer comes.
const OPENER = /<(?:!--|!\[CDATA\[|![a-z]|\?|\/?[a-z][a-z0-9-]*)/gi;
// Processing instructions and CDATA are found by `spans` (see rawHtml).
const TAG = /<(?:\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?|![a-z][^<>]*)>/gi;
// Characters a reader can't tell apart from ASCII, or can't see at all.
// Allowed: ASCII, Latin-1 (not the invisible soft hyphen), typographic punctuation,
// arrows, maths symbols and box drawing.
// (ASCII controls other than tab and line breaks count as unusual: NUL, ESC, DEL.)
const UNUSUAL = /[^\t\n\r\x20-\x7e\u00a0-\u00ac\u00ae-\u00ff\u2010-\u2027\u2030-\u205e\u2190-\u21ff\u2200-\u22ff\u2500-\u25ff]/gu;
// Labels hold no unescaped brackets, so a scan stops at the next one (linear).
// (Backslash escapes, such as `\]`, count as label text.)
// The shown text may hold one level of brackets (`[the [production] guide][a]`).
// A label or link text can't hold a blank line: that ends the paragraph.
const FULL_REF = /(?<=(?:^|[^\\])(?:\\\\)*)\[((?:\\.|[^\[\]\\\n]|\n(?!\n)|\[(?:\\.|[^\[\]\\\n]|\n(?!\n))*\])*)\]\[((?:\\.|[^\[\]\\\n]|\n(?!\n))*)\]/g;
// \u0000 marks where an inline link's `](target)` was, so its text isn't read as a use.
// `[a]: x` in paragraph text is a use of `[a]` too: only a real definition is cut out.
// Nor does a `(` that didn't open an inline link stop one (those are cut out first), nor
// a `[` that doesn't open a well-formed label (`[prod][` then a blank line).
// Neither starts at an escaped `\[`.
const SHORTCUT_REF = /(?<=(?:^|[^\\])(?:\\\\)*)\[((?:\\.|[^\[\]\\\n]|\n(?!\n))+)\](?!\[(?:\\.|[^\[\]\\\n]|\n(?!\n))*\]|\u0000)/g;
// A scheme is case-insensitive: HTTPS://… is a URL too.
// Where GFM autolinks one: at a line's start or after a space, `*`, `_`, `~` or `(`
// (`\https://…` is text), and as far as it runs: to the next space or `<` (trimUrl takes
// the tail off). Both ways matter: a link that appears or goes is a change.
const URL = /(?<=^|[\s*_~(])https?:\/\/[^\s<]+/gim;
// Autolinks: `<scheme:anything>` and `<user@host>` (CommonMark), bare emails and `www.`
// links (GFM), and HTML anchors and images. Each is a target a reader can follow.
// Not after an odd run of backslashes: `\<https://…>` is text.
const AUTOLINK = /(?<=(?:^|[^\\])(?:\\\\)*)<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)>/gi;
const BARE_EMAIL = /(?<![\w.+-])[a-z0-9.+_-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const WWW = /(?<=^|[\s*_~(])www\.[^\s<]+/gim;
// The attribute value quoted or not: `<a href=/safe>` is a link too.
const HTML_LINK = /<(?:a|img)\b[^<>]*?\b(?:href|src)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'=<>`]+))[^<>]*>/gi;
const STRUCK = /~~(?!~)([\s\S]+?)~~|<(del|s)>([^<]*)<\/\2>/gi;
// A number, with a sign only where one can be (not the hyphen of a range like 5-10), and
// the word after it. That word may sit on the next line of the same paragraph (rewrapping
// is a polish), but not across a blank line, a list item or a heading.
// A hyphen joins a unit too: `5-minute` is 5 with minute.
// The token is the whole run from its first digit (`1e3`, `0xff`, `30s`, `10:30`), so
// no part of it can change unseen.
// An identifier's digits (`ADR-0001`, `INC-77`) are taken with its prefix, and never
// paired with a unit: "ADR-0001 and" says nothing about "and".
// Any script's digits (`\p{Nd}`): `٥` to `٩` changes a number as `5` to `9` does.
const NUMBER = /(?<!\w)(?<!\p{Nd}\.)((?:[a-z][a-z0-9]*-(?=\p{Nd}))?(?:[-+\u2212](?=\.?\p{Nd}))?(?:\p{Nd}|\.\p{Nd})(?:[\w%]|\p{Nd}|[.,:](?=\p{Nd}))*)(?:(?:[ \t]+|[ \t]*\n[ \t]*|-(?=\p{L}))(\p{L}+))?/giu;
// A plural is the same unit: `5-minute timeout` and `5 minutes` say the same thing.
// Case counts in a unit (`MB` and `Mb`, `mW` and `MW`), except that a word of three
// letters or more may be capitalised (`5 Minutes` in a heading is `5 minutes`; merge
// gate, PR 3, round 36).
const unit = (w: string) => (/^\p{Lu}?\p{Ll}{2,}$/u.test(w) ? w.toLowerCase() : w).replace(/(?<=\w\w)s$/, "");
// Bold and italics are presentation: `5 **minutes**` says what `5 minutes` says.
// Strikethrough isn't (it withdraws the text), so it's compared, not stripped.
const EMPHASIS = /\*+|(?<!\w)_+|_+(?!\w)/g;

export const NEGATIONS = ["not", "never", "no", "must", "should", "cannot", "can't", "don't", "doesn't", "won't", "shouldn't", "mustn't", "isn't", "aren't", "only", "without", "unless", "except", "nor", "none", "neither", "always"];

const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Georgian", "Hebrew", "Arabic", "Devanagari", "Bengali", "Tamil", "Thai", "Hangul", "Hiragana", "Katakana", "Han"];
const SCRIPT_RES = SCRIPTS.map((name) => [name, new RegExp(`\\p{Script=${name}}`, "u")] as const);
/** The script of a letter, if it's one of the common ones. */
const scriptOf = (c: string) => SCRIPT_RES.find(([, re]) => re.test(c))?.[0];

function frontmatter(text: string): string {
  return FRONTMATTER.exec(text)?.[0] ?? "";
}

/**
 * Fenced code blocks and the prose around them. Line by line, as CommonMark does: a fence
 * of 3+ backticks or tildes, closed by a fence of the same character at least as long;
 * an unclosed fence runs to the end. Each content line loses up to the opening fence's
 * own indentation, as CommonMark does, so moving a block into a list item (which indents
 * fence and content together) is a polish, while shifting the code inside it isn't.
 * Trailing whitespace is ignored.
 */
/** Columns of leading whitespace, a tab reaching the next multiple of 4 (CommonMark). */
const columns = (ws: string) => [...ws].reduce((c, ch) => (ch === "\t" ? c + 4 - (c % 4) : c + 1), 0);


/**
 * Code spans and HTML comments in one left-to-right pass, as CommonMark reads them:
 * whichever starts first wins (a comment inside a code span is code, and a backtick
 * inside a comment is comment). Each code span becomes CODE_MARK plus a private-use
 * character naming it (no letter or digit, so no other check reads it), keeping its
 * line breaks; each comment becomes its line breaks. Linear: a run length or a comment
 * opener that found no closer once is not searched for again in that paragraph.
 */
const CODE_MARK = "\u0004";
const CODE_REF = /\u0004([\u{F0000}-\u{FFFFD}])/gu;
function inlineTokens(text: string): { masked: string; codes: string[]; raws: string[]; comments: string[]; commentHidesCode: boolean } {
  const codes: string[] = [];
  const raws: string[] = []; // each span as written, backticks and all
  const comments: string[] = [];
  let commentHidesCode = false;
  let out = "";
  let at = 0;
  let noCommentClose = false;
  const noCloser = new Map<number, number>(); // run length → paragraph end it failed in
  let paraEnd = -1;
  const keepBreaks = (t: string) => t.replace(/[^\n]/g, "");
  // Open brackets in this paragraph: at a `]` that closes one, CommonMark parses a link's
  // `(destination)` before it reads any backtick inside it, so `](a`b)` isn't code.
  let open = 0;
  const linkTail = linkTails(text);
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n" && text[i + 1] === "\n") open = 0;
    else if (c === "[") open++;
    else if (c === "]" && open > 0) {
      open--;
      const tail = text[i + 1] === "(" ? linkTail(i) : null;
      if (tail) {
        i = tail.end;
        continue;
      }
    }
    if (c === "<" && !noCommentClose && text.startsWith("<!--", i)) {
      const j = text.indexOf("-->", i + 4);
      if (j < 0) {
        noCommentClose = true;
        i += 4;
        continue;
      }
      const comment = text.slice(i, j + 3);
      comments.push(comment.replace(/\s+/g, " "));
      if (comment.includes(FENCE_MARK)) commentHidesCode = true;
      out += text.slice(at, i) + keepBreaks(comment);
      at = i = j + 3;
      continue;
    }
    if (c === "`") {
      let n = 0;
      while (text[i + n] === "`") n++;
      if (i >= paraEnd) {
        const para = text.indexOf("\n\n", i); // positions only move forward: linear
        paraEnd = para < 0 ? text.length : para;
      }
      const end = paraEnd;
      if ((noCloser.get(n) ?? -1) === end) {
        i += n;
        continue;
      }
      let close = -1;
      for (let k = i + n; k < end; ) {
        if (text[k] !== "`") {
          k++;
          continue;
        }
        let m = 0;
        while (text[k + m] === "`") m++;
        if (m === n) {
          close = k;
          break;
        }
        k += m;
      }
      if (close < 0) {
        noCloser.set(n, end);
        i += n;
        continue;
      }
      const code = text.slice(i + n, close);
      out += text.slice(at, i) + CODE_MARK + String.fromCodePoint(0xf0000 + codes.length) + keepBreaks(code);
      // As CommonMark renders it: the line break becomes a space, and spaces before it
      // stay. A continuation line's indentation is already gone by then: a paragraph's
      // raw content is "formed by concatenating the lines and removing initial and final
      // spaces or tabs" (spec §4.8; `aaa\n   bbb` renders `aaa\nbbb`), before inline
      // parsing finds the span. So `printf 'a\n  b'` renders `printf 'a b'`.
      codes.push(code.replace(/\n[ \t]*/g, " "));
      raws.push(text.slice(i, close + n));
      at = i = close + n;
      continue;
    }
    i++;
  }
  return { masked: out + text.slice(at), codes, raws, comments, commentHidesCode };
}

/** Puts each code span's source back where `inlineTokens` left its mark. */
type Unmask = (s: string) => string;

/**
 * A destination CommonMark takes: `<…>`, or a bare one that doesn't start with `<` and
 * holds no space or control character, with its parentheses balanced (escaped ones
 * aside) to cmark's depth of 32. Otherwise the line isn't a definition: it renders as
 * text and is compared as text (merge gate, PR 3, round 31).
 */
function destination(d: string): boolean {
  if (d.startsWith("<")) return /^<(?:\\.|[^<>\\\n])*>$/.test(d);
  if (/[\x00-\x20\x7f]/.test(d)) return false; // ASCII space and controls only, as cmark
  let depth = 0;
  for (let i = 0; i < d.length; i++) {
    if (d[i] === "\\") i++;
    else if (d[i] === "(" && ++depth > 32) return false;
    else if (d[i] === ")" && depth-- === 0) return false;
  }
  return depth === 0;
}

// The tail of a label that began on an earlier line (`[foo` then `bar]: …`).
const LABEL_TAIL = /^[^\[\n]*\]:/m;
// A definition's title that opens, on its line or the next, and maybe closes later: a
// title may span lines, and then it's hidden text (merge gate, PR 3, round 33).
const TITLE_OPEN = new RegExp(
  String.raw`^${CONTAINER}[ \t]{0,3}\[(?!\^)(?:\\.|[^\[\]\\\n])+\]:[ \t]*(?:\n${CONTINUE}[ \t]*)?(<(?:\\.|[^<>\\\n])*>|\S+)(?:[ \t]+|[ \t]*\n${CONTINUE}[ \t]*)(["'(])([^\n]*)$`,
  "gm",
);
const closes = (rest: string, open: string) => {
  const close = open === "(" ? ")" : open;
  for (let i = 0; i < rest.length; i++) if (rest[i] === "\\") i++; else if (rest[i] === close) return true;
  return false;
};
// Quote and list markers at a line's start: what's left is the block the line holds.

/**
 * Reference definitions that CommonMark would take as such: not interrupting a
 * paragraph (the line before holds nothing, a heading, a fence, a thematic break or
 * another definition, or the definition opens a new quote or list item). One that
 * follows paragraph text renders as text, and is compared as text.
 *
 * `unsure` is set where telling the two apart takes more structure than this reads: a
 * definition-like line indented by a tab or four spaces in prose (a deep list item's),
 * a label or title that spans lines, or a definition after a `===` line (a setext
 * heading, or paragraph text). A polish refuses those pages rather than guess (merge
 * gate, PR 3, round 32). Indented code is found by the block pass and isn't prose.
 */
// A definition on a line's content (its container markers off), as commonmark.js reads
// it: up to three spaces, the label, a colon, spaces (and one line break), the
// destination, then a title after spaces or a line break, and nothing after it.
const DEF_AT = /^ {0,3}\[(?!\^)((?:\\.|[^\[\]\\\n])+)\]:[ ]*(?:\n[ ]*)?(<(?:\\.|[^<>\\\n])*>|\S+)(?:(?:[ ]+|[ ]*\n[ ]*)("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\((?:\\.|[^()\\\n])*\)))?[ ]*(?=\n|$)/;
export type Definition = { label: string; dest: string; title: string };
// A title that opens on a candidate's line (or the next) and doesn't close there may
// span lines, as CommonMark allows; checked on the same view the definitions are read
// on, so an indented continuation definition is seen too (found by fuzzing).
const TITLE_AT = /^ {0,3}\[(?!\^)(?:\\.|[^\[\]\\\n])+\]:[ ]*(?:\n[ ]*)?(<(?:\\.|[^<>\\\n])*>|\S+)(?:[ ]+|[ ]*\n[ ]*)(["'(])([^\n]*)/;

/**
 * Reference definitions as CommonMark takes them. One may begin only where a paragraph
 * begins (the block pass says where), or right after another; it's read on the line's
 * content (the text given is past quote and list markers); its destination or title may sit on the
 * next line only if that line continues the paragraph. One that follows paragraph text
 * renders as text, and is compared as text.
 *
 * `unsure` is set where CommonMark implementations differ or this doesn't read the
 * form: a tab between a definition's parts (commonmark.js takes spaces only), or a
 * label or title that spans lines. A polish refuses those pages rather than guess.
 */
function definitionSpans(text: string, unmask: Unmask, blocks: Blocks): { spans: [number, number][]; defs: Definition[]; unsure: boolean } {
  const spans: [number, number][] = [];
  const defs: Definition[] = [];
  let unsure = LABEL_TAIL.test(text);
  for (const m of text.matchAll(TITLE_OPEN)) if (destination(unmask(m[1]!)) && !closes(m[3]!, m[2]!)) unsure = true;
  const lines = text.split("\n");
  const at: number[] = [];
  for (let k = 0, o = 0; k < lines.length; o += lines[k]!.length + 1, k++) at.push(o);
  // `text` is the content view: each line past its container markers already.
  const body = (k: number) => lines[k]!;
  // A line continues the paragraph the previous one is in.
  const continues = (k: number) => k < lines.length && Boolean(blocks.para[k]) && !blocks.paraStart[k];
  let afterDef = false;
  for (let k = 0; k < lines.length; ) {
    if (!(blocks.paraStart[k] || (afterDef && continues(k)))) {
      afterDef = false;
      k++;
      continue;
    }
    // A paragraph's continuation lines lose their indentation before definitions are
    // read: `    [a]: x` right after another definition is one (CommonMark §4.8).
    let view = blocks.paraStart[k] ? body(k) : body(k).replace(/^[ \t]+/, "");
    if (/^ {0,3}\[(?!\^)[^\]\n]*\]:/.test(view) && view.includes("\t")) unsure = true;
    if (continues(k + 1)) view += `\n${body(k + 1)}`;
    if (continues(k + 1) && continues(k + 2)) view += `\n${body(k + 2)}`;
    const opened = TITLE_AT.exec(view);
    if (opened && destination(unmask(opened[1]!)) && !closes(opened[3]!, opened[2]!)) unsure = true;
    const m = DEF_AT.exec(view);
    const name = m ? unmask(m[1]!) : "";
    // A label holds something other than spaces, and at most 999 characters.
    if (!m || !/\S/.test(name) || name.length > 999 || !destination(unmask(m[2]!))) {
      afterDef = false;
      k++;
      continue;
    }
    const used = m[0].split("\n").length;
    // A setext underline after a paragraph of only definitions isn't one in CommonMark:
    // the definitions come out first, and `-` or `===` starts a new paragraph. The block
    // pass doesn't read definitions, so such a page isn't polished.
    if (k + used < lines.length && !blocks.para[k + used] && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[k + used]!)) unsure = true;
    spans.push([at[k]!, at[k + used - 1]! + lines[k + used - 1]!.length]);
    defs.push({ label: m[1]!, dest: m[2]!, title: m[3] ?? "" });
    afterDef = true;
    k += used;
  }
  return { spans, defs, unsure };
}

// Code in reading order: a code block's mark, or an inline code span's.
const CODE_IN_ORDER = /\u0002|\u0004([\u{F0000}-\u{FFFFD}])/gu;

// Code blocks as CommonMark finds them, fenced and indented, in containers or not.
const splitFences = codeBlocks;

/**
 * Inline links `](destination "title")`, found by scanning as CommonMark does: an
 * <angle-bracketed> destination, or one with balanced parentheses to any depth and
 * backslash escapes. Text that doesn't parse as a link isn't one, and renders as text.
 */
type LinkTail = { end: number; dest: string; title: string; tab: boolean };

/**
 * A parser for the `(destination "title")` after a `]`, as CommonMark parses it (null
 * when it doesn't). `tab` says a tab sat around the destination or title (commonmark.js
 * takes spaces only). Linear over a text: a title that ran to its paragraph's end
 * without closing isn't scanned again from a later `](` (`[a](b (t` repeated took 1.8 s).
 * A `<destination` scan stops at the next `<`, so it's linear already.
 */
function linkTails(text: string): (i: number) => LinkTail | null {
  const titleFail: Record<string, number> = {}; // no closer before this paragraph end
  return (i) => linkTail(text, i, titleFail);
}

function linkTail(text: string, i: number, titleFail: Record<string, number>): LinkTail | null {
  let tab = false;
  const space = (j: number) => {
    const from = j;
    while (j < text.length && /[ \t]/.test(text[j]!)) j++;
    if (text[j] === "\n") j++;
    while (j < text.length && /[ \t]/.test(text[j]!)) j++;
    if (text.slice(from, j).includes("\t")) tab = true;
    return j;
  };
  let j = space(i + 2);
  let dest: string;
  if (text[j] === "<") {
    let k = j + 1;
    for (; k < text.length && text[k] !== ">" && text[k] !== "\n" && text[k] !== "<"; k++) if (text[k] === "\\") k++;
    if (text[k] !== ">") return null;
    dest = text.slice(j + 1, k);
    j = k + 1;
  } else {
    const from = j;
    let depth = 0;
    for (; j < text.length; j++) {
      const c = text[j]!;
      if (c === "\\") j++;
      else if (/\s/.test(c)) break;
      else if (c === "(") {
        if (++depth > 32) return null; // cmark's own limit; deeper isn't a link
      } else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (depth !== 0) return null;
    dest = text.slice(from, j);
  }
  const afterDest = j;
  j = space(j);
  const opener = text[j];
  let title = "";
  if (j > afterDest && (opener === '"' || opener === "'" || opener === "(")) {
    const close = opener === "(" ? ")" : opener;
    if (j < (titleFail[close] ?? -1)) return null;
    let k = j + 1;
    // A title ends with its paragraph: it can't hold a blank line.
    for (; k < text.length && text[k] !== close; k++) {
      if (text[k] === "\\") k++;
      else if (text[k] === "\n" && /^[ \t]*(?:\n|$)/.test(text.slice(k + 1, k + 80))) {
        titleFail[close] = k;
        return null;
      }
    }
    if (k >= text.length) {
      titleFail[close] = k;
      return null;
    }
    title = text.slice(j + 1, k);
    j = space(k + 1);
  }
  return text[j] === ")" ? { end: j + 1, dest, title, tab } : null;
}

function inlineLinks(text: string): { start: number; end: number; dest: string; title: string; tab?: boolean }[] {
  const out: { start: number; end: number; dest: string; title: string; tab?: boolean }[] = [];
  // A `](` is a link only after a `[` it closes (`](x)` alone is text).
  const opened = bracketMatches(text);
  const tail = linkTails(text);
  let literalEnd = -1; // the unparsed literal already covers up to here
  for (let i = text.indexOf("]("); i >= 0; i = text.indexOf("](", i + 1)) {
    if (!opened.has(i)) continue;
    const link = tail(i);
    if (link) {
      const { tab, ...rest } = link;
      out.push({ start: i, ...rest, ...(tab ? { tab: true } : {}) });
      i = link.end - 1; // a `](` inside a destination doesn't start another link
      continue;
    }
    // Fail closed: what this scanner can't read is compared as written, to the line's
    // end, so a form it misses can't hide a changed target. Scanning goes on after it:
    // a later `](` may close an outer `[` and be the real link (CommonMark drops the
    // failed opener; found by differential fuzzing).
    if (i < literalEnd) continue; // inside the literal already recorded
    const eol = text.indexOf("\n", i);
    const end = eol < 0 ? text.length : eol;
    out.push({ start: i, end, dest: `unparsed ${text.slice(i, end)}`, title: "" });
    literalEnd = end;
  }
  return out;
}

/** `text` with each inline link's `](…)` replaced, keeping the link text. */
function withoutDestinations(text: string, links: { start: number; end: number }[], replacement: string): string {
  let out = "";
  let at = 0;
  for (const l of links) {
    if (l.start < at) continue;
    out += text.slice(at, l.start) + replacement;
    at = l.end;
  }
  return out + text.slice(at);
}

// An entity renders as its character: `&#110;ot` is "not" to a reader, so decode it first.
// `&minus;` and `&plus;` too: they are signs, and a sign is part of a number.
// Not after an odd run of backslashes: `\&#53;` is the text `&#53;` (found by fuzzing).
const ENTITY = /(?<=(?:^|[^\\])(?:\\\\)*)&(#\d{1,7}|#x[0-9a-f]{1,6}|amp|lt|gt|quot|apos|nbsp|minus|plus);/gi;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", minus: "\u2212", plus: "+" };
function decodeEntity(_whole: string, e: string): string {
  if (e[0] !== "#") return NAMED[e.toLowerCase()]!;
  const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
}

// A reference label as CommonMark matches it: spacing collapsed and Unicode case folded,
// so `[STRASSE]` uses `[straße]: …` (folded as commonmark.js does, lower then upper).
const label = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();
// Only the angle form loses its brackets: a bare `safe.md>` keeps its `>`.
const dest = (s: string) => (s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1) : s);

/** Every link a reader can follow: inline targets, and reference uses resolved to theirs. */
/** The text a link shows: case, spacing and emphasis aside. */
// Emphasis markers only: an underscore inside a word (`prod_api`) is text.
// As written, spacing aside: case counts (`[US]` and `[us]` are different links), and
// so does every `*` (`delete *.log` isn't `delete .log`).
const shownText = (t: string) => t.replace(/\s+/g, " ").trim();

/**
 * For every `]`, where its matching `[` is: one forward pass with a stack, honouring
 * backslash escapes, and reset at a blank line (a label can't cross paragraphs). Linear,
 * where looking back from each `](` was linear per link.
 */
function bracketMatches(text: string): Map<number, number> {
  const match = new Map<number, number>();
  const open: number[] = [];
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === "\\") k++;
    else if (c === "[") open.push(k);
    else if (c === "]") {
      const start = open.pop();
      if (start !== undefined) match.set(k, start);
    } else if (c === "\n" && text[k + 1] === "\n") open.length = 0;
  }
  return match;
}

/** The visible text of the link whose closing `]` is at `i`, or "" without a match. */
const labelAt = (text: string, match: Map<number, number>, i: number) => {
  const start = match.get(i);
  return start === undefined ? "" : text.slice(start + 1, i);
};

/**
 * Every link a reader can follow: inline targets, and reference uses resolved to theirs.
 * `pairs` keeps each target with the text that shows it, so two links can't trade
 * destinations without the change showing.
 */
function linkTargets(text: string, parsed: Definition[], unmask: Unmask): { targets: string[]; pairs: string[] } {
  // A title shows on hover, so it's part of what a link says.
  const titled = (t: string) => (t.trim() ? ` "${t.trim().replace(/\s+/g, " ")}"` : "");
  const defs = new Map<string, string>();
  const defTitles = new Map<string, string>();
  // Only definitions CommonMark takes as such (definitionSpans), each read on its own.
  // Code spans count as written: a definition is read before inline code, and a label,
  // a destination or a title can hold backticks (`[`x`]: https://…`).
  for (const d of parsed)
    if (!defs.has(label(unmask(d.label)))) {
      defs.set(label(unmask(d.label)), dest(unmask(d.dest)));
      defTitles.set(label(unmask(d.label)), titled(unmask(d.title.replace(/^["'(]|["')]$/g, ""))));
    }
  const inline = inlineLinks(text);
  const targets = inline.map((l) => dest(unmask(l.dest)));
  const textMatch = bracketMatches(text);
  // An image (`![…](…)`) loads by itself where a link waits for a click: it's marked.
  // Unless the `!` is escaped (`\![a](x)` is a link).
  const bang = (t: string, open: number | undefined) => {
    if (open === undefined || t[open - 1] !== "!") return "";
    let k = open - 2;
    while (k >= 0 && t[k] === "\\") k--;
    return (open - 2 - k) % 2 ? "" : "!";
  };
  const pairs = inline.map((l) => `${bang(text, textMatch.get(l.start))}${shownText(unmask(labelAt(text, textMatch, l.start)))} → ${dest(unmask(l.dest))}${titled(unmask(l.title))}`);
  // Reference uses, once inline links and definitions are out of the way. An unused
  // definition shows nothing, and a use with no definition is plain text.
  // (Definitions were blanked out of `text` already.)
  // Only parsed links are cut: an unparsed `](` stays a literal fact above, and the
  // reference uses after it are still read (`[r](n` then `[prod]`; found by fuzzing).
  let rest = withoutDestinations(
    text,
    inline.filter((l) => !l.dest.startsWith("unparsed ")),
    "]\u0000",
  );
  // Full and collapsed references (`[text][label]`, `[label][]`), found like inline
  // links: back from each `][` to the matching `[`, at any depth of nesting.
  const uses: [number, number][] = [];
  const restMatch = bracketMatches(rest);
  for (let i = rest.indexOf("]["); i >= 0; i = rest.indexOf("][", i + 1)) {
    let k = i + 2;
    for (; k < rest.length && rest[k] !== "]" && rest[k] !== "[" && !(rest[k] === "\n" && rest[k + 1] === "\n"); k++) if (rest[k] === "\\") k++;
    if (rest[k] !== "]") continue;
    const shown = labelAt(rest, restMatch, i);
    if (!shown && rest[i - 1] !== "[") continue; // no opening bracket: not a reference
    const key = label(unmask(rest.slice(i + 2, k) || shown));
    const target = defs.get(key);
    // Unresolved, it's text, and a shortcut inside it (`[r [a] x][]`) can still be a
    // link (commonmark.js parseCloseBracket); so only a resolved one is taken out.
    if (target === undefined) continue;
    targets.push(target);
    pairs.push(`${bang(rest, restMatch.get(i))}${shownText(unmask(shown))} → ${target}${defTitles.get(key)}`);
    uses.push([i - shown.length - 1, k + 1]);
    i = k;
  }
  rest = cut(rest, uses, () => " ");
  for (const m of rest.matchAll(SHORTCUT_REF)) {
    const key = label(unmask(m[1]!));
    const target = defs.get(key);
    if (target !== undefined) {
      targets.push(target);
      pairs.push(`${bang(rest, m.index)}${shownText(unmask(m[1]!))} → ${target}${defTitles.get(key)}`);
    }
  }
  return { targets, pairs };
}

/**
 * A bare URL as GFM links it: without the punctuation after it, or an unbalanced closing
 * paren. GFM's autolink extension: "Trailing punctuation (specifically, ?, !, ., ,, :,
 * *, _, and ~) will not be considered part of the autolink", and cmark-gfm's
 * `autolink_delim` strips them (and `;`). So `…/runbook_` and `…/runbook~` both link to
 * `…/runbook`: only a literal character after the link differs, which is prose.
 */
function trimUrl(u: string): string {
  // Parentheses counted once (recounting per `)` was quadratic on `https://x/)))…`).
  let open = 0;
  let close = 0;
  for (const c of u) if (c === "(") open++;
  else if (c === ")") close++;
  let end = u.length;
  for (;;) {
    const c = u[end - 1];
    if (c === ")" && close > open) {
      close--;
      end--;
    } else if (c !== undefined && "?!.,:*_~'\"".includes(c)) end--;
    else if (c === ";") {
      // GFM's autolinker reads decoded text: a real entity (`&amp;`, `&#46;`) is its
      // character there, which is then trimmed like any other (`.` goes, `&` stays).
      // cmark-gfm drops an entity-like tail it sees raw (`&hl;`, the GFM spec's example);
      // an entity this can't decode is kept, so the URL here is never shorter than
      // GitHub's (found by differential fuzzing and the review).
      let k = end - 2;
      while (k >= 0 && /[a-zA-Z0-9#]/.test(u[k]!)) k--;
      const name = u.slice(k + 1, end - 1);
      if (!(k >= 0 && u[k] === "&" && name)) end--;
      else {
        const num = /^#(\d{1,7}|x[0-9a-f]{1,6})$/i.exec(name);
        const code = num ? (num[1]![0]!.toLowerCase() === "x" ? Number.parseInt(num[1]!.slice(1), 16) : Number(num[1])) : null;
        const ch = code !== null ? (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd") : Object.hasOwn(NAMED, name) ? NAMED[name]! : null;
        if (ch === null) return u.slice(0, end);
        u = u.slice(0, k) + ch;
        end = u.length;
        if (ch === "(") open++;
        else if (ch === ")") close++;
      }
    } else return u.slice(0, end);
  }
}

/** What the guard compares, taken from one version of the page. */
export function facts(text: string) {
  const fm = frontmatter(text);
  // Line endings are formatting: compare the body with LF throughout.
  const body = text.slice(fm.length).replace(/\r\n?/g, "\n");
  // Fences first: a comment inside code is code. Then comments, outside code only; one
  // that wraps a fenced block hides it, which a polish may neither do nor be checked
  // around (`commentHidesCode`).
  const split = splitFences(body);
  const fences = split.fences;
  // Everything below reads each line's content, past its quote and list markers, as
  // CommonMark's inline parsing does: a link's text or a code span that wraps inside a
  // quote doesn't take the `> ` with it (found by differential fuzzing).
  const view = split.prose
    .split("\n")
    .map((l, i) => l.slice(split.content[i] ?? 0).replace(/^[ \t]+$/, ""))
    .join("\n");
  // Reference definitions render as nothing: read them for their targets, then blank
  // them out of everything a reader sees (a command moved into an unused definition's
  // title has left the page). They're block structure, read before any inline
  // construct: in `[a]: ```sh` the backticks are the destination, and can't pair with
  // a backtick on the next line into a code span (found by differential fuzzing).
  const raw: Unmask = (s) => s;
  const defs = definitionSpans(view, raw, split);
  const defined = new Set(defs.defs.map((d) => label(d.label)));
  const tokens = inlineTokens(cut(view, defs.spans, (d) => d.replace(/[^\n]/g, "")));
  const { comments, commentHidesCode } = tokens;
  const unmask: Unmask = (s) => s.replace(CODE_REF, (_, c: string) => tokens.raws[c.codePointAt(0)! - 0xf0000]!);
  const prose = tokens.masked;
  // Inline code still on the page (a line break inside a span renders as a space, so
  // rewrapping one is a polish).
  const inline = [...prose.matchAll(CODE_REF)].map((m) => tokens.codes[m[1]!.codePointAt(0)! - 0xf0000]!);
  // All code in reading order, fenced and inline: running `drain` and `delete` in each
  // other's step is a different runbook. (Per section wouldn't do: two sections trading
  // commands looks the same as two sections trading places, headings and all.)
  let fenceAt = 0;
  const codeOf = (m: RegExpMatchArray) => (m[0] === FENCE_MARK ? `fence ${fences[fenceAt++]}` : `code ${tokens.codes[m[1]!.codePointAt(0)! - 0xf0000]}`);
  // And the code under each heading, keyed by its text: a command moved from "Steps"
  // to "Rollback" keeps the page's order but not its meaning. Only headings both
  // versions have are compared, so adding or rewording a heading is still a polish.
  // A heading's code includes its subsections', so adding `## Steps` under an existing
  // heading is still a polish.
  const codeBySection = new Map<string, string[]>();
  const order: string[] = [];
  const open: { level: number; key: string }[] = [];
  const seen = new Map<string, number>();
  // Quote and list markers off first, and any indentation allowed: `> ## Steps`,
  // `- ## Steps` and a heading on a deep list item's continuation line are headings too
  // (merge gate, PR 3, round 34). A setext heading (`Steps` over `=====` or `-----`) is
  // a heading too. Taking a line for a heading that CommonMark wouldn't only adds a
  // section to compare: stricter, never blinder.
  const atx = prose
    .replace(/^(?:[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+))+/gm, "")
    .replace(/^([ \t]*\S[^\n]*)\n[ \t]*(=+|-+)[ \t]*$/gm, (whole, text: string, bar: string) =>
      /^[ \t]*#/.test(text) ? whole : `${bar[0] === "=" ? "#" : "##"} ${text.trim()}`,
    );
  for (const section of atx.split(/^(?=[ \t]*#{1,6}(?:[ \t]|$))/m)) {
    const heading = /^[ \t]*(#{1,6})[ \t]*(.*)$/m.exec(section);
    if (heading && section.startsWith(heading[0])) {
      const level = heading[1]!.length;
      while (open.length && open.at(-1)!.level >= level) open.pop();
      // Keyed as written (spacing and a closing `##` aside, code spans restored) and
      // numbered when it repeats: no two headings share a key, so code can't move
      // between them unseen (`prod_api` and `prodapi`, or two `Steps`; merge gate, PR 3,
      // round 35). Restyling a heading stops its section being compared, as rewording
      // one does. Repeats are compared occurrence by occurrence only while both versions
      // have as many, so renaming one of two `Steps` unshares it the same way.
      const text = unmask(heading[2]!).replace(/(?:^|[ \t]+)#+[ \t]*$/, "").replace(/\s+/g, " ").trim();
      let key = text;
      if (text) {
        const n = (seen.get(text) ?? 0) + 1;
        seen.set(text, n);
        key = `${text}\u0001${n}`;
      }
      open.push({ level, key });
    }
    const seq = [...section.matchAll(CODE_IN_ORDER)].map(codeOf);
    order.push(...seq);
    for (const { key } of open) {
      if (!key) continue;
      const list = codeBySection.get(key) ?? [];
      if (!codeBySection.has(key)) codeBySection.set(key, list);
      for (const c of seq) list.push(c);
    }
  }
  const codeOrder = order.join("\u0001");
  // An ordered-list number where CommonMark opens an item is a container marker, not in
  // the content view; anywhere else (`retry\n3. times`) it's text, and counted.
  const noCode = prose.replace(CODE_REF, " ");
  // Links read code spans as written, so `[`a`](u)` and `[`b`](u)` say different things.
  const { targets, pairs: linkPairs } = linkTargets(prose, defs.defs, unmask);
  const links = [...targets, ...[...noCode.matchAll(AUTOLINK)].map((m) => m[1]!), ...[...noCode.matchAll(HTML_LINK)].map((m) => m[1] ?? m[2] ?? m[3]!)];
  const scanned = inlineLinks(noCode);
  const linkTab = scanned.some((l) => l.tab);
  // Parsed links only: an unparsed `](` is a literal fact above, and its text stays in
  // what's read for HTML and words (`[p](rod]: <prod` then `page.md>` on the next line
  // is a raw tag; found by differential fuzzing).
  const noLinks = withoutDestinations(
    noCode,
    scanned.filter((l) => !l.dest.startsWith("unparsed ")),
    "] ",
  );
  // Bare URLs, emails and www. links, outside autolinks and anchors (counted as links).
  const bare = noLinks.replace(AUTOLINK, " ").replace(HTML_LINK, " ");
  const urls = [...bare.matchAll(URL), ...bare.replace(URL, " ").matchAll(WWW), ...bare.replace(URL, " ").replace(WWW, " ").matchAll(BARE_EMAIL)].map((m) => trimUrl(m[0]));
  // Tags outside code and link destinations (`[a](<x y>)` isn't HTML; autolinks look
  // like tags, and are links).
  const htmlText = noLinks.replace(AUTOLINK, " ");
  // Closed comments were cut out above, so an opener left here is real raw HTML.
  const openers = [...htmlText.matchAll(OPENER)].map((m) => m[0].toLowerCase());
  const special = [...spans(htmlText, "<?", "?>"), ...spans(htmlText, "<![CDATA[", "]]>")].sort((x, y) => x[0] - y[0]);
  const tags = [...special.map(([i, j]) => htmlText.slice(i, j)), ...[...htmlText.matchAll(TAG)].map((m) => m[0])].map((t) => t.replace(/\s+/g, " ").toLowerCase());
  // Characters that look like ASCII or are invisible: compared as a set, so a polish
  // can't spell "n\u043et" with a Cyrillic o, or hide a zero-width space in a word.
  // Entities decoded first: `&#8203;` is a zero-width space too.
  const decoded = body.replace(ENTITY, decodeEntity);
  const unusual = [...new Set(decoded.match(UNUSUAL) ?? [])].sort();
  // Invisible characters are counted, not just noted: one already on the page doesn't
  // license another.
  const invisibles = decoded.match(/[\p{Cf}\p{Cc}\u00ad]/gu)?.filter((c) => !"\t\n\r".includes(c)) ?? [];
  // Named entities beyond the few decoded above (`&minus;` renders as a sign): this check
  // can't read them, so a polish may not add one.
  // Each with what follows it, so moving one onto another word or number is a change.
  const entities = [...body.matchAll(/&([a-z][a-z0-9]{1,31});([^\s<>&]{0,32})/gi)].filter((m) => !(m[1]!.toLowerCase() in NAMED)).map((m) => m[0]);
  const struck = [...noLinks.matchAll(STRUCK)].map((m) => (m[1] ?? m[3] ?? "").trim().replace(/\s+/g, " "));
  // Numbers and words in running text only: not inside code or URLs, and not list markers.
  // Link text reads as text: `5 [minutes](units.md)` pairs 5 with minutes.
  const hidden = [...spans(noLinks, "<?", "?>"), ...spans(noLinks, "<![CDATA[", "]]>")].sort((x, y) => x[0] - y[0]);
  const unmarked = cut(noLinks, hidden, () => " ")
    // Links first, on the same text the URL facts read: `[https://x/5` isn't a GFM link
    // (a `[` before it), so its `5` stays text (found by differential fuzzing).
    .replace(AUTOLINK, " ")
    .replace(HTML_LINK, " ")
    .replace(URL, " ")
    .replace(WWW, " ")
    // A full reference shows its text; its label shows too when it resolves to nothing
    // (`[run][never]` with no definition is all text in CommonMark).
    .replace(FULL_REF, (whole, text: string, lab: string) => (defined.has(label(lab || text)) ? ` ${text} ` : whole))
    // A bracket that isn't a link's is text: `202[4` isn't `2024`, nor `no[t` `not`.
    .replace(/!?\[|\]/g, " ")
    .replace(TAG, " ");
  const words = unmarked.replace(EMPHASIS, "").replace(ENTITY, decodeEntity);
  // The same text with each emphasis marker read as a break. An unclosed `**` is literal
  // in CommonMark (`no**t` isn't `not`), and closed ones read either way, so counts are
  // compared both ways (found by differential fuzzing against commonmark.js).
  const spaced = unmarked.replace(EMPHASIS, " ").replace(ENTITY, decodeEntity);
  // Every run of digits in the text, whatever it's attached to (`on-c3`, `ra&#53;te`):
  // a net under the number tokens, which pair a number with its unit.
  const digitRuns = (t: string) => [...t.matchAll(/\p{Nd}+/gu)].map((m) => m[0]);
  const digits = digitRuns(words);
  const digitsSpaced = digitRuns(spaced);
  // Compared as `5 minute`, named as the page wrote it (`5 minutes`).
  const shown = new Map<string, string>();
  const numbers = [...words.matchAll(NUMBER)].map((m) => {
    // As written: an attached unit (`500MB`) is part of the token, and its case counts.
    const n = m[1]!.replace("\u2212", "-");
    const word = /^[a-z]/i.test(n) ? undefined : m[2];
    const key = `${n}${word ? ` ${unit(word)}` : ""}`;
    if (!shown.has(key)) shown.set(key, `${n}${word ? ` ${word}` : ""}`);
    return key;
  });
  // Words with digits in them (`TLSv1.2`, `IPv4`, `RHEL8`, `p99`): a version or a size
  // as much as any number is.
  const digitWords = [...words.matchAll(/(?<![\w.-])[a-z][\w\p{Nd}]*\p{Nd}[\w.\p{Nd}]*/giu)].map((m) => m[0].replace(/\.+$/, "").toLowerCase());
  const count = (t: string) => {
    const lower = t.toLowerCase().replace(/[\u2018\u2019]/g, "'");
    return [
      ...NEGATIONS.map((w) => `${w}×${(lower.match(new RegExp(`(?<![\\w'])${w}(?![\\w'])`, "g")) ?? []).length}`),
      // Every other "n't" (didn't, wasn't, wouldn't, …), counted together.
      `n't×${(lower.match(/\b[a-z]+n't\b/g) ?? []).filter((w) => !NEGATIONS.includes(w)).length}`,
    ];
  };
  const negations = count(words);
  const negationsSpaced = count(spaced);
  // A task list's boxes: ticking one says a step is done.
  // Each with its task's text: tasks may move with their boxes, but a tick may not move
  // to another task (so a task's text stays as written).
  // A task's text runs on over its indented continuation lines, up to a blank line or
  // the next item. Any quote and list markers may come first: `- - [ ] x` is a task in
  // a nested list (merge gate, PR 3, round 37). Each space has one place to match.
  const lines = prose.split("\n");
  const boxes: string[] = [];
  for (let k = 0; k < lines.length; k++) {
    // A task is a list item whose first paragraph starts with its box: on the item's
    // marker line, or on the next when the marker stood alone (`-` then `  [ ] x`).
    // The paragraph's own indentation comes off first (`-` then `   [ ] x`: the item takes
    // two columns, CommonMark strips the third; merge gate, PR 10, round 1).
    const m = split.itemPara[k] ? /^[ \t]*\[([ xX])\](?:[ \t]+|$)/.exec(lines[k]!) : null;
    if (!m) continue;
    let text = lines[k]!.slice(m[0].length);
    for (let n = k + 1; split.para[n] && !split.paraStart[n]; n++) text += `\n${lines[n]}`;
    boxes.push(`${m[1] === " " ? "[ ]" : "[x]"} ${shownText(unmask(text))}`);
  }
  return { frontmatter: fm, fences, comments, tags, openers, commentHidesCode, unsureDefinitions: defs.unsure, linkTab, unusual, invisibles, entities, boxes, linkPairs, codeOrder, codeBySection, headingCounts: seen, digitWords, digits, digitsSpaced, inline, links, urls, struck, numbers, shown, negations, negationsSpaced };
}

function multisetDiff(before: string[], after: string[]): { removed: string[]; added: string[] } {
  const count = new Map<string, number>();
  for (const x of before) count.set(x, (count.get(x) ?? 0) + 1);
  const added: string[] = [];
  for (const x of after) {
    const n = count.get(x) ?? 0;
    if (n > 0) count.set(x, n - 1);
    else added.push(x);
  }
  const removed = [...count].flatMap(([x, n]) => Array.from({ length: n }, () => x));
  return { removed, added };
}

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

/** Larger pages aren't polished: some patterns here cost more than linear time. */
export const POLISH_MAX_CHARS = 64 * 1024;

/** Every change the guard sees between two versions, in words. Empty means it passes. */
export function polishChanges(before: string, after: string): string[] {
  if (before.length > POLISH_MAX_CHARS || after.length > POLISH_MAX_CHARS)
    return [`is over ${POLISH_MAX_CHARS / 1024} KB, too large to check as a polish; propose specific changes with \`edits\` instead`];
  // This check marks fences and code spans with U+0000 to U+0004. A page holding one
  // could pass it off as a fence (a block moves one way, the character the other), so
  // such a page isn't polished (found alongside merge gate round 39).
  if (/[\u0000-\u0004]/.test(before) || /[\u0000-\u0004]/.test(after))
    return ["the page contains a control character (U+0000 to U+0004) that this check uses as its own mark; propose specific changes with `edits` instead"];
  const a = facts(before);
  const b = facts(after);
  const out: string[] = [];
  // Task boxes in order: which step is ticked matters, not only how many are.
  // Where a tag sits decides what it hides (`<span hidden>…</span>`), and comparing
  // positions would mean rendering the page. A page with raw HTML isn't polished.
  if (a.commentHidesCode || b.commentHidesCode)
    out.push("an HTML comment wraps a code block, hiding it; this check can't compare around that, so propose specific changes with `edits` instead");
  if (a.linkTab || b.linkTab)
    out.push("a link has a tab around its destination or title, which CommonMark implementations read differently (cmark takes it, commonmark.js doesn't); propose specific changes with `edits` instead");
  if (a.unsureDefinitions || b.unsureDefinitions)
    out.push("the page has a reference definition (`[label]: …`) in a form CommonMark implementations read differently, or this check doesn't read (a tab between its parts, a label or title spanning lines, a heading underline right after it); propose specific changes with `edits` instead");
  if (a.tags.length || a.openers.length)
    out.push("the page contains raw HTML, and where its tags sit decides what a reader sees, which this check can't compare; propose specific changes with `edits` instead");
  if (a.frontmatter !== b.frontmatter) out.push("changed the frontmatter (polish leaves it byte-for-byte)");
  const fenceDiff = multisetDiff(a.fences, b.fences);
  if (fenceDiff.removed.length || fenceDiff.added.length) out.push("changed a code block");
  const inlineDiff = multisetDiff(a.inline, b.inline);
  // Only when the code itself is unchanged: otherwise the messages below say what changed.
  if (!fenceDiff.removed.length && !fenceDiff.added.length && !inlineDiff.removed.length && !inlineDiff.added.length && a.codeOrder !== b.codeOrder)
    out.push("changed the order of the page's code (commands keep their order; move only sections that have none)");
  for (const [heading, code] of a.codeBySection) {
    const now = b.codeBySection.get(heading);
    const base = heading.replace(/\u0001\d+$/, "");
    if (a.headingCounts.get(base) !== b.headingCounts.get(base)) continue; // a repeat renamed or added
    const name = heading.replace(/\u0001(\d+)/g, (_, n: string) => (n === "1" ? "" : ` (${n})`));
    if (now && now.join("\u0001") !== code.join("\u0001")) out.push(`moved code into or out of the "${short(name)}" section`);
  }
  for (const [what, x, y] of [
    ["HTML comment", a.comments, b.comments],
    ["HTML tag", a.tags, b.tags],
    ["raw HTML opener", a.openers, b.openers],
    ["inline code", a.inline, b.inline],
    // One multiset: `<https://x>` rewritten as a bare `https://x` is the same target.
    ["link", [...a.links, ...a.urls], [...b.links, ...b.urls]],
    ["struck-through text", a.struck, b.struck],
    ["link text", a.linkPairs, b.linkPairs],
    ["task", a.boxes, b.boxes],
    // Entities this check can't read (`&minus;` is a sign): added or removed, either
    // could change what a number says.
    ["entity", a.entities, b.entities],
    ["number", a.numbers, b.numbers],
    ["word with digits", a.digitWords, b.digitWords],
  ] as const) {
    const d = multisetDiff([...x], [...y]);
    const as = (f: typeof a, v: string) => (what === "number" ? (f.shown.get(v) ?? v) : v);
    for (const r of d.removed) out.push(`removed ${what} \`${short(as(a, r))}\``);
    for (const n of d.added) out.push(`added ${what} \`${short(as(b, n))}\``);
  }
  // A new invisible character, or a letter from a script the page doesn't use (a
  // Cyrillic о in an English word). A new letter of a script already there is just
  // rewording a page written in it. Dropping a stray character is fine.
  const scripts = new Set(["Latin", ...a.unusual.map(scriptOf).filter((x): x is string => Boolean(x))]);
  for (const c of multisetDiff(a.invisibles, b.invisibles).added)
    out.push(`added the character U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}, which reads like another or not at all`);
  for (const c of b.unusual) {
    if (a.unusual.includes(c) || /[\p{Cf}\p{Cc}\u00ad]/u.test(c)) continue; // invisibles: counted above
    const script = /\p{Cf}/u.test(c) ? undefined : scriptOf(c);
    if (!script || !scripts.has(script)) out.push(`added the character U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}, which reads like another or not at all`);
  }
  // Digits the number tokens didn't pair (`on-c3`, `ra&#53;te`), read both ways.
  const tokensSaw = out.some((m) => /(?:number|word with digits) `/.test(m));
  if (!tokensSaw)
    for (const [x, y] of [
      [a.digits, b.digits],
      [a.digitsSpaced, b.digitsSpaced],
    ] as const) {
      const d = multisetDiff([...x], [...y]);
      if (d.removed.length || d.added.length) {
        out.push(`changed digits in the text${d.removed.length ? `: removed \`${d.removed.join(" ")}\`` : ""}${d.added.length ? `${d.removed.length ? "," : ":"} added \`${d.added.join(" ")}\`` : ""}`);
        break;
      }
    }
  for (const [x, y] of [
    [a.negations, b.negations],
    [a.negationsSpaced, b.negationsSpaced],
  ] as const) {
    const was = Object.fromEntries(x.map((v) => v.split("×") as [string, string]));
    const now = Object.fromEntries(y.map((v) => v.split("×") as [string, string]));
    const changed = [...NEGATIONS, "n't"].filter((w) => was[w] !== now[w]);
    for (const w of changed) out.push(`changed how often "${w}" appears (${was[w]} → ${now[w]})`);
    if (changed.length) break;
  }
  return out;
}

/** What the guard covered, for the PR body. */
export function polishSummary(text: string): string {
  const f = facts(text);
  return `${f.fences.length} code block(s), ${f.inline.length} inline code span(s), ${f.links.length} link(s), ${f.urls.length} URL(s) and ${f.numbers.length} number(s) unchanged; frontmatter identical`;
}
