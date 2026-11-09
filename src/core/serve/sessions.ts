import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Identity } from "../acl.js";
import { type AuditLog, actorOf } from "../audit-log.js";
import { auditTransport } from "../mcp/audit-transport.js";
import { createMcpServer } from "../mcp/server.js";
import { type IdentitySource, KnowledgeService, WATCH_SETTLE_MS } from "../service.js";

// One MCP session per browser tab or extension: its own Streamable HTTP transport, wrapped
// by the audit transport, serving its own McpServer over its own KnowledgeService. The
// service holds the session's taint set (what team-only pages it has seen), so taint is
// per tab, not per server. All sessions share the identity (one user per server), the
// audit log and one file watcher.

export interface SessionOptions {
  root: string;
  knowledgeRoot: string;
  identity: IdentitySource;
  /** The identity proven at server start, to attribute the first event of each session. */
  who: Identity;
  audit: AuditLog | null;
  includeQueries: boolean;
  now: () => Date;
  maxSessions?: number;
  idleMs?: number;
  log?: (msg: string) => void;
}

interface Session {
  http: StreamableHTTPServerTransport;
  server: McpServer;
  service: KnowledgeService;
  lastUsed: number;
  /** Requests in flight: a session busy answering is never idle. */
  active: number;
}

export const MAX_SESSIONS = 16;
export const SESSION_IDLE_MS = 30 * 60_000;

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export class SessionTable {
  private readonly sessions = new Map<string, Session>();
  /** Sessions being set up: counted against the cap before they have an id. */
  private starting = 0;
  private watcher: FSWatcher | null = null;
  private readonly sweeper: NodeJS.Timeout;
  private readonly max: number;
  private readonly idleMs: number;

  constructor(private readonly opts: SessionOptions) {
    this.max = opts.maxSessions ?? MAX_SESSIONS;
    this.idleMs = opts.idleMs ?? SESSION_IDLE_MS;
    // One watcher for every session: a change marks each service dirty, and each reloads
    // lazily on its next call, never in the middle of a write that is still landing.
    // It watches pages only. The config and CODEOWNERS (the policy, admins, owners) sit
    // outside the knowledge root, and every call already stats them: KnowledgeService's
    // current() reloads when inputsStamp() changes. So a tightened policy applies to an
    // open session's next call (test/serve.test.ts, "applies a tightened policy").
    this.watcher = watch(join(opts.root, opts.knowledgeRoot), { recursive: true }, () => this.invalidate());
    const settle = setTimeout(() => this.invalidate(), WATCH_SETTLE_MS); // see KnowledgeService.watch
    settle.unref();
    this.sweeper = setInterval(() => void this.sweep(), Math.min(60_000, this.idleMs));
    this.sweeper.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** The services of live sessions (tests). */
  services(): KnowledgeService[] {
    return [...this.sessions.values()].map((s) => s.service);
  }

  private invalidate(): void {
    for (const s of this.sessions.values()) s.service.invalidate();
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sid = req.headers["mcp-session-id"];
    if (sid !== undefined) {
      const session = typeof sid === "string" ? this.sessions.get(sid) : undefined;
      if (!session) return json(res, 404, { error: { code: "not_found", message: "no such session; it may have expired: start a new one" } });
      session.active++;
      try {
        return await session.http.handleRequest(req, res);
      } finally {
        session.active--;
        session.lastUsed = Date.now();
      }
    }
    if (req.method !== "POST") return json(res, 400, { error: { code: "invalid", message: "start a session with an initialize request" } });
    // Checked and counted before the first await, so concurrent starts can't pass the cap.
    if (this.sessions.size + this.starting >= this.max)
      return json(res, 503, { error: { code: "unavailable", message: `this server already has ${this.max} sessions open; close a tab or wait for idle ones to expire` } });
    this.starting++;
    try {
      const session = await this.open();
      try {
        await session.http.handleRequest(req, res);
      } finally {
        // Busy from birth: the session joins the table while this request is still
        // being answered, so a sweep in between must not take it.
        session.active--;
        session.lastUsed = Date.now();
      }
      // A first request that wasn't an initialize gets the SDK's error and no session.
      if (!session.http.sessionId) await session.server.close();
    } finally {
      this.starting--;
    }
  }

  private async open(): Promise<Session> {
    const o = this.opts;
    const service = new KnowledgeService(o.root, o.identity, o.now);
    const http = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => void this.sessions.set(id, session),
    });
    const transport = o.audit
      ? auditTransport(http, o.audit, () => o.identity.get(), {
          includeQueries: o.includeQueries,
          initialActor: actorOf(o.who),
          known: () => service.knownValues(),
          snapshot: () => service.snapshot(),
          log: o.log,
        })
      : http;
    // On the wrapper, not on `http`: the audit transport takes over the inner onclose.
    // Set before connect, which chains the server's own handler after this one.
    transport.onclose = () => {
      if (http.sessionId) this.sessions.delete(http.sessionId);
      service.close();
    };
    const server = createMcpServer(service, { who: o.who, whoami: () => o.identity.get(), surface: "http" });
    const session: Session = { http, server, service, lastUsed: Date.now(), active: 1 };
    await server.connect(transport);
    return session;
  }

  /** Close sessions idle longer than the limit, never one with a request in flight. */
  async sweep(now = Date.now()): Promise<void> {
    const idle = [...this.sessions.values()].filter((s) => s.active === 0 && now - s.lastUsed > this.idleMs);
    await Promise.all(idle.map((s) => s.server.close()));
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.watcher?.close();
    this.watcher = null;
    await Promise.all([...this.sessions.values()].map((s) => s.server.close()));
  }
}
