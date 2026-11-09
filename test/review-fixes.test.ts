import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactLinks } from "../src/core/acl.js";
import { patternToRegex, parseCodeowners, resolveTeamOwner } from "../src/core/codeowners.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { extractLinks } from "../src/core/repo.js";
import { KnowledgeService, WATCH_SETTLE_MS } from "../src/core/service.js";
import { INDEX, makeRepo, NOW, page, fixedIdentity } from "./helpers.js";

// Regression tests for findings from the cross-model review of the core diff.

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
function repoWithHidden(body: string) {
  const repo = makeRepo({
    ...INDEX,
    "knowledge/ops.md": page({ id: "ops", title: "Ops notes" }, body),
    "knowledge/sec/hsm.md": page({ id: "hsm", title: "HSM key ceremony", acl: "security" }),
    "knowledge/pub.md": page({ id: "pub", title: "Public page" }),
  });
  cleanups.push(repo.cleanup);
  return repo;
}

describe("link redaction covers every Markdown link form", () => {
  it.each([
    ["inline", "[HSM key ceremony](sec/hsm.md)"],
    ["image", "![HSM key ceremony](sec/hsm.md)"],
    ["angle destination", "[HSM key ceremony](<sec/hsm.md>)"],
    ["query string", "[HSM key ceremony](sec/hsm.md?view=1)"],
    ["fragment", "[HSM key ceremony](sec/hsm.md#steps)"],
    ["title", '[HSM key ceremony](sec/hsm.md "the ceremony")'],
    ["root-relative", "[HSM key ceremony](/knowledge/sec/hsm.md)"],
    ["percent-encoded", "[HSM key ceremony](sec/%68sm.md)"],
    ["reference", "[HSM key ceremony][h]", "[h]: sec/hsm.md"],
    ["collapsed reference", "[HSM key ceremony][]", "[HSM key ceremony]: sec/hsm.md"],
    ["shortcut reference", "See [HSM key ceremony].", '[HSM key ceremony]: <sec/hsm.md> "t"'],
    ["HTML anchor", '<a href="sec/hsm.md">HSM key ceremony</a>'],
  ])("%s", (_name, link, definition = "") => {
    // Reference definitions must sit on their own line, after the prose that uses them.
    const repo = repoWithHidden(`Intro ${link} outro, and [public](pub.md).\n\n${definition}\n`);
    const out = redactLinks(repo.byId.get("ops")!.body, "knowledge/ops.md", repo, LOCAL_IDENTITY);
    expect(out).not.toMatch(/HSM|hsm|sec\//);
    expect(out).toContain("[restricted page]");
    expect(out).toContain("[public](pub.md)");
  });

  it("leaves links to visible pages alone for the team that can see them", () => {
    const repo = repoWithHidden("[HSM key ceremony][h]\n\n[h]: sec/hsm.md\n");
    const out = redactLinks(repo.byId.get("ops")!.body, "knowledge/ops.md", repo, { ...LOCAL_IDENTITY, teams: new Set(["security"]) });
    expect(out).toContain("[h]: sec/hsm.md");
  });

  it("lint sees reference, angle and query links too", () => {
    expect(extractLinks("[a](<b.md>) [c](d.md?x=1) [e][f]\n\n[f]: g.md\n[w]: https://x.io")).toEqual(["b.md", "d.md", "g.md"]);
  });
});

describe("CODEOWNERS escapes", () => {
  it("keeps an escaped space inside the pattern", () => {
    const co = parseCodeowners("* @acme/everyone\n/knowledge/team\\ docs/ @acme/docs\n");
    expect(co.rules[1]).toMatchObject({ pattern: "/knowledge/team\\ docs/", owners: [{ raw: "@acme/docs" }] });
    expect(resolveTeamOwner(co, "knowledge/team docs/x.md", "acme")).toMatchObject({ ok: true, team: "docs" });
  });

  it("treats escaped glob characters literally", () => {
    expect(patternToRegex("docs/\\*.md").test("docs/*.md")).toBe(true);
    expect(patternToRegex("docs/\\*.md").test("docs/a.md")).toBe(false);
  });
});

describe("the server notices CODEOWNERS and config changes", () => {
  it("re-evaluates ownership when CODEOWNERS changes under it", async () => {
    const repo = makeRepo({ ...INDEX, "knowledge/x.md": page({ id: "x", title: "Rotate keys" }) });
    cleanups.push(repo.cleanup);
    const s = new KnowledgeService(repo.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    expect((await s.read({ id: "x" })).citable).toBe(true);
    const co = join(repo.root, "CODEOWNERS");
    writeFileSync(co, readFileSync(co, "utf8").replace("@acme/platform", "@acme/payments"));
    const later = new Date(Date.now() + 5000);
    (await import("node:fs")).utimesSync(co, later, later);
    expect((await s.read({ id: "x" })).citable).toBe(false);
  });
});

describe("the watcher follows a moved knowledge root", () => {
  it("picks up a page added under the new root after config changes", async () => {
    const repo = makeRepo({ ...INDEX, "docs-kb/index.md": page({ id: "index2", title: "New root" }) });
    cleanups.push(repo.cleanup);
    const s = new KnowledgeService(repo.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    s.watch();
    try {
      const cfg = join(repo.root, ".knowledge/config.yaml");
      writeFileSync(cfg, readFileSync(cfg, "utf8").replace("knowledge_root: knowledge", "knowledge_root: docs-kb"));
      const later = new Date(Date.now() + 5000);
      (await import("node:fs")).utimesSync(cfg, later, later);
      expect((await s.read({ id: "index2" })).title).toBe("New root"); // config reload
      // Deterministic: the watcher now follows the new root. (The behavioural check below
      // alone is not a reliable guard on macOS, where FSEvents can coalesce sibling events.)
      expect((s as unknown as { watchedDir: string }).watchedDir).toBe(join(repo.root, "docs-kb"));
      // Let the restarted watcher's settle reload fire and be consumed, so that from here on only
      // the watcher itself can notice the new page.
      await new Promise((r) => setTimeout(r, WATCH_SETTLE_MS + 300));
      await s.read({ id: "index2" });
      writeFileSync(join(repo.root, "docs-kb/added.md"), page({ id: "added", title: "Added later" }));
      let found = "";
      for (let i = 0; i < 40 && !found; i++) {
        await new Promise((r) => setTimeout(r, 50));
        found = await s.read({ id: "added" }).then((p) => p.title, () => "");
      }
      expect(found).toBe("Added later"); // only the re-created watcher can mark this dirty
    } finally {
      s.close();
    }
  });

  // macOS drops events for writes made while a watch stream is still starting: 3 of 20 such
  // writes were never reported. Fake timers, and a test that never yields to the event loop,
  // keep any real event out of it, so only the settle reload can surface the page.
  it("finds a page written while the watcher was starting, once the watcher settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const repo = makeRepo(INDEX);
    cleanups.push(repo.cleanup);
    const s = new KnowledgeService(repo.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    try {
      s.watch();
      writeFileSync(join(repo.root, "knowledge/racing.md"), page({ id: "racing", title: "Written at start" }));
      vi.advanceTimersByTime(WATCH_SETTLE_MS - 1);
      expect((s as unknown as { dirty: boolean }).dirty).toBe(false);
      vi.advanceTimersByTime(1);
      expect((await s.read({ id: "racing" })).title).toBe("Written at start");
    } finally {
      s.close();
      vi.useRealTimers();
    }
  });

  it("cancels the settle reload when the watcher closes", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const repo = makeRepo(INDEX);
    cleanups.push(repo.cleanup);
    const s = new KnowledgeService(repo.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    try {
      s.watch();
      s.close();
      vi.advanceTimersByTime(WATCH_SETTLE_MS);
      expect((s as unknown as { dirty: boolean }).dirty).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
