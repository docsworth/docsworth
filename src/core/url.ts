// Every URL Docsworth sends a credential to must be https, except on loopback (tests and
// local fakes). Plain http would put a GitHub or Confluence token on the wire in clear.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Why `raw` may not carry a credential, or null when it may. */
export function insecureUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  // A password in the URL would be echoed by every error and log that names it.
  if (u.username || u.password) return "must not carry a user name or password; give credentials through their own setting";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname.replace(/\.$/, ""))) return null;
  return "must use https:// (plain http is allowed only on loopback), since the token is sent to it";
}

/** A URL for an error message: scheme and host only, never a path, user or password. */
export function urlForError(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(not a URL)";
  }
}
