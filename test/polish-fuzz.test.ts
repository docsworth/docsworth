import { describe, expect, it } from "vitest";
import { fuzzRun, oracleDiff, seedPages } from "./polish-oracle.js";

// Differential fuzzing against CommonMark's reference parser (commonmark.js, a dev
// dependency): no mutated pair may change what renders while the guard reports nothing.
// `npx tsx scripts/fuzz-polish.ts` runs it longer and prints any miss, shrunk.
const pages = seedPages("examples/acme/knowledge");

describe("polish guard: differential fuzzing against commonmark.js", () => {
  it("the oracle sees a change it should (so a quiet run means something)", () => {
    const fm = "---\nid: a\n---\n";
    expect(oracleDiff(`${fm}Run \`a\`.\n`, `${fm}Run \`b\`.\n`)).toContain("inline");
    expect(oracleDiff(`${fm}Do not.\n`, `${fm}Do.\n`)).toContain("negations");
  });

  it.each([
    [1, 2, 1],
    [2, 6, 2],
    [3, 10, 4],
  ])("seed %i, depth %i, edits %i: no miss in 8000 pairs", (seed, depth, edits) => {
    const { misses, changed } = fuzzRun(pages, seed, 8000, depth, edits);
    // A quarter to a half of mutations change something that renders (measured: 2048,
    // 2739 and 3739 of 8000); if few did, the run proved little.
    expect(changed).toBeGreaterThan(1000);
    expect(misses.map((m) => ({ classes: m.classes, before: m.before.slice(-200), after: m.after.slice(-200) }))).toEqual([]);
  });
});
