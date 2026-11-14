// Fuzz: no page the web app renders shows `[restricted page]` (the placeholder redaction
// leaves for a link to a page the caller can't see) as a link, whatever the page nests around
// it: links, reference links and their definitions, images, emphasis, code, tables.
//
//   npx tsx packages/ui/scripts/fuzz-placeholder.ts --iterations 50000 --seed 1
//
// Exits 1 and prints the page for any link whose text is, or holds, the placeholder.
// Positive control: judge links outer-first in parseGfm (src/core/gfm.ts: collect them on
// `e.entering`), and this finds about 90 in 50,000 (93 with seed 1); with the shipped order, 0.
import { Window } from "happy-dom";
import { renderMarkdown } from "../src/markdown.js";

const arg = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
};
const iterations = arg("iterations", 50000);
let seed = arg("seed", 1);

// mulberry32: an LCG's low bits cycle, so nested choices would come in fixed patterns.
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
};

const WORDS = ["restricted page", "[restricted page]", "Restricted  Page", "notes", "see", "\\[restricted page\\]"];
const gen = (depth: number): string => {
  switch (depth <= 0 ? 0 : rand(8)) {
    case 0:
      return WORDS[rand(WORDS.length)]!;
    case 1:
      return `[${gen(depth - 1)}](https://evil.example/a)`;
    case 2:
      return `[${gen(depth - 1)}][x]`;
    case 3:
      return `![${gen(depth - 1)}](https://evil.example/i.png)`;
    case 4:
      return `*${gen(depth - 1)}*`;
    case 5:
      return `\`${WORDS[rand(3)]}\``;
    case 6:
      return `${gen(depth - 1)} ${gen(depth - 1)}`;
    default:
      return `[${gen(depth - 1)}]`;
  }
};

const win = new Window();
const started = performance.now();
let found = 0;
for (let i = 0; i < iterations; i++) {
  let md = gen(1 + rand(4));
  if (rand(2)) md += "\n\n[x]: https://evil.example/y";
  if (rand(3) === 0) md += "\n\n[restricted page]: https://evil.example/z";
  if (rand(4) === 0) md = `| ${md.replace(/\n/g, " ")} |\n|-|\n| c |`;
  const page = win.document.createElement("div");
  page.innerHTML = renderMarkdown(md, { pagePath: "knowledge/a.md", pageIds: new Map() });
  for (const a of page.querySelectorAll("a")) {
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (text.includes("[restricted page]") || text === "restricted page" || text === "image: restricted page") {
      if (found++ < 5) console.log(`placeholder as a link: ${JSON.stringify(md)}\n  ${a.outerHTML}`);
    }
  }
}
const seconds = ((performance.now() - started) / 1000).toFixed(0);
console.log(`${iterations} pages, seed ${arg("seed", 1)}, ~${seconds} s: ${found} link(s) show the placeholder`);
process.exit(found ? 1 : 0);
