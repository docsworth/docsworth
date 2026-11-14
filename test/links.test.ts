import { describe, expect, it } from "vitest";
import { applyEdits } from "../src/core/edits.js";
import { linkSpans, pageLinks, pageRoute } from "../src/core/links.js";

// A page's links as CommonMark reads them (lint, R8), and where each one's destination sits
// in the source (adopt's rewriting).

describe("pageLinks", () => {
  it("is every link and image destination CommonMark parses, reference links through their definitions", () => {
    const body = [
      "See [the guide](guide.md), ![a diagram](img/d.png) and [docs][d], [Docs][] and [docs].",
      "",
      "[docs]: other.md",
      "[d]: ref.md",
      "[unused]: nowhere.md",
    ].join("\n");
    expect(pageLinks(body)).toEqual(["guide.md", "img/d.png", "ref.md", "other.md", "other.md"]);
  });

  it("reads destinations and link text as CommonMark does", () => {
    expect(pageLinks("[x](guides/foo_(bar)) [y](a_(b_(c))) [outer [inner]](guide) [z](<with space.md>)")).toEqual([
      "guides/foo_(bar)",
      "a_(b_(c))",
      "guide",
      "with%20space.md",
    ]);
  });

  it("finds no link in code or HTML", () => {
    const body = [
      "```",
      "[fenced](missing.md)",
      "```",
      "",
      "    [indented](missing.md)",
      "",
      "A span `[x](missing.md)` and one across",
      "lines `` [y](\nmissing.md) `` here.",
      "",
      '<a data-example="[z](missing.md)">demo</a>',
    ].join("\n");
    expect(pageLinks(body)).toEqual([]);
  });
});

describe("linkSpans", () => {
  const spans = (body: string) => linkSpans(body).map((s) => body.slice(s.start, s.end));

  it("locates each destination a link uses, in inline links, images and the definitions links use", () => {
    const body = "[a](one.md) ![b](two.png) [c][r] [deep](a_(b_(c))) [e](<x y.md>)\n\n[r]: three.md\n[unused]: four.md\n";
    expect(spans(body)).toEqual(["one.md", "two.png", "a_(b_(c))", "x y.md", "three.md"]);
    expect(linkSpans(body).find((s) => s.raw === "x y.md")?.angle).toBe(true);
  });

  it("leaves what CommonMark doesn't link: code, spans across lines, HTML attributes", () => {
    const body = "```\n[a](code.md)\n```\n\nText `` [b](\nspan.md) `` and <a title=\"[c](attr.md)\">x</a> and [real](real.md).\n";
    expect(spans(body)).toEqual(["real.md"]);
  });

  it("gives each destination as CommonMark reads it", () => {
    const body = "[a](caf%C3%A9.md) [b](<x y.md>) [c](a\\(b.md)";
    expect(linkSpans(body).map((s) => s.dest)).toEqual(["caf%C3%A9.md", "x%20y.md", "a(b.md"]);
  });

  it("isn't fooled by a page whose own destinations look like its markers", () => {
    // A definition its scanner can't locate (the label spans lines) already reads like the
    // first marker, literally or through an entity: the code span's text must stay unconfirmed.
    for (const dest of ["dwlinkmarker0x", "dwlinkmarker&#48;x", "dw&#108;inkmarker0x"]) {
      const body = `\`[not](/secret)\` [multi line]\n\n[multi\nline]: ${dest}\n`;
      expect(linkSpans(body)).toEqual([]);
    }
  });

  it("locates what CommonMark links across a CRLF, in a definition in a list item, and inside a longer non-link", () => {
    const body = "See [a](\r\n/one) and [b][d] and garbage](foo[x](/two)).\r\n\r\n- [d]: /three\r\n";
    expect(linkSpans(body).map((s) => body.slice(s.start, s.end))).toEqual(["/one", "/two", "/three"]);
  });

  it("confirms no candidate in code, whatever another candidate's text holds", () => {
    // `x\`y` is no link (no `[` opens it), and its backtick opens the code span the second
    // sits in. Swapping it for a marker would take that backtick away, and make the second a
    // link; a token written before it takes nothing away.
    const body = "see ](x`y) [b](/secret) `\n";
    expect(pageLinks(body)).toEqual([]);
    expect(linkSpans(body)).toEqual([]);
  });

  it("confirms no candidate a token would make a link of: a rule, an underline or an HTML block after a bare label", () => {
    // CommonMark reads none of these as a definition; with a token written before the line,
    // it would.
    for (const line of ["---", "===", "***", "<div>"]) expect(linkSpans(`[x][d]\n\n[d]:\n${line}\n\n[real](/setup)\n`).map((s) => s.raw)).toEqual(["/setup"]);
  });

  it("confirms a link whose text holds a candidate: the token in its text isn't the link's own", () => {
    const body = "[a `](x)` b](/y)\n";
    expect(linkSpans(body).map((s) => s.raw)).toEqual(["/y"]);
  });

  it("confirms no made-up link, though a real one elsewhere has its destination, before it or after it", () => {
    for (const body of [
      "[x](div) [use][d]\n\n[d]:\n<div>\n\n[real](/setup)\n",
      "[use][d] [x](div)\n\n[d]:\n<div>\n\n[real](/setup)\n",
    ]) {
      expect(linkSpans(body).map((s) => body.slice(s.start - 1, s.end))).toEqual(["(div", "(/setup"]);
    }
  });

  it("tries another marker when the page already holds one, in its text or in what CommonMark reads", () => {
    for (const dest of ["dwlinkmarker0x", "dwlinkmarker&#48;x", "dw&#108;inkmarker0x"]) {
      const body = `\`[not](/secret)\` [multi line] [real](r.md)\n\n[multi\nline]: ${dest}\n`;
      const tries = ["dwlinkmarker", "dwfresh"];
      expect(linkSpans(body, () => tries.shift()!).map((s) => s.dest)).toEqual(["r.md"]);
    }
    // A page that holds every marker tried gets no spans: adopt lists its links instead.
    expect(linkSpans("[a](x.md) dwlinkmarker0x", () => "dwlinkmarker")).toEqual([]);
  });

  it("takes time in proportion to the page, whatever look-alikes of its markers it holds", () => {
    // A long look-alike run, and many links: each marker mustn't grow with the run.
    const links = Array.from({ length: 1000 }, (_, i) => `[p](p${i}.md)`).join(" ");
    const body = `${links} dwlinkmarker${"q".repeat(200000)}0x`;
    const t = performance.now();
    expect(linkSpans(body)).toHaveLength(1000);
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it("scans a page of unclosed destinations in time proportional to it", () => {
    // Each `](` scanned on through every later one: 64 KB took 1.7 s that way. Best of three at
    // 256 KB, a size the quadratic scan misses by many seconds.
    const body = "](".repeat(128_000);
    const runs = [0, 1, 2].map(() => {
      const t = performance.now();
      linkSpans(body);
      return performance.now() - t;
    });
    expect(Math.min(...runs)).toBeLessThan(1000);
  });

  it("reads nested images in time proportional to the page", () => {
    // Each image's text, collected through its whole subtree, made n nested images cost n²: 4,000
    // took 1.5 s that way. Read linearly, 8,000 take about 25 ms. A ratio of small timings swung
    // past its bound under load (10.7 for 4x), so this is the best of three at a size the
    // quadratic version misses by seconds and a loaded machine doesn't approach.
    const body = `${"![a".repeat(8000)}${"](x.png)".repeat(8000)}\n`;
    const runs = [0, 1, 2].map(() => {
      const t = performance.now();
      pageLinks(body);
      linkSpans(body);
      return performance.now() - t;
    });
    expect(Math.min(...runs)).toBeLessThan(1000);
  });

  it("takes time in proportion to the page, however many links it has", () => {
    const body = Array.from({ length: 10000 }, (_, i) => `- [page ${i}](p${i}.md)`).join("\n");
    const t = performance.now();
    expect(linkSpans(body)).toHaveLength(10000);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("applyEdits", () => {
  it("applies edits from the last offset back, so each keeps its place", () => {
    expect(applyEdits("ab cd ef", [{ start: 0, end: 2, insert: "XYZ" }, { start: 6, end: 8, insert: "Q" }])).toBe("XYZ cd Q");
  });

  it("takes time in proportion to the text, however many edits there are", () => {
    // Rebuilding the text once per edit is quadratic: 20,000 edits on 500 KB copied 10 GB.
    const text = "x".repeat(500_000);
    const edits = Array.from({ length: 20_000 }, (_, i) => ({ start: i * 25, end: i * 25 + 1, insert: "yy" }));
    const t = performance.now();
    expect(applyEdits(text, edits)).toHaveLength(520_000);
    expect(performance.now() - t).toBeLessThan(200);
  });

  it("applies edits at one offset in the order given", () => {
    expect(applyEdits("ab", [{ start: 1, end: 1, insert: "1" }, { start: 1, end: 1, insert: "2" }, { start: 1, end: 2, insert: "B" }])).toBe("a12B");
  });

  it("refuses edits that overlap", () => {
    expect(() => applyEdits("abcdef", [{ start: 0, end: 3, insert: "x" }, { start: 2, end: 4, insert: "y" }])).toThrow(/overlap/);
  });
});

// Each against the route a real Docusaurus build (3.9.2) served for the same file: Hermes
// Agent's site, with these pages added (2026-11-13).
describe("pageRoute, as Docusaurus serves a page", () => {
  it.each([
    ["zz-routes/index.md", undefined, undefined, "zz-routes"],
    ["zz-routes/abs-slug.md", "/zz-abs-target", undefined, "zz-abs-target"],
    ["zz-routes/rel-slug.md", "rel-target", undefined, "zz-routes/rel-target"],
    ["zz-routes/with-id.md", undefined, "other-id", "zz-routes/other-id"],
    ["zz-routes/02-numbered.md", undefined, undefined, "zz-routes/numbered"],
    ["zz-routes/2.0-plan.md", undefined, undefined, "zz-routes/2.0-plan"],
    ["zz-routes/03-sub/README.md", undefined, undefined, "zz-routes/sub"],
    ["zz-routes/03-sub/03-leaf.md", undefined, undefined, "zz-routes/sub/leaf"],
    // A file named after its directory is its category index by the names as written:
    // `other` isn't `04-other`, so this one isn't.
    ["zz-routes/04-other/other.md", undefined, undefined, "zz-routes/other/other"],
    ["zz-routes/05-same/05-same.md", undefined, undefined, "zz-routes/same"],
    // Nor is a number-prefixed `index`: `01-index` isn't `index`.
    ["zz-routes/06-idx/01-index.md", undefined, undefined, "zz-routes/idx/index"],
    ["zz-routes/index-with-id/index.md", undefined, "idx-id", "zz-routes/index-with-id"],
    ["zz-routes/slug-and-id.md", "/zz-both", "some-id", "zz-both"],
  ])("%s", (under, slug, id, route) => {
    expect(pageRoute(under, slug, id)).toBe(route);
  });
});
