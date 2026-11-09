// Gmail, read from its page. Gmail's markup isn't a contract and changes without notice, so
// every selector lives here, each with fallbacks, and the fixtures in test/fixtures pin what
// they were written against. When nothing matches, nothing is mounted: the side panel still
// works from the toolbar. Nothing in a thread is read until its button is clicked.

import { clip, type GmailContext, MAX_TITLE } from "../contract.js";

export const SELECTORS = {
  /** The open thread's subject heading. */
  subject: ["h2.hP", "h2[data-legacy-thread-id]", "[role='main'] h2[data-thread-perm-id]"],
  /** Each message in the thread that's shown expanded (collapsed ones have no body in the page). */
  message: ["div.adn[data-message-id]", "[role='main'] [data-message-id]"],
  /** A message's body, inside the message. */
  body: ["div.a3s", "div.ii.gt"],
  /** Its sender's display name, inside the message. */
  sender: ["span.gD[name]", "span[email][name]"],
} as const;

/** Marks the button's host, so it's mounted once per subject. */
export const HOST_ATTR = "data-docsworth";

function first(root: ParentNode, selectors: readonly string[]): HTMLElement | null {
  for (const s of selectors) {
    const el = root.querySelector<HTMLElement>(s);
    if (el) return el;
  }
  return null;
}

function all(root: ParentNode, selectors: readonly string[]): HTMLElement[] {
  for (const s of selectors) {
    const els = [...root.querySelectorAll<HTMLElement>(s)];
    if (els.length) return els;
  }
  return [];
}

// innerText follows what's shown (trimmed quotes are hidden); textContent is the fallback.
const text = (el: HTMLElement) => (el.innerText ?? el.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();

/** The open thread's subject heading, when a thread is open. */
export const findSubject = (doc: Document) => first(doc, SELECTORS.subject);

/**
 * The open thread as a capture: its subject, and each expanded message as its sender's
 * name and its text. Senders' addresses are left out: a capture becomes a PR that everyone
 * who can read the repository can read. The text is cut to the capture limit.
 */
export function threadContext(doc: Document, url: string): GmailContext | null {
  const subject = findSubject(doc);
  if (!subject) return null;
  const parts = all(doc, SELECTORS.message).flatMap((m) => {
    const body = first(m, SELECTORS.body);
    if (!body) return [];
    const who = first(m, SELECTORS.sender)?.getAttribute("name")?.trim();
    return [`${who ? `From ${who}:\n\n` : ""}${text(body)}`];
  });
  if (!parts.length) return null;
  return { kind: "gmail-context", subject: text(subject).slice(0, MAX_TITLE), text: clip(parts.join("\n\n---\n\n")), url };
}

/**
 * Mounts the button beside the open thread's subject, once: a host element with an open
 * shadow root, so Gmail's styles don't reach the button. Styles are set through the DOM,
 * which a page's style-src doesn't govern. Returns the host, or null when there's no thread.
 */
export function mount(doc: Document, onClick: (e: MouseEvent) => void): HTMLElement | null {
  const subject = findSubject(doc);
  if (!subject?.parentElement) return null;
  const existing = subject.parentElement.querySelector<HTMLElement>(`:scope > [${HOST_ATTR}]`);
  if (existing) return existing;
  const host = doc.createElement("span");
  host.setAttribute(HOST_ATTR, "");
  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = "Save to Docsworth";
  button.title = "Open the Docsworth side panel with this thread, to search for related pages or draft one from it";
  Object.assign(button.style, {
    font: "500 13px/1 system-ui, sans-serif",
    padding: "6px 10px",
    marginLeft: "8px",
    border: "1px solid #c7c7cc",
    borderRadius: "6px",
    background: "#fff",
    color: "#1f2328",
    cursor: "pointer",
    verticalAlign: "middle",
  });
  button.addEventListener("click", onClick);
  host.attachShadow({ mode: "open" }).appendChild(button);
  subject.insertAdjacentElement("afterend", host);
  return host;
}

type Reply = { ok: boolean; error?: string } | undefined;

/**
 * The button's click: only a trusted one counts (Gmail's own scripts can dispatch clicks, but
 * not trusted ones). It reads the thread then, and only then, and sends it in the click's turn,
 * so the worker can open the side panel (that needs a user gesture, and it lasts through the
 * message). The button says how it went.
 */
export function clickHandler(doc: Document, url: () => string, send: (ctx: GmailContext) => Promise<Reply>): (e: MouseEvent) => void {
  return (e) => {
    if (!e.isTrusted) return;
    const ctx = threadContext(doc, url());
    if (!ctx) return;
    const button = e.currentTarget as HTMLButtonElement;
    send(ctx).then(
      (r) => {
        button.textContent = r?.ok ? "Opened in Docsworth" : "Couldn't open Docsworth";
        button.title = r?.ok ? "" : (r?.error ?? "no answer from the extension");
      },
      () => {
        button.textContent = "Couldn't open Docsworth";
      },
    );
  };
}
