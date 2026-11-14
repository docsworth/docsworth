import { cpSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Identity } from "../src/core/acl.js";
import { loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityProvider, LOCAL_IDENTITY } from "../src/core/identity.js";
import { KnowledgeService, RepoLoader, type ToolError } from "../src/core/service.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, NOW } from "./helpers.js";
import { ALL_SPACES, ENG_OTHER, ENG_PAGE, PAY_PAGE, SEC_PAGE, serveMirror, writeMirror } from "./mirror-helpers.js";

// `docsworth serve` gives every session's service one RepoLoader: one copy of the pages and
// their index however many tabs are open. What belongs to a session (its taint) must stay
// its own, and what one identity is shown must be exactly what it would be shown alone.

let acme: ReturnType<typeof acmeOnGitHub>;
let gh: FakeGitHub;
beforeEach(() => {
  acme = acmeOnGitHub();
  gh = new FakeGitHub(
    "acme/knowledge",
    "acme",
    {
      sam: { login: "sam", teams: ["security"], push: true },
      tok: { login: "u", teams: [], push: true },
    },
    acme.root,
  );
});
afterEach(() => {
  acme.cleanup();
  expect(gh.violations).toEqual([]);
});

const internals = (s: KnowledgeService) => s as unknown as { repo: object; index: object };
const asUser = (token: string, loader?: RepoLoader) =>
  new KnowledgeService(acme.root, new IdentityProvider(loadConfig(acme.root), new GitHubClient(token, { fetch: gh.fetch })), () => NOW, loader);
const DRAFT = { type: "runbook", title: "Drain a Kafka partition", owner_team: "platform", body: "# Drain a Kafka partition\n\n## Steps\n\n1. Pause the consumer.\n", reason: "From the INC-412 thread." } as const;
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as ToolError);

describe("one load shared by many services", () => {
  it("gives every service the same pages and index, and loads a change once for all of them", async () => {
    const loader = new RepoLoader(acme.root);
    const a = new KnowledgeService(acme.root, { get: async () => LOCAL_IDENTITY, fresh: async () => LOCAL_IDENTITY, github: null }, () => NOW, loader);
    const b = new KnowledgeService(acme.root, { get: async () => LOCAL_IDENTITY, fresh: async () => LOCAL_IDENTITY, github: null }, () => NOW, loader);
    expect(loader.loads).toBe(1);
    expect(internals(a).repo).toBe(internals(b).repo);
    expect(internals(a).index).toBe(internals(b).index);

    const page = join(acme.root, "knowledge/runbooks/deploy-production.md");
    writeFileSync(page, `${readFileSync(page, "utf8")}\nThe zebracorn step.\n`);
    loader.invalidate();
    expect((await a.search({ query: "zebracorn" })).results.map((r) => r.id)).toEqual(["rb-deploy-prod"]);
    expect((await b.search({ query: "zebracorn" })).results.map((r) => r.id)).toEqual(["rb-deploy-prod"]);
    expect(loader.loads).toBe(2);
    expect(internals(a).repo).toBe(internals(b).repo);
  });

  it("keeps each service's taint its own, across a reload", async () => {
    const loader = new RepoLoader(acme.root);
    const tainted = asUser("sam", loader);
    const fresh = asUser("sam", loader);
    await tainted.read({ id: "pol-secrets" });
    const refusal = "this session read pages restricted to @acme/security; draft_page can only create pages with the same audience (this one would be `internal`)";
    expect(await rejection(tainted.draftPage(DRAFT))).toMatchObject({ code: "forbidden", message: refusal });
    // The other service on the same load never read it.
    expect(await rejection(fresh.draftPage(DRAFT))).toBeUndefined();
    // A new load keeps what the session saw.
    tainted.reload();
    expect(await rejection(tainted.draftPage(DRAFT))).toMatchObject({ code: "forbidden", message: refusal });
  });

  describe("shows each identity exactly what it would see on a load of its own", () => {
    beforeEach(async () => {
      await writeMirror(acme.root, ALL_SPACES);
      serveMirror(acme.root);
    });
    const user = (login: string, teams: string[]): Identity => ({ mode: "github", login, teams: new Set(teams), repoAccess: true, canWrite: true });
    const IDENTITIES: Identity[] = [
      LOCAL_IDENTITY,
      user("nina", []),
      user("pat", ["platform"]),
      user("sam", ["security"]),
      user("pia", ["payments"]),
      { mode: "github", login: "eve", teams: new Set(["security", "payments", "platform"]), repoAccess: false, canWrite: true },
    ];
    const as = (who: Identity, loader?: RepoLoader) =>
      new KnowledgeService(acme.root, { get: async () => who, fresh: async () => who, github: who.mode === "local" ? null : new GitHubClient("tok", { fetch: gh.fetch }) }, () => NOW, loader);
    const settle = (p: Promise<unknown>) => p.catch((e: { code?: string; message: string }) => ({ error: `${e.code}: ${e.message}` }));
    const QUERIES = ["deploy", "secrets rotation", "payroll ledger", ENG_PAGE.title, SEC_PAGE.title, PAY_PAGE.title];
    const IDS = ["pol-secrets", "rb-deploy-prod", ENG_PAGE.id, ENG_OTHER.id, SEC_PAGE.id, PAY_PAGE.id];
    const answers = async (s: KnowledgeService) => ({
      search: await Promise.all(QUERIES.map((query) => settle(s.search({ query })))),
      read: await Promise.all(IDS.map((id) => settle(s.read({ id })))),
      list: await settle(s.list({})),
      graph: await settle(s.uiGraph()),
      overview: await settle(s.uiOverview()),
    });

    it("whichever identity filled the shared caches first", async () => {
      const shared = new RepoLoader(acme.root);
      // Every identity in turn, then again in reverse, on the one load: the mirror's
      // per-audience views are filled by whoever asks first.
      for (const who of [...IDENTITIES, ...[...IDENTITIES].reverse()]) {
        expect(await answers(as(who, shared))).toEqual(await answers(as(who)));
      }
      expect(shared.loads).toBe(1);
    });
  });

  it("keeps watching when the config names a knowledge root that doesn't exist yet, and loads it once it does", async () => {
    const loader = new RepoLoader(acme.root);
    loader.watch();
    try {
      const cfg = join(acme.root, ".knowledge/config.yaml");
      const co = join(acme.root, "CODEOWNERS");
      writeFileSync(cfg, readFileSync(cfg, "utf8").replace("knowledge_root: knowledge", "knowledge_root: later-kb"));
      writeFileSync(co, readFileSync(co, "utf8").replaceAll("/knowledge/", "/later-kb/"));
      const later = new Date(Date.now() + 5000);
      utimesSync(cfg, later, later);
      utimesSync(co, later, later);
      // The new root isn't there: nothing to serve, but no failure either.
      expect(loader.current().repo.pages).toHaveLength(0);
      cpSync(join(acme.root, "knowledge"), join(acme.root, "later-kb"), { recursive: true });
      await expect.poll(() => loader.current().repo.pages.length, { timeout: 5000 }).toBeGreaterThan(20);
      expect(loader.watchedDir).toBe(join(acme.root, "later-kb"));
    } finally {
      loader.close();
    }
  });
});
