import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Identity } from "../acl.js";
import { type AuditLog, actorOf } from "../audit-log.js";
import { auditTransport } from "../mcp/audit-transport.js";
import { createMcpServer } from "../mcp/server.js";
import { type IdentitySource, KnowledgeService, RepoLoader } from "../service.js";

// One MCP session per browser tab or extension: its own Streamable HTTP transport, wrapped
// by the audit transport, serving its own McpServer over its own KnowledgeService. The
// service holds the session's taint set (what team-only pages it has seen), so taint is
// per tab, not per server. All sessions share the identity (one user per server), the
// audit log, and one load of the repo with its file watcher (RepoLoader).

export interface SessionOptions {
  root: string;
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
/** An initialize request is a few hundred bytes; a first request bigger than this isn't one. */
const MAX_START_BYTES = 64 * 1024;
export const SESSION_IDLE_MS = 30 * 60_000;

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const NOT_A_START = { status: 400, error: { code: "invalid", message: "start a session with an initialize request" } };

/**
 * A first request's body, if it can start a session: the headers the transport requires,
 * and exactly one initialize request. Checked before a slot is counted or reclaimed, so a
 * request the transport would refuse can't close someone's idle session for nothing.
 */
async function startBody(req: IncomingMessage): Promise<{ body: unknown } | { status: number; error: { code: string; message: string } }> {
  const accept = req.headers.accept ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
    return { status: 406, error: { code: "invalid", message: "the client must accept both application/json and text/event-stream" } };
  if (!(req.headers["content-type"] ?? "").includes("application/json")) return { status: 415, error: { code: "invalid", message: "the body must be application/json" } };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_START_BYTES) return NOT_A_START;
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return NOT_A_START;
  }
  const only = Array.isArray(body) ? (body.length === 1 ? body[0] : undefined) : body;
  return isInitializeRequest(only) ? { body } : NOT_A_START;
}

export class SessionTable {
  private readonly sessions = new Map<string, Session>();
  /** Sessions being set up: counted against the cap before they have an id. */
  private starting = 0;
  /** One load of the repo for every session; its watcher marks it stale on any change. */
  readonly loader: RepoLoader;
  private readonly sweeper: NodeJS.Timeout;
  private readonly max: number;
  private readonly idleMs: number;

  constructor(private readonly opts: SessionOptions) {
    this.max = opts.maxSessions ?? MAX_SESSIONS;
    this.idleMs = opts.idleMs ?? SESSION_IDLE_MS;
    // One load and one watcher for every session: a change marks the load stale, and the
    // next call from any session builds a new one, never in the middle of a write that is
    // still landing. It watches pages only. The config and CODEOWNERS (the policy, admins,
    // owners) sit outside the knowledge root, and every call already stats them, so a
    // tightened policy applies to an open session's next call (test/serve.test.ts,
    // "applies a tightened policy").
    this.loader = new RepoLoader(opts.root);
    // A new load is built inside one session's call; every session with nothing in flight
    // moves onto it now, and a busy one when its last request ends (handle). So however
    // the repo changes, the sessions hold one load between them, not one each.
    this.loader.onLoad = () => {
      for (const s of this.sessions.values()) if (s.active === 0) s.service.release();
    };
    this.loader.watch();
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
        if (session.active === 0) session.service.release();
      }
    }
    if (req.method !== "POST") return json(res, 400, { error: NOT_A_START.error });
    const first = await startBody(req);
    if (!("body" in first)) return json(res, first.status, { error: first.error });
    // Checked and counted with no await in between, so concurrent starts can't pass the cap.
    // A full server makes room by closing the session idle longest: a closed tab never
    // tells the server, so refusing would lock the user out until it expired. Only when
    // every slot is busy (answering, or still starting) is a new one refused.
    let reclaimed: Session | undefined;
    if (this.sessions.size + this.starting >= this.max) {
      reclaimed = this.idlest();
      if (!reclaimed)
        return json(res, 503, { error: { code: "unavailable", message: `this server is answering ${this.max} sessions at once; try again in a moment` } });
      this.sessions.delete(reclaimed.http.sessionId!); // out of the table before any await
    }
    // This start's slot: counted in `starting` until its session joins the table, then
    // there instead (never in both, or a start beside a slow first answer finds no room).
    this.starting++;
    let reserved = true;
    const joined = () => {
      if (reserved) this.starting--;
      reserved = false;
    };
    try {
      if (reclaimed) await reclaimed.server.close().catch((err: unknown) => this.opts.log?.(`closing an idle session failed: ${(err as Error).message}`));
      const session = await this.open(joined);
      try {
        await session.http.handleRequest(req, res, first.body); // the body is read: hand it over
      } finally {
        // Busy from birth: the session joins the table while this request is still
        // being answered, so a sweep in between must not take it.
        session.active--;
        session.lastUsed = Date.now();
        if (session.active === 0) session.service.release(); // as for any request (above)
      }
      // A first request that wasn't an initialize gets the SDK's error and no session.
      if (!session.http.sessionId) await session.server.close();
    } finally {
      joined();
    }
  }

  private async open(joined: () => void): Promise<Session> {
    const o = this.opts;
    const service = new KnowledgeService(o.root, o.identity, o.now, this.loader);
    const http = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        this.sessions.set(id, session);
        joined();
      },
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

  /** The session that has had no request in flight for longest, if any. */
  private idlest(): Session | undefined {
    let found: Session | undefined;
    for (const s of this.sessions.values()) if (s.active === 0 && (!found || s.lastUsed < found.lastUsed)) found = s;
    return found;
  }

  /** Close sessions idle longer than the limit, never one with a request in flight. */
  async sweep(now = Date.now()): Promise<void> {
    const idle = [...this.sessions.values()].filter((s) => s.active === 0 && now - s.lastUsed > this.idleMs);
    // Out of the table first, so a start can't pick one of these to reclaim as well.
    for (const s of idle) this.sessions.delete(s.http.sessionId!);
    await Promise.all(idle.map((s) => s.server.close()));
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.loader.close();
    await Promise.all([...this.sessions.values()].map((s) => s.server.close()));
  }
}
