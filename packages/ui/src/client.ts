// A small client for Docsworth's MCP server over Streamable HTTP (`docsworth serve`'s /mcp):
// initialize once, then tools/call, with the session id and the bearer token on every
// request. The server answers in JSON (enableJsonResponse), so no event stream is read.

export const PROTOCOL_VERSION = "2025-06-18";

/** A refusal or failure, with the server's structured code (not_found, forbidden, …). */
export class DocsworthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  /** The server's origin, e.g. http://127.0.0.1:4747. */
  url: string;
  token: string;
  /** Who this client is, for the audit log ("docsworth-web", "docsworth-extension"). */
  name?: string;
  fetch?: typeof fetch;
  /**
   * A session this tab opened before (kept in sessionStorage across reloads, so reloading
   * doesn't open a new one each time). If the server has expired it, a new one starts.
   */
  session?: string | null;
  /** Called with each new session id, so the host can keep it. */
  onSession?: (id: string) => void;
  /** Called when the session ends after it answered: the host forgets it and reloads. */
  onSessionLost?: () => void;
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content?: { type: string; text?: string }[] };

const sessionExpired = () =>
  new DocsworthError("session_expired", "This tab's session with docsworth serve ended (it was idle for 30 minutes, or the server restarted). Reload the page to start a new one.");

export class DocsworthClient {
  private session: string | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 0;
  /** A call was answered in this session, so the page may show what it said. */
  private served = false;
  /** That session ended: nothing more runs until the page reloads. */
  private lost = false;

  constructor(private readonly opts: ClientOptions) {
    if (opts.session) {
      this.session = opts.session;
      this.starting = Promise.resolve();
    }
  }

  private send(method: "POST" | "DELETE", body?: object, session = this.session): Promise<Response> {
    const fetchImpl = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.token}`,
      accept: "application/json, text/event-stream",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(session ? { "mcp-session-id": session, "mcp-protocol-version": PROTOCOL_VERSION } : {}),
    };
    return fetchImpl(new URL("/mcp", this.opts.url), { method, headers, body: body ? JSON.stringify(body) : undefined });
  }

  private static async failure(res: Response): Promise<DocsworthError> {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (res.status === 401) return new DocsworthError("unauthorized", "the server didn't accept this link's token; open the URL `docsworth serve` printed");
    return new DocsworthError(body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? `the server answered ${res.status}`);
  }

  /** Opens the session; concurrent callers share one initialize. */
  start(): Promise<void> {
    this.starting ??= (async () => {
      const res = await this.send("POST", {
        jsonrpc: "2.0",
        id: ++this.nextId,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: this.opts.name ?? "docsworth-web", version: "0.2.0" } },
      });
      if (!res.ok) throw await DocsworthClient.failure(res);
      const session = res.headers.get("mcp-session-id");
      if (!session) throw new DocsworthError("invalid", "the server opened no session");
      // The session is kept only once acknowledged: one that wasn't is closed, never reused,
      // or the next initialize would carry it and be refused.
      const ack = await this.send("POST", { jsonrpc: "2.0", method: "notifications/initialized" }, session);
      if (!ack.ok) {
        const err = await DocsworthClient.failure(ack);
        await this.send("DELETE", undefined, session).catch(() => undefined);
        throw err;
      }
      if (this.lost) {
        // The tab ended while this session opened: close it rather than keep it.
        await this.send("DELETE", undefined, session).catch(() => undefined);
        throw sessionExpired();
      }
      this.session = session;
      this.opts.onSession?.(session);
    })().catch((err: unknown) => {
      this.starting = null; // let the next call try again
      throw err;
    });
    return this.starting;
  }

  /**
   * Calls a tool and returns its structured result, or throws its structured error.
   *
   * The server's taint check is per session, and so per tab (docs/security-model.md). When
   * the server no longer knows the session (idle for 30 minutes, or restarted), a new one
   * holds none of the reads behind what this tab shows. So a new session is started only
   * while nothing has been shown: a reloaded tab whose kept session had expired. Once a call
   * has been answered, a lost session ends the tab: this call and every later one, writes
   * included, throw `session_expired` until the page reloads and reads its views again. An
   * answer that arrives from a session the tab has already left is never shown either: it
   * ends the tab, since what it says isn't in the session the tab now uses.
   */
  async call<T>(tool: string, args: Record<string, unknown> = {}, retried = false): Promise<T> {
    if (this.lost) throw sessionExpired();
    await this.start();
    if (this.lost) throw sessionExpired(); // the tab ended while this call waited for a session
    const used = this.session;
    const res = await this.send("POST", { jsonrpc: "2.0", id: ++this.nextId, method: "tools/call", params: { name: tool, arguments: args } });
    if (res.status === 404) {
      // Refused on a session another call already left: this one ran nowhere, so it runs in
      // the session the tab uses now.
      if (used !== this.session && !this.lost && !retried) return this.call<T>(tool, args, true);
      // Refused on the session the tab uses, before anything was shown: start over, once.
      if (used === this.session && !this.served && !retried) {
        this.session = null;
        this.starting = null;
        return this.call<T>(tool, args, true);
      }
      this.end();
      throw sessionExpired();
    }
    if (!res.ok) throw await DocsworthClient.failure(res);
    const msg = (await res.json()) as { result?: ToolResult; error?: { code: number; message: string } };
    if (used !== this.session) {
      this.end();
      throw sessionExpired();
    }
    this.served = true;
    if (msg.error) throw new DocsworthError(`jsonrpc_${msg.error.code}`, msg.error.message);
    const result = msg.result ?? {};
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    if (result.isError) {
      const e = result.structuredContent?.error as { code?: string; message?: string } | undefined;
      // A tool the policy disabled is refused by the SDK, with text and no structured error.
      throw new DocsworthError(e?.code ?? (/ disabled$/.test(text) ? "forbidden" : "error"), e?.message ?? text.replace(/^MCP error -?\d+: /, ""));
    }
    return (result.structuredContent ?? {}) as T;
  }

  /** The session is gone and the tab has shown what it said: nothing more runs until a reload. */
  private end(): void {
    if (this.lost) return;
    this.lost = true;
    this.session = null;
    this.starting = null;
    this.opts.onSessionLost?.();
  }

  /** Ends the session on the server. */
  async close(): Promise<void> {
    if (!this.session) return;
    await this.send("DELETE").catch(() => undefined);
    this.session = null;
    this.starting = null;
  }
}
