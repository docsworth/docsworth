import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { Identity } from "../src/core/acl.js";
import { ConfigError, loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityProvider, LOCAL_IDENTITY } from "../src/core/identity.js";
import { lintRepo } from "../src/core/lint.js";
import { createMcpServer, REQUIRES_USER_INTERACTION } from "../src/core/mcp/server.js";
import { loadRepo } from "../src/core/repo.js";
import { KnowledgeService, ToolError } from "../src/core/service.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, copyAcme, fixedIdentity, NOW } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const ALICE: Identity = { mode: "github", login: "alice", teams: new Set(["platform"]), repoAccess: true, canWrite: true };
const BOB: Identity = { mode: "github", login: "bob", teams: new Set(["payments"]), repoAccess: true, canWrite: true };

/** The acme example with a `policy:` block appended to its config. */
function acmeWithPolicy(policy: string) {
  const acme = copyAcme();
  cleanups.push(acme.cleanup);
  const cfg = join(acme.root, ".knowledge/config.yaml");
  writeFileSync(cfg, `${readFileSync(cfg, "utf8")}policy:\n${policy.replace(/^/gm, "  ")}\n`);
  return acme.root;
}

async function tools(root: string, who: Identity) {
  const service = new KnowledgeService(root, fixedIdentity(who), () => NOW);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createMcpServer(service, { who }).connect(s);
  const client = new Client({ name: "policy-test", version: "0" });
  await client.connect(c);
  cleanups.push(() => void client.close());
  return { list: (await client.listTools()).tools, client };
}

async function refusal(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ToolError);
  return { code: (err as ToolError).code, message: (err as ToolError).message };
}

describe("per-tool allowlists", () => {
  it("refuses a tool to identities outside its teams, at call time, before any page is touched", async () => {
    const root = acmeWithPolicy("tools:\n  search: { teams: [platform] }\n  read: { teams: [] }");
    const asBob = new KnowledgeService(root, fixedIdentity(BOB), () => NOW);
    expect(await refusal(asBob.search({ query: "deploy" }))).toEqual({ code: "forbidden", message: "policy allows `search` only for @acme/platform" });
    // A refused read says the same for a real id and a made-up one: no existence oracle.
    expect(await refusal(asBob.read({ id: "rb-deploy-prod" }))).toEqual({ code: "forbidden", message: "policy disables `read` for everyone" });
    expect(await refusal(asBob.read({ id: "zzz" }))).toEqual({ code: "forbidden", message: "policy disables `read` for everyone" });
    const asAlice = new KnowledgeService(root, fixedIdentity(ALICE), () => NOW);
    expect((await asAlice.search({ query: "deploy" })).results.length).toBeGreaterThan(0);
  });

  it("the local identity (no teams) is refused any allowlisted tool: fail closed", async () => {
    const root = acmeWithPolicy("tools:\n  stale: { teams: [platform] }");
    const s = new KnowledgeService(root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    expect((await refusal(s.stale())).code).toBe("forbidden");
  });

  it("drops refused tools from that identity's tools/list, and a call to one is refused", async () => {
    const root = acmeWithPolicy("tools:\n  stale: { teams: [platform] }");
    const bob = await tools(root, BOB);
    expect(bob.list.map((t) => t.name).sort()).toEqual(["draft_page", "list", "propose_edit", "read", "search", "verify"]);
    const r = await bob.client.callTool({ name: "stale", arguments: {} });
    expect(r).toMatchObject({ isError: true, content: [{ text: "MCP error -32602: Tool stale disabled" }] });
    const alice = await tools(root, ALICE);
    expect(alice.list.map((t) => t.name)).toContain("stale");
  });

  it("applies a policy change to the next call, without a restart", async () => {
    const root = acmeWithPolicy("include_stale: allowed");
    const s = new KnowledgeService(root, fixedIdentity(BOB), () => NOW);
    await s.stale();
    const cfg = join(root, ".knowledge/config.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8")}  tools:\n    stale: { teams: [platform] }\n`);
    const later = new Date(Date.now() + 5000);
    (await import("node:fs")).utimesSync(cfg, later, later);
    expect((await refusal(s.stale())).message).toBe("policy allows `stale` only for @acme/platform");
  });

  // Codex merge gate, PR 1, round 13: the plan's dynamic list, not just call-time refusal.
  it("updates a session's tools/list after a policy change, and says so with list_changed", async () => {
    const root = acmeWithPolicy("include_stale: allowed");
    const service = new KnowledgeService(root, fixedIdentity(BOB), () => NOW);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service, { who: BOB }).connect(s);
    const client = new Client({ name: "policy-test", version: "0" });
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void changed++);
    await client.connect(c);
    cleanups.push(() => void client.close());
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("stale");

    const cfg = join(root, ".knowledge/config.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8")}  tools:\n    stale: { teams: [platform] }\n`);
    const later = new Date(Date.now() + 5000);
    (await import("node:fs")).utimesSync(cfg, later, later);
    await client.callTool({ name: "list", arguments: {} }); // any call re-checks the policy
    await new Promise((r) => setTimeout(r, 20));
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("stale");
    expect(changed).toBe(1);
  });

  // Codex merge gate, PR 1, round 17: a session with every tool disabled must still see a
  // policy relaxation, since its calls never reach a handler; the approval flag follows too.
  it("re-enables tools and updates the approval flag on a timer, with no calls at all", async () => {
    const root = acmeWithPolicy("tools:\n    search: { teams: [] }\n    read: { teams: [] }\n    list: { teams: [] }\n    stale: { teams: [] }\n    propose_edit: { teams: [] }\n    verify: { teams: [] }\n    draft_page: { teams: [] }");
    const service = new KnowledgeService(root, fixedIdentity(BOB), () => NOW);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service, { who: BOB, resyncMs: 30 }).connect(s);
    const client = new Client({ name: "policy-test", version: "0" });
    await client.connect(c);
    cleanups.push(() => void client.close());
    expect((await client.listTools()).tools).toEqual([]);

    const cfg = join(root, ".knowledge/config.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/  tools:[\s\S]*$/, "  require_human_approval: true\n"));
    const later = new Date(Date.now() + 5000);
    (await import("node:fs")).utimesSync(cfg, later, later);
    await new Promise((r) => setTimeout(r, 120));
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["draft_page", "list", "propose_edit", "read", "search", "stale", "verify"]);
    expect(tools.find((t) => t.name === "verify")?._meta?.[REQUIRES_USER_INTERACTION]).toBe(true);
  });

  it("rejects a policy naming a tool that doesn't exist", () => {
    const root = acmeWithPolicy("tools:\n  delete_everything: { teams: [platform] }");
    expect(() => loadConfig(root)).toThrow(ConfigError);
  });
});

describe("writes: disabled", () => {
  it("offers no write tools, and the service refuses them too", async () => {
    const root = acmeWithPolicy("writes: disabled");
    const { list } = await tools(root, ALICE);
    expect(list.map((t) => t.name).sort()).toEqual(["list", "read", "search", "stale"]);
    const s = new KnowledgeService(root, fixedIdentity(ALICE), () => NOW);
    expect(await refusal(s.proposeEdit({ id: "rb-deploy-prod", content: "x", reason: "r" }))).toEqual({
      code: "forbidden",
      message: "writes are disabled by policy (policy.writes in .knowledge/config.yaml)",
    });
  });

  it("leaves write tools out even for a server built without an identity", async () => {
    const service = new KnowledgeService(acmeWithPolicy("writes: disabled"), fixedIdentity(ALICE), () => NOW);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service).connect(s);
    const client = new Client({ name: "policy-test", version: "0" });
    await client.connect(c);
    cleanups.push(() => void client.close());
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["list", "read", "search", "stale"]);
  });

  it("is refused before GitHub is asked for anything", async () => {
    const acme = acmeOnGitHub();
    cleanups.push(acme.cleanup);
    const cfg = join(acme.root, ".knowledge/config.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8")}policy:\n  writes: disabled\n`);
    const gh = new FakeGitHub("acme/knowledge", "acme", { alice: { login: "alice", teams: ["platform"], push: true } }, acme.root);
    const s = new KnowledgeService(acme.root, new IdentityProvider(loadConfig(acme.root), new GitHubClient("alice", { fetch: gh.fetch })), () => NOW);
    expect((await refusal(s.verify({ id: "rb-deploy-prod" }))).code).toBe("forbidden");
    expect(gh.requests).toEqual([]); // not even an identity lookup
  });
});

describe("require_human_approval", () => {
  it("marks only the write tools, and only when on", async () => {
    const on = await tools(acmeWithPolicy("require_human_approval: true"), ALICE);
    const meta = Object.fromEntries(on.list.map((t) => [t.name, t._meta?.[REQUIRES_USER_INTERACTION] ?? null]));
    expect(meta).toEqual({ search: null, read: null, list: null, stale: null, propose_edit: true, verify: true, draft_page: true });
    const off = await tools(acmeWithPolicy("writes: enabled"), ALICE);
    expect(off.list.every((t) => t._meta?.[REQUIRES_USER_INTERACTION] === undefined)).toBe(true);
  });
});

describe("include_stale: denied", () => {
  it("keeps gated pages out of results even when the agent asks for them", async () => {
    const allowed = new KnowledgeService(acmeWithPolicy("include_stale: allowed"), fixedIdentity(LOCAL_IDENTITY), () => NOW);
    const denied = new KnowledgeService(acmeWithPolicy("include_stale: denied"), fixedIdentity(LOCAL_IDENTITY), () => NOW);
    const q = { query: "scale the kubernetes cluster", include_stale: true };
    expect((await allowed.search(q)).results.map((r) => r.id)).toContain("rb-scale-cluster");
    const r = await denied.search(q);
    expect(r.results.map((x) => x.id)).not.toContain("rb-scale-cluster");
    expect(r.excluded.map((x) => x.id)).toContain("rb-scale-cluster");
  });
});

describe("policy.admins (lint)", () => {
  const lint = (root: string) => lintRepo(loadRepo(root), NOW).diagnostics.filter((d) => d.rule === "policy-admins");

  it("errors when the winning CODEOWNERS rule for the config isn't the admins team", () => {
    const root = acmeWithPolicy("admins: kb-admins");
    expect(lint(root).map((d) => [d.severity, d.path])).toEqual([
      ["error", ".knowledge/config.yaml"],
      ["error", "CODEOWNERS"],
    ]);
    expect(lint(root)[0]!.message).toMatch(/^policy\.admins is `kb-admins`, but CODEOWNERS doesn't make @acme\/kb-admins the owner of \.knowledge\/config\.yaml \((line \d+ names .+|no rule matches it)\); add `\/\.knowledge\/config\.yaml @acme\/kb-admins` as the last line$/);
  });

  it("passes when the last matching rule names the admins team, and a later rule would override it", () => {
    const root = acmeWithPolicy("admins: kb-admins");
    const co = join(root, "CODEOWNERS");
    writeFileSync(co, `${readFileSync(co, "utf8")}/.knowledge/config.yaml @acme/kb-admins\n/CODEOWNERS @acme/kb-admins\n`);
    expect(lint(root)).toEqual([]);
    // A broader rule after it wins in GitHub, so it must win here too.
    writeFileSync(co, `${readFileSync(co, "utf8")}/.knowledge/ @acme/platform\n`);
    expect(lint(root).map((d) => [d.severity, d.path])).toEqual([["error", ".knowledge/config.yaml"]]);
  });

  // Any one code owner's approval satisfies GitHub, so a co-owner bypasses the admins
  // (Codex merge gate, PR 1). An error, not a warning.
  it("errors when another owner on the same rule could approve config changes without the admins", () => {
    const root = acmeWithPolicy("admins: kb-admins");
    const co = join(root, "CODEOWNERS");
    writeFileSync(co, `${readFileSync(co, "utf8")}/.knowledge/config.yaml @acme/kb-admins @acme/platform\n/CODEOWNERS @acme/kb-admins\n`);
    expect(lint(root).map((d) => [d.severity, d.message])).toEqual([
      ["error", expect.stringMatching(/^CODEOWNERS line \d+ also lets @acme\/platform approve changes to \.knowledge\/config\.yaml; @acme\/kb-admins must be its only owner$/)],
    ]);
  });
});
