import { describe, expect, it } from "vitest";
import { codeBlocks, FENCE_MARK } from "../src/core/blocks.js";

// The block pass's view of a page, where the polish guard can't show it (the guard
// refuses pages with raw HTML, so an HTML-looking line can't be checked through it).

describe("block structure", () => {
  it("keeps a lazy line in its quote's paragraph unless it's a real HTML block start", () => {
    // `<x/not-html` isn't a complete tag: the paragraph goes on lazily (CommonMark §4.6).
    const lazy = codeBlocks("> [go\n<x/not-html\nthere](/safe)");
    expect(lazy.prose.split("\n").map((_, i) => Boolean(lazy.para[i]))).toEqual([true, true, true]);
    // `<div>` starts an HTML block (type 6): the quote ends, and the block runs to a
    // blank line, so `there` is HTML, not a paragraph.
    const b = codeBlocks("> go\n<div>\nthere");
    expect(b.prose.split("\n")).toEqual(["> go", "", "<div>", "there"]);
    expect(b.prose.split("\n").map((_, i) => Boolean(b.para[i]))).toEqual([true, false, false, false]);
  });

  it("reads an HTML comment block to its end, blank lines and all", () => {
    const b = codeBlocks("<!--\n\n[a]: x\n\n-->\nText");
    expect(b.para.filter(Boolean)).toHaveLength(1); // only "Text"
    expect(b.fences).toEqual([]);
  });

  it("ends an indented block at a blank line's end, and keeps code to CommonMark's literal", () => {
    expect(codeBlocks("Intro.\n\n    a\n\n    b\n\nText").fences).toEqual(["a\n\nb\n"]);
    expect(codeBlocks("- ~~~yaml\n  a\n \n  b\n  ~~~").fences).toEqual(["yaml\u0003a\n\nb\n"]);
    expect(codeBlocks("```\ncode\n```").prose.split("\n")[0]).toBe(FENCE_MARK);
  });
});
