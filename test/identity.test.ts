import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema, loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityError, IdentityProvider, LOCAL_IDENTITY, resolveToken } from "../src/core/identity.js";
import { KnowledgeService } from "../src/core/service.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, NOW } from "./helpers.js";

const cleanupsG3: (() => void)[] = [];

const config = (repo?: string) => ConfigSchema.parse({ github: { org: "acme", ...(repo ? { repo } : {}) } });
const fake = () =>
  new FakeGitHub("acme/knowledge", "acme", {
    alice: { login: "alice", teams: ["platform", "security"], push: true },
    bob: { login: "bob", teams: [], push: false },
    carol: { login: "carol", teams: ["platform"], push: true, access: false },
    dave: { login: "dave", teams: ["platform"], push: true, noReadOrg: true },
  });
const provider = (gh: FakeGitHub, token: string, clock?: () => number, log?: (m: string) => void) =>
  new IdentityProvider(config("acme/knowledge"), new GitHubClient(token, { fetch: gh.fetch }), clock, log);

describe("identity modes", () => {
  it("local-only repo: internal pages, no teams, no writes", async () => {
    const p = IdentityProvider.fromEnv(config(), { DOCSWORTH_NO_GH_CLI: "1", GITHUB_TOKEN: "ignored" });
    expect(await p.get()).toEqual(LOCAL_IDENTITY);
  });

  it("GitHub repo without a token: refuses to construct (fail closed)", () => {
    expect(() => IdentityProvider.fromEnv(config("acme/knowledge"), { DOCSWORTH_NO_GH_CLI: "1" })).toThrow(IdentityError);
  });

  it("GitHub repo with a token: login, org teams and push permission", async () => {
    const who = await provider(fake(), "alice").get();
    expect(who).toMatchObject({ mode: "github", login: "alice", repoAccess: true, canWrite: true });
    expect([...who.teams].sort()).toEqual(["platform", "security"]);
  });

  it("no repo access: fails closed with a clear error", async () => {
    await expect(provider(fake(), "carol").get()).rejects.toThrow(/no access to acme\/knowledge/);
  });

  it("bad token: fails closed", async () => {
    await expect(provider(fake(), "mallory").get()).rejects.toThrow(/401/);
  });

  it("token without read:org: no teams, warns on stderr, still serves internal pages", async () => {
    const logs: string[] = [];
    const who = await provider(fake(), "dave", undefined, (m) => logs.push(m)).get();
    expect(who.teams.size).toBe(0);
    expect(logs.join()).toMatch(/read:org/);
  });

  it("caches for 5 minutes, then re-resolves; fresh() always re-resolves", async () => {
    const gh = fake();
    let t = 0;
    const p = provider(gh, "alice", () => t);
    const userCalls = () => gh.requests.filter((r) => r.path === "/user").length;
    await p.get();
    t = 4 * 60_000;
    await p.get();
    expect(userCalls()).toBe(1);
    t = 6 * 60_000;
    await p.get();
    expect(userCalls()).toBe(2);
    await p.fresh();
    expect(userCalls()).toBe(3);
  });
});

describe("token resolution", () => {
  it("prefers GITHUB_TOKEN, then GH_TOKEN", () => {
    expect(resolveToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" })).toBe("a");
    expect(resolveToken({ GH_TOKEN: "b" })).toBe("b");
    expect(resolveToken({ DOCSWORTH_NO_GH_CLI: "1" })).toBeNull();
  });
});

describe("enterprise identity: SSO, token kinds, deprovisioning (G3)", () => {
  it("a token not authorized for the org's SAML SSO fails closed, naming SSO and the authorization link", async () => {
    const gh = new FakeGitHub("acme/knowledge", "acme", { erin: { login: "erin", teams: ["platform"], push: true, sso: "required" } });
    const err = await provider(gh, "erin").get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect((err as Error).message).toBe(
      "this token isn't authorized for acme's SAML single sign-on; authorize it at https://github.com/orgs/acme/sso?authorization_request=FAKE123 (the link expires in an hour), or use a fine-grained or GitHub App token",
    );
  });

  // Codex merge gate, PR 1, round 9: an SSO 403 from /user/teams isn't a missing scope.
  it("an SSO-required 403 from /user/teams fails closed too, not as 'lacks read:org'", async () => {
    const gh = new FakeGitHub("acme/knowledge", "acme", { gwen: { login: "gwen", teams: ["platform"], push: true, sso: "teams-required" } });
    const logs: string[] = [];
    const err = await provider(gh, "gwen", undefined, (m) => logs.push(m)).get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect((err as Error).message).toMatch(/^this token isn't authorized for acme's SAML single sign-on; authorize it at https:\/\/github\.com\/orgs\/acme\/sso\?authorization_request=TEAMS456/);
    expect(logs).toEqual([]);
  });

  it("teams withheld for SSO: no team pages, and a warning that names the configured org", async () => {
    const gh = new FakeGitHub("acme/knowledge", "acme", { finn: { login: "finn", teams: ["platform"], push: true, sso: "partial" } });
    const logs: string[] = [];
    const who = await provider(gh, "finn", undefined, (m) => logs.push(m)).get();
    expect(who.teams.size).toBe(0);
    expect(logs).toEqual(["this token isn't authorized for acme's SAML SSO, so GitHub withheld its teams; team-ACL pages stay hidden until you authorize it"]);
  });

  it("refuses a GitHub App installation token before calling GitHub", () => {
    expect(() => IdentityProvider.fromEnv(config("acme/knowledge"), { DOCSWORTH_NO_GH_CLI: "1", GITHUB_TOKEN: "ghs_0123456789abcdef" })).toThrow(
      /^this is a GitHub App installation token, which acts for no person; use your own token/,
    );
    // A GitHub App *user* token (ghu_) is a person's token and is accepted.
    expect(() => IdentityProvider.fromEnv(config("acme/knowledge"), { DOCSWORTH_NO_GH_CLI: "1", GITHUB_TOKEN: "ghu_0123456789abcdef" })).not.toThrow();
  });

  it("caches team membership for policy.identity_cache_seconds", async () => {
    const gh = fake();
    let t = 0;
    const cfg = ConfigSchema.parse({ github: { org: "acme", repo: "acme/knowledge" }, policy: { identity_cache_seconds: 60 } });
    const p = new IdentityProvider(cfg, new GitHubClient("alice", { fetch: gh.fetch }), () => t);
    const userCalls = () => gh.requests.filter((r) => r.path === "/user").length;
    await p.get();
    t = 59_000;
    await p.get();
    expect(userCalls()).toBe(1);
    t = 61_000;
    await p.get();
    expect(userCalls()).toBe(2);
  });

  describe("deprovisioning", () => {
    const service = (gh: FakeGitHub, clock: () => number) => {
      const acme = acmeOnGitHub();
      cleanupsG3.push(acme.cleanup);
      const p = new IdentityProvider(loadConfig(acme.root), new GitHubClient("alice", { fetch: gh.fetch }), clock);
      return { p, s: new KnowledgeService(acme.root, p, () => NOW) };
    };
    afterEach(() => cleanupsG3.splice(0).forEach((c) => c()));

    it("removal from the org: reads stop by the end of the cache window at the latest", async () => {
      const gh = fake();
      let t = 0;
      const { s } = service(gh, () => t);
      expect((await s.read({ id: "rb-deploy-prod" })).id).toBe("rb-deploy-prod");
      gh.users.alice = { ...gh.users.alice!, access: false }; // SCIM removed alice from the org
      t = 4 * 60_000;
      expect((await s.read({ id: "rb-deploy-prod" })).id).toBe("rb-deploy-prod"); // inside the documented window
      t = 6 * 60_000;
      await expect(s.read({ id: "rb-deploy-prod" })).rejects.toThrow(/^no access to acme\/knowledge with this token \(GitHub said 404\)$/);
    });

    it("removal from the org: writes stop at once, and so do reads after that failed live check", async () => {
      const gh = fake();
      let t = 0;
      const { p, s } = service(gh, () => t);
      await s.read({ id: "rb-deploy-prod" });
      gh.users.alice = { ...gh.users.alice!, access: false };
      await expect(p.fresh()).rejects.toThrow(/^no access to acme\/knowledge with this token \(GitHub said 404\)$/); // writes re-check live
      t = 60_000; // well inside the window: the failed check dropped the cached identity
      await expect(s.read({ id: "rb-deploy-prod" })).rejects.toThrow(IdentityError);
    });

    it("removal from a team: that team's pages are hidden once the cache window passes", async () => {
      const gh = fake();
      let t = 0;
      const { s } = service(gh, () => t);
      expect((await s.read({ id: "rb-rotate-db-creds" })).id).toBe("rb-rotate-db-creds"); // acl: security
      gh.users.alice = { ...gh.users.alice!, teams: ["platform"] }; // IdP group sync removed alice from security
      t = 6 * 60_000;
      await expect(s.read({ id: "rb-rotate-db-creds" })).rejects.toMatchObject({ code: "not_found" });
    });
  });
});
