import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { Identity } from "../src/core/acl.js";
import { type AuditEvent, AuditLog, type AuditSink } from "../src/core/audit-log.js";
import { loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityProvider, LOCAL_IDENTITY } from "../src/core/identity.js";
import { auditTransport } from "../src/core/mcp/audit-transport.js";
import { createMcpServer } from "../src/core/mcp/server.js";
import { loadRepo } from "../src/core/repo.js";
import { type ServeOptions, startServer } from "../src/core/serve/server.js";
import { KnowledgeService } from "../src/core/service.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, copyAcme, fixedIdentity, NOW } from "./helpers.js";

const TOKEN = "u".repeat(43);
const UI_TOOLS = ["ui_capabilities", "ui_graph", "ui_overview", "ui_page"];
const STDIO_TOOLS = ["draft_page", "list", "propose_edit", "read", "search", "stale", "verify"];

class MemorySink implements AuditSink {
  readonly name = "memory";
  readonly events: AuditEvent[] = [];
  fail = false;
  constructor(readonly required = true) {}
  async write(e: AuditEvent): Promise<void> {
    if (this.fail) throw new Error("disk full");
    this.events.push(e);
  }
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function serveAt(root: string, opts: Partial<ServeOptions> & Pick<ServeOptions, "identity" | "who">) {
  const sink = new MemorySink();
  const audit = new AuditLog([sink], { session: "serve-run", server: { version: "test", repo: null, commit: null } }, () => NOW, () => {});
  const s = await startServer({ root, knowledgeRoot: "knowledge", audit, includeQueries: false, now: () => NOW, port: 0, token: TOKEN, extensions: new Set(), webRoot: null, log: () => {}, ...opts });
  cleanups.push(() => s.close());
  return { s, sink };
}

async function httpClient(port: number) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } });
  const client = new Client({ name: "docsworth-web", version: "0.0.1" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: r.structuredContent as Record<string, any> };
  };
  return { client, call };
}

describe("ui tools: the HTTP surface and its policy (R4)", () => {
  it("are listed on HTTP sessions only, next to the stdio tools", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const { s } = await serveAt(acme.root, { identity: fixedIdentity(LOCAL_IDENTITY), who: LOCAL_IDENTITY });
    const { client } = await httpClient(s.port);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...STDIO_TOOLS, ...UI_TOOLS].sort());

    const service = new KnowledgeService(acme.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    const [c, sv] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service).connect(sv);
    const stdio = new Client({ name: "agent", version: "1" });
    await stdio.connect(c);
    cleanups.push(() => stdio.close());
    expect((await stdio.listTools()).tools.map((t) => t.name).sort()).toEqual(STDIO_TOOLS);
  });

  it("drop out with `list` when the policy refuses it, at startup and after a live change", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const cfg = join(acme.root, ".knowledge/config.yaml");
    const original = readFileSync(cfg, "utf8");
    writeFileSync(cfg, `${original}\npolicy:\n  tools:\n    list: { teams: [] }\n`);
    const { s } = await serveAt(acme.root, { identity: fixedIdentity(LOCAL_IDENTITY), who: LOCAL_IDENTITY });
    const { client, call } = await httpClient(s.port);
    const names = async () => (await client.listTools()).tools.map((t) => t.name);
    expect(await names()).not.toEqual(expect.arrayContaining(["list"]));
    for (const ui of UI_TOOLS.filter((t) => t !== "ui_page")) expect(await names()).not.toContain(ui);
    expect(await names()).toContain("ui_page"); // it answers to read
    // A disabled tool is refused by the SDK before any handler runs.
    expect((await call("ui_graph")).isError).toBe(true);

    // Lifted live: the next call's re-check enables them again.
    writeFileSync(cfg, original);
    await call("search", { query: "deploy" });
    await expect.poll(names).toEqual(expect.arrayContaining(UI_TOOLS));
    expect((await call("ui_graph")).isError).toBe(false);

    // And refused live again, with the policy's own words when called anyway.
    writeFileSync(cfg, `${original}\npolicy:\n  tools:\n    list: { teams: [] }\n`);
    await call("search", { query: "deploy" });
    await expect.poll(names).not.toContain("ui_overview");
  });

  it("name the policy entry they answer to when the service refuses them", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    writeFileSync(join(acme.root, ".knowledge/config.yaml"), `${readFileSync(join(acme.root, ".knowledge/config.yaml"), "utf8")}\npolicy:\n  tools:\n    list: { teams: [] }\n`);
    const service = new KnowledgeService(acme.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    for (const [method, tool] of [
      [() => service.uiGraph(), "ui_graph"],
      [() => service.uiOverview(), "ui_overview"],
      [() => service.uiCapabilities(), "ui_capabilities"],
    ] as const) {
      const err = await method().catch((e: unknown) => e as { code: string; message: string });
      expect(err).toMatchObject({ code: "forbidden", message: `policy disables \`list\` (which \`${tool}\` answers to) for everyone` });
    }
    writeFileSync(join(acme.root, ".knowledge/config.yaml"), `${readFileSync(join(acme.root, ".knowledge/config.yaml"), "utf8").replace(/\npolicy:[\s\S]*$/, "")}\npolicy:\n  tools:\n    read: { teams: [] }\n`);
    const err = await service.uiPage({ id: "rb-deploy-prod" }).catch((e: unknown) => e as { code: string; message: string });
    expect(err).toMatchObject({ code: "forbidden", message: "policy disables `read` (which `ui_page` answers to) for everyone" });
  });

  it("ui_page answers from the one look at the repo its read took: a change after it doesn't mix in", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const service = new KnowledgeService(acme.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    const adr = "knowledge/decisions/ADR-0001-postgres-primary-store.md";
    // Right as the read returns, a page it links to goes and the config is touched, so the
    // next look at the repo reloads without it.
    const svc = service as unknown as { readWith: (...a: unknown[]) => Promise<unknown> };
    const readWith = svc.readWith.bind(service);
    let changed = false;
    svc.readWith = async (...a: unknown[]) => {
      const read = await readWith(...a);
      if (!changed) {
        rmSync(join(acme.root, adr));
        utimesSync(join(acme.root, ".knowledge/config.yaml"), new Date(), new Date(Date.now() + 60_000));
        changed = true;
      }
      return read;
    };
    const page = await service.uiPage({ id: "svc-payments" });
    expect(changed).toBe(true);
    expect(page.links).toMatchObject({ [adr]: "adr-0001" }); // as its content, read before the change, shows it
    // The change was real: the next answer, from a look after it, has no such link.
    expect((await service.uiPage({ id: "svc-payments" })).links).not.toHaveProperty(adr);
  });

  it("ui_page links only visible pages, and keeps the app's reads out of the agents' usage log", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const usage = join(acme.root, ".knowledge/usage.jsonl");
    const service = new KnowledgeService(acme.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    const page = await service.uiPage({ id: "svc-payments" });
    expect(page.content).toContain("[restricted page]"); // its link to the ledger, hidden here
    expect(Object.values(page.links)).not.toContain("svc-ledger");
    expect(page.links).toMatchObject({ "knowledge/decisions/ADR-0001-postgres-primary-store.md": "adr-0001" });
    const { existsSync } = await import("node:fs");
    expect(existsSync(usage)).toBe(false);
    await service.read({ id: "svc-payments" });
    expect(readFileSync(usage, "utf8")).toContain('"tool":"read"');
  });

  it("ui_graph with owner_team names only that team's pages, and the links among them", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const service = new KnowledgeService(acme.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    const all = await service.uiGraph();
    const team = await service.uiGraph({ owner_team: "payments" });
    expect(team.nodes.length).toBeGreaterThan(0);
    expect(team.nodes.map((n) => n.id).sort()).toEqual(all.nodes.filter((n) => n.owner_team === "payments").map((n) => n.id).sort());
    const ids = new Set(team.nodes.map((n) => n.id));
    for (const e of team.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  });

  it("ui_page names (and taints with) only the links left in what it shows", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    // A line with a visible link (to the security policy, for a security member) and a
    // hidden page's path in text: redaction drops the whole line, the link with it.
    const f = join(acme.root, "knowledge/runbooks/rotate-tls-certs.md");
    writeFileSync(f, `${readFileSync(f, "utf8")}\nPolicy: [the secrets policy](../security/index.md) covers knowledge/services/ledger/index.md too.\n`);
    const sam: Identity = { mode: "github", login: "sam", teams: new Set(["security"]), repoAccess: true, canWrite: true };
    const service = new KnowledgeService(acme.root, fixedIdentity(sam), () => NOW);
    const page = await service.uiPage({ id: "rb-rotate-tls" });
    expect(page.content.trim().split("\n").at(-1)).toBe("[restricted page]");
    expect(Object.values(page.links)).not.toContain("pol-secrets");
    expect((service as unknown as { tainted: Set<string> }).tainted.size).toBe(0);
  });

  it("offers as owners the teams of visible pages and of CODEOWNERS, names only", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const caps = await new KnowledgeService(acme.root, fixedIdentity(LOCAL_IDENTITY), () => NOW).uiCapabilities();
    expect(caps.teams).toEqual(["devex", "payments", "platform", "security", "sre"]);
  });
});

describe("ui tools: taint is per session (R5)", () => {
  it("a session that saw a team page in the graph can't write it into an internal page; a fresh session can", async () => {
    const acme = acmeOnGitHub();
    cleanups.push(acme.cleanup);
    const gh = new FakeGitHub("acme/knowledge", "acme", { sam: { login: "sam", teams: ["security"], push: true } }, acme.root);
    cleanups.push(() => expect(gh.violations).toEqual([]));
    const identity = new IdentityProvider(loadConfig(acme.root), new GitHubClient("sam", { fetch: gh.fetch }));
    const { s } = await serveAt(acme.root, { identity, who: await identity.fresh() });
    const edit = { id: "rb-deploy-prod", edits: [{ old: "30 minutes", new: "45 minutes" }], reason: "soak time" };

    const a = await httpClient(s.port);
    const graph = await a.call("ui_graph");
    expect(graph.data.nodes.map((n: { id: string }) => n.id)).toContain("pol-secrets");
    const refused = await a.call("propose_edit", edit);
    expect(refused.data.error).toEqual({
      code: "forbidden",
      message: "this session read pages restricted to @acme/security; propose_edit can only target pages with the same audience (this page is `internal`)",
    });

    // ui_page taints as read does: a fresh session that only opens a team page is tainted too.
    const c = await httpClient(s.port);
    await c.call("ui_page", { id: "pol-secrets" });
    expect((await c.call("propose_edit", edit)).data.error.code).toBe("forbidden");
    // And a page that only links to a team page names it in `links`: that taints too.
    const d = await httpClient(s.port);
    const index = await d.call("ui_page", { id: "index" });
    expect(Object.values(index.data.links)).toContain("pol-secrets");
    expect((await d.call("propose_edit", edit)).data.error.code).toBe("forbidden");
    const draft = { type: "runbook", title: "Rotate the HSM", owner_team: "platform", body: "# Rotate the HSM\n", reason: "notes" };
    const refusedDraft = await a.call("draft_page", draft);
    expect(refusedDraft.data.error).toEqual({
      code: "forbidden",
      message: "this session read pages restricted to @acme/security; draft_page can only create pages with the same audience (this one would be `internal`)",
    });

    const b = await httpClient(s.port);
    const ok = await b.call("propose_edit", edit);
    expect(ok.isError).toBe(false);
    expect(ok.data.pr_url).toMatch(/\/pull\/1$/);
    const drafted = await b.call("draft_page", draft);
    expect(drafted.isError).toBe(false);
    expect(drafted.data.pr_url).toMatch(/\/pull\/2$/);
  });
});

/** The responses of every ui tool, for one identity, on the repo at `root`. */
async function uiResponses(root: string, who: Identity) {
  const service = new KnowledgeService(root, fixedIdentity(who), () => NOW);
  return {
    capabilities: await service.uiCapabilities(),
    overview: await service.uiOverview(),
    graph: await service.uiGraph(),
    teamGraph: await service.uiGraph({ owner_team: "payments" }),
    page: await service.uiPage({ id: "svc-payments" }),
    index: await service.uiPage({ id: "index" }),
  };
}

describe("ui tools: hidden pages don't show, and don't change what is shown (R6)", () => {
  const SECURITY: Identity = { mode: "github", login: "sam", teams: new Set(["security"]), repoAccess: true, canWrite: true };

  // Each change touches only pages the identity can't see.
  const changes: [string, Identity, (root: string) => void][] = [
    ["a hidden page is added", LOCAL_IDENTITY, (r) => writeFileSync(join(r, "knowledge/security/new-secret.md"), readFileSync(join(r, "knowledge/security/rotate-db-credentials.md"), "utf8").replace("id: rb-rotate-db-creds", "id: rb-new-secret").replace(/title: .*/, "title: Brand new secret runbook"))],
    ["a hidden page is removed", LOCAL_IDENTITY, (r) => rmSync(join(r, "knowledge/security/rotate-db-credentials.md"))],
    ["a hidden page is renamed (title and id)", LOCAL_IDENTITY, (r) => {
      const f = join(r, "knowledge/services/ledger/index.md");
      writeFileSync(f, readFileSync(f, "utf8").replace("id: svc-ledger", "id: svc-ledger-two").replace(/title: .*/, "title: Ledger, renamed"));
    }],
    ["a hidden page is moved", LOCAL_IDENTITY, (r) => renameSync(join(r, "knowledge/security/rotate-db-credentials.md"), join(r, "knowledge/security/rotate-db-credentials-v2.md"))],
    ["a page hidden from a team member is renamed", SECURITY, (r) => {
      const f = join(r, "knowledge/services/ledger/index.md");
      writeFileSync(f, readFileSync(f, "utf8").replace("id: svc-ledger", "id: svc-ledger-two").replace(/title: .*/, "title: Ledger, renamed"));
    }],
  ];

  it.each(changes)("when %s, every ui response stays the same", async (_name, who, change) => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const before = await uiResponses(acme.root, who);
    const copy = mkdtempSync(join(tmpdir(), "docsworth-ni-"));
    cleanups.push(() => rmSync(copy, { recursive: true, force: true }));
    cpSync(acme.root, copy, { recursive: true });
    change(copy);
    expect(await uiResponses(copy, who)).toEqual(before);
  });

  it.each([
    ["local", LOCAL_IDENTITY],
    ["security", SECURITY],
  ] as const)("never names a page hidden from %s, and flags restricted links exactly as read shows them", async (_n, who) => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const repo = loadRepo(acme.root);
    const hidden = repo.pages.filter((p) => p.acl !== "internal" && !who.teams.has(p.acl));
    expect(hidden.length).toBeGreaterThan(0);
    const text = JSON.stringify(await uiResponses(acme.root, who));
    for (const p of hidden) for (const needle of [p.id, p.title, p.path]) expect(text, `${p.id}: ${needle}`).not.toContain(needle);
    const service = new KnowledgeService(acme.root, fixedIdentity(who), () => NOW);
    for (const n of (await service.uiGraph()).nodes) {
      const read = await service.read({ id: n.id });
      expect(n.has_restricted_links, n.id).toBe(read.content.includes("[restricted page]"));
    }
  });

  it("draws edges only between visible pages", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const { nodes, edges } = await uiResponses(acme.root, LOCAL_IDENTITY).then((r) => r.graph);
    const ids = new Set(nodes.map((n) => n.id));
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) expect(ids.has(e.from) && ids.has(e.to), `${e.from} → ${e.to}`).toBe(true);
    expect(edges).toContainEqual({ from: "rb-deploy-prod", to: "adr-0002" });
  });
});

describe("ui tools: audit (R7)", () => {
  /** What an event says about the call, without its transport-specific fields. */
  const semantic = (e: AuditEvent) => ({ kind: e.kind, actor: e.actor, tool: e.tool, args: e.args, outcome: e.outcome, code: e.code, returned: e.returned, excluded: e.excluded, snapshot: e.snapshot });
  const calls: [string, Record<string, unknown>][] = [
    ["search", { query: "deploy to production", limit: 3 }],
    ["read", { id: "rb-deploy-prod" }],
    ["read", { id: "rb-rotate-db-creds" }],
    ["list", { path: "runbooks" }],
    ["stale", {}],
  ];

  it("records the same events over HTTP as over stdio for the same calls", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);

    const stdioSink = new MemorySink();
    const audit = new AuditLog([stdioSink], { session: "stdio", server: { version: "test", repo: null, commit: null } }, () => NOW, () => {});
    const service = new KnowledgeService(acme.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    const [c, sv] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service).connect(auditTransport(sv, audit, async () => LOCAL_IDENTITY, { includeQueries: false, log: () => {}, known: () => service.knownValues(), snapshot: () => service.snapshot() }));
    const stdio = new Client({ name: "docsworth-web", version: "0.0.1" });
    await stdio.connect(c);
    cleanups.push(() => stdio.close());
    for (const [name, args] of calls) await stdio.callTool({ name, arguments: args });

    const { s, sink } = await serveAt(acme.root, { identity: fixedIdentity(LOCAL_IDENTITY), who: LOCAL_IDENTITY });
    const http = await httpClient(s.port);
    for (const [name, args] of calls) await http.call(name, args);

    expect(sink.events.map(semantic)).toEqual(stdioSink.events.map(semantic));
    expect(sink.events.length).toBe(calls.length);
    // Transport-specific: each log names its own session, and the client as it introduced itself.
    expect(new Set(sink.events.map((e) => e.session))).toEqual(new Set(["serve-run"]));
    for (const e of sink.events) expect(e.client).toEqual({ name: "docsworth-web", version: "0.0.1" });
  });

  it("audits ui calls with the page ids they returned, and answers none when a required sink fails", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const { s, sink } = await serveAt(acme.root, { identity: fixedIdentity(LOCAL_IDENTITY), who: LOCAL_IDENTITY });
    const { call } = await httpClient(s.port);
    const graph = await call("ui_graph");
    const event = sink.events.find((e) => e.tool === "ui_graph");
    expect(event).toMatchObject({ kind: "tool_call", outcome: "ok" });
    expect(event?.returned?.sort()).toEqual(graph.data.nodes.map((n: { id: string }) => n.id).sort());

    sink.fail = true;
    const denied = await call("ui_graph");
    expect(denied.isError).toBe(true);
    expect(denied.data.error.code).toBe("unavailable");
    expect(denied.data.nodes).toBeUndefined();
  });
});
