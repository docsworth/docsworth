// Where the server is and how to reach it. The server's address isn't a secret and goes to
// storage.local. The token goes to storage.session only: content scripts can read
// storage.local, and they can't read storage.session (the worker pins it to trusted
// contexts). Chrome clears storage.session when it quits, so the token is pasted again then.

export const DEFAULT_SERVER = "http://127.0.0.1:4747";
const SERVER = "server";
const TOKEN = "token";
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

import { PENDING_PREFIX } from "./contract.js";
import type { StorageLike } from "./storage.js";

type Areas = { local: Pick<StorageLike, "get" | "set">; session: StorageLike };

/** A server the extension may call: http on 127.0.0.1 or localhost, as an origin. Else null. */
export function serverOrigin(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(u.hostname) || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** What was pasted: the link `docsworth serve` printed (server and token), or a token alone. */
export function parsePairing(input: string): { server?: string; token: string } | null {
  const s = input.trim();
  if (TOKEN_RE.test(s)) return { token: s };
  try {
    const u = new URL(s);
    const t = /^#t=([A-Za-z0-9_-]{43})$/.exec(u.hash)?.[1];
    const server = serverOrigin(s);
    return t && server ? { server, token: t } : null;
  } catch {
    return null;
  }
}

export async function loadSettings(areas: Areas): Promise<{ server: string; token: string | null }> {
  const [local, session] = await Promise.all([areas.local.get(SERVER), areas.session.get(TOKEN)]);
  const token = session[TOKEN];
  return {
    server: serverOrigin(String(local[SERVER] ?? "")) ?? DEFAULT_SERVER,
    token: typeof token === "string" && TOKEN_RE.test(token) ? token : null,
  };
}

/**
 * Saves the server to storage.local and the token to storage.session. Either way every
 * window's kept session goes, so each panel starts over in a new one. Forgetting the token
 * (null) also removes the captures waiting for a panel.
 */
export async function saveSettings(areas: Areas, server: string, token: string | null): Promise<void> {
  const origin = serverOrigin(server);
  if (!origin) throw new Error("the server must be http://127.0.0.1:<port> or http://localhost:<port>");
  if (token !== null && !TOKEN_RE.test(token)) throw new Error("that isn't a docsworth serve token");
  const stale = Object.keys(await areas.session.get(null)).filter((k) => k.startsWith(SESSION_PREFIX) || (token === null && k.startsWith(PENDING_PREFIX)));
  if (stale.length) await areas.session.remove(stale);
  await areas.local.set({ [SERVER]: origin });
  if (token === null) await areas.session.remove(TOKEN);
  else await areas.session.set({ [TOKEN]: token });
}

/** Where a window's side panel keeps its MCP session, so reopening the panel resumes it. */
const SESSION_PREFIX = "session:";
export const sessionKey = (window: number) => `${SESSION_PREFIX}${window}`;
