import type { IncomingMessage } from "node:http";
import { tokenMatches } from "./token.js";

// Who may talk to `docsworth serve`. It listens on 127.0.0.1 only, and on top of that
// every request must name this server as its Host (a DNS-rebound page names its own),
// and a browser request's Origin must be this server or an extension the user allowed.
// /mcp also needs the bearer token. There are no cookies: nothing a browser attaches on
// its own can authorize a request, so another site can't make one on the user's behalf.

/** A Chromium extension id: 32 letters a to p. */
export const EXTENSION_ID = /^[a-p]{32}$/;

export interface AccessRules {
  port: number;
  token: string;
  /** Extension ids allowed to call /mcp from `chrome-extension://<id>`. */
  extensions: ReadonlySet<string>;
}

export type Verdict =
  | { ok: true; /** The origin to answer with CORS headers, for an allowed extension. */ cors?: string }
  | { ok: false; status: 401 | 403; message: string };

const own = (port: number) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

/** Host and Origin, checked on every request, static files included. */
export function checkOrigin(req: IncomingMessage, rules: AccessRules): Verdict {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${rules.port}` && host !== `localhost:${rules.port}`)
    return { ok: false, status: 403, message: "this server answers only to 127.0.0.1 and localhost on its own port" };
  const origin = req.headers.origin;
  if (origin === undefined || own(rules.port).includes(origin)) return { ok: true };
  const ext = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin)?.[1];
  if (ext && rules.extensions.has(ext)) return { ok: true, cors: origin };
  return { ok: false, status: 403, message: "requests from this origin are not allowed; an extension must be allowed with --allow-extension" };
}

/** The bearer token, checked on every /mcp request after checkOrigin. */
export function checkToken(req: IncomingMessage, rules: AccessRules): Verdict {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  return tokenMatches(rules.token, m?.[1]) ? { ok: true } : { ok: false, status: 401, message: "a valid bearer token is required" };
}

/** CORS headers for an allowed extension origin, on preflights and on responses. */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE",
    "access-control-allow-headers": "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
    "access-control-expose-headers": "mcp-session-id",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}
