import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { type AuditEvent, AuditLog, type AuditSink } from "../src/core/audit-log.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { SECURITY_HEADERS, type Serving, startServer } from "../src/core/serve/server.js";
import { WATCH_SETTLE_MS } from "../src/core/service.js";
import { copyAcme, fixedIdentity, NOW } from "./helpers.js";

const TOKEN = "t".repeat(43);
const EXT = "abcdefghijklmnopabcdefghijklmnop";

class MemorySink implements AuditSink {
  readonly name = "memory";
  readonly required = true;
  readonly events: AuditEvent[] = [];
  async write(e: AuditEvent): Promise<void> {
    this.events.push(e);
  }
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function serve(opts: { maxSessions?: number; idleMs?: number; webRoot?: string | null } = {}) {
  const acme = copyAcme();
  cleanups.push(acme.cleanup);
  const sink = new MemorySink();
  const audit = new AuditLog([sink], { session: "serve-run", server: { version: "test", repo: null, commit: null } }, () => NOW, () => {});
  const s: Serving = await startServer({
    root: acme.root,
    identity: fixedIdentity(LOCAL_IDENTITY),
    who: LOCAL_IDENTITY,
    audit,
    includeQueries: false,
    now: () => NOW,
    port: 0,
    token: TOKEN,
    extensions: new Set([EXT]),
    webRoot: opts.webRoot ?? null,
    maxSessions: opts.maxSessions,
    idleMs: opts.idleMs,
    log: () => {},
  });
  cleanups.push(() => s.close());
  return { s, sink, root: acme.root };
}

/** A raw request, with whatever headers (Host included) the test wants; `holdBody` sends the body later. */
function raw(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string; holdBody?: Promise<void> }) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((done, fail) => {
    const req = request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/", headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d));
      res.on("end", () => done({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", fail);
    if (!opts.holdBody) return void req.end(opts.body);
    req.flushHeaders();
    void opts.holdBody.then(() => req.end(opts.body));
  });
}

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

async function client(port: number, token = TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const c = new Client({ name: "docsworth-web", version: "0.0.1" });
  await c.connect(transport);
  return { c, transport };
}

describe("docsworth serve: listener and auth (R1–R3)", () => {
  it("listens on 127.0.0.1 only", async () => {
    const { s } = await serve();
    expect(s.server.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/#t=${TOKEN}`);
  });

  it("refuses /mcp without the token, or with a wrong one, as 401 with the security headers", async () => {
    const { s } = await serve();
    for (const authorization of [undefined, "Bearer nope", `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, TOKEN]) {
      const r = await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, ...(authorization ? { authorization } : {}) }, body: INIT });
      expect(r.status, String(authorization)).toBe(401);
      expect(JSON.parse(r.body)).toEqual({ error: { code: "unauthorized", message: "a valid bearer token is required" } });
      expect(r.headers["www-authenticate"]).toBe('Bearer realm="docsworth"');
      expect(r.headers["content-security-policy"]).toBe(SECURITY_HEADERS["content-security-policy"]);
    }
    expect(s.sessions.size).toBe(0);
  });

  it("refuses a foreign Host, even with the token (DNS rebinding)", async () => {
    const { s } = await serve();
    for (const host of ["evil.example", `evil.example:${s.port}`, `127.0.0.1:${s.port + 1}`, "127.0.0.1"]) {
      const r = await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, host, authorization: `Bearer ${TOKEN}` }, body: INIT });
      expect(r.status, host).toBe(403);
      expect(JSON.parse(r.body).error.message).toBe("this server answers only to 127.0.0.1 and localhost on its own port");
    }
    // The static app too.
    expect((await raw(s.port, { headers: { host: "evil.example" } })).status).toBe(403);
  });

  it("refuses a foreign Origin, even with the token, and gives it no CORS headers", async () => {
    const { s } = await serve();
    for (const origin of ["https://evil.example", "null", `http://127.0.0.1:${s.port + 1}`, "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba"]) {
      const r = await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, origin, authorization: `Bearer ${TOKEN}` }, body: INIT });
      expect(r.status, origin).toBe(403);
      expect(JSON.parse(r.body).error.message).toMatch(/^requests from this origin are not allowed/);
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect(s.sessions.size).toBe(0);
  });

  it("answers an allowed extension's preflight without the token, and only after Host and Origin pass", async () => {
    const { s } = await serve();
    const ok = await raw(s.port, { method: "OPTIONS", path: "/mcp", headers: { origin: `chrome-extension://${EXT}`, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, mcp-session-id" } });
    expect(ok.status).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(`chrome-extension://${EXT}`);
    expect(ok.headers["access-control-allow-headers"]).toMatch(/authorization/);
    expect(ok.headers["access-control-expose-headers"]).toBe("mcp-session-id");
    expect(ok.headers.vary).toBe("Origin");
    const evil = await raw(s.port, { method: "OPTIONS", path: "/mcp", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const rebound = await raw(s.port, { method: "OPTIONS", path: "/mcp", headers: { host: "evil.example", origin: `chrome-extension://${EXT}` } });
    expect(rebound.status).toBe(403);
  });

  it("serves an allowed extension with CORS headers, and the same-origin app without them", async () => {
    const { s } = await serve();
    const ext = await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, origin: `chrome-extension://${EXT}`, authorization: `Bearer ${TOKEN}` }, body: INIT });
    expect(ext.status).toBe(200);
    expect(ext.headers["access-control-allow-origin"]).toBe(`chrome-extension://${EXT}`);
    expect(ext.headers["mcp-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const app = await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, origin: `http://127.0.0.1:${s.port}`, authorization: `Bearer ${TOKEN}` }, body: INIT });
    expect(app.status).toBe(200);
    expect(app.headers["access-control-allow-origin"]).toBeUndefined();
    expect(app.headers["content-security-policy"]).toBe(SECURITY_HEADERS["content-security-policy"]);
  });
});

describe("docsworth serve: MCP sessions (R11)", () => {
  it("serves the tools over HTTP, audits the call with the client's name, and ends the session on DELETE", async () => {
    const { s, sink } = await serve();
    const { c, transport } = await client(s.port);
    expect(s.sessions.size).toBe(1);
    const r = await c.callTool({ name: "search", arguments: { query: "deploy to production" } });
    expect((r.structuredContent as { results: { id: string }[] }).results.map((x) => x.id)).toContain("rb-deploy-prod");
    const event = sink.events.find((e) => e.kind === "tool_call" && e.tool === "search");
    expect(event).toMatchObject({ outcome: "ok", client: { name: "docsworth-web", version: "0.0.1" }, actor: { mode: "local" } });
    await transport.terminateSession();
    await c.close();
    expect(s.sessions.size).toBe(0);
  });

  it("shuts down promptly while a client still holds a stream open (Ctrl-C with a tab open)", async () => {
    const { s } = await serve();
    const init = await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` }, body: INIT });
    const sid = init.headers["mcp-session-id"] as string;
    // A tab's standing event stream, and a call whose body never finishes arriving: both open.
    const held = [
      request({ host: "127.0.0.1", port: s.port, method: "GET", path: "/mcp", headers: { host: `127.0.0.1:${s.port}`, accept: "text/event-stream", authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" } }),
      request({ host: "127.0.0.1", port: s.port, method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, host: `127.0.0.1:${s.port}`, authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18", "content-length": "1000" } }),
    ];
    for (const r of held) {
      r.on("error", () => {});
      r.flushHeaders();
    }
    await new Promise((r) => setTimeout(r, 100));
    const closed = await Promise.race([s.close().then(() => "closed"), new Promise((r) => setTimeout(() => r("still waiting"), 3000))]);
    expect(closed).toBe("closed");
    for (const r of held) r.destroy();
  });

  it("refuses a request for an unknown session as not found", async () => {
    const { s } = await serve();
    const r = await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}`, "mcp-session-id": "00000000-0000-0000-0000-000000000000" }, body: INIT });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: { code: "not_found", message: "no such session; it may have expired: start a new one" } });
  });

  it("keeps a first request that isn't an initialize from leaving a session behind", async () => {
    const { s } = await serve();
    const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const r = await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` }, body: call });
    expect(r.status).toBe(400);
    expect(s.sessions.size).toBe(0);
  });

  const start = (port: number, holdBody?: Promise<void>) => raw(port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` }, body: INIT, holdBody });
  const LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const inSession = (port: number, sid: string, holdBody?: Promise<void>) =>
    raw(port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }, body: LIST, holdBody });
  const sidOf = (r: { headers: Record<string, string | string[] | undefined> }) => r.headers["mcp-session-id"] as string;
  /** Makes a session's close take a while, as a real audit sink's write can: the window a race needs. */
  const slowClose = (s: Serving, sid: string) => {
    const session = (s.sessions as unknown as { sessions: Map<string, { server: { close(): Promise<void> } }> }).sessions.get(sid)!;
    const close = session.server.close.bind(session.server);
    let closes = 0;
    session.server.close = async () => {
      closes++;
      await new Promise((r) => setTimeout(r, 50));
      await close();
    };
    return () => closes;
  };
  const BUSY = (n: number) => ({ error: { code: "unavailable", message: `this server is answering ${n} sessions at once; try again in a moment` } });

  it("holds the session cap under concurrent starts, and frees a slot when one ends", async () => {
    const { s } = await serve({ maxSessions: 3 });
    const sizes: number[] = [];
    const starts = await Promise.all(Array.from({ length: 8 }, () => start(s.port).then((r) => (sizes.push(s.sessions.size), r))));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
    expect(s.sessions.size).toBe(3);
    // Each start either got a session or found every slot busy: never anything else.
    for (const r of starts) expect(r.status === 200 || (r.status === 503 && JSON.parse(r.body).error.message === BUSY(3).error.message)).toBe(true);
    const live = (s.sessions as unknown as { sessions: Map<string, unknown> }).sessions;
    const id = starts.find((r) => r.status === 200 && live.has(sidOf(r)))!;
    const del = await raw(s.port, { method: "DELETE", path: "/mcp", headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": sidOf(id) } });
    expect(del.status).toBe(200);
    expect(s.sessions.size).toBe(2);
    expect((await start(s.port)).status).toBe(200);
  });

  it("makes room by closing the session idle longest, so closed tabs can't lock the user out", async () => {
    const { s } = await serve({ maxSessions: 2 });
    const a = sidOf(await start(s.port));
    const b = sidOf(await start(s.port));
    await new Promise((r) => setTimeout(r, 5));
    expect((await inSession(s.port, a)).status).toBe(200); // a was used after b: b is idle longest
    const c = await start(s.port);
    expect(c.status).toBe(200);
    expect(s.sessions.size).toBe(2);
    const gone = await inSession(s.port, b);
    expect(gone.status).toBe(404);
    expect(JSON.parse(gone.body)).toEqual({ error: { code: "not_found", message: "no such session; it may have expired: start a new one" } });
    expect((await inSession(s.port, a)).status).toBe(200);
    expect((await inSession(s.port, sidOf(c))).status).toBe(200);
    expect(s.sessions.size).toBe(2);
  });

  it("reclaims a different idle session for each of several starts arriving at once", async () => {
    const { s } = await serve({ maxSessions: 3 });
    const old = [];
    for (let i = 0; i < 3; i++) old.push(sidOf(await start(s.port)));
    const closes = old.map((sid) => slowClose(s, sid));
    const sizes: number[] = [];
    const fresh = await Promise.all(Array.from({ length: 3 }, () => start(s.port).then((r) => (sizes.push(s.sessions.size), r))));
    expect(fresh.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
    const live = (s.sessions as unknown as { sessions: Map<string, unknown> }).sessions;
    expect([...live.keys()].sort()).toEqual(fresh.map(sidOf).sort());
    for (const sid of old) expect((await inSession(s.port, sid)).status).toBe(404);
    expect(closes.map((n) => n())).toEqual([1, 1, 1]);
  });

  it("closes a session once when the sweep and a start both want it", async () => {
    const { s } = await serve({ maxSessions: 1 });
    const a = sidOf(await start(s.port));
    const closes = slowClose(s, a);
    const sweeping = s.sessions.sweep(Date.now() + 60 * 60_000); // a is past its idle limit
    const b = await start(s.port); // arrives while the sweep is still closing a
    await sweeping;
    expect(b.status).toBe(200);
    expect(closes()).toBe(1);
    expect(s.sessions.size).toBe(1);
  });

  it("reclaims nothing for a first request that can't start a session", async () => {
    const { s } = await serve({ maxSessions: 1 });
    const kept = sidOf(await start(s.port));
    const post = (headers: Record<string, string>, body: string) => raw(s.port, { method: "POST", path: "/mcp", headers: { authorization: `Bearer ${TOKEN}`, ...headers }, body });
    const notInit = await post(MCP_HEADERS, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(notInit.status).toBe(400);
    expect(JSON.parse(notInit.body)).toEqual({ error: { code: "invalid", message: "start a session with an initialize request" } });
    expect((await post(MCP_HEADERS, "{not json")).status).toBe(400);
    expect((await post(MCP_HEADERS, JSON.stringify([JSON.parse(INIT), JSON.parse(INIT)]))).status).toBe(400);
    const json = await post({ ...MCP_HEADERS, accept: "application/json" }, INIT);
    expect(json.status).toBe(406);
    expect(JSON.parse(json.body).error.code).toBe("invalid");
    expect((await post({ ...MCP_HEADERS, "content-type": "text/plain" }, INIT)).status).toBe(415);
    expect((await inSession(s.port, kept)).status).toBe(200); // still there
    expect(s.sessions.size).toBe(1);
    expect((await start(s.port)).status).toBe(200); // a real start still makes room
  });

  it("never closes a session with a request in flight: with every slot busy, a new one is refused", async () => {
    const { s } = await serve({ maxSessions: 2 });
    const a = sidOf(await start(s.port));
    const b = sidOf(await start(s.port));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const calls = [inSession(s.port, a, held), inSession(s.port, b, held)];
    await expect.poll(() => (s.sessions as unknown as { sessions: Map<string, { active: number }> }).sessions.get(a)?.active).toBe(1);
    await expect.poll(() => (s.sessions as unknown as { sessions: Map<string, { active: number }> }).sessions.get(b)?.active).toBe(1);
    const refused = await start(s.port);
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual(BUSY(2));
    release();
    for (const r of await Promise.all(calls)) expect(r.status).toBe(200);
    expect((await start(s.port)).status).toBe(200); // idle again: one is reclaimed
    expect(s.sessions.size).toBe(2);
  });

  it("counts a session that is still starting against the cap, and never reclaims it", async () => {
    const { s } = await serve({ maxSessions: 1 });
    // A's slot is counted, and its transport hasn't started it yet: no session id. (Its body
    // is read before the slot is counted, so the hold is in the transport, not the body.)
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    const proto = StreamableHTTPServerTransport.prototype;
    const handle = proto.handleRequest;
    let first = true;
    proto.handleRequest = async function (this: StreamableHTTPServerTransport, ...args: Parameters<typeof handle>) {
      if (first) {
        first = false;
        await holding;
      }
      return handle.apply(this, args);
    };
    try {
      const a = start(s.port);
      await expect.poll(() => (s.sessions as unknown as { starting: number }).starting).toBe(1);
      expect(s.sessions.size).toBe(0);
      const b = await start(s.port);
      expect(b.status).toBe(503);
      expect(JSON.parse(b.body)).toEqual(BUSY(1));
      release();
      expect((await a).status).toBe(200);
      expect(s.sessions.size).toBe(1);
    } finally {
      proto.handleRequest = handle;
    }
  });

  it("counts a started session once, from the moment it joins the table", async () => {
    const { s } = await serve({ maxSessions: 2 });
    // Holds the first request open after the session has joined the table (as a slow
    // client reading its answer would): until it ends, that session still counts as starting.
    const proto = StreamableHTTPServerTransport.prototype;
    const handle = proto.handleRequest;
    let held = false;
    proto.handleRequest = async function (this: StreamableHTTPServerTransport, ...args: Parameters<typeof handle>) {
      await handle.apply(this, args);
      if (!held) {
        held = true;
        await new Promise((r) => setTimeout(r, 300));
      }
    };
    try {
      const a = start(s.port);
      await expect.poll(() => s.sessions.size).toBe(1);
      const b = await start(s.port);
      expect(b.status).toBe(200);
      expect((await a).status).toBe(200);
      expect(s.sessions.size).toBe(2);
    } finally {
      proto.handleRequest = handle;
    }
  });

  it("expires idle sessions, closing their server and service", async () => {
    const { s } = await serve({ idleMs: 1000 });
    const { c } = await client(s.port);
    // A session used just now survives a sweep.
    await s.sessions.sweep(Date.now());
    expect(s.sessions.size).toBe(1);
    const [service] = s.sessions.services();
    const closed = new Promise<void>((done) => {
      const orig = service!.close.bind(service);
      service!.close = () => {
        orig();
        done();
      };
    });
    await s.sessions.sweep(Date.now() + 2000);
    await closed;
    expect(s.sessions.size).toBe(0);
    await c.close();
  });

  it("never expires a session while one of its requests is still in flight", async () => {
    const { s } = await serve({ idleMs: 1000 });
    const init = await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` }, body: INIT });
    const sid = init.headers["mcp-session-id"] as string;
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" };
    // A request whose body hasn't arrived yet: it is in flight until released.
    let release!: () => void;
    const slow = raw(s.port, { method: "POST", path: "/mcp", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), holdBody: new Promise<void>((r) => (release = r)) });
    const table = s.sessions as unknown as { sessions: Map<string, { active: number }> };
    await expect.poll(() => table.sessions.get(sid)?.active).toBe(1);
    await s.sessions.sweep(Date.now() + 60_000);
    expect(s.sessions.size).toBe(1);
    release();
    expect((await slow).status).toBe(200);
    // Finished, it counts as used just now, and only goes once it has really been idle.
    await s.sessions.sweep(Date.now());
    expect(s.sessions.size).toBe(1);
    await s.sessions.sweep(Date.now() + 60_000);
    expect(s.sessions.size).toBe(0);
  });

  it("applies a tightened policy to an open session's next call (the watcher covers pages; config is read per call)", async () => {
    const { s, root } = await serve();
    const { c } = await client(s.port);
    const edit = { id: "rb-deploy-prod", append: "x", reason: "r" };
    const before = await c.callTool({ name: "propose_edit", arguments: edit });
    expect((before.structuredContent as { error: { code: string } }).error.code).toBe("unavailable"); // local mode
    const cfg = join(root, ".knowledge/config.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8")}\npolicy:\n  writes: disabled\n`);
    const after = await c.callTool({ name: "propose_edit", arguments: edit });
    expect((after.structuredContent as { error: unknown }).error).toEqual({ code: "forbidden", message: "writes are disabled by policy (policy.writes in .knowledge/config.yaml)" });
    // And the session's tool list follows on the next re-check.
    await expect.poll(async () => (await c.listTools()).tools.map((t) => t.name)).not.toContain("propose_edit");
    await c.close();
  });

  it("marks every session's service dirty when a page changes, so the next call reads it", async () => {
    const { s, root } = await serve();
    const { c } = await client(s.port);
    const before = await c.callTool({ name: "search", arguments: { query: "zebracorn" } });
    expect((before.structuredContent as { results: unknown[] }).results).toHaveLength(0);
    const page = join(root, "knowledge/runbooks/deploy-production.md");
    const { readFileSync } = await import("node:fs");
    writeFileSync(page, `${readFileSync(page, "utf8")}\nThe zebracorn step.\n`);
    await expect.poll(async () => ((await c.callTool({ name: "search", arguments: { query: "zebracorn" } })).structuredContent as { results: { id: string }[] }).results.map((r) => r.id), { timeout: 5000 }).toContain("rb-deploy-prod");
    await c.close();
  });
});

describe("docsworth serve: one load of the repo for every session", () => {
  const services = (s: Serving) => s.sessions.services() as unknown as { repo: object }[];
  const ids = async (c: Client, query: string) => ((await c.callTool({ name: "search", arguments: { query } })).structuredContent as { results: { id: string }[] }).results.map((r) => r.id);

  it("gives every session's service the same loaded pages", async () => {
    const { s } = await serve();
    const a = await client(s.port);
    const b = await client(s.port);
    await ids(a.c, "deploy");
    await ids(b.c, "deploy");
    const [x, y] = services(s);
    expect(x!.repo).toBe(y!.repo);
    expect(s.sessions.loader.loads).toBe(1);
    await a.c.close();
    await b.c.close();
  });

  it("moves an idle session to a new load when one is built, so old loads aren't kept", async () => {
    const { s, root } = await serve();
    const open = async () => (await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` }, body: INIT })).headers["mcp-session-id"] as string;
    const search = (sid: string) =>
      raw(s.port, {
        method: "POST",
        path: "/mcp",
        headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "deploy" } } }),
      });
    const a = await open();
    const b = await open();
    expect((await search(a)).status).toBe(200);
    expect((await search(b)).status).toBe(200);
    const page = join(root, "knowledge/runbooks/deploy-production.md");
    writeFileSync(page, `${readFileSync(page, "utf8")}\nThe zebracorn step.\n`);
    s.sessions.loader.invalidate();
    expect((await search(a)).status).toBe(200); // a builds the new load
    const [x, y] = services(s);
    expect(y!.repo).toBe(x!.repo); // b moved to it without a call of its own
    expect(s.sessions.loader.loads).toBe(2);
  });

  it("moves a session onto a new load built while its first answer was still going out", async () => {
    const { s, root } = await serve();
    const proto = StreamableHTTPServerTransport.prototype;
    const handle = proto.handleRequest;
    let held = false;
    proto.handleRequest = async function (this: StreamableHTTPServerTransport, ...args: Parameters<typeof handle>) {
      await handle.apply(this, args);
      if (!held) {
        held = true; // the first session's initialize: it stays in flight a while longer
        await new Promise((r) => setTimeout(r, 300));
      }
    };
    try {
      const first = raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` }, body: INIT });
      await expect.poll(() => s.sessions.size).toBe(1);
      const page = join(root, "knowledge/runbooks/deploy-production.md");
      writeFileSync(page, `${readFileSync(page, "utf8")}\nThe zebracorn step.\n`);
      s.sessions.loader.invalidate();
      const b = (await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` }, body: INIT })).headers["mcp-session-id"] as string;
      await raw(s.port, {
        method: "POST",
        path: "/mcp",
        headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}`, "mcp-session-id": b, "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search", arguments: { query: "zebracorn" } } }),
      });
      expect((await first).status).toBe(200);
      const [x, y] = services(s);
      await expect.poll(() => x!.repo === y!.repo).toBe(true); // once the first request ends
    } finally {
      proto.handleRequest = handle;
    }
  });

  it("moves a session that was busy when the new load was built, once its request ends", async () => {
    const { s, root } = await serve();
    const open = async () => (await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` }, body: INIT })).headers["mcp-session-id"] as string;
    const call = (sid: string, method: string, params: object, holdBody?: Promise<void>) =>
      raw(s.port, {
        method: "POST",
        path: "/mcp",
        headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method, params }),
        holdBody,
      });
    const a = await open();
    const b = await open();
    await call(a, "tools/call", { name: "search", arguments: { query: "deploy" } });
    await call(b, "tools/call", { name: "search", arguments: { query: "deploy" } });
    // b is busy with a request that never touches the repo while a builds the new load.
    let release!: () => void;
    const busy = call(b, "ping", {}, new Promise<void>((r) => (release = r)));
    await expect.poll(() => (s.sessions as unknown as { sessions: Map<string, { active: number }> }).sessions.get(b)?.active).toBe(1);
    const page = join(root, "knowledge/runbooks/deploy-production.md");
    writeFileSync(page, `${readFileSync(page, "utf8")}\nThe zebracorn step.\n`);
    s.sessions.loader.invalidate();
    await call(a, "tools/call", { name: "search", arguments: { query: "deploy" } });
    const [x, y] = services(s);
    expect(y!.repo).not.toBe(x!.repo); // busy: not moved under its request
    release();
    expect((await busy).status).toBe(200);
    expect(y!.repo).toBe(x!.repo);
  });

  it("keeps watching for the sessions left when one is reclaimed, deleted or fails to start", async () => {
    const { s, root } = await serve({ maxSessions: 2 });
    // The SDK client holds an event stream open, so its session is never idle. The others
    // are opened as the web app opens them: requests only, idle between calls.
    const kept = await client(s.port);
    const open = () => raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` }, body: INIT });
    const reclaimed = (await open()).headers["mcp-session-id"] as string;
    const gone = (await open()).headers["mcp-session-id"] as string; // the server is full: this reclaims that one
    expect(s.sessions.size).toBe(2);
    const live = (s.sessions as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(live.has(reclaimed)).toBe(false);
    expect((await raw(s.port, { method: "DELETE", path: "/mcp", headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": gone } })).status).toBe(200);
    const notInit = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await raw(s.port, { method: "POST", path: "/mcp", headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` }, body: notInit })).status).toBe(400);
    expect(s.sessions.size).toBe(1);
    // Past the watcher's settle reload, so only the watcher itself can notice the edit.
    await new Promise((r) => setTimeout(r, WATCH_SETTLE_MS + 300));
    await ids(kept.c, "deploy");
    const page = join(root, "knowledge/runbooks/deploy-production.md");
    writeFileSync(page, `${readFileSync(page, "utf8")}\nThe zebracorn step.\n`);
    await expect.poll(() => ids(kept.c, "zebracorn"), { timeout: 5000 }).toContain("rb-deploy-prod");
    await kept.c.close();
  });

  it("follows a moved knowledge root, so an edit under the new one reaches an open session", async () => {
    const { s, root } = await serve();
    const { c } = await client(s.port);
    mkdirSync(join(root, "docs-kb"));
    cpSync(join(root, "knowledge"), join(root, "docs-kb"), { recursive: true });
    const cfg = join(root, ".knowledge/config.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("knowledge_root: knowledge", "knowledge_root: docs-kb"));
    // Ownership moves with it, or the moved pages would be unowned and never citable.
    const co = join(root, "CODEOWNERS");
    writeFileSync(co, readFileSync(co, "utf8").replaceAll("/knowledge/", "/docs-kb/"));
    const later = new Date(Date.now() + 5000);
    utimesSync(cfg, later, later);
    utimesSync(co, later, later);
    await ids(c, "deploy"); // the config change is read on this call
    expect(s.sessions.loader.watchedDir).toBe(join(root, "docs-kb"));
    await new Promise((r) => setTimeout(r, WATCH_SETTLE_MS + 300));
    await ids(c, "deploy");
    const page = join(root, "docs-kb/runbooks/deploy-production.md");
    writeFileSync(page, `${readFileSync(page, "utf8")}\nThe quokkafish step.\n`);
    await expect.poll(() => ids(c, "quokkafish"), { timeout: 5000 }).toContain("rb-deploy-prod");
    await c.close();
  });
});

describe("docsworth serve: the static app", () => {
  /** The app in `<parent>/web`, next to `<parent>/web-secret.txt`; only `<parent>` (ours) is removed. */
  function webRoot() {
    const parent = mkdtempSync(join(tmpdir(), "docsworth-web-"));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const dir = join(parent, "web");
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Docsworth</title>");
    writeFileSync(join(dir, "assets/app-1a2b.js"), "console.log(1)");
    writeFileSync(join(parent, "web-secret.txt"), "outside");
    return dir;
  }

  it("serves the app's files and its routes, with the security headers and no token", async () => {
    const { s } = await serve({ webRoot: webRoot() });
    const index = await raw(s.port, { path: "/" });
    expect(index.status).toBe(200);
    expect(index.body).toMatch(/<title>Docsworth/);
    expect(index.headers["cache-control"]).toBe("no-store");
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(index.headers[k]).toBe(v);
    const route = await raw(s.port, { path: "/p/rb-deploy-prod" });
    expect(route.status).toBe(200);
    expect(route.body).toMatch(/<title>Docsworth/);
    const js = await raw(s.port, { path: "/assets/app-1a2b.js" });
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).toMatch(/immutable/);
  });

  it("never serves a file outside the app, however the path is spelled", async () => {
    const dir = webRoot();
    const { s } = await serve({ webRoot: dir });
    const secret = "web-secret.txt"; // next to the app's directory, inside this test's own temp dir
    for (const path of [`/../${secret}`, `/%2e%2e/${secret}`, `/assets/..%2f..%2f${secret}`, `/..%5c${secret}`, "/%00", "/%E0%A4%A"]) {
      const r = await raw(s.port, { path });
      expect(r.body, path).not.toBe("outside");
      expect([400, 404], path).toContain(r.status);
    }
  });

  it("says /mcp is served when no app is built, and refuses non-GET methods", async () => {
    const { s } = await serve({ webRoot: null });
    const r = await raw(s.port, { path: "/" });
    expect(r.status).toBe(404);
    expect(r.body).toBe("The web app isn't built into this install; /mcp is served.\n");
    expect((await raw(s.port, { method: "POST", path: "/" })).status).toBe(405);
  });
});
