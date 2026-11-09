// Differential fuzzing of the polish guard against CommonMark's reference parser.
//   npx tsx scripts/fuzz-polish.ts [--iterations 20000] [--seed 1] [--depth 2] [--edits 1] [--show 10]
// Prints each miss (rendered facts changed, guard silent), shrunk, and exits 1 if any.
import { fuzz, minimize, seedPages } from "../test/polish-oracle.js";

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? Number(process.argv[i + 1]) : d;
  // A run that silently got NaN would report zero misses for a check that never ran.
  if (!Number.isInteger(v) || v < 0) {
    console.error(`--${name} must be a non-negative integer, got ${process.argv[i + 1]}`);
    process.exit(2);
  }
  return v;
};
const iterations = arg("iterations", 20000);
const seed = arg("seed", 1);
const show = arg("show", 10);
const depth = arg("depth", 2);
const edits = arg("edits", 1);

const t0 = Date.now();
const misses = fuzz(seedPages("examples/acme/knowledge"), seed, iterations, depth, edits);
console.log(`${iterations} pairs, seed ${seed}, depth ${depth}, edits ${edits}, ${((Date.now() - t0) / 1000).toFixed(1)} s: ${misses.length} miss(es)`);
const byClass = new Map<string, number>();
for (const m of misses) for (const c of m.classes) byClass.set(c, (byClass.get(c) ?? 0) + 1);
if (byClass.size) console.log(`by class: ${[...byClass].map(([c, n]) => `${c} ${n}`).join(", ")}`);
for (const m of misses.slice(0, show)) {
  const [a, b] = minimize(m.before, m.after);
  console.log(`\n--- miss ${m.i} (${m.classes.join(", ")})\nbefore: ${JSON.stringify(a.replace(/^---\n[\s\S]*?\n---\n/, ""))}\nafter:  ${JSON.stringify(b.replace(/^---\n[\s\S]*?\n---\n/, ""))}`);
}
process.exit(misses.length ? 1 : 0);
