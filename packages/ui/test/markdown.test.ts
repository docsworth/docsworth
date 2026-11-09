import { describe, expect, it } from "vitest";
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

  it("shows the server's placeholder for a link the viewer can't see as text", () => {
    const root = dom(render("Writes go to the [restricted page] for every balance change."));
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("[restricted page]");
  });

  it("resolves relative paths within the repo and refuses ones that leave it", () => {
    expect(resolveRelative("knowledge/runbooks/a.md", "../decisions/b.md")).toBe("knowledge/decisions/b.md");
    expect(resolveRelative("knowledge/a.md", "./x/../y.md")).toBe("knowledge/y.md");
    expect(resolveRelative("knowledge/a.md", "../../z.md")).toBeNull();
  });
});
