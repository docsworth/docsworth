import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuditEvent, AuditLog, type AuditSink } from "../src/core/audit-log.js";
import { loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityProvider, LOCAL_IDENTITY } from "../src/core/identity.js";
import { auditTransport } from "../src/core/mcp/audit-transport.js";
import { createMcpServer } from "../src/core/mcp/server.js";
import { lintRepo } from "../src/core/lint.js";
import { buildNewPage } from "../src/core/new-page.js";
import { isPage, loadRepo, parsePage } from "../src/core/repo.js";
import { KnowledgeService, ToolError } from "../src/core/service.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, copyAcme, fixedIdentity, NOW } from "./helpers.js";

let acme: ReturnType<typeof acmeOnGitHub>;
let gh: FakeGitHub;
beforeEach(() => {
  acme = acmeOnGitHub();
  gh = new FakeGitHub(
    "acme/knowledge",
    "acme",
    {
      alice: { login: "alice", teams: ["platform"], push: true },
      pat: { login: "pat", teams: ["payments"], push: true },
      riley: { login: "riley", teams: ["sre"], push: true },
      sam: { login: "sam", teams: ["security"], push: true },
      viewer: { login: "viewer", teams: ["platform"], push: false },
    },
    acme.root,
  );
});
afterEach(() => {
  acme.cleanup();
  // No test here may ever write to the default branch.
  expect(gh.violations).toEqual([]);
});

const service = (token: string, fetch = gh.fetch) =>
  new KnowledgeService(acme.root, new IdentityProvider(loadConfig(acme.root), new GitHubClient(token, { fetch })), () => NOW);
const suffixes = (s: KnowledgeService, ...xs: string[]) => {
  let i = 0;
  Object.assign(s, { draftSuffix: () => xs[Math.min(i++, xs.length - 1)]! });
  return s;
};
const DRAFT = { type: "runbook", title: "Drain a Kafka partition", owner_team: "platform", body: "# Drain a Kafka partition\n\n## Steps\n\n1. Pause the consumer.\n", reason: "From the INC-412 thread." } as const;
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as ToolError);

describe("draft_page: a new page as a draft PR (R8)", () => {
  it("names the page itself, opens a draft PR from a docsworth/draft/ branch, and leaves main untouched", async () => {
    const r = await service("alice").draftPage(DRAFT);
    expect(r.id).toMatch(/^rb-drain-a-kafka-partition-[0-9a-f]{12}$/);
    expect(r.path).toBe(`knowledge/runbooks/${r.id.slice(3)}.md`);
    expect(r.branch).toMatch(new RegExp(`^docsworth/draft/${r.id}-\\d{8}T\\d{6}-[0-9a-f]{6}$`));
    expect(gh.file(r.path)).toBeUndefined();
    const page = parsePage(r.path, gh.file(r.path, r.branch)!);
    expect(isPage(page) && page).toMatchObject({ id: r.id, title: DRAFT.title, type: "runbook", status: "draft", owner_team: "platform", last_verified: "2026-11-02", review_every: "90d", acl: "internal" });
    expect(gh.pulls[0]).toMatchObject({ head: r.branch, base: "main", title: "Draft: Drain a Kafka partition", draft: true });
    expect(gh.pulls[0]?.body).toMatch(/From the INC-412 thread[\s\S]*on behalf of @alice/);
  });

  it("gives two drafts with the same title different, unguessable names", async () => {
    const a = await service("alice").draftPage(DRAFT);
    const b = await service("alice").draftPage(DRAFT);
    expect(a.id).not.toBe(b.id);
    expect(a.path).not.toBe(b.path);
  });

  it("follows CODEOWNERS rules on file names: a payments runbook lands where payments owns", async () => {
    const r = await service("pat").draftPage({ ...DRAFT, title: "Payments refund delay", owner_team: "payments" });
    expect(r.path).toMatch(/^knowledge\/runbooks\/payments-refund-delay-[0-9a-f]{12}\.md$/);
  });

  describe("CODEOWNERS prefix routing: a `<team>-` name where the directory is another team's", () => {
    it.each([
      ["pat", "payments"],
      ["riley", "sre"],
    ])("%s drafts a %s runbook into runbooks/, named so CODEOWNERS gives it to that team, and it lints there", async (token, team) => {
      const r = await service(token).draftPage({ ...DRAFT, owner_team: team });
      expect(r.id).toMatch(new RegExp(`^rb-${team}-drain-a-kafka-partition-[0-9a-f]{12}$`));
      expect(r.path).toBe(`knowledge/runbooks/${r.id.slice(3)}.md`);
      expect(gh.file(r.path)).toBeUndefined();
      expect(gh.pulls[0]).toMatchObject({ head: r.branch, base: "main", draft: true });
      // The file from the PR branch, written into the repo, lints clean where it landed.
      writeFileSync(join(acme.root, r.path), gh.file(r.path, r.branch)!);
      const repo = loadRepo(acme.root);
      expect(repo.byId.get(r.id)).toMatchObject({ owner_team: team, status: "draft" });
      expect(lintRepo(repo, NOW).diagnostics.filter((d) => d.path === r.path && d.severity === "error")).toEqual([]);
    });

    it("keeps the plain name where it already works: no prefix for the directory's own team or a title that starts with the team", async () => {
      expect((await service("alice").draftPage(DRAFT)).path).toMatch(/^knowledge\/runbooks\/drain-a-kafka-partition-[0-9a-f]{12}\.md$/);
      expect((await service("pat").draftPage({ ...DRAFT, title: "Payments: drain a partition", owner_team: "payments" })).path).toMatch(/^knowledge\/runbooks\/payments-drain-a-partition-[0-9a-f]{12}\.md$/);
    });

    it("retries a taken `<team>-` name with a fresh one, and never names it", async () => {
      writeFileSync(join(acme.root, "knowledge/runbooks/payments-drain-a-kafka-partition-aaaaaaaaaaaa.md"), readFileSync(join(acme.root, "knowledge/runbooks/flush-cdn-cache.md"), "utf8").replace("id: rb-flush-cdn", "id: rb-other"));
      const s = suffixes(service("pat"), "aaaaaaaaaaaa", "bbbbbbbbbbbb");
      const r = await s.draftPage({ ...DRAFT, owner_team: "payments" });
      expect(r.id).toBe("rb-payments-drain-a-kafka-partition-bbbbbbbbbbbb");
    });
  });

  it("notes where the content came from, as an autolink", async () => {
    const r = await service("alice").draftPage({ ...DRAFT, source_url: "https://mail.google.com/mail/u/0/#inbox/FMfcg" });
    expect(gh.file(r.path, r.branch)).toContain("> Captured from <https://mail.google.com/mail/u/0/#inbox/FMfcg> on 2026-11-02. Review it before merging.");
  });

  it("normalizes a source URL into one autolink, so it can't add markdown of its own", async () => {
    const r = await service("alice").draftPage({ ...DRAFT, source_url: "https://x.example/a> [click](https://evil.example)" });
    expect(gh.file(r.path, r.branch)).toContain("> Captured from <https://x.example/a%3E%20[click](https://evil.example)> on 2026-11-02.");
  });

  it.each([
    ["key: value"],
    ["- item"],
    ['"quoted" and \'single\''],
    ["#hash and ---"],
    ["{a: 1} [x, y]"],
    ["&anchor *alias !tag"],
    ["| > % @ `"],
    ["yes"],
    ["null"],
    ["2026-11-02"],
    ["0x1F"],
  ])("serializes a YAML-looking title or description (%s) so it parses back as given", async (value) => {
    const r = await service("alice").draftPage({ ...DRAFT, title: value, description: value });
    const page = parsePage(r.path, gh.file(r.path, r.branch)!);
    expect(isPage(page)).toBe(true);
    expect(isPage(page) && [page.title, page.description, page.status, page.owner_team]).toEqual([value, value, "draft", "platform"]);
  });

  describe("refusals, each with its own code and words", () => {
    it("in local mode", async () => {
      const local = copyAcme();
      try {
        const s = new KnowledgeService(local.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
        expect(await rejection(s.draftPage(DRAFT))).toMatchObject({ code: "unavailable", message: "writes need github.repo in .knowledge/config.yaml and a GitHub token" });
      } finally {
        local.cleanup();
      }
    });

    it("when the policy refuses draft_page, or writes", async () => {
      const cfg = join(acme.root, ".knowledge/config.yaml");
      const original = readFileSync(cfg, "utf8");
      writeFileSync(cfg, `${original}\npolicy:\n  tools:\n    draft_page: { teams: [] }\n`);
      expect(await rejection(service("alice").draftPage(DRAFT))).toMatchObject({ code: "forbidden", message: "policy disables `draft_page` for everyone" });
      writeFileSync(cfg, `${original}\npolicy:\n  writes: disabled\n`);
      expect(await rejection(service("alice").draftPage(DRAFT))).toMatchObject({ code: "forbidden", message: "writes are disabled by policy (policy.writes in .knowledge/config.yaml)" });
      expect(gh.pulls).toHaveLength(0);
    });

    it("without push access", async () => {
      expect(await rejection(service("viewer").draftPage(DRAFT))).toMatchObject({ code: "forbidden", message: "your token has no push access to acme/knowledge" });
    });

    it("when CODEOWNERS gives the directory to another team and routes no `<team>-` names there, naming the directory and the prefix, not the page", async () => {
      const e = await rejection(service("sam").draftPage({ ...DRAFT, owner_team: "security" }));
      expect(e).toMatchObject({ code: "invalid", message: "CODEOWNERS assigns @acme/platform there (knowledge/runbooks/) and doesn't give @acme/security `knowledge/runbooks/security-*`; give a `dir` that @acme/security owns" });
      expect(gh.pulls).toHaveLength(0);
    });

    it("when the session read pages for a narrower audience", async () => {
      const s = service("sam");
      await s.read({ id: "pol-secrets" });
      const e = await rejection(s.draftPage({ ...DRAFT, owner_team: "platform" }));
      expect(e).toMatchObject({ code: "forbidden", message: "this session read pages restricted to @acme/security; draft_page can only create pages with the same audience (this one would be `internal`)" });
      expect(gh.requests.filter((q) => q.path.includes("/contents/"))).toHaveLength(0); // refused before GitHub was asked about the file
    });

    it("for an audience the caller isn't in", async () => {
      expect(await rejection(service("alice").draftPage({ ...DRAFT, acl: "security" }))).toMatchObject({ code: "forbidden", message: "a new page's `acl` must be `internal` or a team you're on, not `security`" });
    });

    it.each([
      [{ type: "adr" }, "`type` must be runbook, service, guide or policy; ADRs are written by hand"],
      [{ dir: "../outside" }, "`dir` must be a relative path under knowledge/ without . or .. segments"],
      [{ dir: "/etc" }, "`dir` must be a relative path under knowledge/ without . or .. segments"],
      [{ dir: "runbooks/./x" }, "`dir` must be a relative path under knowledge/ without . or .. segments"],
      [{ title: "two\nlines" }, "`title` must be one line of 1 to 200 characters"],
      [{ title: "x".repeat(201) }, "`title` must be one line of 1 to 200 characters"],
      [{ description: "d".repeat(281) }, "`description` must be one line of 1 to 280 characters"],
      [{ description: "a b" }, "`description` must be one line of 1 to 280 characters"],
      [{ source_url: "javascript:alert(1)" }, "`source_url` must be an http or https URL"],
      [{ source_url: "ftp://files.example/x" }, "`source_url` must be an http or https URL"],
      [{ body: "   " }, "`body` is empty"],
      [{ reason: " " }, "a reason is required"],
    ])("for bad input %o", async (bad, message) => {
      expect(await rejection(service("alice").draftPage({ ...DRAFT, ...(bad as object) } as never))).toMatchObject({ code: "invalid", message });
      expect(gh.pulls).toHaveLength(0);
    });
  });

  describe("name collisions: retried with a fresh name, never named", () => {
    it("retries when the id is taken in the repo, then succeeds", async () => {
      // A page already holds the first name (written before the service loads the repo).
      const taken = join(acme.root, "knowledge/runbooks/drain-a-kafka-partition-old.md");
      writeFileSync(taken, readFileSync(join(acme.root, "knowledge/runbooks/flush-cdn-cache.md"), "utf8").replace("id: rb-flush-cdn", "id: rb-drain-a-kafka-partition-aaaaaaaaaaaa"));
      const s = suffixes(service("alice"), "aaaaaaaaaaaa", "bbbbbbbbbbbb");
      const r = await s.draftPage(DRAFT);
      expect(r.id).toBe("rb-drain-a-kafka-partition-bbbbbbbbbbbb");
    });

    it("gives up after three taken names with an error that names none of them", async () => {
      // This time the path is taken (by a page with another id).
      writeFileSync(join(acme.root, "knowledge/runbooks/drain-a-kafka-partition-aaaaaaaaaaaa.md"), readFileSync(join(acme.root, "knowledge/runbooks/flush-cdn-cache.md"), "utf8").replace("id: rb-flush-cdn", "id: rb-other"));
      const s = suffixes(service("alice"), "aaaaaaaaaaaa");
      const e = await rejection(s.draftPage(DRAFT));
      expect(JSON.stringify(e)).not.toContain("aaaaaaaaaaaa");
      expect(e).toMatchObject({ code: "unavailable", message: "couldn't find a free name for the new page; try again" });
    });

    it("retries when GitHub already has the path on the default branch", async () => {
      let claimed = 0;
      const fetch: typeof gh.fetch = async (url, init) => {
        const u = String(url);
        // The first two names "exist" on main.
        if ((init?.method ?? "GET") === "GET" && /\/contents\/knowledge\/runbooks\/drain-a-kafka-partition-/.test(u) && claimed < 2) {
          claimed++;
          return new Response(JSON.stringify({ path: "x", sha: "s", encoding: "base64", content: "" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return gh.fetch(url, init);
      };
      const s = suffixes(service("alice", fetch), "aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc");
      const r = await s.draftPage(DRAFT);
      expect(r.id).toBe("rb-drain-a-kafka-partition-cccccccccccc");
      expect(claimed).toBe(2);
    });
  });

  it("builds pages through core's builder, which reports a taken id or path instead of throwing", () => {
    const repo = loadRepo(acme.root);
    const base = { type: "runbook" as const, title: "T", ownerTeam: "platform", status: "draft" as const, body: "x\n", now: NOW };
    expect(buildNewPage(repo, { ...base, id: "rb-deploy-prod", slug: "fresh" })).toEqual({ ok: false, problem: { kind: "id_taken", path: "knowledge/runbooks/deploy-production.md" } });
    expect(buildNewPage(repo, { ...base, id: "rb-fresh", slug: "deploy-production" })).toEqual({ ok: false, problem: { kind: "path_taken", path: "knowledge/runbooks/deploy-production.md" } });
    // A page that wouldn't lint is reported, not built.
    const bad = buildNewPage(repo, { ...base, id: "rb-fresh", slug: "fresh", reviewEvery: "soon" });
    expect(bad).toMatchObject({ ok: false, problem: { kind: "invalid", issues: [expect.stringMatching(/review_every/)] } });
  });
});

describe("ui_capabilities and the write tools", () => {
  it("lists the write tools the policy allows, and says writes are off when it allows none", async () => {
    expect(await service("alice").uiCapabilities()).toMatchObject({ mode: "github", writes: true, write_tools: ["draft_page", "propose_edit", "verify"] });
    const cfg = join(acme.root, ".knowledge/config.yaml");
    const original = readFileSync(cfg, "utf8");
    writeFileSync(cfg, `${original}\npolicy:\n  tools:\n    draft_page: { teams: [] }\n`);
    expect(await service("alice").uiCapabilities()).toMatchObject({ writes: true, write_tools: ["propose_edit", "verify"] });
    writeFileSync(cfg, `${original}\npolicy:\n  tools:\n    draft_page: { teams: [] }\n    propose_edit: { teams: [] }\n    verify: { teams: [] }\n`);
    const none = await service("alice").uiCapabilities();
    expect(none).toMatchObject({ writes: false, write_tools: [], writes_off: "the policy allows you none of the write tools" });
    expect(await service("viewer").uiCapabilities()).toMatchObject({ writes: false, write_tools: [], writes_off: "your token has no push access to acme/knowledge" });
  });
});

describe("propose_edit append (R9)", () => {
  it("adds to the end of the page as it is on the default branch", async () => {
    const path = "knowledge/runbooks/deploy-production.md";
    const before = gh.file(path)!;
    const r = await service("alice").proposeEdit({ id: "rb-deploy-prod", append: "## Seen in INC-412\n\nThe canary stalled at 25%.", reason: "postmortem" });
    expect(gh.file(path)).toBe(before);
    expect(gh.file(path, r.branch)).toBe(`${before.replace(/\s*$/, "")}\n\n## Seen in INC-412\n\nThe canary stalled at 25%.\n`);
    expect(gh.pulls[0]?.title).toBe("Proposed addition: Deploy to production");
  });

  it("works on a page with links the caller can't see, and leaves those links as they are", async () => {
    const path = "knowledge/services/payments/index.md";
    const s = service("alice");
    expect((await s.read({ id: "svc-payments" })).content).toContain("[restricted page]");
    // A whole new body from the redacted view is refused there...
    expect(await rejection(s.proposeEdit({ id: "svc-payments", body: "x", reason: "r" }))).toMatchObject({ code: "invalid" });
    // ...but an addition is not, and the hidden link survives in the PR.
    const before = gh.file(path)!;
    const r = await s.proposeEdit({ id: "svc-payments", append: "## Contacts\n\n#payments-oncall", reason: "r" });
    expect(gh.file(path, r.branch)).toBe(`${before.replace(/\s*$/, "")}\n\n## Contacts\n\n#payments-oncall\n`);
    expect(gh.file(path, r.branch)).toContain("ledger");
  });

  it("doesn't overwrite a change made on the default branch after the page was read", async () => {
    const path = "knowledge/runbooks/deploy-production.md";
    const s = service("alice");
    await s.read({ id: "rb-deploy-prod" });
    const changed = `${gh.file(path)!}\nA line someone merged meanwhile.\n`;
    gh.branches.get("main")!.set(path, { content: changed, sha: "newsha" });
    const r = await s.proposeEdit({ id: "rb-deploy-prod", append: "Added.", reason: "r" });
    expect(gh.file(path, r.branch)).toBe(`${changed.replace(/\s*$/, "")}\n\nAdded.\n`);
  });

  it.each([
    [{ append: "  " }, "`append` is empty"],
    [{ append: "x", polish: true }, "an `append` adds text, so it can't be a polish"],
    [{ append: "see [restricted page]" }, "`append` contains `[restricted page]`, which `read` shows in place of a link you can't see; leave it out"],
    [{ append: "x", body: "y" }, "give exactly one of `edits`, `body`, `content` or `append`"],
  ])("refuses %o", async (bad, message) => {
    expect(await rejection(service("alice").proposeEdit({ id: "rb-deploy-prod", reason: "r", ...(bad as object) }))).toMatchObject({ code: "invalid", message });
    expect(gh.pulls).toHaveLength(0);
  });
});

describe("draft_page in the audit log", () => {
  class MemorySink implements AuditSink {
    readonly name = "memory";
    readonly required = true;
    readonly events: AuditEvent[] = [];
    async write(e: AuditEvent): Promise<void> {
      this.events.push(e);
    }
  }

  it("records the intent without an id (the server picks it), and the id from the response", async () => {
    const sink = new MemorySink();
    const audit = new AuditLog([sink], { session: "s", server: { version: "test", repo: "acme/knowledge", commit: null } }, () => NOW, () => {});
    const s = service("alice");
    const identity = new IdentityProvider(loadConfig(acme.root), new GitHubClient("alice", { fetch: gh.fetch }));
    const [c, sv] = InMemoryTransport.createLinkedPair();
    await createMcpServer(s).connect(auditTransport(sv, audit, () => identity.get(), { includeQueries: false, log: () => {}, known: () => s.knownValues(), snapshot: () => s.snapshot() }));
    const client = new Client({ name: "agent", version: "1" });
    await client.connect(c);
    const r = await client.callTool({ name: "draft_page", arguments: { ...DRAFT, acl: "internal", draft: true } });
    const id = (r.structuredContent as { id: string }).id;
    const intent = sink.events.find((e) => e.kind === "tool_intent");
    expect(intent).toMatchObject({ tool: "draft_page", args: { type: "runbook", owner_team: "platform", acl: "internal", draft: true } });
    expect(JSON.stringify(intent)).not.toContain(DRAFT.title);
    const done = sink.events.find((e) => e.kind === "tool_call");
    expect(done).toMatchObject({ tool: "draft_page", outcome: "ok", returned: [id], pr_url: expect.stringMatching(/\/pull\/1$/) });
    await client.close();
  });
});
