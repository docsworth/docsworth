// Differential fuzzing of link redaction against CommonMark's reference parser.
//   npx tsx scripts/fuzz-acl.ts [--iterations 4000] [--seed 1] [--seeds 1] [--show 5]
// Two corpora: each body references random pages in random forms (test/acl-oracle.ts), as
// paths and URLs; then, on a docs site, as routes. Prints each leak (a redacted text that
// still reaches a page its reader can't see) and exits 1 if any, or if more than
// OVER_BOUND of the texts reaching only visible pages (or repo paths outside the knowledge
// root) were redacted all the same.
import { canSee, redactLinks } from "../src/core/acl.js";
import type { Repo } from "../src/core/repo.js";
import { FUZZ_IDENTITIES, NO_PAGES, NO_ROUTES, REPO_PATHS, fuzzRepo, routeRepo } from "../test/acl-fuzz-fixture.js";
import { body, labelsLeft, leaks, type Rng, rng, routeBody, siteModel } from "../test/acl-oracle.js";

/** The most over-redaction a run may show: 0.5% of the texts reaching only visible pages. */
const OVER_BOUND = 0.005;

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

type Corpus = { name: string; repo: Repo; cleanup: () => void; targets: (r: Rng, onlyVisible: boolean, who: (typeof FUZZ_IDENTITIES)[number]) => string[]; text: (r: Rng, from: string, targets: string[], who: (typeof FUZZ_IDENTITIES)[number]) => string };
const classic = fuzzRepo();
const routes = routeRepo();
const pagesOf = (repo: Repo) => [...repo.pages.map((p) => p.path), ...repo.invalid.map((p) => p.path)];
const corpora: Corpus[] = [
  {
    name: "paths",
    ...classic,
    targets: (_r, onlyVisible, who) => (onlyVisible ? classic.repo.pages.filter((p) => canSee(p, who)).map((p) => p.path) : [...pagesOf(classic.repo), ...NO_PAGES]),
    text: (r, from, targets) => body(r, from, targets, classic.repo.config.knowledge_root),
  },
  {
    name: "routes",
    ...routes,
    // Repo paths outside the root are neither visible pages nor hidden ones: a link to one
    // keeps its label, so a text reaching only those (and visible pages) counts as clean. A
    // visible page whose route a hidden one shares (`/shared`, `/team`) is hidden there, and
    // so is `vault`, a hidden page's slug beside the repo's own directory.
    targets: (_r, onlyVisible, who) => {
      const site = siteModel(routes.repo, who);
      const visible = routes.repo.pages.filter((p) => canSee(p, who) && site.routes.get(site.pageUrl.get(p.path)!) === false).map((p) => p.path);
      return onlyVisible ? [...visible, ...REPO_PATHS.filter((p) => !site.routes.has(p))] : [...pagesOf(routes.repo), ...NO_ROUTES, ...REPO_PATHS];
    },
    text: (r, from, targets, who) => routeBody(r, from, targets, siteModel(routes.repo, who)),
  },
];

let failed = false;
const shown: string[] = [];
for (const c of corpora) {
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
      const from = c.repo.pages[Math.floor(r() * c.repo.pages.length)]!.path;
      const onlyVisible = r() < 0.5;
      const text = c.text(r, from, c.targets(r, onlyVisible, who), who);
      const out = redactLinks(text, from, c.repo, who);
      const audience = `[${[...who.teams].join(",")}]`;
      if (leaks(text, from, c.repo, who).length) {
        reaching++;
        const left = [...leaks(out, from, c.repo, who), ...labelsLeft(text, out, from, c.repo, who)];
        if (left.length) leaked.push(`--- leak (${c.name}, seed ${seed}, ${from} as ${audience})\n${text}\n→ ${left.join("; ")}`);
      } else if (onlyVisible) {
        clean++;
        if (out !== text) {
          overRedacted++;
          over.push(`--- redacted, reaching only visible pages (${c.name}, seed ${seed}, ${from} as ${audience})\n${text}\n⇒\n${out}`);
        }
      }
    }
  }
  const tooMuch = overRedacted > OVER_BOUND * clean;
  failed ||= leaked.length > 0 || tooMuch;
  console.log(
    `${c.name}: ${iterations * seeds} texts, seeds ${first}–${first + seeds - 1}, ${((Date.now() - t0) / 1000).toFixed(1)} s: ${reaching} reach a hidden page, ${leaked.length} leak(s) after redaction; ${overRedacted} of ${clean} reaching only visible pages redacted${tooMuch ? `, over the ${OVER_BOUND * 100}% bound` : ""}`,
  );
  shown.push(...leaked, ...over);
  c.cleanup();
}
for (const l of shown.slice(0, show)) console.log(`\n${l}`);
process.exit(failed ? 1 : 0);
