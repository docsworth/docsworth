import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { type AccessRules, checkOrigin, checkToken, corsHeaders, type Verdict } from "./auth.js";
import { SessionTable, type SessionOptions } from "./sessions.js";

// `docsworth serve`: the knowledge repo over MCP (Streamable HTTP) at /mcp, for the web app
// and the browser extension, plus the web app's static files at /. Bound to 127.0.0.1
// only. Every response carries the security headers; /mcp also needs the bearer token.
// The static files hold no data: everything the app shows comes through /mcp, under the
// same ACL, gate, policy, taint check and audit log as an agent's stdio session.

export const DEFAULT_PORT = 4747;

/** Sent on every response, the static app's included. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export interface ServeOptions extends Omit<SessionOptions, "knowledgeRoot"> {
  knowledgeRoot: string;
  port: number;
  token: string;
  extensions: ReadonlySet<string>;
  /** The built web app (dist/web), or null to serve /mcp only. */
  webRoot: string | null;
}

export interface Serving {
  server: Server;
  sessions: SessionTable;
  port: number;
  /** The URL to open, with the token in the fragment (never sent to the server). */
  url: string;
  close(): Promise<void>;
}

function refuse(res: ServerResponse, v: Extract<Verdict, { ok: false }>, extra: Record<string, string> = {}): void {
  const auth = v.status === 401 ? { "www-authenticate": 'Bearer realm="docsworth"' } : {};
  res.writeHead(v.status, { ...SECURITY_HEADERS, ...extra, ...auth, "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: v.status === 401 ? "unauthorized" : "forbidden", message: v.message } }));
}

/** A file under `webRoot` for a URL path, or the app's index for a client-side route. */
function staticFile(webRoot: string, pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  const root = resolve(webRoot);
  const file = resolve(root, `.${rel.endsWith("/") ? `${rel}index.html` : rel}`);
  if (file !== root && !file.startsWith(root + sep)) return null; // never outside the app
  try {
    if (statSync(file).isFile()) return file;
  } catch {
    /* not a file: maybe a client-side route */
  }
  // A path without an extension is one of the app's routes (/p/<id>, /graph): its index.
  return extname(rel) === "" ? join(root, "index.html") : null;
}

function serveStatic(webRoot: string | null, req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, HEAD" }).end();
    return;
  }
  const file = webRoot ? staticFile(webRoot, pathname) : null;
  let size = 0;
  try {
    size = file ? statSync(file).size : 0;
  } catch {
    /* index.html missing: the app isn't built */
  }
  if (!file || (!size && file.endsWith("index.html"))) {
    const body = webRoot ? "Not found.\n" : "The web app isn't built into this install; /mcp is served.\n";
    res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" }).end(body);
    return;
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": String(size),
    // Hashed asset names can be cached; the index must not be, or a new build wouldn't load.
    "cache-control": file.endsWith("index.html") ? "no-store" : "max-age=31536000, immutable",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

export async function startServer(opts: ServeOptions): Promise<Serving> {
  const sessions = new SessionTable(opts);
  let rules: AccessRules = { port: opts.port, token: opts.token, extensions: opts.extensions };

  const server = createServer((req, res) => {
    const origin = checkOrigin(req, rules);
    if (!origin.ok) return refuse(res, origin);
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/mcp") return serveStatic(opts.webRoot, req, res, pathname);

    const cors = origin.cors ? corsHeaders(origin.cors) : {};
    // A preflight can't carry the token; Host and Origin were checked above.
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...SECURITY_HEADERS, ...cors }).end();
      return;
    }
    const auth = checkToken(req, rules);
    if (!auth.ok) return refuse(res, auth, cors);
    // Merged into whatever the transport writes.
    for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...cors, vary: "Origin" })) res.setHeader(k, v);
    sessions.handle(req, res).catch((err: unknown) => {
      opts.log?.(`request failed: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "internal", message: "internal error" } }));
    });
  });

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(opts.port, "127.0.0.1", () => done());
  });
  // With port 0 (tests), the Host check needs the port the OS picked.
  const port = (server.address() as AddressInfo).port;
  rules = { ...rules, port };
  return {
    server,
    sessions,
    port,
    url: `http://127.0.0.1:${port}/#t=${opts.token}`,
    async close() {
      await sessions.close();
      // Stop listening, then drop what is still open (a tab's event stream, a call still
      // arriving): close() alone waits for every connection to finish, so Ctrl-C would hang.
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
    },
  };
}
