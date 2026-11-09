// What the extension's parts may say to one another, and the records the worker leaves for
// the side panel (docs/security-model.md, "The browser extension"). A content script runs inside a
// page and is only as trustworthy as that page, so it may send one kind of message, an open
// Gmail thread's context. Of that, only the subject reaches the server unasked, as the panel's
// search for related pages; the text goes only in a draft the person submits. The side panel
// and the options page are extension pages: they read the token and call the server themselves.

export const GMAIL_ORIGIN = "https://mail.google.com";
/** The most text a capture carries, in UTF-8 bytes. */
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_TITLE = 300;
/** A capture no panel took within this long is dropped. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const PENDING_PREFIX = "pending:";

/** The one message a content script may send: the open thread, read when its button is clicked. */
export type GmailContext = { kind: "gmail-context"; subject: string; text: string; url: string };

/** A capture waiting for the side panel of the window it came from. */
export type Pending = { window: number; source: "gmail" | "selection"; title: string; text: string; url: string; at: number };

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
export function clip(text: string, max = MAX_TEXT_BYTES): string {
  const buf = new TextEncoder().encode(text);
  // A streaming decode holds back a character cut in half instead of writing U+FFFD for it.
  return buf.length <= max ? text : new TextDecoder().decode(buf.subarray(0, max), { stream: true });
}

const originOf = (url: unknown): string | null => {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

function isGmailContext(m: unknown): m is GmailContext {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return false;
  if (Object.keys(m).sort().join(",") !== "kind,subject,text,url") return false;
  const r = m as Record<string, unknown>;
  return r.kind === "gmail-context" && typeof r.subject === "string" && typeof r.text === "string" && typeof r.url === "string";
}

/**
 * Why the worker refuses a message, or null to accept it. Only a Gmail thread's context is
 * accepted, from this extension's own content script, in the top frame of a tab whose
 * origin is exactly Gmail's, about a Gmail address, within the size limits.
 */
export function refusal(msg: unknown, sender: chrome.runtime.MessageSender, ownId: string): string | null {
  if (sender.id !== ownId) return "not from this extension";
  if (sender.tab?.id === undefined || sender.tab.id < 0 || sender.tab.windowId === undefined || sender.frameId !== 0) return "not from a tab's top frame";
  if (originOf(sender.url) !== GMAIL_ORIGIN || (sender.origin !== undefined && sender.origin !== GMAIL_ORIGIN)) return "not from Gmail";
  if (!isGmailContext(msg)) return "not a Gmail thread's context";
  if (originOf(msg.url) !== GMAIL_ORIGIN) return "not a Gmail address";
  if (bytes(msg.text) > MAX_TEXT_BYTES || msg.subject.length > MAX_TITLE) return "too large";
  return null;
}

/** A stored capture, checked as it's read back: the panel trusts nothing it didn't check. */
export function isPending(v: unknown): v is Pending {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    Number.isInteger(r.window) &&
    (r.source === "gmail" || r.source === "selection") &&
    typeof r.title === "string" &&
    r.title.length <= MAX_TITLE &&
    typeof r.text === "string" &&
    bytes(r.text) <= MAX_TEXT_BYTES &&
    typeof r.url === "string" &&
    typeof r.at === "number"
  );
}
