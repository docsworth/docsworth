import { describe, expect, it } from "vitest";
import { FRONTMATTER_MAX, splitFrontmatter } from "../src/core/frontmatter.js";

// Inputs a page's author controls, sized to hurt: each must cost about what prose of the
// same size does. (A wiki page's, through pro's mirror, is tested in pro.)

const N = 64 * 1024;
const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
const best = (f: () => unknown) => {
  let ms = Infinity;
  for (let i = 0; i < 3 && ms >= 50; i++) {
    const t0 = performance.now();
    f();
    ms = Math.min(ms, performance.now() - t0);
  }
  return ms;
};

describe("frontmatter size", () => {
  const page = (yaml: string) => `---\n${yaml}\n---\nbody\n`;

  it("refuses frontmatter over the limit, before YAML reads it", () => {
    // YAML parsing slows past linear on hostile input: 64 KB of `}&` took 650 ms.
    const doc = splitFrontmatter(page(fill("}&")));
    expect(doc.data).toBeNull();
    expect(doc.error).toBe("frontmatter is over 16 KB");
    expect(best(() => splitFrontmatter(page(fill("}&"))))).toBeLessThan(50);
  });

  it("counts the limit in bytes", () => {
    // Review: a string's length is UTF-16 code units; `é` is two bytes.
    const yaml = `title: T\ndescription: "${"é".repeat(FRONTMATTER_MAX / 2)}"`;
    expect(yaml.length).toBeLessThan(FRONTMATTER_MAX);
    expect(splitFrontmatter(page(yaml)).error).toBe("frontmatter is over 16 KB");
  });

  it("reads frontmatter up to the limit", () => {
    const yaml = `title: T\ndescription: "${"a".repeat(FRONTMATTER_MAX - 40)}"`;
    expect(yaml.length).toBeLessThanOrEqual(FRONTMATTER_MAX);
    expect(splitFrontmatter(page(yaml)).data?.title).toBe("T");
  });
});
