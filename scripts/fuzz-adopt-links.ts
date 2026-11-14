// Fuzz: `docsworth adopt` rewrites a route link only to a link that names the page the route
// meant, whatever the page's name holds (punctuation, entities, backticks, Unicode) and
// whatever sits around the link (code spans, brackets, HTML, emphasis).
//
//   npx tsx scripts/fuzz-adopt-links.ts --iterations 2000 --seed 1
//
// Each page links its siblings by root-relative and relative routes, inline, in angle brackets
// and through definitions. After adopt, the page must parse to as many links as before; each
// rewritten one must resolve to exactly the page its route named, with its query and fragment;
// and lint must fail no link adopt didn't list. Exits 1 and prints the page for any miss.
// Positive control: drop the backtick from `escapeSegment` and delete the whole-parse check in
// `convertLinks` (src/core/adopt.ts), and this finds about 20 in 2,000 (19 with seed 1): a
// backtick in a rewritten destination opens a code span across the line; with the shipped
// code, 0.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { adoptRepo } from "../src/core/adopt.js";
import { lintRepo } from "../src/core/lint.js";
import { linkPath, pageLinks, shownPath } from "../src/core/links.js";
import { loadRepo, resolveLink } from "../src/core/repo.js";

const arg = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
};
const iterations = arg("iterations", 2000);
let seed = arg("seed", 1);
const firstSeed = seed;

// mulberry32: an LCG's low bits cycle, so nested choices would come in fixed patterns.
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
};
const pick = <T>(a: readonly T[]) => a[rand(a.length)]!;

const NAME_PARTS = [..."abcxyz019-_ .()[]`*!'\"&;:=+,@$~^{}|<>é漢\\", "&amp;", "&#35;", "%", "%41"];
const AROUND = ["", "`", "*", "_", "[", "]", "<b>", "`code`", "![", "\\", "<!-- ", "&", "> "];
const NOW = new Date("2026-11-02T12:00:00Z");
const PAGE = "knowledge/main.md";
// A route as a site would write it: percent-encoded, brackets and backticks included.
const route = (name: string) => encodeURI(name).replace(/[()[\]`<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const suffix = (d: string) => d.slice(d.search(/[?#]/) >= 0 ? d.search(/[?#]/) : d.length);

let misses = 0;
let rewritten = 0;
let left = 0;
const started = Date.now();
for (let i = 0; i < iterations; i++) {
  const root = mkdtempSync(join(tmpdir(), "docsworth-fuzz-adopt-"));
  try {
    const files: Record<string, string> = {
      ".knowledge/config.yaml": "format: 1\nknowledge_root: knowledge\ngithub:\n  org: acme\n",
      CODEOWNERS: "/knowledge/ @acme/platform\n",
    };
    const names: string[] = [];
    for (let n = 0; n < 3; n++) {
      const name = `p${Array.from({ length: 1 + rand(4) }, () => pick(NAME_PARTS)).join("")}`;
      if (/[/]|[. ]$/.test(name)) continue;
      const full = rand(5) < 2 ? `sub/${name}` : name;
      names.push(full);
      files[`knowledge/${full}.md`] = `# Page ${n}\n`;
    }
    const defs: string[] = [];
    const links = names.map((name, n) => {
      const dest = `${rand(2) ? "/" : ""}${route(name)}${pick(["", "", "#frag", "?q=1"])}`;
      switch (rand(4)) {
        case 0:
          return `[t](<${dest.replace(/%20/g, " ")}>)`;
        case 1:
          defs.push(`[d${n}]: ${dest}`);
          return `[t][d${n}]`;
        default:
          return `[t](${dest})`;
      }
    });
    const body = `# Main\n\n${links.map((l) => `${pick(AROUND)}${l}${pick(AROUND)} ${pick(AROUND)}`).join(rand(2) ? " " : "\n")}\n\n${defs.join("\n")}\n`;
    files[PAGE] = body;
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }

    const result = adoptRepo(root, { now: NOW });
    rewritten += result.linksRewritten;
    left += result.linksLeft.length;
    const after = readFileSync(join(root, PAGE), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    const was = pageLinks(body);
    const now = pageLinks(after);
    const why: string[] = [];
    if (now.length !== was.length) why.push(`${was.length} links before, ${now.length} after`);
    else
      now.forEach((d, k) => {
        if (d === was[k]) return;
        // The page the route meant, by its file name: the route's path, decoded.
        const meant = posix.normalize(`knowledge/${shownPath(linkPath(was[k]!)).replace(/^\/+/, "")}.md`);
        const named = resolveLink(PAGE, linkPath(d));
        if (named !== meant) why.push(`\`${was[k]}\` meant ${meant}, became \`${d}\`, naming ${named}`);
        if (suffix(d) !== suffix(was[k]!)) why.push(`\`${was[k]}\` lost its query or fragment: \`${d}\``);
      });
    const listed = result.linksLeft.filter((l) => l.path === PAGE).length;
    const broken = lintRepo(loadRepo(root), NOW).diagnostics.filter((d) => d.rule === "broken-link" && d.path === PAGE);
    // Each left link is used once, so lint can fail at most as many links as adopt listed.
    if (broken.length > listed) why.push(`lint fails ${broken.length} link(s), adopt listed ${listed}: ${broken.map((d) => d.message).join("; ")}`);
    if (why.length) {
      misses++;
      if (misses <= 5) console.log(`MISS\n--- before\n${body}--- after\n${after}--- why\n${why.join("\n")}\n`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const secs = Math.round((Date.now() - started) / 1000);
console.log(`${iterations} pages, seed ${firstSeed}, ~${secs} s: ${rewritten} links rewritten, ${left} left; ${misses} miss(es)`);
process.exit(misses ? 1 : 0);
