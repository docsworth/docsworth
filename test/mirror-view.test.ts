import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canSee, type Identity, RESTRICTED } from "../src/core/acl.js";
import { GitHubClient } from "../src/core/github.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { MIRRORED_NOTE } from "../src/core/mcp/text.js";
import { type MirrorPage, redactMirror, tinyId } from "../src/core/mirror-view.js";
import { KnowledgeService, MIRROR_LIMIT } from "../src/core/service.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, NOW } from "./helpers.js";
import { ALL_SPACES, ENG_OTHER, ENG_PAGE, mirrorPage, PAY_PAGE, SEC_PAGE, serveMirror, writeMirror } from "./mirror-helpers.js";

// v0.2 L2: mirrored pages served to agents as non-citable context, behind mirror.serve,
// to exactly the audience their space's acl allows.

let acme: ReturnType<typeof acmeOnGitHub>;
let gh: FakeGitHub;
beforeEach(async () => {
  acme = acmeOnGitHub();
  await writeMirror(acme.root, ALL_SPACES);
  gh = new FakeGitHub("acme/knowledge", "acme", { tok: { login: "u", teams: [], push: true } }, acme.root);
});
afterEach(() => {
  acme.cleanup();
  expect(gh.violations).toEqual([]);
});

const user = (login: string, teams: string[]): Identity => ({ mode: "github", login, teams: new Set(teams), repoAccess: true, canWrite: true });
const service = (who: Identity) => new KnowledgeService(acme.root, { get: async () => who, fresh: async () => who, github: new GitHubClient("tok", { fetch: gh.fetch }) }, () => NOW);
const settle = (p: Promise<unknown>) => p.catch((e: { code?: string; message: string }) => ({ error: `${e.code}: ${e.message}` }));

describe("mirror.serve off (the default)", () => {
  it("serves no mirrored page: none in search, and a mirror id reads like an unknown one", async () => {
    const s = service(user("pat", ["platform"]));
    const r = await s.search({ query: "deploy checklist canary jenkins" });
    expect(r).not.toHaveProperty("mirrored");
    expect(JSON.stringify(r)).not.toContain("mirror:");
    const a = (await settle(s.read({ id: ENG_PAGE.id }))) as { error: string };
    const b = (await settle(s.read({ id: "mirror:confluence:ENG:999" }))) as { error: string };
    expect(a.error.replace(ENG_PAGE.id, "X")).toBe(b.error.replace("mirror:confluence:ENG:999", "X"));
    expect(a.error).toMatch(/^not_found: /);
  });
});

describe("mirror.serve on", () => {
  beforeEach(() => serveMirror(acme.root));

  it("lists matching mirrored pages apart from results, never citable, with a note", async () => {
    const r = await service(user("pat", ["platform"])).search({ query: "deploy checklist canary jenkins" });
    expect(r.mirrored?.map((m) => m.id)).toEqual([ENG_PAGE.id, ENG_OTHER.id]);
    expect(r.mirrored?.every((m) => m.citable === false)).toBe(true);
    expect(r.mirrored?.[0]).toMatchObject({ title: ENG_PAGE.title, source: "confluence", source_url: ENG_PAGE.url, owner_team: "platform", last_edited: ENG_PAGE.last_edited });
    expect(r.results.some((p) => p.id.startsWith("mirror:"))).toBe(false);
    expect(r.note).toContain(MIRRORED_NOTE);
  });

  it("caps the list, and leaves it out when the filters are page-only", async () => {
    const many = Array.from({ length: 6 }, (_, i) => mirrorPage("ENG", String(200 + i), `Canary note ${i}`, "canary canary rollout"));
    await writeMirror(acme.root, { ENG: [...ALL_SPACES.ENG, ...many] });
    const s = service(user("pat", ["platform"]));
    expect((await s.search({ query: "canary rollout" })).mirrored).toHaveLength(MIRROR_LIMIT);
    expect(await s.search({ query: "canary rollout", type: "runbook" })).not.toHaveProperty("mirrored");
    expect((await s.search({ query: "canary rollout", owner_team: "platform" })).mirrored?.map((m) => m.id)).toEqual([ENG_PAGE.id]);
  });

  it("reads a mirrored page as context: citable false, flagged, with its source", async () => {
    const r = await service(user("pat", ["platform"])).read({ id: ENG_OTHER.id });
    expect(r).toMatchObject({ id: ENG_OTHER.id, citable: false, flags: ["mirrored"], source_url: ENG_OTHER.url, content: ENG_OTHER.markdown });
    expect((r as { gate_reason: string }).gate_reason).toMatch(/^mirrored from Confluence/);
  });

  it("serves a team space only to that team, and redacts links to it from pages others can see", async () => {
    const pat = service(user("pat", ["platform"]));
    const seen = (await pat.search({ query: "payroll key rotation vault" })).mirrored ?? [];
    expect(seen.map((m) => m.id)).not.toContain(SEC_PAGE.id);
    expect(JSON.stringify(seen)).not.toContain("Payroll key rotation");
    const eng = (await pat.read({ id: ENG_PAGE.id })) as { content: string };
    expect(eng.content).toBe(`Before a deploy, check the canary dashboard and the Jenkins job. For keys see ${RESTRICTED}, ${RESTRICTED} or ${RESTRICTED} directly.`);
    const sam = service(user("sam", ["security"]));
    expect((await sam.search({ query: "payroll key rotation vault" })).mirrored?.map((m) => m.id)[0]).toBe(SEC_PAGE.id);
    expect(((await sam.read({ id: ENG_PAGE.id })) as { content: string }).content).toBe(ENG_PAGE.markdown);
  });

  it("redacts every form of link to a hidden mirrored page (review round 1)", async () => {
    const forms = mirrorPage(
      "ENG",
      "150",
      "Link forms",
      [
        `[Payroll key rotation](${SEC_PAGE.url} 'legacy')`,
        `[Payroll key rotation](${SEC_PAGE.url} (legacy))`,
        `See ${SEC_PAGE.url.replace("https://acme.atlassian.net", "HTTPS://ACME.ATLASSIAN.NET")}, then continue.`,
        "And _Payroll key rotation_ by native id.",
        `[Payroll \\] key](${SEC_PAGE.url}) and [nested [Payroll] key](${SEC_PAGE.url} "Payroll key rotation") then [visible](https://example.com/ok).`,
        "[rel](/wiki/spaces/SEC/pages/900/Payroll+key+rotation) [noslug](https://acme.atlassian.net/wiki/spaces/SEC/pages/900) [old](https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=900)",
        "Bare: /wiki/spaces/SEC/pages/900/Payroll+key+rotation and https://acme.atlassian.net/wiki/spaces/SEC/pages/900 and /wiki/pages/viewpage.action?pageId=900.",
        `Ref: [Payroll key rotation][sec], [sec][] and [sec].\n\n[sec]: ${SEC_PAGE.url} "Payroll key rotation"`,
      ].join("\n\n"),
      { links_to: [SEC_PAGE.native_id] },
    );
    await writeMirror(acme.root, { ...ALL_SPACES, ENG: [...ALL_SPACES.ENG, forms] });
    const { content } = (await service(user("pat", ["platform"])).read({ id: forms.id })) as { content: string };
    expect(content).toBe(
      `${RESTRICTED}\n\n${RESTRICTED}\n\nSee ${RESTRICTED}, then continue.\n\nAnd ${RESTRICTED} by native id.\n\n${RESTRICTED} and ${RESTRICTED} then [visible](https://example.com/ok).\n\n${RESTRICTED} ${RESTRICTED} ${RESTRICTED}\n\nBare: ${RESTRICTED} and ${RESTRICTED} and ${RESTRICTED}.\n\nRef: ${RESTRICTED}, ${RESTRICTED} and ${RESTRICTED}.\n\n`,
    );
  });

  it("redacts a repo page's links to mirrored pages the reader can't see (merge gate, PR 5, round 4)", async () => {
    const path = join(acme.root, "knowledge/runbooks/deploy-production.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("## Checks", `Keys: [Payroll key rotation](${SEC_PAGE.url}), or ${SEC_PAGE.url}.\n\n## Checks`));
    const pat = service(user("pat", ["platform"]));
    const seen = (await pat.read({ id: "rb-deploy-prod" })) as { content: string };
    expect(seen.content).toContain(`Keys: ${RESTRICTED}, or ${RESTRICTED}.`);
    expect(seen.content).not.toContain("Payroll");
    const hits = await pat.search({ query: "keys payroll rotation deploy production", include_stale: true });
    expect(JSON.stringify(hits)).not.toContain("SEC/pages/900");
    expect(JSON.stringify(hits)).not.toContain("Payroll key rotation");
    // Nor does the hidden link's text rank the page: "payroll" appears nowhere else in it.
    const ranked = await pat.search({ query: "payroll", include_stale: true });
    expect([...ranked.results, ...ranked.excluded].map((p) => p.id)).not.toContain("rb-deploy-prod");
    const sam = service(user("sam", ["security"]));
    expect(((await sam.read({ id: "rb-deploy-prod" })) as { content: string }).content).toContain(SEC_PAGE.url);
  });

  it("taints the session after a team space's page, like a team page", async () => {
    const sam = service(user("sam", ["security"]));
    await sam.read({ id: SEC_PAGE.id });
    await expect(sam.proposeEdit({ id: "rb-deploy-prod", edits: [{ old: "30 minutes", new: "45 minutes" }], reason: "r" })).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringMatching(/^this session read pages restricted to @acme\/security/),
    });
  });

  it("taints the session after a team space's page shows in search", async () => {
    const sam = service(user("sam", ["security"]));
    const r = await sam.search({ query: "payroll quarter" });
    expect(r.mirrored?.map((m) => m.id)).toContain(SEC_PAGE.id);
    // Nothing else in the response is a security page, so only the mirrored hit can taint.
    expect([...r.results, ...r.excluded].map((p) => p.id)).toEqual([]);
    await expect(sam.proposeEdit({ id: "rb-deploy-prod", edits: [{ old: "30 minutes", new: "45 minutes" }], reason: "r" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("serves only files a mirror run of this user's wrote, unchanged", async () => {
    const dir = join(acme.root, ".knowledge/mirror/confluence/eng");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "planted--1.md"), `---\nmirror: {id: "mirror:confluence:ENG:666", title: Planted canary page, acl: internal, url: x, links_to: []}\n---\ncanary canary`);
    const r = await service(user("pat", ["platform"])).search({ query: "planted canary page" });
    expect(JSON.stringify(r)).not.toContain("mirror:confluence:ENG:666");
  });

  it("stops serving a recorded file once it changes after its run", async () => {
    const file = join(acme.root, ".knowledge/mirror/confluence/eng", readdirSync(join(acme.root, ".knowledge/mirror/confluence/eng")).find((f) => f.includes("101"))!);
    writeFileSync(file, readFileSync(file, "utf8").replace("Before a deploy", "injected-secret Before a deploy"));
    const s = service(user("pat", ["platform"]));
    expect(JSON.stringify(await s.search({ query: "injected-secret" }))).not.toContain("injected-secret");
    await expect(s.read({ id: ENG_PAGE.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("stops serving a page whose file is edited or deleted after the server loaded it (merge gate, PR 5)", async () => {
    const s = service(user("pat", ["platform"]));
    expect((await s.search({ query: "deploy checklist canary jenkins" })).mirrored?.map((m) => m.id)).toContain(ENG_PAGE.id);
    await s.read({ id: ENG_OTHER.id });
    const dir = join(acme.root, ".knowledge/mirror/confluence/eng");
    const file = (native: string) => join(dir, readdirSync(dir).find((f) => f.includes(native))!);
    writeFileSync(file("101"), readFileSync(file("101"), "utf8").replace("Before a deploy", "Edited after loading. Before a deploy"));
    rmSync(file("102"));
    for (const id of [ENG_PAGE.id, ENG_OTHER.id]) await expect(s.read({ id })).rejects.toMatchObject({ code: "not_found" });
    const after = await s.search({ query: "deploy checklist canary jenkins rollout" });
    expect(JSON.stringify(after)).not.toContain(ENG_PAGE.id);
    expect(JSON.stringify(after)).not.toContain(ENG_OTHER.id);
  });

  it("drops a page edited after loading from search, before any read reloads the mirror", async () => {
    const s = service(user("pat", ["platform"]));
    expect((await s.search({ query: "deploy checklist canary jenkins" })).mirrored?.map((m) => m.id)).toContain(ENG_PAGE.id);
    const dir = join(acme.root, ".knowledge/mirror/confluence/eng");
    const file = join(dir, readdirSync(dir).find((f) => f.includes("101"))!);
    writeFileSync(file, readFileSync(file, "utf8").replace("Before a deploy", "Edited after loading. Before a deploy"));
    const after = await s.search({ query: "deploy checklist canary jenkins" });
    expect((after.mirrored ?? []).map((m) => m.id)).not.toContain(ENG_PAGE.id);
    expect(JSON.stringify(after)).not.toContain("Edited after loading");
  });

  it("picks up a new mirror run without a restart", async () => {
    const s = service(user("pat", ["platform"]));
    expect((await s.search({ query: "flamingo" })).mirrored ?? []).toEqual([]);
    await new Promise((r) => setTimeout(r, 20)); // a later mtime on the records directory
    await writeMirror(acme.root, { ENG: [...ALL_SPACES.ENG, mirrorPage("ENG", "300", "Flamingo cutover", "flamingo cutover plan")] });
    expect((await s.search({ query: "flamingo" })).mirrored?.map((m) => m.id)).toEqual(["mirror:confluence:ENG:300"]);
  });

  it("refuses a mirror out_dir reached through a symlink to outside the repository", async () => {
    // Real output, written outside the repo, then reached through a symlinked parent.
    const outside = mkdtempSync(join(tmpdir(), "docsworth-outside-"));
    try {
      const cfg = join(acme.root, ".knowledge/config.yaml");
      symlinkSync(outside, join(acme.root, ".knowledge/cache"));
      writeFileSync(cfg, readFileSync(cfg, "utf8").replace("out_dir: .knowledge/mirror\n", "out_dir: .knowledge/cache/mirror\n"));
      await writeMirror(acme.root, { ENG: [ENG_PAGE] }, join(outside, "mirror")); // the run's output, outside
      const warned: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((m: string) => (warned.push(String(m)), true)) as typeof process.stderr.write;
      try {
        expect(await service(user("pat", ["platform"])).search({ query: "deploy checklist canary jenkins" })).not.toHaveProperty("mirrored");
      } finally {
        process.stderr.write = write;
      }
      expect(warned.join("")).toMatch(/mirror\.out_dir \.knowledge\/cache\/mirror resolves outside the repository/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a mirror out_dir outside the repository: no mirrored pages, a warning", async () => {
    const cfg = join(acme.root, ".knowledge/config.yaml");
    const { readFileSync } = await import("node:fs");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("out_dir: .knowledge/mirror\n", "out_dir: ../elsewhere\n"));
    const warned: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((m: string) => (warned.push(String(m)), true)) as typeof process.stderr.write;
    try {
      const r = await service(user("pat", ["platform"])).search({ query: "deploy checklist canary jenkins" });
      expect(r).not.toHaveProperty("mirrored");
    } finally {
      process.stderr.write = write;
    }
    expect(warned.join("")).toMatch(/mirror\.out_dir \.\.\/elsewhere resolves outside the repository; serving no mirrored pages/);
  });
});

describe("redactMirror: a Notion page by id, in any URL form", () => {
  it("redacts every link to a hidden Notion page", () => {
    const id = "0f3c5a1e2b4d4c6e8a9b1c2d3e4f5a6b";
    const hidden = mirrorPage("workspace", id, "Payroll keys", "secret", { source: "notion", id: `mirror:notion:workspace:${id}`, url: `https://www.notion.so/Payroll-keys-${id}` });
    const dashed = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
    const visible = mirrorPage("workspace", "1", "Index", `[a](https://www.notion.so/${id}) [b](https://acme.notion.site/Renamed-${id}?pvs=4) https://www.notion.so/x/${dashed} [c](${id}) [d](/${dashed}) ${id} [ok](https://www.notion.so/Other-${"1".repeat(32)})`, { source: "notion" });
    expect(redactMirror(visible, [hidden], RESTRICTED)).toBe(`${RESTRICTED} ${RESTRICTED} ${RESTRICTED} ${RESTRICTED} ${RESTRICTED} ${RESTRICTED} [ok](https://www.notion.so/Other-${"1".repeat(32)})`);
  });
});

// The ACL matrix (test/acl.test.ts), extended to mirrored spaces: for every identity, no
// response carries a mirrored page it can't see: not its id, title, URL or text.
describe("mirror ACL matrix", () => {
  beforeEach(() => serveMirror(acme.root));
  const ALL: MirrorPage[] = [ENG_PAGE, ENG_OTHER, SEC_PAGE, PAY_PAGE];
  const traces = (m: MirrorPage) => [m.id, m.title, m.url, m.markdown.slice(0, 40)];
  const IDENTITIES: [string, Identity][] = [
    ["local", LOCAL_IDENTITY],
    ["no teams", user("nina", [])],
    ["platform", user("pat", ["platform"])],
    ["security", user("sam", ["security"])],
    ["payments", user("pia", ["payments"])],
    ["no repo access", { mode: "github", login: "eve", teams: new Set(["security", "payments", "platform"]), repoAccess: false, canWrite: true }],
  ];

  it.each(IDENTITIES)("%s: no tool leaks a mirrored page it cannot see", async (_name, who) => {
    const s = who.mode === "local" ? new KnowledgeService(acme.root, { get: async () => who, fresh: async () => who, github: null }, () => NOW) : service(who);
    const hidden = ALL.filter((m) => !canSee(m, who));
    const visible = ALL.filter((m) => canSee(m, who));
    const assertNoTrace = (out: unknown, ctx: string) => {
      const text = JSON.stringify(out);
      for (const m of hidden) for (const t of traces(m)) if (text.includes(t)) throw new Error(`${ctx} leaked \`${t}\` of hidden ${m.id}`);
    };
    for (const m of visible) assertNoTrace(await s.read({ id: m.id }), `read(${m.id})`);
    for (const m of ALL)
      for (const query of [m.title, m.markdown.slice(0, 60), m.id, "canary deploy payroll ledger rotation"])
        assertNoTrace(await settle(s.search({ query })), `search(${query})`);
    for (const m of hidden) {
      const a = (await settle(s.read({ id: m.id }))) as { error: string };
      const b = (await settle(s.read({ id: "mirror:confluence:ZZZ:1" }))) as { error: string };
      expect(a.error.replace(m.id, "X")).toBe(b.error.replace("mirror:confluence:ZZZ:1", "X"));
    }
  });

  it("is not vacuous: each team sees a mirrored page the others can't", () => {
    expect(canSee(SEC_PAGE, user("x", ["security"]))).toBe(true);
    expect(canSee(SEC_PAGE, user("x", ["platform"]))).toBe(false);
    expect(canSee(PAY_PAGE, user("x", ["payments"]))).toBe(true);
    expect(canSee(PAY_PAGE, LOCAL_IDENTITY)).toBe(false);
  });
});

describe("redactHiddenLinks: every form a reader resolves", () => {
  // The same forms as repo links (test/references.test.ts), for a link to a hidden
  // mirrored page: decoded, broken across lines, or as it renders.
  const U = SEC_PAGE.url;
  const notion = mirrorPage("NOT", "0f3a2b4c5d6e7f8091a2b3c4d5e6f708", "Notion keys", "x", { source: "notion", acl: "security", url: "https://www.notion.so/Notion-keys-0f3a2b4c5d6e7f8091a2b3c4d5e6f708" });
  it.each([
    ["a character reference", `[x](${U.replace(/\//g, "&#47;")})`],
    ["percent-encoding", `[x](${U.replace("/pages/", "%2Fpages%2F")})`],
    ["a value broken across lines", `<a href="${U.slice(0, 30)}\n${U.slice(30)}">x</a>`],
    ["markup inside the URL", `see ${U.replace("/pages/900", "/pages/**900**")}`],
    ["an encoded pageId", "see https://acme.atlassian.net/wiki/pages/viewpage.action?pageId&#61;900"],
    ["backslashes", `<img src="${U.replace(/\//g, "\\")}">`],
    ["a tiny link", `see https://acme.atlassian.net/wiki/x/${tinyId("900")} for it`],
    ["a Notion id with markup inside", "see https://www.notion.so/0f3a2b4c-**5d6e**-7f80-91a2-b3c4d5e6f708"],
  ])("%s", (_name, text) => {
    const out = redactMirror(mirrorPage("ENG", "555", "probe", text), [SEC_PAGE, notion], RESTRICTED);
    expect(out).toContain(RESTRICTED);
    expect(out.replace(/\*\*/g, "").replace(/&#47;/g, "/").replace(/%2F/gi, "/").replace(/\\/g, "/")).not.toMatch(/pages\/900|pageId(?:=|&#61;)900|x\/hAM|0f3a2b4c/i);
  });

  it("encodes a tiny link as Confluence does", () => {
    expect(tinyId("900")).toBe("hAM");
    expect(tinyId("98306")).toBe("AoAB");
  });

  it("leaves a link to a visible page alone", () => {
    const text = `see ${ENG_OTHER.url} and https://acme.atlassian.net/wiki/x/${tinyId("101")}`;
    expect(redactMirror(mirrorPage("ENG", "555", "probe", text), [SEC_PAGE, notion], RESTRICTED)).toBe(text);
  });

  it("reads a tiny link's case: `aQ` (page 105) isn't `AQ` (page 1)", () => {
    // Review: compared in lower case, a visible page's tiny link was taken for a hidden one.
    const one = mirrorPage("SEC", "1", "Page one", "x", { acl: "security" });
    expect(tinyId("1")).toBe("AQ");
    expect(tinyId("105")).toBe("aQ");
    const text = "see https://acme.atlassian.net/wiki/x/aQ for it";
    expect(redactMirror(mirrorPage("ENG", "555", "probe", text), [one], RESTRICTED)).toBe(text);
    expect(redactMirror(mirrorPage("ENG", "555", "probe", "see https://acme.atlassian.net/wiki/x/AQ"), [one], RESTRICTED)).toContain(RESTRICTED);
  });
});

describe("redactHiddenLinks: input size", () => {
  it("reads destinations that never close in linear time", () => {
    // Each `](` read to the end of the text: 64 KB of `(]` took 9 s.
    const N = 64 * 1024;
    const fill = (u: string) => u.repeat(Math.ceil(N / u.length)).slice(0, N);
    const best = (text: string) => {
      let ms = Infinity;
      for (let i = 0; i < 3 && ms >= 50; i++) {
        const t0 = performance.now();
        redactMirror(mirrorPage("ENG", "555", "probe", text), [SEC_PAGE], RESTRICTED);
        ms = Math.min(ms, performance.now() - t0);
      }
      return ms;
    };
    const benign = best(fill(`Before a deploy see [the checklist](${ENG_OTHER.url}) first.\n`));
    // And spaces before a definition: two adjacent space runs backtracked (2.3 s).
    // And titles that never close after a link to a hidden page: each was read to the end.
    for (const unit of ["(]", "](", "](<", '](x "', " \t", "> ", "](/pages/900 '", "](/pages/900 ("]) {
      const hostile = best(fill(unit));
      expect(hostile, `${JSON.stringify(unit)}: ${Math.round(hostile)} ms against ${Math.round(benign)} ms`).toBeLessThan(Math.max(250, 10 * benign));
    }
  });
});

describe("redactMirror: an iframe's srcdoc", () => {
  // Merge gate, PR 13, round 9: a srcdoc is a document a browser shows in its own right,
  // so the id sweep reads it as one; there an id split by markup shows whole.
  it.each([
    ['<iframe srcdoc="see /wiki/spaces/SEC/pages/9<b></b>00 now"></iframe>'],
    ['<iframe srcdoc="see /wiki/spaces/SEC/pages/9&lt;b&gt;&lt;/b&gt;00 now"></iframe>'],
  ])("redacts a hidden page's id in %s", (text) => {
    expect(redactMirror(mirrorPage("ENG", "557", "probe", text), [SEC_PAGE], RESTRICTED)).toBe(RESTRICTED);
  });

  // Merge gate, PR 13, round 10: a relative link under a `<base href>` at the wiki's space.
  it("redacts a hidden page's link resolved against a base", () => {
    const text = '<base href="https://acme.atlassian.net/wiki/spaces/SEC/">\n\n[x](pages/900)';
    expect(redactMirror(mirrorPage("ENG", "558", "probe", text), [SEC_PAGE], RESTRICTED)).toBe(`<base href="https://acme.atlassian.net/wiki/spaces/SEC/">\n\n${RESTRICTED}`);
  });
});
