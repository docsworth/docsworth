import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityProvider } from "../src/core/identity.js";
import { KnowledgeService } from "../src/core/service.js";
import { applyEdits, setLastVerified } from "../src/core/writes.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, NOW } from "./helpers.js";

let acme: ReturnType<typeof acmeOnGitHub>;
let gh: FakeGitHub;
beforeEach(() => {
  acme = acmeOnGitHub();
  gh = new FakeGitHub(
    "acme/knowledge",
    "acme",
    {
      alice: { login: "alice", teams: ["platform"], push: true },
      sam: { login: "sam", teams: ["security"], push: true },
      viewer: { login: "viewer", teams: ["platform"], push: false },
    },
    acme.root,
  );
});
afterEach(() => {
  acme.cleanup();
  // R13: no test in this file may ever produce a default-branch write.
  expect(gh.violations).toEqual([]);
});

const service = (token: string) =>
  new KnowledgeService(acme.root, new IdentityProvider(loadConfig(acme.root), new GitHubClient(token, { fetch: gh.fetch })), () => NOW);
const DEPLOY = "knowledge/runbooks/deploy-production.md";

describe("propose_edit: R13 PR-only writes", () => {
  it("opens a PR from a fresh docsworth/ branch and leaves main untouched", async () => {
    const before = gh.file(DEPLOY);
    const r = await service("alice").proposeEdit({
      id: "rb-deploy-prod",
      edits: [{ old: "for at least 30 minutes", new: "for at least 45 minutes" }],
      reason: "Staging soak time was raised to 45 minutes in October.",
    });
    expect(r.branch).toMatch(/^docsworth\/propose\/rb-deploy-prod-\d{8}T\d{6}-[0-9a-f]{6}$/);
    expect(r.pr_url).toBe("https://github.com/acme/knowledge/pull/1");
    expect(gh.file(DEPLOY)).toBe(before);
    expect(gh.file(DEPLOY, r.branch)).toContain("for at least 45 minutes");
    expect(gh.pulls[0]).toMatchObject({ head: r.branch, base: "main", title: "Proposed edit: Deploy to production" });
    expect(gh.pulls[0]?.body).toMatch(/Staging soak time[\s\S]*on behalf of @alice/);
  });

  it("puts to exactly the branch it created", async () => {
    await service("alice").proposeEdit({ id: "rb-deploy-prod", edits: [{ old: "30 minutes", new: "45 minutes" }], reason: "r" });
    const created = gh.requests.find((q) => q.method === "POST" && q.path.endsWith("/git/refs"))?.body as { ref: string };
    const put = gh.requests.find((q) => q.method === "PUT")?.body as { branch: string };
    expect(created.ref).toBe(`refs/heads/${put.branch}`);
  });

  it.each([
    [[{ old: "this text is not on the page", new: "x" }], /not found/],
    [[{ old: "shipyard", new: "x" }], /more than once/],
    [[], /no edits/],
  ])("rejects bad edits %j without creating a branch", async (edits, message) => {
    await expect(service("alice").proposeEdit({ id: "rb-deploy-prod", edits, reason: "r" })).rejects.toThrow(message);
    expect(gh.createdBranches.size).toBe(0);
  });

  it.each(["owner_team: platform", "acl: internal", "last_verified: 2026-10-15", "id: rb-deploy-prod"])(
    "refuses to change the protected field `%s`",
    async (line) => {
      const [field] = line.split(":");
      const current = gh.file(DEPLOY)!;
      const tampered = current.includes(line)
        ? current.replace(line, `${field}: changed`)
        : current.replace("review_every: 90d", `review_every: 90d\n${field}: security`);
      await expect(service("alice").proposeEdit({ id: "rb-deploy-prod", content: tampered, reason: "r" })).rejects.toThrow(
        new RegExp(`may not change \`${field}\``),
      );
    },
  );

  it("requires exactly one of edits, body or content, and a reason", async () => {
    await expect(service("alice").proposeEdit({ id: "rb-deploy-prod", body: "x", content: "x", reason: "r" })).rejects.toThrow("give exactly one of `edits`, `body`, `content` or `append`");
    await expect(service("alice").proposeEdit({ id: "rb-deploy-prod", reason: "r" })).rejects.toMatchObject({ code: "invalid" });
    await expect(service("alice").proposeEdit({ id: "rb-deploy-prod", content: "x", edits: [], reason: "r" })).rejects.toMatchObject({ code: "invalid" });
    await expect(service("alice").proposeEdit({ id: "rb-deploy-prod", content: "x", reason: " " })).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses callers without push access", async () => {
    await expect(service("viewer").proposeEdit({ id: "rb-deploy-prod", content: "x", reason: "r" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("answers hidden pages exactly like unknown ones", async () => {
    const hidden = await service("alice").proposeEdit({ id: "rb-rotate-db-creds", content: "x", reason: "r" }).catch((e: Error) => e.message);
    const unknown = await service("alice").proposeEdit({ id: "nope", content: "x", reason: "r" }).catch((e: Error) => e.message);
    expect(hidden).toBe("no page with id `rb-rotate-db-creds`");
    expect(unknown).toBe("no page with id `nope`");
  });

  it("taint check: after reading a team page, refuses to write to a broader page", async () => {
    const s = service("sam");
    await s.read({ id: "rb-rotate-db-creds" });
    await expect(s.proposeEdit({ id: "rb-deploy-prod", edits: [{ old: "30 minutes", new: "45 minutes" }], reason: "r" })).rejects.toThrow(
      /restricted to @acme\/security/,
    );
    // Same audience is fine.
    const ok = await s.proposeEdit({ id: "rb-rotate-db-creds", edits: [{ old: "1 hour", new: "2 hours" }], reason: "r" });
    expect(ok.pr_url).toMatch(/pull\/1$/);
  });

  it.each([
    ["search results", (s: KnowledgeService) => s.search({ query: "rotate database credentials vault" })],
    ["search excluded entries", (s: KnowledgeService) => s.search({ query: "ledger journal postings" })],
    ["list by type", (s: KnowledgeService) => s.list({ type: "policy" })],
    ["stale", (s: KnowledgeService) => s.stale({ owner_team: "payments" })],
  ])("taint check: %s with a team page also taint the session", async (_name, touch) => {
    // sam is on security and payments, so both team pages are visible to them.
    gh.users.sam = { login: "sam", teams: ["security", "payments"], push: true };
    const s = service("sam");
    await touch(s);
    await expect(s.proposeEdit({ id: "rb-deploy-prod", edits: [{ old: "30 minutes", new: "45 minutes" }], reason: "r" })).rejects.toThrow(/restricted to @acme\//);
  });

  it("keeps the branch and returns the PR when the create-PR response is lost", async () => {
    const realFetch = gh.fetch;
    const lossy = new GitHubClient("alice", {
      fetch: async (url, init) => {
        if (String(url).endsWith("/pulls") && init?.method === "POST") {
          await realFetch(url, init); // GitHub records the PR...
          throw new TypeError("fetch failed: socket hang up"); // ...but the response never arrives
        }
        return realFetch(url, init);
      },
    });
    const s = new KnowledgeService(acme.root, new IdentityProvider(loadConfig(acme.root), lossy), () => NOW);
    const r = await s.proposeEdit({ id: "rb-deploy-prod", edits: [{ old: "30 minutes", new: "45 minutes" }], reason: "r" });
    expect(r.pr_url).toMatch(/\/pull\/1$/);
    expect(gh.branches.has(r.branch)).toBe(true);
  });

  it("cleans up its branch when the PR cannot be opened", async () => {
    const realFetch = gh.fetch;
    const failing = new GitHubClient("alice", {
      fetch: (url, init) => (String(url).endsWith("/pulls") ? Promise.resolve(new Response('{"message":"boom"}', { status: 500 })) : realFetch(url, init)),
    });
    const s = new KnowledgeService(acme.root, new IdentityProvider(loadConfig(acme.root), failing), () => NOW);
    await expect(s.proposeEdit({ id: "rb-deploy-prod", edits: [{ old: "30 minutes", new: "45 minutes" }], reason: "r" })).rejects.toThrow(/500/);
    expect([...gh.branches.keys()]).toEqual(["main"]);
  });
});

describe("verify", () => {
  it("is owner-only", async () => {
    await expect(service("sam").verify({ id: "rb-deploy-prod" })).rejects.toThrow("only members of @acme/platform can verify `rb-deploy-prod`");
    expect(gh.createdBranches.size).toBe(0);
  });

  it("bumps only last_verified, through a PR", async () => {
    const r = await service("alice").verify({ id: "rb-scale-cluster" });
    const before = gh.file("knowledge/runbooks/scale-k8s-cluster.md")!;
    const after = gh.file("knowledge/runbooks/scale-k8s-cluster.md", r.branch)!;
    expect(r.last_verified).toBe("2026-11-02");
    expect(after).toBe(before.replace("last_verified: 2026-08-01", "last_verified: 2026-11-02"));
    expect(gh.pulls[0]?.title).toBe("Verify: Scale the Kubernetes cluster (2026-11-02)");
  });

  it("is unavailable in local-only mode", async () => {
    const local = new KnowledgeService("examples/acme", { get: async () => ({ mode: "local", login: null, teams: new Set(), repoAccess: true, canWrite: false }), fresh: async () => ({ mode: "local", login: null, teams: new Set(), repoAccess: true, canWrite: false }), github: null }, () => NOW);
    await expect(local.verify({ id: "rb-deploy-prod" })).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("edit primitives", () => {
  it("applies sequential exact edits", () => {
    expect(applyEdits("a b c", [{ old: "a", new: "x" }, { old: "c", new: "z" }])).toBe("x b z");
  });
  it("sets last_verified without touching anything else", () => {
    const src = "---\ntitle: T\nlast_verified: 2026-01-01   \nreview_every: 90d\n---\nbody last_verified: keep\n";
    expect(setLastVerified(src, "2026-11-02")).toBe("---\ntitle: T\nlast_verified: 2026-11-02\nreview_every: 90d\n---\nbody last_verified: keep\n");
  });
});
