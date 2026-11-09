import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Parser } from "commonmark";
import { NEGATIONS, polishChanges } from "../src/core/polish.js";

// A differential check for the polish guard. CommonMark's reference parser
// (commonmark.js, a dev dependency only) says what a page renders; the guard says what
// changed. A pair where the rendered facts differ but the guard reports nothing is a
// miss: a polish that would have changed what the page says, unseen.
//
// The oracle reads only the classes the guard claims and core CommonMark has: code
// blocks (with their info string), inline code, code order, links and images (text,
// target, title), digits and negation words in visible text. GFM-only forms (tasks,
// strikethrough, bare URLs) aren't in core, and the guard compares those more strictly.

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

export type Facts = Record<string, string[]>;

// GitHub's bare-URL autolinks (GFM's extension, not in core CommonMark): `www.`, `http`
// and `https` links and emails in text, with trailing punctuation left out as cmark-gfm's
// autolink_delim does. They count as links here as they do on GitHub.
const BARE = /(?<=^|[\s*_~(])(?:(?:https?:\/\/|www\.)[^\s<]+|[a-zA-Z0-9.+_-]+@[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+)/g;
function delim(u: string): string {
  for (;;) {
    const c = u.at(-1);
    if (c === undefined) return u;
    if (c === ")") {
      if ((u.match(/\)/g) ?? []).length <= (u.match(/\(/g) ?? []).length) return u;
      u = u.slice(0, -1);
    } else if ("?!.,:*_~'\"".includes(c)) u = u.slice(0, -1);
    else if (c === ";") u = u.replace(/&[a-zA-Z0-9]+;$|;$/, "");
    else return u;
  }
}

export function oracle(page: string): Facts {
  const body = page.replace(FRONTMATTER, "");
  const doc = new Parser().parse(body);
  const blocks: string[] = [];
  const inline: string[] = [];
  const order: string[] = [];
  const links: string[] = [];
  const captures: string[] = [];
  let text = "";
  let run = ""; // adjacent text nodes outside links, for bare URLs
  const flush = () => {
    for (const m of run.matchAll(BARE)) {
      const u = delim(m[0]);
      if (u.includes("@") && !u.includes("/") && /[-_]$/.test(u)) continue;
      links.push(`${u} → ${u} ""`);
    }
    run = "";
  };
  const add = (s: string) => {
    text += s;
    for (let i = 0; i < captures.length; i++) captures[i] += s;
  };
  const walker = doc.walker();
  for (let ev = walker.next(); ev; ev = walker.next()) {
    const n = ev.node;
    if (n.type !== "text") flush();
    switch (n.type) {
      case "code_block":
        blocks.push(`${n.info ?? ""}\u0003${n.literal ?? ""}`);
        order.push(`block ${n.info ?? ""}\u0003${n.literal ?? ""}`);
        add("\n\n");
        break;
      case "code":
        inline.push(n.literal ?? "");
        order.push(`code ${n.literal ?? ""}`);
        // A code span breaks words, as the guard reads it (`-'` then code then `never`).
        text += " ";
        for (let i = 0; i < captures.length; i++) captures[i] += `\`${n.literal}\``;
        break;
      case "text":
        add(n.literal ?? "");
        if (!captures.length) run += n.literal ?? "";
        break;
      case "softbreak":
      case "linebreak":
        add(" ");
        break;
      case "link":
      case "image":
        // A link's edges break words, as the guard reads them (`(x)Never` has "Never").
        text += " ";
        if (ev.entering) captures.push("");
        else {
          const shown = captures.pop()!.replace(/\s+/g, " ").trim();
          // A title's spacing isn't what it says: rewrapping one is a polish.
          links.push(`${n.type === "image" ? "!" : ""}${shown} → ${n.destination ?? ""} "${(n.title ?? "").replace(/\s+/g, " ").trim()}"`);
        }
        break;
      case "html_block":
      case "html_inline":
        // The guard refuses a page with raw HTML; record it so the pair is compared.
        order.push(`html ${n.literal ?? ""}`);
        break;
      case "emph":
      case "strong":
        // Emphasis edges break words too, as the guard's spaced reading does.
        text += " ";
        break;
      default:
        if (!ev.entering && n.isContainer) add("\n\n");
    }
  }
  flush();
  // An underscore at a word's edge (`never_`, `_not`) doesn't hide the word from a reader.
  const lower = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/(?<![\p{L}\p{Nd}])_+|_+(?![\p{L}\p{Nd}])/gu, " ");
  const negations = NEGATIONS.map((w) => `${w}×${(lower.match(new RegExp(`(?<![\\w'])${w.replace("'", "'")}(?![\\w'])`, "g")) ?? []).length}`);
  // GFM task boxes (not in core CommonMark): a list item whose first block is a
  // paragraph whose text starts with `[ ]` or `[x]`, then whitespace or its end.
  const tasks: string[] = [];
  const sourceLines = body.split("\n");
  const w2 = doc.walker();
  for (let ev = w2.next(); ev; ev = w2.next()) {
    const item = ev.node;
    if (!ev.entering || item.type !== "item" || item.firstChild?.type !== "paragraph") continue;
    // cmark-gfm matches the paragraph's raw text: `\[ ] x` isn't a task.
    const [[line, col]] = item.firstChild.sourcepos;
    const raw = sourceLines[line - 1]!.slice(col - 1);
    const m = /^\[([ xX])\](?:[ \t]|$)/.exec(raw);
    if (!m) continue;
    let lead = "";
    // Up to the first node that isn't text or a line break (soft or hard: two trailing
    // spaces only move the text to the next line).
    for (let t = item.firstChild.firstChild; t && (t.type === "text" || t.type === "softbreak" || t.type === "linebreak"); t = t.next) lead += t.type === "text" ? (t.literal ?? "") : "\n";
    tasks.push(`[${m[1] === " " ? " " : "x"}] ${lead.replace(/^\[[ xX]\]/, "").replace(/\s+/g, " ").trim()}`);
  }
  return {
    tasks: [...tasks].sort(),
    blocks: [...blocks].sort(),
    inline: [...inline].sort(),
    order: [order.join("\u0001")],
    links: [...links].sort(),
    digits: [...(text.match(/\p{Nd}+/gu) ?? [])].sort(),
    negations,
  };
}

/** The oracle classes that differ between two pages. */
export function oracleDiff(before: string, after: string): string[] {
  const a = oracle(before);
  const b = oracle(after);
  return Object.keys(a).filter((k) => a[k]!.join("\u0002") !== b[k]!.join("\u0002"));
}

/** A miss: what renders differs, and the guard reports nothing. */
export function miss(before: string, after: string): string[] | null {
  const diff = oracleDiff(before, after);
  if (!diff.length) return null;
  return polishChanges(before, after).length ? null : diff;
}

// Seeded, so a run can be repeated exactly.
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = ["`", "``", "```", "~~~", "[", "]", "(", ")", "<", ">", "> ", "-", "- ", "* ", "+ ", "1. ", "3. ", "#", "## ", "!", ":", '"', "'", "\\", " ", "  ", "    ", "\t", "\n", "\n\n", "5", "7", "not ", "never ", "_", "*", "**", "[a]: ", "](", "](x)", "&amp;", "&#53;", "===", "---", "|", "x"];
const PREFIXES = ["> ", "- ", "* ", "1. ", "2. ", "  ", "   ", "    ", "\t", ">", "> - ", "- > ", "## "];

/** One random edit: a token, a deletion, a line moved, indented, prefixed, joined or split. */
export function mutate(page: string, r: () => number): string {
  const fm = FRONTMATTER.exec(page)?.[0] ?? "";
  const body = page.slice(fm.length);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const at = Math.floor(r() * (body.length + 1));
  const lines = body.split("\n");
  const li = Math.floor(r() * lines.length);
  let out: string;
  switch (Math.floor(r() * 10)) {
    case 0:
    case 1:
      out = body.slice(0, at) + pick(TOKENS) + body.slice(at);
      break;
    case 2:
      out = body.slice(0, at) + body.slice(at + 1 + Math.floor(r() * 3));
      break;
    case 3:
      out = body.slice(0, at) + pick(TOKENS) + body.slice(at + 1);
      break;
    case 4: {
      lines[li] = pick(PREFIXES) + lines[li];
      out = lines.join("\n");
      break;
    }
    case 5: {
      lines[li] = lines[li]!.replace(/^(?:[ \t]|> ?|[-*+] |\d+\. )/, "");
      out = lines.join("\n");
      break;
    }
    case 6: {
      // Move a line somewhere else, as a restructure does.
      const [line] = lines.splice(li, 1);
      lines.splice(Math.floor(r() * (lines.length + 1)), 0, line!);
      out = lines.join("\n");
      break;
    }
    case 7: {
      // Join with the next line, or split at a space: a rewrap.
      if (li + 1 < lines.length && r() < 0.5) lines.splice(li, 2, `${lines[li]} ${lines[li + 1]!.trimStart()}`);
      else {
        const sp = lines[li]!.indexOf(" ", Math.floor(r() * lines[li]!.length));
        if (sp > 0) lines.splice(li, 1, lines[li]!.slice(0, sp), lines[li]!.slice(sp + 1));
      }
      out = lines.join("\n");
      break;
    }
    case 8:
      lines.splice(li, 0, r() < 0.5 ? "" : lines[li]!);
      out = lines.join("\n");
      break;
    default:
      lines.splice(li, 1);
      out = lines.join("\n");
  }
  return fm + out;
}

/** Shrink a miss: drop lines from both pages while it stays a miss. */
export function minimize(before: string, after: string): [string, string] {
  let a = before;
  let b = after;
  for (let changed = true; changed; ) {
    changed = false;
    const la = a.split("\n");
    for (let i = 0; i < la.length; i++) {
      const lb = b.split("\n");
      const j = lb.indexOf(la[i]!);
      const tries: [string, string][] = [];
      if (j >= 0) tries.push([[...la.slice(0, i), ...la.slice(i + 1)].join("\n"), [...lb.slice(0, j), ...lb.slice(j + 1)].join("\n")]);
      for (const [na, nb] of tries)
        if (miss(na, nb)) {
          a = na;
          b = nb;
          changed = true;
          break;
        }
      if (changed) break;
    }
  }
  return [a, b];
}

// Shapes the gate found ways around, as seeds: containers, fences, definitions, lists.
export const SNIPPETS = [
  "## Steps\n\n1. Drain the node:\n\n   ```sh\n   kubectl drain node-1\n   ```\n\n2. Restart it.\n\n## Rollback\n\nRun `uncordon node-1`.\n",
  "> Note: do not skip this.\n>\n> - [ ] Check the canary for 10 minutes.\n> - See [the guide](guide.md \"Guide\").\n",
  "See [run][a] and [prod].\n\n[a]: safe.md \"Safe\"\n[prod]: <prod page.md>\n",
  "- ~~~yaml\n  key: 5\n  ~~~\n- > ```\n  > rm -rf /tmp\n  > ```\n",
  "Retry the job\n3 times, never more.\n\n    indented code 5\n\nText with `code` and ``a ` b`` spans.\n",
  "Setext\n======\n\nRun `a`.\n\nOther\n-----\n\n![img](x.png) and <https://example.com/5>.\n",
];

export function seedPages(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".md")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(root);
  return [...out, ...SNIPPETS.map((s) => `---\nid: snippet\n---\n${s}`)];
}

export type Miss = { seed: number; i: number; classes: string[]; before: string; after: string };

/**
 * `iterations` pairs: a seed page mutated up to `depth` times, then `edits` more times
 * (1 to `edits`) for the polish.
 */
export function fuzz(pages: string[], seed: number, iterations: number, depth = 2, edits = 1): Miss[] {
  return fuzzRun(pages, seed, iterations, depth, edits).misses;
}

/** The same, with how many pairs changed what renders: a run where none did tested nothing. */
export function fuzzRun(pages: string[], seed: number, iterations: number, depth = 2, edits = 1): { misses: Miss[]; changed: number } {
  const r = rng(seed);
  const misses: Miss[] = [];
  let changed = 0;
  for (let i = 0; i < iterations; i++) {
    let before = pages[Math.floor(r() * pages.length)]!;
    for (let k = Math.floor(r() * (depth + 1)); k > 0; k--) before = mutate(before, r);
    let after = mutate(before, r);
    for (let k = Math.floor(r() * edits); k > 0; k--) after = mutate(after, r);
    if (oracleDiff(before, after).length) changed++;
    const classes = miss(before, after);
    if (classes) misses.push({ seed, i, classes, before, after });
  }
  return { misses, changed };
}
