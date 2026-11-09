// Differential fuzzing of link redaction against CommonMark's reference parser.
//   npx tsx scripts/fuzz-acl.ts [--iterations 4000] [--seed 1] [--seeds 1] [--show 5]
// Each body references random pages in random forms (test/acl-oracle.ts). Prints each
// leak (a redacted text that still reaches a page its reader can't see) and exits 1 if
// any; reports how many texts reaching only visible pages were redacted all the same.
import { canSee, redactLinks } from "../src/core/acl.js";
import { FUZZ_IDENTITIES, NO_PAGES, fuzzRepo } from "../test/acl-fuzz-fixture.js";
import { body, leaks, rng } from "../test/acl-oracle.js";

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? Number(process.argv[i + 1]) : d;
  // A run that silently got NaN would report zero leaks for a check that never ran.
  if (!Number.isInteger(v) || v < 0) {
    console.error(`--${name} must be a non-negative integer, got ${process.argv[i + 1]}`);
    process.exit(2);
  }
  return v;
};
const iterations = arg("iterations", 4000);
const first = arg("seed", 1);
const seeds = arg("seeds", 1);
const show = arg("show", 5);

const { repo, cleanup } = fuzzRepo();
const all = [...repo.pages.map((p) => p.path), ...repo.invalid.map((p) => p.path), ...NO_PAGES];
const t0 = Date.now();
let reaching = 0;
let clean = 0;
let overRedacted = 0;
const leaked: string[] = [];
const over: string[] = [];
for (let seed = first; seed < first + seeds; seed++) {
  const r = rng(seed);
  for (let i = 0; i < iterations; i++) {
    const who = FUZZ_IDENTITIES[Math.floor(r() * FUZZ_IDENTITIES.length)]!;
    const from = repo.pages[Math.floor(r() * repo.pages.length)]!.path;
    const onlyVisible = r() < 0.5;
    const targets = onlyVisible ? repo.pages.filter((p) => canSee(p, who)).map((p) => p.path) : all;
    const text = body(r, from, targets, repo.config.knowledge_root);
    const out = redactLinks(text, from, repo, who);
    const audience = `[${[...who.teams].join(",")}]`;
    if (leaks(text, from, repo, who).length) {
      reaching++;
      const left = leaks(out, from, repo, who);
      if (left.length) leaked.push(`--- leak (seed ${seed}, ${from} as ${audience})\n${text}\n→ ${left.join("; ")}`);
    } else if (onlyVisible) {
      clean++;
      if (out !== text) {
        overRedacted++;
        over.push(`--- redacted, reaching only visible pages (seed ${seed}, ${from} as ${audience})\n${text}\n⇒\n${out}`);
      }
    }
  }
}
cleanup();
console.log(
  `${iterations * seeds} texts, seeds ${first}–${first + seeds - 1}, ${((Date.now() - t0) / 1000).toFixed(1)} s: ${reaching} reach a hidden page, ${leaked.length} leak(s) after redaction; ${overRedacted} of ${clean} reaching only visible pages redacted`,
);
for (const l of [...leaked, ...over].slice(0, show)) console.log(`\n${l}`);
process.exit(leaked.length ? 1 : 0);
