import { describe, expect, it } from "vitest";
import { plainText } from "../../../src/core/search.js";
import { renderMarkdown, resolveRelative } from "../src/markdown.js";

const PAGE = "knowledge/runbooks/deploy-production.md";
const IDS = new Map([
  ["knowledge/decisions/ADR-0002-argo-rollouts.md", "adr-0002"],
  ["knowledge/runbooks/rollback-deploy.md", "rb-rollback-deploy"],
]);
const render = (md: string) => renderMarkdown(md, { pagePath: PAGE, pageIds: IDS });

/** The output as a browser parses it. */
function dom(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

/** Everything that could run, fetch or navigate unexpectedly: none of it may survive. */
function assertInert(html: string) {
  const root = dom(html);
  expect(root.querySelectorAll("script, img, iframe, object, embed, style, link, svg, video, audio, source, form, base, meta").length, html).toBe(0);
  for (const el of root.querySelectorAll("*")) for (const attr of el.getAttributeNames()) expect(attr, `${el.tagName} ${attr}`).not.toMatch(/^on|^style$|^src$|^srcset$/i);
  for (const a of root.querySelectorAll("a")) expect(a.getAttribute("href") ?? "", a.outerHTML).toMatch(/^(?:\/p\/|#|https?:\/\/|mailto:)/i);
}

describe("safe markdown (R12)", () => {
  it.each([
    ["raw script", "<script>alert(1)</script>\n\nok"],
    ["raw img with onerror", '<img src="x" onerror="alert(1)">'],
    ["inline raw html", 'text <span onclick="alert(1)">x</span> and <iframe src="https://evil.example"></iframe>'],
    ["javascript link", "[click](javascript:alert(1))"],
    ["upper-case scheme with spaces", "[click](  JAVASCRIPT:alert(1))"],
    ["vbscript and file", "[a](vbscript:msgbox) [b](file:///etc/passwd)"],
    ["data link", "[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
    ["protocol-relative", "[a](//evil.example/x)"],
    ["external image", "![tracking pixel](https://evil.example/p.png)"],
    ["data image", "![a](data:image/png;base64,AAAA)"],
    ["image inside a link", "[![a](https://evil.example/p.png)](https://example.com)"],
    ["html block", '<div>\n<a href="javascript:alert(1)">x</a>\n</div>'],
    ["reference link to javascript", "[x][r]\n\n[r]: javascript:alert(1)"],
  ])("leaves nothing that runs or fetches: %s", (_name, md) => {
    assertInert(render(md));
  });

  it.each([
    ["raw html, a script link and an image", "| <b onclick=\"x\">a</b> | b |\n|---|---|\n| [c](javascript:alert(1)) | ![p](https://evil.example/p.png) <script>x</script> |"],
    ["text that is markup", '| a |\n|---|\n| &lt;img src=x onerror=alert(1)&gt; " onmouseover="x |'],
  ])("builds a table from hostile cells, and leaves nothing in it that runs or fetches: %s", (_name, md) => {
    const html = render(md);
    expect(dom(html).querySelector("table td"), html).not.toBeNull();
    assertInert(html);
  });

  it("turns an image into a link labelled with its alt text, so it is never fetched", () => {
    const a = dom(render("![the diagram](https://example.com/d.png)")).querySelector("a");
    expect(a?.textContent).toBe("image: the diagram");
    expect(a?.getAttribute("href")).toBe("https://example.com/d.png");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("drops a data image's link and keeps its label", () => {
    const root = dom(render("![a](data:image/png;base64,AAAA)"));
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("image: a");
  });

  it("routes a relative link to a visible page inside the app", () => {
    const a = dom(render("See [the ADR](../decisions/ADR-0002-argo-rollouts.md#context).")).querySelector("a");
    expect(a?.getAttribute("href")).toBe("/p/adr-0002");
    expect(a?.getAttribute("target")).toBeNull();
  });

  it("keeps only the text of a relative link to anything else", () => {
    const root = dom(render("[gone](./missing.md) and [up](../../../../outside.md)"));
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent?.trim()).toBe("gone and up");
  });

  it("opens external links in a new tab without a referrer", () => {
    const a = dom(render("[docs](https://example.com/a?b=1&c=2)")).querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com/a?b=1&c=2");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("never makes the placeholder a link, whatever target the page defines for it", () => {
    // As redaction leaves it: a page's own definition, or a target or label written after it.
    for (const md of [
      "See [restricted page] now.\n\n[restricted page]: https://evil.example/phish",
      "[Restricted  Page]: https://evil.example\n\n| a |\n|-|\n| [restricted page] |",
      "On-call: see [restricted page](https://evil.example/phish) first.",
      "On-call: see [restricted page][x] first.\n\n[x]: https://evil.example/phish",
      "On-call: see ![restricted page](https://evil.example/p.png) first.",
      // A link around it: `[![HSM](hsm.md)](https://…)`, redacted.
      "On-call: see [[restricted page]](https://evil.example/phish) first.",
      "On-call: see [the [restricted page] notes](https://evil.example/phish) first.",
      // An image inside a link: once the image is the placeholder, the link holds it.
      "On-call: see [notes ![restricted page](x.png)](https://evil.example/phish) first.",
    ]) {
      // No link or image anywhere. (A definition a page writes for the placeholder isn't one,
      // so it shows as the text it is.)
      const root = dom(render(md));
      expect(root.querySelector("a, img"), md).toBeNull();
      expect(root.textContent, md).toContain("[restricted page]");
    }
  });

  it("shows an image inside a link as its label, in that link: links never nest", () => {
    const root = dom(render("[![build passing](https://ci.example/badge.svg)](https://ci.example/runs) and [`restricted page` ![see](x.png)](https://evil.example)"));
    expect([...root.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["image: build passing", "https://ci.example/runs"],
      // Its whole label shows, so it never reads as the placeholder.
      ["restricted page image: see", "https://evil.example"],
    ]);
    expect(root.querySelector("a a")).toBeNull();
  });

  it("never reads the placeholder as a link definition: a redacted `[term](page.md): text` line stays", () => {
    for (const md of ["[restricted page]: required", "- [restricted page]: https://example.com/x \"t\""]) {
      const root = dom(render(md));
      expect(root.textContent, md).toContain("[restricted page]:");
      expect(root.querySelector("a"), md).toBeNull();
    }
  });

  it("shows the server's placeholder for a link the viewer can't see as text", () => {
    const root = dom(render("Writes go to the [restricted page] for every balance change."));
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("[restricted page]");
  });

  describe("GFM tables", () => {
    const cellsOf = (row: Element) => [...row.children].map((c) => c.textContent);

    it("renders the header, each row, the alignment and the markup inside cells", () => {
      const root = dom(render("| Mode | Used for | Count |\n|:---|:---:|---:|\n| `chat` | **OpenAI**, see [the ADR](../decisions/ADR-0002-argo-rollouts.md) | 3 |\n| x | [docs](https://example.com) | 12 |"));
      const table = root.querySelector("table");
      expect(table, root.innerHTML).not.toBeNull();
      expect(cellsOf(table!.querySelector("thead tr")!)).toEqual(["Mode", "Used for", "Count"]);
      const rows = [...table!.querySelectorAll("tbody tr")];
      expect(rows.map(cellsOf)).toEqual([
        ["chat", "OpenAI, see the ADR", "3"],
        ["x", "docs", "12"],
      ]);
      expect([...table!.querySelectorAll("th")].map((th) => th.className)).toEqual(["dw-align-left", "dw-align-center", "dw-align-right"]);
      expect(rows[0]!.querySelector("td code")?.textContent).toBe("chat");
      expect(rows[0]!.querySelector("td strong")?.textContent).toBe("OpenAI");
      // Links in cells are rewritten like any other: a page route, an external link.
      expect(rows[0]!.querySelector("a")?.getAttribute("href")).toBe("/p/adr-0002");
      expect(rows[1]!.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
      expect(root.textContent).not.toContain("|");
    });

    it("reads an escaped pipe as a pipe, in code too, and not as a new column", () => {
      const root = dom(render("| Command | Note |\n| --- | --- |\n| `ps \\| grep x` | a \\| b |"));
      const row = root.querySelector("tbody tr")!;
      expect(cellsOf(row)).toEqual(["ps | grep x", "a | b"]);
      expect(row.querySelector("code")?.textContent).toBe("ps | grep x");
    });

    it("pads a short row and drops a long row's extra cells", () => {
      const root = dom(render("a | b\n--|--\n1\n1 | 2 | 3"));
      expect([...root.querySelectorAll("tbody tr")].map(cellsOf)).toEqual([
        ["1", ""],
        ["1", "2"],
      ]);
    });

    it("keeps the lines before a table as a paragraph, and finds tables in quotes and lists", () => {
      const root = dom(render("The modes:\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> | q |\n> |---|\n> | in a quote |\n\n- | l |\n  |---|\n  | in a list |"));
      expect(root.querySelector("p")?.textContent).toBe("The modes:");
      expect(root.querySelectorAll("table")).toHaveLength(3);
      expect(root.querySelector("blockquote table td")?.textContent).toBe("in a quote");
      expect(root.querySelector("li table td")?.textContent).toBe("in a list");
    });

    it("ends a table at a lazy line, and makes none from a lazy header or delimiter, as GitHub does", () => {
      // GitHub's answers, from `gh api markdown -f mode=gfm`: an unprefixed line ends the table
      // and isn't a row. (GitHub moves that line out of the quote or list; here it stays in.)
      for (const [md, header, rest] of [
        ["> a | b\n> ---|---\nx | y", "a ¦ b", "x | y"],
        ["- | l |\n  |---|\n| lazy |", "l", "| lazy |"],
        // A reference definition leaves the paragraph's text; its lines must still line up.
        ["> [r]: https://example.com\n> | a |\n> |---|\nlazy", "a", "lazy"],
      ] as const) {
        const root = dom(render(md));
        const rows = [...root.querySelectorAll("table tr")].map((r) => [...r.children].map((c) => c.textContent).join(" ¦ "));
        expect(rows, md).toEqual([header]);
        // The lazy line follows the table as text (a tight list's paragraph has no <p>).
        expect(root.querySelector("table")!.textContent, md).not.toContain(rest);
        expect(root.textContent!.trim().endsWith(rest), md).toBe(true);
      }
      const lazyHeader = "1. Step one\n| a | b |\n|---|---|\n| 1 | 2 |";
      expect(dom(render(lazyHeader)).querySelector("table"), lazyHeader).toBeNull();
    });

    it("ends a table at any block start, as GitHub does, even one that can't interrupt a paragraph", () => {
      // GitHub's answers: an ordered list from 2, indented code, an empty list item and an HTML
      // tag alone on its line each end the table; CommonMark alone keeps them in the paragraph.
      const rowsOf = (root: HTMLElement) => [...root.querySelectorAll("table tr")].map((r) => [...r.children].map((c) => c.textContent).join(" ¦ "));
      let root = dom(render("a | b\n-|-\n2. item"));
      expect(rowsOf(root)).toEqual(["a ¦ b"]);
      expect(root.querySelector("ol")?.getAttribute("start")).toBe("2");
      expect(root.querySelector("ol li")?.textContent).toBe("item");
      root = dom(render("a | b\n-|-\n1 | 2\n    code"));
      expect(rowsOf(root)).toEqual(["a ¦ b", "1 ¦ 2"]);
      expect(root.querySelector("pre code")?.textContent).toBe("code\n");
      root = dom(render("a | b\n-|-\n1 | 2\n*"));
      expect(rowsOf(root)).toEqual(["a ¦ b", "1 ¦ 2"]);
      expect(root.querySelectorAll("ul li")).toHaveLength(1);
      root = dom(render("a | b\n-|-\n1 | 2\n<custom-tag>"));
      expect(rowsOf(root)).toEqual(["a ¦ b", "1 ¦ 2"]);
      expect(root.textContent).not.toContain("custom-tag");
      // HTML by CommonMark's grammar: a quoted `>` is inside the tag; an unclosed quote is no tag.
      expect(rowsOf(dom(render('a | b\n-|-\n1 | 2\n<x a="x>y">')))).toEqual(["a ¦ b", "1 ¦ 2"]);
      expect(rowsOf(dom(render('a | b\n-|-\n1 | 2\n<x a="unterminated>')))).toEqual(["a ¦ b", "1 ¦ 2", '<x a="unterminated> ¦ ']);
      root = dom(render("> a | b\n> -|-\n>     code"));
      expect(rowsOf(root)).toEqual(["a ¦ b"]);
      expect(root.querySelector("blockquote pre code")?.textContent).toBe("code\n");
    });

    it("keeps the page's link definitions in the blocks after a table", () => {
      const root = dom(render("a | b\n-|-\n2. [docs][r]\n\n[r]: https://example.com/docs"));
      expect(root.querySelector("ol li a")?.getAttribute("href")).toBe("https://example.com/docs");
      // A label defined again after the table: GitHub links to that later one (its renderer,
      // `gh api markdown -f mode=gfm`, 2026-11-13), so the tail's own definitions win here.
      const twice = dom(render("[r]: https://first.example\na | b\n-|-\n2. [r]: https://second.example\n   [docs][r]"));
      expect(twice.querySelector("ol li a")?.getAttribute("href")).toBe("https://second.example");
    });

    it("takes time in proportion to a paragraph's length, table or not", () => {
      // Noting each line's laziness must not copy what came before: 80,000 lines took seconds.
      const md = Array.from({ length: 80000 }, (_, i) => `line ${i}`).join("\n");
      const t = performance.now();
      render(md);
      expect(performance.now() - t).toBeLessThan(2000);
    });

    it("bounds the work of tables chained in one paragraph, whatever the page holds", () => {
      // Each table ended by a line that can't interrupt a paragraph re-parses what follows it;
      // chained, that was quadratic (1,600 tables: 2.2 s). Page text is untrusted.
      const md = "a | b\n-|-\n    code\n".repeat(4000);
      const t = performance.now();
      const root = dom(render(md));
      expect(performance.now() - t).toBeLessThan(2000);
      expect(root.querySelector("table th")?.textContent).toBe("a");
      expect(root.querySelector("pre code")?.textContent).toBe("code\n");
      // A short chain after a long page: within the budget, but not more than 16 deep.
      const deep = `${"filler words. ".repeat(20000)}\n\n${"a | b\n-|-\n    code\n".repeat(40)}`;
      expect(dom(render(deep)).querySelectorAll("table")).toHaveLength(17);
      // A shallow chain whose tail is the page: each re-parse costs about the page's length, so
      // the budget (eight pages) stops it before the depth cap does.
      const heavy = `${"a | b\n-|-\n    code\n".repeat(14)}a | b\n-|-\n${"1 | 2\n".repeat(3000)}`;
      expect(dom(render(heavy)).querySelectorAll("table")).toHaveLength(9);
    });

    it("bounds a table's cells by the page's length: padding a row is free, so it isn't unlimited", () => {
      // 800 header cells and 800 one-cell rows: 4.8 KB padded to 640,000 cells.
      const wide = `${"|h".repeat(800)}|\n${"|-".repeat(800)}|\n${"x\n".repeat(800)}`;
      const t = performance.now();
      const root = dom(render(wide));
      expect(performance.now() - t).toBeLessThan(2000);
      expect(root.querySelectorAll("td").length).toBeLessThanOrEqual(wide.length);
      // An ordinary table is well inside the bound.
      expect(dom(render("| a | b |\n|---|---|\n| 1 |\n| 3 | 4 |")).querySelectorAll("td")).toHaveLength(4);
    });

    it("reads an underline after a table as GitHub does: --- is a rule after it, anything else a row", () => {
      // CommonMark alone makes each of these a setext heading of the whole table.
      for (const [md, rows, rule] of [
        ["a | b\n---|---\nrow | cell\n---", ["a ¦ b", "row ¦ cell"], true],
        ["a | b\n---|---\nrow | cell\n===", ["a ¦ b", "row ¦ cell", "=== ¦ "], false],
        ["> a | b\n> ---|---\n> x | y\n> ====", ["a ¦ b", "x ¦ y", "==== ¦ "], false],
        ["- a | b\n  -|-\n  1|2\n  --", ["a ¦ b", "1 ¦ 2", "-- ¦ "], false],
      ] as const) {
        const root = dom(render(md));
        expect([...root.querySelectorAll("table tr")].map((r) => [...r.children].map((c) => c.textContent).join(" ¦ ")), md).toEqual(rows);
        expect(root.querySelector("h1, h2"), md).toBeNull();
        expect(root.querySelector(".dw-table-scroll + hr") !== null, md).toBe(rule);
      }
      // After a lazy line, GitHub reads the underline on its own: a rule, or the text `===`.
      for (const [md, after] of [
        ["> a | b\n> -|-\nlazy\n> ---", ["P lazy", "HR "]],
        ["> a | b\n> -|-\nlazy\n> ===", ["P lazy", "P ==="]],
      ] as const) {
        const root = dom(render(md));
        expect([...root.querySelectorAll("table tr")].map((r) => r.textContent?.trim()), md).toEqual(["ab"]);
        expect(root.querySelector("h1, h2"), md).toBeNull();
        const following = [...root.querySelector("blockquote")!.children].slice(1).map((el) => `${el.tagName} ${el.textContent}`);
        expect(following, md).toEqual(after);
      }
    });

    it("needs the delimiter row, with one cell per header cell: otherwise it's a paragraph", () => {
      // The last: a line of dashes with no pipe isn't a delimiter row, even in a paragraph with one.
      for (const md of ["a | b\nc | d", "| a | b |\n|---|\n| 1 | 2 |", "| a | b |\n|---|-x-|", "a | b\nc\n:---"]) {
        const root = dom(render(md));
        expect(root.querySelector("table"), md).toBeNull();
        expect(root.querySelector("p")?.textContent, md).toBe(md);
      }
    });
  });

  it("resolves relative paths within the repo and refuses ones that leave it", () => {
    expect(resolveRelative("knowledge/runbooks/a.md", "../decisions/b.md")).toBe("knowledge/decisions/b.md");
    expect(resolveRelative("knowledge/a.md", "./x/../y.md")).toBe("knowledge/y.md");
    expect(resolveRelative("knowledge/a.md", "../../z.md")).toBeNull();
  });
});

describe("search's text snippets (src/core/search.ts)", () => {
  // The words of the page as rendered here: block and cell ends apart, as a reader sees them.
  const shownWords = (md: string) => {
    const html = render(md).replace(/<\/(td|th|p|li|h[1-6]|pre|blockquote|tr)>|<br \/>|<hr \/>/g, " $&");
    return (dom(html).textContent ?? "").match(/[\p{L}\p{N}_]+/gu) ?? [];
  };
  it.each([
    "| a | b |\n|:--|--:|\n| `x` | **y** |",
    "| a | b |\n|-|-|\n| x | y | not shown |",
    "| A | B |\n|-|-|\n| left &#124; right | second |",
    "| A | B |\n|-|-|\n| x | y |\n    command | grep | dropped",
    "| A | B |\n|-|-|\n| [visible](https://e/x|y) | second |",
    "> a | b\n> ---|---\nlazy words",
    "a | b\n---|---\nrow | cell\n===",
    "a | b\n-|-\n2. item words",
    "ordinary prose\n---|---",
    "| `a \\| b` | c |\n| --- | --- |\n| x | y |",
    "See ![architecture diagram](diagram.png) and | ![x](y.png) |\n|-|\n| ![](z.png) |",
    "Diagram:![architecture](d.png)",
    "An image of raw HTML ![<b>](secret.png) only.",
    "Nested ![alpha ![](inner.png)](outer.png) and ![two\nlines](x.png).",
    "[restricted page]: required\n\n> [Restricted Page]: also kept",
    "See [restricted page] now.\n\n[restricted page]: https://evil.example/phish",
  ])("has exactly the words the page shows: %j", (md) => {
    expect(plainText(md).match(/[\p{L}\p{N}_]+/gu) ?? []).toEqual(shownWords(md));
  });
});
