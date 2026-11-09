import { describe, expect, it } from "vitest";
import { clip, type GmailContext, isPending, MAX_TEXT_BYTES, refusal } from "../src/contract.js";

// R15: the message contract. A content script runs inside a page and may send one thing, a
// Gmail thread's context, from this extension, in Gmail's top frame. Everything else is
// refused, with the reason the worker answers.

const OWN = "abcdefghijklmnopabcdefghijklmnop";
const THREAD = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQZ";
const sender = (over: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({
  id: OWN,
  tab: { id: 7, windowId: 3 } as chrome.tabs.Tab,
  frameId: 0,
  url: THREAD,
  origin: "https://mail.google.com",
  ...over,
});
const msg = (over: Partial<GmailContext> & Record<string, unknown> = {}) => ({ kind: "gmail-context", subject: "Re: payments", text: "the thread", url: THREAD, ...over });

describe("the worker's message contract", () => {
  it("accepts a Gmail thread's context from its own content script in Gmail's top frame", () => {
    expect(refusal(msg(), sender(), OWN)).toBeNull();
  });

  it("refuses a message from another extension, or none", () => {
    expect(refusal(msg(), sender({ id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }), OWN)).toBe("not from this extension");
    expect(refusal(msg(), sender({ id: undefined }), OWN)).toBe("not from this extension");
  });

  it("refuses an extension page (no tab) and a subframe", () => {
    expect(refusal(msg(), sender({ tab: undefined, url: `chrome-extension://${OWN}/sidepanel.html`, origin: `chrome-extension://${OWN}` }), OWN)).toBe("not from a tab's top frame");
    expect(refusal(msg(), sender({ frameId: 2 }), OWN)).toBe("not from a tab's top frame");
  });

  it("refuses any origin but Gmail's exact one, lookalikes included", () => {
    for (const url of ["https://mail.google.com.evil.example/mail/", "http://mail.google.com/mail/", "https://evil.example/https://mail.google.com/", "https://docs.google.com/", "not a url"]) {
      expect(refusal(msg(), sender({ url, origin: undefined }), OWN), url).toBe("not from Gmail");
    }
    expect(refusal(msg(), sender({ origin: "https://mail.google.com.evil.example" }), OWN)).toBe("not from Gmail");
  });

  it("refuses anything but the exact schema: a tool call, extra or missing keys, wrong types", () => {
    const bad: unknown[] = [
      { kind: "tools/call", name: "draft_page", arguments: { title: "x" } },
      { method: "tools/call", params: { name: "propose_edit" } },
      msg({ extra: "x" }),
      { kind: "gmail-context", subject: "s", text: "t" },
      msg({ subject: 3 as unknown as string }),
      msg({ kind: "gmail-context-v2" as "gmail-context" }),
      null,
      "gmail-context",
      [msg()],
    ];
    for (const m of bad) expect(refusal(m, sender(), OWN), JSON.stringify(m)).toBe("not a Gmail thread's context");
  });

  it("refuses a thread address that isn't Gmail's", () => {
    expect(refusal(msg({ url: "https://evil.example/" }), sender(), OWN)).toBe("not a Gmail address");
  });

  it("refuses text over 64 KB in UTF-8, and a subject over 300 characters", () => {
    expect(refusal(msg({ text: "a".repeat(MAX_TEXT_BYTES) }), sender(), OWN)).toBeNull();
    expect(refusal(msg({ text: "é".repeat(MAX_TEXT_BYTES / 2 + 1) }), sender(), OWN)).toBe("too large");
    expect(refusal(msg({ subject: "s".repeat(301) }), sender(), OWN)).toBe("too large");
  });
});

describe("clip", () => {
  it("cuts to the byte limit, never inside a character", () => {
    expect(clip("hello", 10)).toBe("hello");
    expect(clip("ab😀cd", 4)).toBe("ab"); // the emoji is four bytes: it doesn't fit half in
    expect(clip("ab😀cd", 6)).toBe("ab😀");
    const big = clip("é".repeat(MAX_TEXT_BYTES));
    expect(new TextEncoder().encode(big).length).toBe(MAX_TEXT_BYTES);
    expect(big).not.toContain("�");
  });
});

describe("a stored capture, read back", () => {
  const ok = { window: 3, source: "gmail", title: "t", text: "x", url: THREAD, at: 1 };
  it("is checked field by field", () => {
    expect(isPending(ok)).toBe(true);
    for (const bad of [{ ...ok, window: "3" }, { ...ok, source: "page" }, { ...ok, title: "t".repeat(301) }, { ...ok, text: "a".repeat(MAX_TEXT_BYTES + 1) }, { ...ok, at: "now" }, null, "x"]) expect(isPending(bad), JSON.stringify(bad)?.slice(0, 80)).toBe(false);
  });
});
