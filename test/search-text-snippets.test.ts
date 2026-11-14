import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { type AuditEvent, AuditLog, type AuditSink } from "../src/core/audit-log.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { plainText } from "../src/core/search.js";
import { startServer } from "../src/core/serve/server.js";
import { KnowledgeService } from "../src/core/service.js";
import { copyAcme, fixedIdentity, INDEX, makeRepo, NOW, page } from "./helpers.js";
import { mirrorPage, serveMirror, writeMirror } from "./mirror-helpers.js";

// search's `snippets: "text"`: the web app asks for snippets cut from the page as a reader
// sees it, so nothing is cut in the middle of markup and no client has to guess what a
// piece of markdown shows. Agents' snippets (the default, markdown) don't change.

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const repoWith = (files: Record<string, string>) => {
  const r = makeRepo({ ...INDEX, ...files });
  cleanups.push(r.cleanup);
  return r.root;
};
const local = (root: string) => new KnowledgeService(root, fixedIdentity(LOCAL_IDENTITY), () => NOW);

const BODY = [
  "# Memory providers",
  "",
  "Set **memory_enabled** in `~/.hermes/config.yaml`, then see [the guide](guide.md) and _the_ FAQ.",
  "",
  "```yaml",
  "memory:",
  "  memory_char_limit: 2200 # about 800 tokens",
  "```",
  "",
  "| Key | Default |",
  "| --- | --- |",
  "| `memory_enabled` | true |",
  "",
  'Escaped \\_marks\\_ stay, an image ![the diagram](d.png) shows its words, and <b>raw HTML</b> shows none of its tags.',
  "",
].join("\n");

describe("plainText", () => {
  it("is the page as a reader sees it: no markup, link targets, fences or table rules", () => {
    const text = plainText(BODY);
    expect(text).toContain("Memory providers Set memory_enabled in ~/.hermes/config.yaml, then see the guide and the FAQ.");
    expect(text).toContain("memory: memory_char_limit: 2200 # about 800 tokens");
    expect(text).toContain("Key | Default memory_enabled | true");
    expect(text).toContain("Escaped _marks_ stay, an image image: the diagram shows its words, and raw HTML shows none of its tags.");
    for (const markup of ["**", "`", "](", "```", "---", "<b>", "d.png", "guide.md"]) expect(text, markup).not.toContain(markup);
    // An image reads as the web app labels it, and next to what it's next to.
    expect(plainText("Diagram:![architecture](d.png) and ![](z.png)")).toBe("Diagram:image: architecture and image: z.png");
    expect(plainText("![<b>](secret.png)")).toBe("image: secret.png");
    // One label for an image, as the web app makes it: an image inside it isn't shown.
    expect(plainText("![alpha ![](inner.png)](outer.png)")).toBe("image: alpha");
  });

  it("takes time in proportion to the page however deeply links and images nest (page text is untrusted)", () => {
    // Every label checked for the placeholder walked everything inside it: 4,000 nested
    // images took 54 ms, and 40,000 would take seconds, on every search that returned them.
    const md = `${"![a ".repeat(20000)}needle${"](x)".repeat(20000)}`;
    const t = performance.now();
    const text = plainText(md);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(text).toContain("needle");
  });

  it("keeps code as written, pipes and all: only a table's own rules and outer pipes go", () => {
    // Code alone on its line: it isn't a table's row or rule.
    expect(plainText("`| keep_me |`\n\n`| --- |`")).toBe("| keep_me | | --- |");
    // In a table, a pipe in code is escaped (`\|`), and GitHub shows it unescaped.
    expect(plainText("| `a \\| b` | c |\n| --- | --- |\n| `\\|x\\|` | y |")).toBe("a | b | c |x| | y");
  });

  it("takes table marks only from a table: a header, then its delimiter row (one dash is enough, as on GitHub)", () => {
    expect(plainText("| literal prose |")).toBe("| literal prose |");
    expect(plainText("| - |")).toBe("| - |");
    expect(plainText("Intro line.\n| a | b |\n|-|-|\n| 1 | 2 |")).toBe("Intro line. a | b 1 | 2");
    // The header is the line right before the delimiter row; a piped line above it is prose.
    expect(plainText("| not a row |\n| a | b |\n|-|-|\n| 1 | 2 |")).toBe("| not a row | a | b 1 | 2");
    expect(plainText("| a |\n| - |\n| 1 |")).toBe("a 1");
    // An escaped pipe splits no cell, in text or code; it shows as a pipe in a table, and code
    // outside one keeps its backslash.
    expect(plainText("| a \\| b | c |\n| --- | --- |\n| x | y |")).toBe("a | b | c x | y");
    expect(plainText("Run `grep a \\| b` or a \\| b.")).toBe("Run grep a \\| b or a | b.");
    expect(plainText("```\ngrep a \\| b\n```")).toBe("grep a \\| b");
    // Cells are split as the web app splits them (one parse, src/core/gfm.ts): an entity
    // pipe is a cell's text, a table ends at indented code, and a pipe in a link's target
    // splits a cell, as on GitHub.
    expect(plainText("| A | B |\n|-|-|\n| left &#124; right | second |")).toBe("A | B left | right | second");
    expect(plainText("| A | B |\n|-|-|\n| x | y |\n    command | grep | dropped")).toBe("A | B x | y command | grep | dropped");
    expect(plainText("| A | B |\n|-|-|\n| [visible](https://e/x|y) | second |")).toBe("A | B [visible](https://e/x | y)");
    // A row's cells past the delimiter row's are dropped, by GitHub and by the web app.
    expect(plainText("| a | b |\n|-|-|\n| x | y | not shown |")).toBe("a | b x | y");
    // A header has as many cells as its delimiter row; otherwise it's prose, shown whole.
    expect(plainText("ordinary prose\n---|---")).toBe("ordinary prose ---|---");
  });
});

describe('search with snippets: "text"', () => {
  it("cuts the snippet from the page's text, and says so; the default stays markdown", async () => {
    const root = repoWith({ "knowledge/memory.md": page({ id: "memory", title: "Memory" }, BODY) });
    const text = await local(root).search({ query: "memory enabled config", snippets: "text" });
    const hit = text.results.find((r) => r.id === "memory")!;
    expect(text.snippets).toBe("text");
    expect(hit.snippet).toContain("Set memory_enabled in ~/.hermes/config.yaml");
    expect(hit.snippet).not.toMatch(/\*\*|`|\]\(/);
    expect(hit.snippet).not.toContain("---"); // the table's delimiter row
    const markdown = await local(root).search({ query: "memory enabled config" });
    expect(markdown).not.toHaveProperty("snippets");
    expect(markdown.results.find((r) => r.id === "memory")!.snippet).toContain("Set **memory_enabled** in `~/.hermes/config.yaml`");
  });

  it("never cuts inside markup: a cut through bold text cuts its words", async () => {
    // 240 characters fall inside the bold run; the markdown snippet keeps an opened `**`.
    const long = `${"Words before the point. ".repeat(9)}**The bold sentence that the cut falls inside of, which goes on for a while longer.** After.\n`;
    const root = repoWith({ "knowledge/long.md": page({ id: "long", title: "Long" }, long) });
    const markdown = (await local(root).search({ query: "words before point" })).results[0]!.snippet;
    expect(markdown).toMatch(/\*\*The bold/);
    const text = (await local(root).search({ query: "words before point", snippets: "text" })).results[0]!.snippet;
    expect(text).toMatch(/The bold sentence.*…$/);
    expect(text).not.toContain("*");
  });

  it("is cut from the redacted page: a hidden page's link is still `[restricted page]`, its target gone", async () => {
    const root = repoWith({
      "knowledge/ops.md": page({ id: "ops", title: "Ops notes" }, "On-call ops notes: see [HSM key ceremony](hsm.md) first.\n"),
      "knowledge/hsm.md": page({ id: "hsm", title: "HSM key ceremony", acl: "security" }),
    });
    const r = await local(root).search({ query: "on-call ops notes", snippets: "text" });
    expect(r.results.find((x) => x.id === "ops")?.snippet).toBe("On-call ops notes: see [restricted page] first.");
    expect(JSON.stringify(r)).not.toMatch(/HSM|hsm/);
  });

  it("keeps `[restricted page]` as it is, whatever target the page defines for it", async () => {
    const root = repoWith({
      "knowledge/ops.md": page({ id: "ops", title: "Ops notes" }, "On-call ops notes: see [HSM key ceremony](hsm.md) first.\n\n[restricted page]: https://evil.example/phish\n"),
      "knowledge/hsm.md": page({ id: "hsm", title: "HSM key ceremony", acl: "security" }),
    });
    const r = await local(root).search({ query: "on-call ops notes", snippets: "text" });
    // The page's own definition isn't one for the placeholder, so it reads as the text it is.
    expect(r.results.find((x) => x.id === "ops")?.snippet).toBe("On-call ops notes: see [restricted page] first. [restricted page]: https://evil.example/phish");
    // Or a target, or a label, written right after the link redaction replaces.
    const term = repoWith({
      "knowledge/ops.md": page({ id: "ops", title: "Ops notes" }, "On-call ops notes, by term:\n\n[HSM key ceremony](hsm.md): required\n"),
      "knowledge/hsm.md": page({ id: "hsm", title: "HSM key ceremony", acl: "security" }),
    });
    expect((await local(term).search({ query: "on-call ops notes", snippets: "text" })).results.find((x) => x.id === "ops")?.snippet).toBe("On-call ops notes, by term: [restricted page]: required");
    for (const after of ["(https://evil.example/phish)", "[x]\n\n[x]: https://evil.example/phish", " and [![HSM key ceremony](hsm.md)](https://evil.example/phish)"]) {
      const next = repoWith({
        "knowledge/ops.md": page({ id: "ops", title: "Ops notes" }, `On-call ops notes: see [HSM key ceremony](hsm.md)${after} first.\n`),
        "knowledge/hsm.md": page({ id: "hsm", title: "HSM key ceremony", acl: "security" }),
      });
      const s = (await local(next).search({ query: "on-call ops notes", snippets: "text" })).results.find((x) => x.id === "ops")?.snippet;
      // Every redacted link is the placeholder, brackets and all, even where it would read as
      // a link definition.
      expect(s?.split("[restricted page]").length, after).toBe(after.includes("hsm.md") ? 3 : 2);
    }
  });

  it("cuts a mirrored page's snippet from its text too", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    await writeMirror(acme.root, { ENG: [mirrorPage("ENG", "103", "Old wiki tips", "Set **memory_enabled** in `config.yaml` before a zebracorn deploy.")] });
    serveMirror(acme.root);
    const text = await local(acme.root).search({ query: "zebracorn deploy", snippets: "text" });
    expect(text.mirrored?.[0]?.snippet).toBe("Set memory_enabled in config.yaml before a zebracorn deploy.");
    expect((await local(acme.root).search({ query: "zebracorn deploy" })).mirrored?.[0]?.snippet).toBe("Set **memory_enabled** in `config.yaml` before a zebracorn deploy.");
  });

  it("is at most 240 characters of the page, as a markdown snippet is, however much markup the page has", async () => {
    // Without markup, those characters hold more words (security-model.md says why the text
    // window isn't the markdown one's: it may end inside markup). The bound is the same.
    const links = Array.from({ length: 8 }, (_, i) => `[label ${i}](https://example.com/${"x".repeat(60)}/${i})`).join(" ");
    const root = repoWith({ "knowledge/links.md": page({ id: "links", title: "Links" }, `The needle is here. ${links} After the links.\n`) });
    for (const snippets of ["markdown", "text"] as const) {
      const s = (await local(root).search({ query: "needle", snippets })).results[0]!.snippet;
      expect(s.replace(/^…|…$/g, "").length, snippets).toBeLessThanOrEqual(240);
    }
  });

  it("is audited, and a value it doesn't know is refused", async () => {
    const root = repoWith({ "knowledge/memory.md": page({ id: "memory", title: "Memory" }, BODY) });
    const events: AuditEvent[] = [];
    const sink: AuditSink = { name: "memory", required: true, write: async (e) => void events.push(e) };
    const audit = new AuditLog([sink], { session: "s", server: { version: "test", repo: null, commit: null } }, () => NOW, () => {});
    const token = "t".repeat(43);
    const s = await startServer({ root, identity: fixedIdentity(LOCAL_IDENTITY), who: LOCAL_IDENTITY, audit, includeQueries: false, now: () => NOW, port: 0, token, extensions: new Set(), webRoot: null, log: () => {} });
    try {
      const c = new Client({ name: "docsworth-web", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const r = await c.callTool({ name: "search", arguments: { query: "memory", snippets: "text" } });
      expect((r.structuredContent as { snippets?: string }).snippets).toBe("text");
      expect(events.find((e) => e.kind === "tool_call" && e.tool === "search")).toMatchObject({ outcome: "ok", args: { snippets: "text" } });
      // A value it doesn't know is refused, and recorded as <invalid>, never as given.
      const smuggled = `ghp_${"x".repeat(36)}`;
      expect((await c.callTool({ name: "search", arguments: { query: "memory", snippets: smuggled } })).isError).toBe(true);
      expect(events.filter((e) => e.kind === "tool_call" && e.tool === "search").at(-1)).toMatchObject({ args: { snippets: "<invalid>" } });
      expect(JSON.stringify(events)).not.toContain(smuggled);
      await c.close();
    } finally {
      await s.close();
    }
  });
});
