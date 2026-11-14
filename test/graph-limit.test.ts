import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuditEvent, AuditLog, type AuditSink } from "../src/core/audit-log.js";
import { loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityProvider, LOCAL_IDENTITY } from "../src/core/identity.js";
import { loadRepo } from "../src/core/repo.js";
import { startServer } from "../src/core/serve/server.js";
import { KnowledgeService, type ToolError } from "../src/core/service.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, copyAcme, fixedIdentity, NOW } from "./helpers.js";

// ui_graph's max_nodes: a big repo's graph is drawn from its most-linked pages, and only the
// pages returned are named, so only those taint the session (docs/security-model.md, "Each
// view asks only for what it shows").

let acme: ReturnType<typeof acmeOnGitHub>;
let gh: FakeGitHub;
beforeEach(() => {
  acme = acmeOnGitHub();
  gh = new FakeGitHub("acme/knowledge", "acme", { sam: { login: "sam", teams: ["security"], push: true } }, acme.root);
});
afterEach(() => {
  acme.cleanup();
  expect(gh.violations).toEqual([]);
});

const sam = () => new KnowledgeService(acme.root, new IdentityProvider(loadConfig(acme.root), new GitHubClient("sam", { fetch: gh.fetch })), () => NOW);
const DRAFT = { type: "runbook", title: "Drain a Kafka partition", owner_team: "platform", body: "# Drain a Kafka partition\n\n## Steps\n\n1. Pause the consumer.\n", reason: "From the INC-412 thread." } as const;
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as ToolError);

/** The visible pages ranked as max_nodes ranks them, worked out here from the full graph. */
async function ranked(s: KnowledgeService) {
  const full = await s.uiGraph();
  const degree = new Map<string, number>();
  for (const e of full.edges) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const order = full.nodes.map((n) => n.id).sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b));
  return { full, order };
}

describe("ui_graph with max_nodes", () => {
  it("returns the most-linked pages, the links among them, how many it chose from, and each team's count", async () => {
    const { full, order } = await ranked(sam());
    expect(full.nodes.length).toBeGreaterThan(5);
    const g = await sam().uiGraph({ max_nodes: 5 });
    expect(g.nodes.map((n) => n.id)).toEqual(order.slice(0, 5));
    const kept = new Set(order.slice(0, 5));
    expect(g.edges).toEqual(full.edges.filter((e) => kept.has(e.from) && kept.has(e.to)));
    expect(g.total).toBe(full.nodes.length);
    const byTeam = new Map<string, number>();
    for (const n of full.nodes) byTeam.set(n.owner_team, (byTeam.get(n.owner_team) ?? 0) + 1);
    expect(g.teams).toEqual([...byTeam].sort(([a], [b]) => a.localeCompare(b)).map(([team, pages]) => ({ team, pages })));
    // Under the limit, it's the whole graph.
    expect((await sam().uiGraph({ max_nodes: 500 })).nodes).toEqual(full.nodes);
  });

  it("limits one team's pages among themselves, and still counts every team", async () => {
    const all = await sam().uiGraph();
    const platform = all.nodes.filter((n) => n.owner_team === "platform");
    const g = await sam().uiGraph({ owner_team: "platform", max_nodes: 3 });
    expect(g.nodes).toHaveLength(3);
    expect(g.nodes.every((n) => n.owner_team === "platform")).toBe(true);
    expect(g.total).toBe(platform.length);
    expect(g.teams).toEqual((await sam().uiGraph()).teams);
  });

  it("taints the session with the pages it returned, and no others", async () => {
    const { order } = await ranked(sam());
    const restricted = new Set(loadRepo(acme.root).pages.filter((p) => p.acl === "security").map((p) => p.id));
    const first = order.findIndex((id) => restricted.has(id));
    expect(first).toBeGreaterThan(0); // a security page that a smaller limit leaves out
    const without = sam();
    await without.uiGraph({ max_nodes: first });
    expect(await rejection(without.draftPage(DRAFT))).toBeUndefined();
    const withIt = sam();
    await withIt.uiGraph({ max_nodes: first + 1 });
    expect(await rejection(withIt.draftPage(DRAFT))).toMatchObject({
      code: "forbidden",
      message: "this session read pages restricted to @acme/security; draft_page can only create pages with the same audience (this one would be `internal`)",
    });
  });

  it("is audited with the pages it returned and the limit asked for", async () => {
    const local = copyAcme();
    const events: AuditEvent[] = [];
    const sink: AuditSink = { name: "memory", required: true, write: async (e) => void events.push(e) };
    const audit = new AuditLog([sink], { session: "s", server: { version: "test", repo: null, commit: null } }, () => NOW, () => {});
    const token = "t".repeat(43);
    const s = await startServer({ root: local.root, identity: fixedIdentity(LOCAL_IDENTITY), who: LOCAL_IDENTITY, audit, includeQueries: false, now: () => NOW, port: 0, token, extensions: new Set(), webRoot: null, log: () => {} });
    try {
      const c = new Client({ name: "docsworth-web", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const r = await c.callTool({ name: "ui_graph", arguments: { max_nodes: 4 } });
      const nodes = (r.structuredContent as { nodes: { id: string }[] }).nodes.map((n) => n.id);
      expect(nodes).toHaveLength(4);
      const e = events.find((x) => x.kind === "tool_call" && x.tool === "ui_graph");
      expect(e).toMatchObject({ outcome: "ok", args: { max_nodes: 4 }, returned: nodes });
      const tooMany = await c.callTool({ name: "ui_graph", arguments: { max_nodes: 501 } });
      expect(tooMany.isError).toBe(true);
      await c.close();
    } finally {
      await s.close();
      local.cleanup();
    }
  });
});
