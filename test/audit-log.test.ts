import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { Identity } from "../src/core/acl.js";
import { AUDIT_MARKER, type AuditEvent, AuditLog, type AuditSink, createAuditLog, defaultAuditDir, FileSink, resolveAuditDir, writeAll } from "../src/core/audit-log.js";
import { ConfigSchema, loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityProvider, LOCAL_IDENTITY } from "../src/core/identity.js";
import { auditTransport } from "../src/core/mcp/audit-transport.js";
import { createMcpServer } from "../src/core/mcp/server.js";
import { loadRepo } from "../src/core/repo.js";
import { KnowledgeService } from "../src/core/service.js";
import { FakeGitHub } from "./fake-github.js";
import { ALL_SPACES, ENG_PAGE, SEC_PAGE, serveMirror, writeMirror } from "./mirror-helpers.js";
import { acmeOnGitHub, copyAcme, NOW, fixedIdentity } from "./helpers.js";

// Token-shaped strings, built here so the file holds none for a secret scanner to flag.
const GHP = ["ghp", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("_");
const XOXB = ["xo", "xb"].join("");

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

/** Collects events in memory; `fail` makes every write throw; `onWrite` observes timing. */
class MemorySink implements AuditSink {
  readonly name = "memory";
  readonly events: AuditEvent[] = [];
  fail = false;
  constructor(
    readonly required = false,
    private readonly onWrite?: (e: AuditEvent) => void,
  ) {}
  async write(e: AuditEvent): Promise<void> {
    this.onWrite?.(e);
    if (this.fail) throw new Error("disk full");
    this.events.push(e);
  }
}

const SERVER = { version: "test", repo: null, commit: null };

async function connect(service: KnowledgeService, sinks: AuditSink[], who: () => Promise<Identity>, includeQueries = false) {
  const audit = new AuditLog(sinks, { session: "s1", server: SERVER }, () => NOW, () => {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(service).connect(
    auditTransport(serverSide, audit, who, { includeQueries, log: () => {}, known: () => service.knownValues(), snapshot: () => service.snapshot() }),
  );
  const client = new Client({ name: "audit-test", version: "1.2.3" });
  await client.connect(clientSide);
  cleanups.push(() => void client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: r.structuredContent as Record<string, any> | undefined };
  };
  return { audit, call, client };
}

function localAcme() {
  const acme = copyAcme();
  cleanups.push(acme.cleanup);
  return { root: acme.root, service: new KnowledgeService(acme.root, fixedIdentity(LOCAL_IDENTITY), () => NOW) };
}

describe("audit at the JSON-RPC boundary", () => {
  it("counts mirrored pages a search showed as returned, and a typed mirror id as the caller's (v0.2 L2)", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    await writeMirror(acme.root, ALL_SPACES);
    serveMirror(acme.root);
    const service = new KnowledgeService(acme.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    const sink = new MemorySink();
    const { call, audit } = await connect(service, [sink], async () => LOCAL_IDENTITY);
    const r = await call("search", { query: "deploy checklist canary jenkins" });
    expect(r.data?.mirrored?.map((m: { id: string }) => m.id)).toContain(ENG_PAGE.id);
    await call("read", { id: SEC_PAGE.id }); // a security space: hidden from the local identity
    await audit.flush();
    const [search, read] = sink.events;
    expect(search!.returned).toContain(ENG_PAGE.id);
    expect(read).toMatchObject({ outcome: "error", code: "not_found", args: { id: SEC_PAGE.id } });
    expect(JSON.stringify(sink.events)).not.toContain(SEC_PAGE.title);
  });

  it("records exactly one event per tools/call, including calls the SDK rejects before any handler", async () => {
    const { service } = localAcme();
    const sink = new MemorySink();
    const { call, audit } = await connect(service, [sink], async () => LOCAL_IDENTITY);
    await call("search", { query: "scale the kubernetes cluster" });
    await call("read", { id: "rb-rotate-db-creds" }); // hidden from the local identity
    await call("read", { id: "zzz-unknown" });
    await call("list");
    await call("stale");
    await call("nope"); // unknown tool
    await call("search", {}); // malformed: query is required
    await audit.flush();
    expect(sink.events.map((e) => [e.kind, e.tool, e.outcome, e.code ?? null])).toEqual([
      ["tool_call", "search", "ok", null],
      ["tool_call", "read", "error", "not_found"],
      ["tool_call", "read", "error", "not_found"],
      ["tool_call", "list", "ok", null],
      ["tool_call", "stale", "ok", null],
      ["tool_call", "<unknown>", "error", "unknown_tool"], // only this server's tool names are recorded
      ["tool_call", "search", "error", "invalid"],
    ]);
    const [search, hidden] = sink.events;
    expect(search!.returned!.length).toBeGreaterThan(0);
    expect(search!.excluded).toContain("rb-scale-cluster");
    expect(hidden!.args).toEqual({ id: "rb-rotate-db-creds" }); // the id the caller typed
    expect(search!.client).toEqual({ name: "audit-test", version: "1.2.3" });
    // Local mode names the OS user (Codex merge gate, PR 1, round 12): never anonymous.
    expect(search!.actor).toEqual({ login: userInfo().username, mode: "local", teams: [] });
    expect(sink.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("never records tokens, content, query text or a hidden page beyond the id the caller typed", async () => {
    const { root, service } = localAcme();
    const sink = new MemorySink();
    const { call, audit } = await connect(service, [sink], async () => LOCAL_IDENTITY);
    const query = "rotate database credentials for the ledger";
    await call("search", { query, include_stale: true });
    await call("search", { query: "secrets vault production" });
    await call("read", { id: "rb-scale-cluster" });
    await call("read", { id: "svc-ledger" });
    await call("list", { path: "security" });
    await call("list", { path: "services" });
    await call("stale");
    await call("propose_edit", { id: "rb-deploy-prod", content: "SECRET-BODY-TEXT", reason: "REASON-TEXT ghp_faketoken123" });
    await audit.flush();

    const hiddenPages = loadRepo(root).pages.filter((p) => p.acl !== "internal");
    expect(hiddenPages.length).toBeGreaterThan(0);
    const typed = new Set(["svc-ledger"]);
    const scrubbed = JSON.stringify(sink.events.map(({ args, ...rest }) => ({ ...rest, args: args && typed.has(String(args.id)) ? { ...args, id: "<typed>" } : args })));
    for (const p of hiddenPages) for (const s of [p.id, p.title, p.path]) expect(scrubbed, `hidden ${s}`).not.toContain(s);
    for (const s of ["autoscaler", "SECRET-BODY-TEXT", "REASON-TEXT", "ghp_faketoken123", query]) expect(scrubbed).not.toContain(s);
  });

  // Codex merge gate, PR 1, round 11: arguments are recorded per tool, and validated.
  it("records only each tool's own arguments, and marks malformed values <invalid>", async () => {
    const { service } = localAcme();
    const sink = new MemorySink();
    const { call, audit } = await connect(service, [sink], async () => LOCAL_IDENTITY);
    await call("search", { query: "q", path: "SECRET PASTED CONTENT", owner_team: "platform" }); // search has no path
    await call("list", { path: "runbooks/../../SECRET PASTED CONTENT" });
    await call("nope", { id: "rb-deploy-prod", owner_team: "SECRET PASTED CONTENT" }); // unknown tool: no args
    await call("read", { id: "rb-deploy-prod" });
    await audit.flush();
    expect(sink.events.map((e) => [e.tool, e.args ?? null])).toEqual([
      ["search", { owner_team: "platform" }],
      ["list", { path: "<withheld>" }], // failed, so the typed path isn't recorded (round 19)
      ["<unknown>", null],
      ["read", { id: "rb-deploy-prod" }],
    ]);
    expect(JSON.stringify(sink.events)).not.toMatch(/SECRET/);
  });

  // Codex merge gate, PR 1, round 14: client-chosen strings are validated too.
  it("records a malformed tool name or client name as <invalid>", async () => {
    const { service } = localAcme();
    const sink = new MemorySink();
    const audit = new AuditLog([sink], { session: "s1", server: SERVER }, () => NOW, () => {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service).connect(auditTransport(serverSide, audit, async () => LOCAL_IDENTITY, { includeQueries: false, log: () => {} }));
    const client = new Client({ name: "ghp_SECRETTOKEN\nline two", version: "1.0" });
    await client.connect(clientSide);
    cleanups.push(() => void client.close());
    await client.callTool({ name: "read SECRET PAGE TEXT", arguments: {} });
    await audit.flush();
    expect(sink.events[0]).toMatchObject({ tool: "<invalid>", client: { name: "<invalid>", version: "1.0" } });
    expect(JSON.stringify(sink.events)).not.toMatch(/SECRET/);
  });

  // Codex merge gate, PR 1, round 16: a shape-valid value can still be a token.
  it("redacts token-shaped values even when they pass their shape check", async () => {
    const { service } = localAcme();
    const sink = new MemorySink();
    const { call, audit } = await connect(service, [sink], async () => LOCAL_IDENTITY, true);
    await call("list", { path: GHP });
    await call("search", { query: `why does ${XOXB}-123456-abcdef fail`, applies_to: "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MA" });
    await call("read", { id: "rb-deploy-prod" });
    await audit.flush();
    // applies_to isn't a tag the repo uses, so it's not recorded as typed (round 23).
    expect(sink.events.map((e) => e.args)).toEqual([{ path: "<withheld>" }, { applies_to: "<unknown>", query: "<redacted>" }, { id: "rb-deploy-prod" }]);
  });

  // Codex merge gate, PR 1, round 18: redaction is central, so no producer can skip it.
  it("redacts token-shaped strings in any event, whoever emits it", async () => {
    const sink = new MemorySink();
    const audit = new AuditLog([sink], { session: "s", server: SERVER }, () => NOW, () => {});
    await audit.emit({ kind: "mirror_purge", detail: { source: GHP, nested: ["fine", `${XOXB}-1234-abcd`] }, args: { id: "rb-deploy-prod" } });
    expect(sink.events[0]).toMatchObject({ detail: { source: "<redacted>", nested: ["fine", "<redacted>"] }, args: { id: "rb-deploy-prod" } });
  });

  // Codex merge gate, PR 1, round 19.
  it("records a list path only when the call showed that directory", async () => {
    const { service } = localAcme();
    const sink = new MemorySink();
    const { call, audit } = await connect(service, [sink], async () => LOCAL_IDENTITY);
    await call("list", { path: "runbooks" });
    await call("list", { path: "security" }); // team-only: not found for the local identity
    await audit.flush();
    expect(sink.events.map((e) => e.args)).toEqual([{ path: "runbooks" }, { path: "<withheld>" }]);
  });

  it("holds client names to a product-name shape, so they can't carry text or hex credentials", async () => {
    const { service } = localAcme();
    for (const [name, version, want] of [
      ["claude-code", "2.1.309", { name: "claude-code", version: "2.1.309" }],
      ["deploy steps: run kubectl", "1", { name: "<invalid>", version: "1" }],
      ["a1b2c3d4e5f6a7b8c9d0e1f2", "1", { name: "<invalid>", version: "1" }],
    ] as const) {
      const sink = new MemorySink();
      const audit = new AuditLog([sink], { session: "s1", server: SERVER }, () => NOW, () => {});
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createMcpServer(service).connect(auditTransport(serverSide, audit, async () => LOCAL_IDENTITY, { includeQueries: false, log: () => {} }));
      const client = new Client({ name, version });
      await client.connect(clientSide);
      await client.callTool({ name: "stale", arguments: {} });
      await audit.flush();
      await client.close();
      expect(sink.events[0]!.client).toEqual(want);
    }
  });

  it("rejects audit_log.required without audit_log.enabled", () => {
    expect(() => ConfigSchema.parse({ github: { org: "acme" }, audit_log: { required: true } })).toThrow(/audit_log\.required needs audit_log\.enabled: true/);
  });

  it("records query text only when include_queries is on", async () => {
    const { service } = localAcme();
    const sink = new MemorySink();
    const { call, audit } = await connect(service, [sink], async () => LOCAL_IDENTITY, true);
    await call("search", { query: "rollback a deploy" });
    await audit.flush();
    expect(sink.events[0]!.args).toEqual({ query: "rollback a deploy" });
  });

  it("fails closed: a read whose event a required sink can't take is not answered", async () => {
    const { service } = localAcme();
    const sink = new MemorySink(true);
    sink.fail = true;
    const { call } = await connect(service, [sink], async () => LOCAL_IDENTITY);
    const r = await call("read", { id: "rb-scale-cluster" });
    expect(r.isError).toBe(true);
    expect(r.data).toEqual({ error: { code: "unavailable", message: expect.stringMatching(/^the audit log \(memory\) could not record this call: disk full$/) } });
    expect(JSON.stringify(r)).not.toMatch(/autoscaler/);
  });

  // Codex merge gate, PR 1: with two required sinks, one may record "ok, returned these
  // pages" while the other fails and the caller gets `unavailable`. The working sink must
  // then learn the response was withheld.
  it("corrects the sinks that recorded a read the caller never received", async () => {
    const { service } = localAcme();
    const good = new MemorySink(true);
    const bad = new MemorySink(true);
    bad.fail = true;
    const { call, audit } = await connect(service, [good, bad], async () => LOCAL_IDENTITY);
    const r = await call("read", { id: "rb-scale-cluster" });
    await audit.flush();
    expect(r.data!.error.code).toBe("unavailable");
    expect(good.events.map((e) => [e.seq, e.outcome, e.code ?? null, e.returned ?? null, e.detail ?? null])).toEqual([
      [1, "ok", null, ["rb-scale-cluster"], null],
      [2, "error", "audit_unavailable", null, { withheld_seq: 1 }],
    ]);
  });

  // Codex merge gate, PR 1, round 6: a backed-up sink must still get its correction.
  it("delivers the correction even to a sink that is at its queue limit", async () => {
    const { service } = localAcme();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: AuditSink & { events: AuditEvent[] } = {
      name: "slow",
      required: true,
      maxQueue: 1,
      events: [],
      async write(e) {
        await gate;
        this.events.push(e);
      },
    };
    const bad = new MemorySink(true);
    bad.fail = true;
    const { call, audit } = await connect(service, [slow, bad], async () => LOCAL_IDENTITY);
    // The refusal waits for every required sink to settle, so let the slow one finish.
    const pending = call("read", { id: "rb-scale-cluster" });
    release();
    const r = await pending;
    expect(r.data!.error.code).toBe("unavailable");
    await audit.flush();
    expect(slow.events.map((e) => [e.seq, e.outcome, e.code ?? null])).toEqual([
      [1, "ok", null],
      [2, "error", "audit_unavailable"],
    ]);
  });

  // Codex merge gate, PR 1, round 13: corrections stay bounded where they could pile up.
  it("an optional sink at its limit drops the correction (bounded) and warns, instead of queuing it anyway", async () => {
    const { service } = localAcme();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: AuditSink & { events: AuditEvent[] } = { name: "slow", required: false, maxQueue: 1, events: [], async write(e) { await gate; this.events.push(e); } };
    const bad = new MemorySink(true);
    bad.fail = true;
    const warnings: string[] = [];
    const audit = new AuditLog([slow, bad], { session: "s1", server: SERVER }, () => NOW, (m) => warnings.push(m));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service).connect(auditTransport(serverSide, audit, async () => LOCAL_IDENTITY, { includeQueries: false, log: () => {} }));
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientSide);
    cleanups.push(() => void client.close());
    await client.callTool({ name: "read", arguments: { id: "rb-scale-cluster" } });
    await new Promise((r) => setTimeout(r, 20));
    release();
    await audit.flush();
    expect(slow.events.map((e) => e.outcome)).toEqual(["ok"]);
    expect(warnings).toEqual(["audit sink slow is failing (queue is full (1 events waiting)); events to it are being dropped"]);
  });

  it("corrects the sinks that recorded a write intent when the write was refused", async () => {
    const acme = acmeOnGitHub();
    cleanups.push(acme.cleanup);
    const gh = new FakeGitHub("acme/knowledge", "acme", { alice: { login: "alice", teams: ["platform"], push: true } }, acme.root);
    const identity = new IdentityProvider(loadConfig(acme.root), new GitHubClient("alice", { fetch: gh.fetch }));
    const good = new MemorySink(true);
    const bad = new MemorySink(true);
    bad.fail = true;
    const { call, audit } = await connect(new KnowledgeService(acme.root, identity, () => NOW), [good, bad], () => identity.get());
    await call("verify", { id: "rb-deploy-prod" });
    await audit.flush();
    expect(good.events.map((e) => [e.kind, e.code ?? null, e.detail ?? null])).toEqual([
      ["tool_intent", null, null],
      ["tool_call", "audit_unavailable", { withheld_seq: 1 }],
    ]);
    expect(gh.pulls).toEqual([]);
  });

  it("an optional sink that fails never blocks or changes a call", async () => {
    const { service } = localAcme();
    const sink = new MemorySink(false);
    sink.fail = true;
    const { call } = await connect(service, [sink], async () => LOCAL_IDENTITY);
    const r = await call("read", { id: "rb-scale-cluster" });
    expect(r.isError).toBe(false);
    expect(r.data!.content).toMatch(/autoscaler/);
  });

  it("gives 50 concurrent calls distinct seq values, written in order", async () => {
    const { root, service } = localAcme();
    const dir = join(root, "..", `audit-${Date.now()}`);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { call, audit } = await connect(service, [new FileSink(dir, true, 30, NOW)], async () => LOCAL_IDENTITY);
    await Promise.all(Array.from({ length: 50 }, (_, i) => call("search", { query: i % 2 ? "deploy" : "rollback" })));
    await audit.flush();
    const seqs = readFileSync(join(dir, "audit-2026-11-02.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as AuditEvent).seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe("write tools record their intent before GitHub sees anything", () => {
  function githubService() {
    const acme = acmeOnGitHub();
    cleanups.push(acme.cleanup);
    const gh = new FakeGitHub("acme/knowledge", "acme", { alice: { login: "alice", teams: ["platform"], push: true } }, acme.root);
    const identity = new IdentityProvider(loadConfig(acme.root), new GitHubClient("alice", { fetch: gh.fetch }));
    return { gh, identity, service: new KnowledgeService(acme.root, identity, () => NOW) };
  }
  const writes = (gh: FakeGitHub) => gh.requests.filter((r) => r.method !== "GET").length;

  it("writes intent, then the outcome with the PR link", async () => {
    const { gh, identity, service } = githubService();
    let writesAtIntent = -1;
    const sink = new MemorySink(true, (e) => {
      if (e.kind === "tool_intent") writesAtIntent = writes(gh);
    });
    const { call, audit } = await connect(service, [sink], () => identity.get());
    const r = await call("propose_edit", { id: "rb-rollback-deploy", edits: [{ old: "within 5 minutes", new: "within 10 minutes" }], reason: "INC-42" });
    await audit.flush();
    expect(r.isError).toBe(false);
    expect(writesAtIntent).toBe(0);
    expect(sink.events.map((e) => e.kind)).toEqual(["tool_intent", "tool_call"]);
    expect(sink.events[1]).toMatchObject({ tool: "propose_edit", outcome: "ok", pr_url: r.data!.pr_url, actor: { login: "alice", mode: "github", teams: ["platform"] } });
    expect(JSON.stringify(sink.events)).not.toMatch(/within 10 minutes|INC-42/);
  });

  it("refuses the write, and opens no PR, when a required sink can't take the intent", async () => {
    const { gh, identity, service } = githubService();
    const sink = new MemorySink(true);
    sink.fail = true;
    const { call } = await connect(service, [sink], () => identity.get());
    const r = await call("propose_edit", { id: "rb-rollback-deploy", edits: [{ old: "within 5 minutes", new: "within 10 minutes" }], reason: "INC-42" });
    expect(r.data).toEqual({ error: { code: "unavailable", message: "the audit log (memory) could not record this call: disk full" } });
    expect(gh.pulls).toEqual([]);
    expect(writes(gh)).toBe(0);
  });
});

describe("review fixes, round 29", () => {
  it("records tools named like Object built-ins as unknown, without breaking", async () => {
    const { service } = localAcme();
    const sink = new MemorySink();
    const { call, audit } = await connect(service, [sink], async () => LOCAL_IDENTITY);
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) await call(name, { id: "x" });
    await audit.flush();
    // Each is refused and recorded, never as its raw name and with no arguments. (The SDK's
    // own lookup also finds inherited keys and calls them "disabled", hence forbidden.)
    expect(sink.events).toHaveLength(4);
    for (const e of sink.events) {
      expect(["<unknown>", "<invalid>"]).toContain(e.tool);
      expect(e.outcome === "error" || e.outcome === "denied").toBe(true);
      expect(e.args).toBeUndefined();
    }
  });

  it("keeps a write's id reserved until its response is out, so a duplicate can't open a second PR", async () => {
    const acme = acmeOnGitHub();
    cleanups.push(acme.cleanup);
    const gh = new FakeGitHub("acme/knowledge", "acme", { alice: { login: "alice", teams: ["platform"], push: true } }, acme.root);
    const identity = new IdentityProvider(loadConfig(acme.root), new GitHubClient("alice", { fetch: gh.fetch }));
    const service = new KnowledgeService(acme.root, identity, () => NOW);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const slow: AuditSink = { name: "slow", required: true, async write() { if (n++ === 1) await gate; } }; // holds the outcome
    const audit = new AuditLog([slow], { session: "s1", server: SERVER }, () => NOW, () => {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service).connect(auditTransport(serverSide, audit, () => identity.get(), { includeQueries: false, log: () => {} }));
    clientSide.onmessage = () => {};
    await clientSide.start();
    const call = { jsonrpc: "2.0" as const, id: 3, method: "tools/call", params: { name: "verify", arguments: { id: "rb-deploy-prod" } } };
    await clientSide.send(call);
    for (let i = 0; i < 50 && gh.pulls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20)); // the outcome is now being recorded, held by the gate
    const writesAfterFirst = gh.requests.filter((r) => r.method !== "GET").length;
    await clientSide.send(call); // same id
    release();
    await new Promise((r) => setTimeout(r, 100));
    // Count GitHub writes, not PRs: with a fixed clock a second verify would reuse the
    // first's branch and PR, so only the write requests show whether it ran again.
    const writes = gh.requests.filter((r) => r.method !== "GET").length;
    expect(gh.pulls).toHaveLength(1);
    expect(writes).toBe(writesAfterFirst);
    await clientSide.close();
  });
});

describe("review fixes, round 28", () => {
  it("refuses any request that reuses an in-flight tool call's id, whatever its method", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const slow = { get: async () => (await new Promise((r) => setTimeout(r, 60)), LOCAL_IDENTITY), fresh: async () => LOCAL_IDENTITY, github: null };
    const service = new KnowledgeService(acme.root, slow, () => NOW);
    const down = new MemorySink(true);
    down.fail = true; // a required sink is down: the read must not get out
    const audit = new AuditLog([down], { session: "s1", server: SERVER }, () => NOW, () => {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service).connect(auditTransport(serverSide, audit, async () => LOCAL_IDENTITY, { includeQueries: false, log: () => {} }));
    const replies: JSONRPCMessage[] = [];
    clientSide.onmessage = (m) => void replies.push(m);
    await clientSide.start();
    await clientSide.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read", arguments: { id: "rb-scale-cluster" } } });
    await clientSide.send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }); // same id, another method
    await new Promise((r) => setTimeout(r, 150));
    expect(JSON.stringify(replies)).not.toMatch(/autoscaler/);
    expect(replies.filter((m) => "id" in m && m.id === 5)).toHaveLength(2);
    await clientSide.close();
  });
});

describe("review fixes, round 27", () => {
  it("each event names the knowledge snapshot it was answered from, refreshed on reload", async () => {
    const { root, service } = localAcme();
    const sink = new MemorySink();
    const { call, audit } = await connect(service, [sink], async () => LOCAL_IDENTITY);
    await call("list");
    const page = join(root, "knowledge/runbooks/rollback-deploy.md");
    writeFileSync(page, readFileSync(page, "utf8").replace("within 5 minutes", "within 6 minutes"));
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, ".knowledge/config.yaml"), later, later); // force a reload
    await call("list");
    await audit.flush();
    const [a, b] = sink.events.map((e) => e.snapshot!);
    expect(a!.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b!.content_sha256).not.toBe(a!.content_sha256);
  });
});

describe("review fixes, round 26", () => {
  it("a duplicate-id refusal that a required sink can't record is answered unavailable", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    // A slow identity keeps the first call inside its handler, so its id is truly in flight.
    const slow = { get: async () => (await new Promise((r) => setTimeout(r, 60)), LOCAL_IDENTITY), fresh: async () => LOCAL_IDENTITY, github: null };
    const service = new KnowledgeService(acme.root, slow, () => NOW);
    const down = new MemorySink(true);
    down.fail = true;
    const audit = new AuditLog([down], { session: "s1", server: SERVER }, () => NOW, () => {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service).connect(auditTransport(serverSide, audit, async () => LOCAL_IDENTITY, { includeQueries: false, log: () => {} }));
    const replies: JSONRPCMessage[] = [];
    clientSide.onmessage = (m) => void replies.push(m);
    await clientSide.start();
    const call = { jsonrpc: "2.0" as const, id: 9, method: "tools/call", params: { name: "stale", arguments: {} } };
    await clientSide.send(call);
    await clientSide.send(call); // same id while the first is still in its handler
    await new Promise((r) => setTimeout(r, 150));
    const forNine = replies.filter((m) => "id" in m && m.id === 9);
    expect(forNine).toHaveLength(2);
    // Neither is answered without a record: both are `unavailable`, the refusal included.
    for (const m of forNine) expect(m).toMatchObject({ result: { structuredContent: { error: { code: "unavailable" } } } });
    await clientSide.close();
  });
});

describe("review fixes, round 25: degraded audits are visible to the caller", () => {
  /** A required sink that takes the first `n` events, then fails. */
  class TakesN extends MemorySink {
    constructor(private n: number) {
      super(true);
    }
    override async write(e: AuditEvent): Promise<void> {
      if (this.n-- <= 0) throw new Error("collector down");
      this.events.push(e);
    }
  }

  it("a write whose outcome can't be recorded still returns its PR, marked audit.degraded", async () => {
    const acme = acmeOnGitHub();
    cleanups.push(acme.cleanup);
    const gh = new FakeGitHub("acme/knowledge", "acme", { alice: { login: "alice", teams: ["platform"], push: true } }, acme.root);
    const identity = new IdentityProvider(loadConfig(acme.root), new GitHubClient("alice", { fetch: gh.fetch }));
    const { call } = await connect(new KnowledgeService(acme.root, identity, () => NOW), [new TakesN(1)], () => identity.get());
    const r = await call("verify", { id: "rb-deploy-prod" });
    expect(r.data!.pr_url).toMatch(/\/pull\/1$/);
    expect(r.data!.audit).toEqual({ degraded: true, reason: expect.stringMatching(/^the outcome of verify couldn't be recorded \(the audit log \(memory\) could not record this call: collector down\); its intent was$/) });
  });

  it("a refused read whose correction can't land says the log may be wrong", async () => {
    const { service } = localAcme();
    const bad = new MemorySink(true);
    bad.fail = true;
    const { call } = await connect(service, [new TakesN(1), bad], async () => LOCAL_IDENTITY);
    const r = await call("read", { id: "rb-scale-cluster" });
    expect(r.data).toMatchObject({ error: { code: "unavailable" }, audit: { degraded: true, reason: expect.stringMatching(/that log may show this call as answered$/) } });
  });
});

describe("review fixes, round 23", () => {
  it("records a free-form argument only if the repo itself uses that value", async () => {
    const { service } = localAcme();
    const sink = new MemorySink();
    const { call, audit } = await connect(service, [sink], async () => LOCAL_IDENTITY);
    const hex = "0123456789abcdef0123456789abcdef"; // a lowercase credential passes every shape check
    await call("search", { query: "q", applies_to: hex, owner_team: hex });
    await call("read", { id: hex });
    await call("search", { query: "q", applies_to: "service:payments", owner_team: "payments" });
    await call("read", { id: "svc-ledger" }); // a real (hidden) page id is the documented exception
    await audit.flush();
    expect(sink.events.map((e) => e.args)).toEqual([
      { owner_team: "<unknown>", applies_to: "<unknown>" },
      { id: "<unknown>" },
      { owner_team: "payments", applies_to: "service:payments" },
      { id: "svc-ledger" },
    ]);
    expect(JSON.stringify(sink.events)).not.toContain(hex);
  });

  it("rejects a misspelled policy or audit_log key instead of ignoring it", () => {
    expect(() => ConfigSchema.parse({ github: { org: "acme" }, policy: { write: "disabled" } })).toThrow(/write/);
    expect(() => ConfigSchema.parse({ github: { org: "acme" }, audit_log: { enabled: true, requred: true } })).toThrow(/requred/);
  });

  // Codex merge gate, PR 1, round 24: the block names themselves, too.
  it("rejects a misspelled top-level block, and still accepts audit_http for pro", () => {
    expect(() => ConfigSchema.parse({ github: { org: "acme" }, polciy: { writes: "disabled" } })).toThrow(/polciy/);
    expect(() => ConfigSchema.parse({ github: { org: "acme" }, audit_lgo: { enabled: true } })).toThrow(/audit_lgo/);
    expect(ConfigSchema.parse({ github: { org: "acme" }, audit_http: { url_env: "X" } }).github.org).toBe("acme");
  });
});

describe("review fixes, round 22", () => {
  it("refuses a tools/call that reuses an in-flight id, so no response escapes the audit", async () => {
    const { service } = localAcme();
    const good = new MemorySink(true);
    const bad = new MemorySink(true);
    bad.fail = true; // a required sink is down: every read must be refused
    const audit = new AuditLog([good, bad], { session: "s1", server: SERVER }, () => NOW, () => {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service).connect(auditTransport(serverSide, audit, async () => LOCAL_IDENTITY, { includeQueries: false, log: () => {} }));
    const replies: JSONRPCMessage[] = [];
    clientSide.onmessage = (m) => void replies.push(m);
    await clientSide.start();
    await clientSide.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    const call = { jsonrpc: "2.0" as const, id: 7, method: "tools/call", params: { name: "read", arguments: { id: "rb-scale-cluster" } } };
    await Promise.all([clientSide.send(call), clientSide.send(call)]);
    await new Promise((r) => setTimeout(r, 50));
    await audit.flush();
    const forSeven = replies.filter((m) => "id" in m && m.id === 7);
    expect(forSeven).toHaveLength(2);
    expect(JSON.stringify(forSeven)).not.toMatch(/autoscaler/); // the page body never went out
    expect(good.events.map((e) => e.code)).toEqual(expect.arrayContaining(["duplicate_request_id", "audit_unavailable"]));
    await clientSide.close();
  });
});

describe("review fixes, round 20", () => {
  it("writeAll keeps writing until every byte is down", () => {
    const got: Buffer[] = [];
    const dribble = (_fd: number, buf: Buffer, off: number, len: number) => {
      const n = Math.min(3, len); // a write that only ever takes 3 bytes
      got.push(buf.subarray(off, off + n));
      return n;
    };
    writeAll(7, '{"v":1,"kind":"tool_call"}\n', dribble);
    expect(Buffer.concat(got).toString()).toBe('{"v":1,"kind":"tool_call"}\n');
  });

  it("sends the refusal only once the correction is recorded", async () => {
    const { service } = localAcme();
    const slow: AuditSink & { events: AuditEvent[] } = {
      name: "slow",
      required: true,
      events: [],
      async write(e) {
        await new Promise((r) => setTimeout(r, 25));
        this.events.push(e);
      },
    };
    const bad = new MemorySink(true);
    bad.fail = true;
    const { call } = await connect(service, [slow, bad], async () => LOCAL_IDENTITY);
    const r = await call("read", { id: "rb-scale-cluster" });
    expect(r.data!.error.code).toBe("unavailable");
    // No flush: by the time the caller has the refusal, the correction is already down.
    expect(slow.events.map((e) => e.code ?? "ok")).toEqual(["ok", "audit_unavailable"]);
  });
});

describe("the file sink", () => {
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "docsworth-audit-"));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
  };
  const event = (ts = NOW.toISOString()): AuditEvent => ({ v: 1, ts, seq: 1, kind: "tool_call", session: "s", server: SERVER });

  // Codex merge gate, PR 1, round 16: an audit dir must be Docsworth's own.
  it("refuses, untouched, an existing directory that isn't an audit directory (say $HOME)", () => {
    const home = tmp();
    chmodSync(home, 0o755);
    writeFileSync(join(home, ".bashrc"), "x");
    writeFileSync(join(home, "audit-2020-01-01.jsonl"), "unrelated, but shaped like ours");
    expect(() => new FileSink(home, true, 30, NOW)).toThrow(/holds \.bashrc and isn't a Docsworth audit directory \(no \.docsworth-audit\); use a directory of its own$/);
    expect(statSync(home).mode & 0o777).toBe(0o755); // not chmodded
    expect(existsSync(join(home, "audit-2020-01-01.jsonl"))).toBe(true); // not pruned
    expect(existsSync(join(home, AUDIT_MARKER))).toBe(false);
  });

  it("adopts a new directory, or one holding only audit files, by marking it", () => {
    const fresh = join(tmp(), "audit");
    new FileSink(fresh, true, 30, NOW);
    expect(existsSync(join(fresh, AUDIT_MARKER))).toBe(true);
    const old = tmp();
    writeFileSync(join(old, "audit-2026-11-01.jsonl"), "");
    new FileSink(old, true, 30, NOW);
    expect(existsSync(join(old, AUDIT_MARKER))).toBe(true);
  });

  it("creates a 0700 directory and 0600 daily files", async () => {
    const dir = join(tmp(), "audit");
    const sink = new FileSink(dir, true, 30, NOW);
    await sink.write(event(), "{}");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "audit-2026-11-02.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked directory", () => {
    const base = tmp();
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    expect(() => new FileSink(join(base, "link"), true, 30, NOW)).toThrow(/is a symlink; refusing to write through it$/);
  });

  it("refuses to write through a symlink planted at the day's file", async () => {
    const dir = tmp();
    const elsewhere = join(tmp(), "elsewhere");
    writeFileSync(elsewhere, "");
    symlinkSync(elsewhere, join(dir, "audit-2026-11-02.jsonl"));
    const sink = new FileSink(dir, true, 30, NOW);
    await expect(sink.write(event(), "{}")).rejects.toMatchObject({ code: "ELOOP" });
    expect(readFileSync(elsewhere, "utf8")).toBe("");
  });

  it("prunes daily files past the retention window, and nothing else", () => {
    const dir = tmp();
    writeFileSync(join(dir, AUDIT_MARKER), ""); // a marked audit dir may hold other files
    for (const f of ["audit-2026-10-01.jsonl", "audit-2026-10-04.jsonl", "notes.txt"]) writeFileSync(join(dir, f), "");
    new FileSink(dir, true, 30, NOW); // cutoff 2026-10-03
    expect(["audit-2026-10-01.jsonl", "audit-2026-10-04.jsonl", "notes.txt"].map((f) => existsSync(join(dir, f)))).toEqual([false, true, true]);
  });
});

describe("review fixes: the audit log's edges", () => {
  it("attributes an event to the last resolved identity, and says so, when identity fails mid-session", async () => {
    const { service } = localAcme();
    const sink = new MemorySink();
    let fail = false;
    const { call, audit } = await connect(service, [sink], async () => {
      if (fail) throw new Error("GitHub down");
      return { ...LOCAL_IDENTITY, login: "alice" };
    });
    await call("list");
    fail = true;
    await call("list");
    await audit.flush();
    expect(sink.events[1]).toMatchObject({ actor: { login: "alice" }, detail: { actor_unresolved: true } });
  });

  // Codex merge gate, PR 1, round 5: name the person even when the very first lookup fails.
  it("falls back to the identity proven at server start when the first lookup fails", async () => {
    const { service } = localAcme();
    const sink = new MemorySink();
    const audit = new AuditLog([sink], { session: "s1", server: SERVER }, () => NOW, () => {});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const down = async (): Promise<Identity> => {
      throw new Error("GitHub down");
    };
    const initialActor = { login: "alice", mode: "github" as const, teams: ["platform"] };
    await createMcpServer(service).connect(auditTransport(serverSide, audit, down, { includeQueries: false, log: () => {}, initialActor }));
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientSide);
    cleanups.push(() => void client.close());
    await client.callTool({ name: "list", arguments: {} });
    await audit.flush();
    expect(sink.events[0]).toMatchObject({ actor: initialActor, detail: { actor_unresolved: true } });
  });

  it("tightens an existing audit directory and day file to 0700 and 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docsworth-audit-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "audit-2026-11-02.jsonl"), "", { mode: 0o644 });
    const sink = new FileSink(dir, true, 30, NOW);
    await sink.write({ v: 1, ts: NOW.toISOString(), seq: 1, kind: "tool_call", session: "s", server: SERVER }, "{}");
    expect([statSync(dir).mode & 0o777, statSync(join(dir, "audit-2026-11-02.jsonl")).mode & 0o777]).toEqual([0o700, 0o600]);
  });

  // Codex merge gate, PR 1, round 9: containment is judged on canonical paths.
  // Codex merge gate, PR 1, round 10: ignored isn't enough if files there are tracked.
  it("refuses an ignored audit dir that already holds tracked files", () => {
    const repo = mkdtempSync(join(tmpdir(), "docsworth-git-"));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", repo]);
    mkdirSync(join(repo, "state/audit"), { recursive: true });
    writeFileSync(join(repo, "state/audit/audit-2026-10-01.jsonl"), "{}\n");
    execFileSync("git", ["-C", repo, "add", "state/audit/audit-2026-10-01.jsonl"]);
    writeFileSync(join(repo, ".gitignore"), "state/\n");
    expect(() => resolveAuditDir(repo, "state/audit")).toThrow(/^audit_log\.dir state\/audit is ignored by git but already holds tracked files \(state\/audit\/audit-2026-10-01\.jsonl\);/);
  });

  it("treats a path that runs through a symlink into the repo as inside", () => {
    const repo = mkdtempSync(join(tmpdir(), "docsworth-git-"));
    const outside = mkdtempSync(join(tmpdir(), "docsworth-outside-"));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", repo]);
    mkdirSync(join(repo, "state"));
    symlinkSync(join(repo, "state"), join(outside, "link"));
    expect(() => resolveAuditDir(repo, join(outside, "link/audit"))).toThrow(/is inside the repository and not ignored by git;/);
  });

  it("treats a directory named ..audit inside the repo as inside", () => {
    const repo = mkdtempSync(join(tmpdir(), "docsworth-git-"));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", repo]);
    expect(() => resolveAuditDir(repo, "..audit")).toThrow(/^audit_log\.dir \.\.audit is inside the repository and not ignored by git;/);
  });

  it("refuses when git can't answer at all (e.g. not installed), rather than assume it's safe", () => {
    const repo = mkdtempSync(join(tmpdir(), "docsworth-git-"));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    const PATH = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(() => resolveAuditDir(repo, ".knowledge/audit")).toThrow(/^couldn't confirm that audit_log\.dir \.knowledge\/audit is ignored by git/);
    } finally {
      process.env.PATH = PATH;
    }
  });

  it("refuses the repository root itself, and a default state dir that lands inside the repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "docsworth-git-"));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", repo]);
    expect(() => resolveAuditDir(repo, ".")).toThrow(/^audit_log\.dir \. is inside the repository and not ignored by git;/);
    expect(() => resolveAuditDir(repo, undefined, { XDG_STATE_HOME: join(repo, "state") })).toThrow(/is inside the repository and not ignored by git;/);
  });
});

describe("where the audit log lives", () => {
  it("defaults to a state directory outside the checkout", () => {
    const dir = defaultAuditDir("/work/acme-knowledge", { XDG_STATE_HOME: "/state" });
    expect(dir).toMatch(/^\/state\/docsworth\/acme-knowledge-[0-9a-f]{8}\/audit$/);
  });

  it("refuses a directory inside the repository that git doesn't ignore, and accepts an ignored one", () => {
    const repo = mkdtempSync(join(tmpdir(), "docsworth-git-"));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", repo]);
    expect(() => resolveAuditDir(repo, ".knowledge/audit")).toThrow(/^audit_log\.dir \.knowledge\/audit is inside the repository and not ignored by git;/);
    writeFileSync(join(repo, ".gitignore"), ".knowledge/audit/\n");
    expect(resolveAuditDir(repo, ".knowledge/audit")).toBe(join(repo, ".knowledge/audit"));
  });

  // Codex merge gate, PR 1, round 7: optional means best effort, even at setup.
  it("an optional log that can't be set up warns and is skipped; a required one refuses", () => {
    const repo = mkdtempSync(join(tmpdir(), "docsworth-git-"));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q", repo]);
    const config = (required: boolean) => ConfigSchema.parse({ github: { org: "acme" }, audit_log: { enabled: true, required, dir: ".knowledge/audit" } });
    const logs: string[] = [];
    expect(createAuditLog(repo, config(false), [], { log: (m) => logs.push(m) })).toBeNull();
    expect(logs).toEqual([expect.stringMatching(/^audit log disabled for this run: audit_log\.dir \.knowledge\/audit is inside the repository and not ignored by git;/)]);
    expect(() => createAuditLog(repo, config(true), [], { log: () => {} })).toThrow(/is inside the repository and not ignored by git/);
  });

  it("is off unless enabled, so v0.1 behaviour is unchanged", () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const config = loadConfig(acme.root);
    expect(config.audit_log.enabled).toBe(false);
    expect(createAuditLog(acme.root, config)).toBeNull();
  });
});

describe("docsworth mcp with the audit log on (real entry point)", () => {
  it("writes server_start, the calls and server_stop to the state directory", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const state = mkdtempSync(join(tmpdir(), "docsworth-state-"));
    cleanups.push(() => rmSync(state, { recursive: true, force: true }));
    const cfgFile = join(acme.root, ".knowledge/config.yaml");
    writeFileSync(cfgFile, `${readFileSync(cfgFile, "utf8")}audit_log:\n  enabled: true\n  required: true\n`);
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DOCSWORTH_NO_GH_CLI: "1", XDG_STATE_HOME: state };
    const client = new Client({ name: "docsworth-e2e", version: "0" });
    await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/cli.ts", "--as-of", "2026-11-02", "mcp", acme.root], env, stderr: "ignore" }));
    await client.callTool({ name: "search", arguments: { query: "rollback" } });
    await client.callTool({ name: "read", arguments: { id: "svc-ledger" } });
    await client.close();

    const dir = defaultAuditDir(acme.root, env);
    let lines: AuditEvent[] = [];
    for (let i = 0; i < 50 && !lines.some((e) => e.kind === "server_stop"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      const f = spawnSync("sh", ["-c", `cat "${dir}"/audit-*.jsonl 2>/dev/null`], { encoding: "utf8" }).stdout;
      lines = f.trim() ? f.trim().split("\n").map((l) => JSON.parse(l) as AuditEvent) : [];
    }
    expect(lines.map((e) => [e.kind, e.tool ?? null, e.code ?? null])).toEqual([
      ["server_start", null, null],
      ["tool_call", "search", null],
      ["tool_call", "read", "not_found"],
      ["server_stop", null, null],
    ]);
    expect(lines[0]!.detail).toMatchObject({ mode: "local", config_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // server_stop carries the same details, for the config in force at the end (round 27).
    expect(lines[3]!.detail).toMatchObject({ mode: "local", config_sha256: lines[0]!.detail!.config_sha256, policy: expect.any(Object) });
    expect(lstatSync(dir).isDirectory()).toBe(true);
  });
});
