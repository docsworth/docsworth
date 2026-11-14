import { describe, expect, it, vi } from "vitest";
import { CAPTURE_FILE } from "../src/capture.js";
import { CAPTURE_FN, type Extraction, MAX_TEXT_BYTES, PENDING_TTL_MS } from "../src/contract.js";
import { writePending } from "../src/pending.js";
import { MENU, MENU_PAGE, MENUS, onAction, onAlarm, onMenuClick, onMessage, type WorkerApi } from "../src/worker.js";
import { FakeArea } from "./fake-chrome.js";

// R15 at the worker's own boundary: a refused message opens no panel and stores nothing; an
// accepted one does both. (contract.test.ts covers each refusal's reason.)

const OWN = "abcdefghijklmnopabcdefghijklmnop";
const THREAD = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQZ";

/**
 * The worker's Chrome. By default Chrome refuses to run capture.js, as it does in a frame the
 * extension may not read; `read` makes the tab answer with an extraction instead.
 */
function worker(read?: Extraction) {
  const session = new FakeArea();
  const open = vi.fn().mockResolvedValue(undefined);
  const alarm = vi.fn().mockResolvedValue(undefined);
  const executeScript = vi.fn(async (inj: { files?: string[] }) => {
    if (!read) throw new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.");
    return [{ frameId: 0, documentId: "d", result: inj.files ? undefined : read }];
  });
  const api = { runtime: { id: OWN }, sidePanel: { open }, storage: { session }, alarms: { create: alarm }, scripting: { executeScript } } as unknown as WorkerApi;
  return { api, open, session, alarm, executeScript };
}
const article: Extraction = { title: "Rotating TLS certificates", url: "https://docs.example.com/tls", markdown: "## Rotate\n\n```sh\ncertbot renew\n```", cut: false };
const stored = (w: ReturnType<typeof worker>) => [...w.session.data.values()] as Record<string, unknown>[];
const gmail = (over: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({ id: OWN, tab: { id: 7, windowId: 3 } as chrome.tabs.Tab, frameId: 0, url: THREAD, origin: "https://mail.google.com", ...over });
const msg = { kind: "gmail-context", subject: "Re: payments", text: "the thread", url: THREAD };

describe("the worker's messages", () => {
  it("opens the panel and leaves it the thread, for an accepted message", async () => {
    const w = worker();
    const reply = vi.fn();
    expect(onMessage(w.api, msg, gmail(), reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(w.open).toHaveBeenCalledWith({ tabId: 7 });
    expect([...w.session.data.values()]).toEqual([expect.objectContaining({ window: 3, source: "gmail", title: "Re: payments", text: "the thread", url: THREAD })]);
  });

  it("opens nothing and stores nothing for a refused one", async () => {
    const refused: [unknown, chrome.runtime.MessageSender][] = [
      [msg, gmail({ id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" })],
      [msg, gmail({ url: "https://mail.google.com.evil.example/", origin: "https://mail.google.com.evil.example" })],
      [msg, gmail({ frameId: 1 })],
      [{ kind: "tools/call", name: "draft_page", arguments: {} }, gmail()],
      [{ ...msg, text: "é".repeat(MAX_TEXT_BYTES) }, gmail()],
    ];
    for (const [m, sender] of refused) {
      const w = worker();
      const reply = vi.fn();
      expect(onMessage(w.api, m, sender, reply)).toBe(false);
      expect(reply).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });
      await new Promise((r) => setTimeout(r, 5));
      expect(w.open).not.toHaveBeenCalled();
      expect(w.session.writes).toEqual([]);
    }
  });
});

describe("the context menu", () => {
  it("has the two items, each where it applies", () => {
    expect(MENUS).toEqual([
      { id: MENU, title: "Save selection to Docsworth", contexts: ["selection"] },
      { id: MENU_PAGE, title: "Save page to Docsworth", contexts: ["page"] },
    ]);
  });

  it("opens the panel, then reads the page's main content in its top frame, and leaves it the markdown", async () => {
    const w = worker(article);
    onMenuClick(w.api, { menuItemId: MENU_PAGE, pageUrl: "https://docs.example.com/tls?utm_source=x", frameId: 0 }, { id: 4, windowId: 2 });
    // In the click's turn: the open, and nothing read yet.
    expect(w.open).toHaveBeenCalledWith({ tabId: 4 });
    expect(w.executeScript).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(w.session.data.size).toBe(1));
    expect(w.executeScript.mock.calls.map(([inj]) => inj)).toEqual([
      { target: { tabId: 4, frameIds: [0] }, files: [CAPTURE_FILE] },
      expect.objectContaining({ target: { tabId: 4, frameIds: [0] }, args: [CAPTURE_FN, "page"] }),
    ]);
    expect(stored(w)).toEqual([{ window: 2, source: "page", title: article.title, text: article.markdown, url: article.url, at: expect.any(Number) }]);
  });

  it("reads a selection in the frame it was made in", async () => {
    const w = worker(article);
    onMenuClick(w.api, { menuItemId: MENU, selectionText: "plain", pageUrl: "https://docs.example.com/", frameId: 6 }, { id: 4, windowId: 2 });
    await vi.waitFor(() => expect(w.session.data.size).toBe(1));
    expect(w.executeScript.mock.calls.map(([inj]) => (inj as { target: unknown }).target)).toEqual([{ tabId: 4, frameIds: [6] }, { tabId: 4, frameIds: [6] }]);
    expect(stored(w)[0]).toMatchObject({ source: "selection", text: article.markdown });
  });

  it("says when what it read was cut", async () => {
    const w = worker({ ...article, cut: true });
    onMenuClick(w.api, { menuItemId: MENU_PAGE, pageUrl: article.url }, { id: 4, windowId: 2 });
    await vi.waitFor(() => expect(w.session.data.size).toBe(1));
    expect(stored(w)[0]!.note).toMatch(/^Cut at 64 KB/);
  });

  it("falls back to Chrome's plain text of a selection it may not read, and says so", async () => {
    const w = worker();
    onMenuClick(w.api, { menuItemId: MENU, selectionText: "Rotate every 60 days.", pageUrl: "https://docs.example.com/", frameUrl: "https://embed.example.net/f", frameId: 6 }, { id: 4, windowId: 2 });
    await vi.waitFor(() => expect(w.session.data.size).toBe(1));
    expect(stored(w)[0]).toMatchObject({ source: "selection", text: "Rotate every 60 days.", url: "https://embed.example.net/f", note: expect.stringMatching(/^Plain text:/) });
  });

  it("opens an empty draft for a page it may not read, and says so", async () => {
    const w = worker();
    onMenuClick(w.api, { menuItemId: MENU_PAGE, pageUrl: "https://chromewebstore.google.com/detail/x" }, { id: 4, windowId: 2 });
    await vi.waitFor(() => expect(w.session.data.size).toBe(1));
    expect(stored(w)[0]).toMatchObject({ source: "page", text: "", url: "https://chromewebstore.google.com/detail/x", note: expect.stringMatching(/^Chrome didn't let Docsworth read this page/) });
  });

  it("reads nothing and stores nothing when the panel didn't open", async () => {
    const w = worker(article);
    w.open.mockRejectedValue(new Error("`sidePanel.open()` may only be called in response to a user gesture."));
    onMenuClick(w.api, { menuItemId: MENU_PAGE, pageUrl: article.url }, { id: 4, windowId: 2 });
    await new Promise((r) => setTimeout(r, 5));
    expect(w.executeScript).not.toHaveBeenCalled();
    expect(w.session.writes).toEqual([]);
  });

  it("sends a selection to its tab's panel, cut to the limit", async () => {
    const w = worker();
    onMenuClick(w.api, { menuItemId: MENU, selectionText: "é".repeat(MAX_TEXT_BYTES), pageUrl: "https://wiki.example.com/tls" }, { id: 4, windowId: 2, title: "TLS" });
    await vi.waitFor(() => expect(w.session.data.size).toBe(1));
    expect(w.open).toHaveBeenCalledWith({ tabId: 4 });
    const [c] = [...w.session.data.values()] as { window: number; source: string; title: string; text: string; url: string }[];
    expect([c!.window, c!.source, c!.title, c!.url]).toEqual([2, "selection", "TLS", "https://wiki.example.com/tls"]);
    expect(new TextEncoder().encode(c!.text).length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
  });

  it("does nothing for another menu item or a tab it can't open a panel in", async () => {
    const w = worker();
    onMenuClick(w.api, { menuItemId: "other", selectionText: "x" }, { id: 4, windowId: 2 });
    onMenuClick(w.api, { menuItemId: MENU, selectionText: "x" }, { id: -1, windowId: 2 });
    onMenuClick(w.api, { menuItemId: MENU, selectionText: "x" }, undefined);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.open).not.toHaveBeenCalled();
    expect(w.session.writes).toEqual([]);
  });
});

describe("the toolbar button", () => {
  it("opens the panel itself, in the click's turn, which gives the extension the tab", () => {
    const w = worker();
    onAction(w.api, { id: 4, windowId: 2 });
    expect(w.open).toHaveBeenCalledWith({ tabId: 4 });
  });

  it("does nothing without a tab, and nothing more if the panel didn't open", async () => {
    const w = worker();
    w.open.mockRejectedValue(new Error("no gesture"));
    onAction(w.api, { id: -1, windowId: 2 });
    onAction(w.api, undefined);
    expect(w.open).not.toHaveBeenCalled();
    onAction(w.api, { id: 4, windowId: 2 });
    await new Promise((r) => setTimeout(r, 5));
    expect(w.session.writes).toEqual([]);
  });
});

describe("the time limit", () => {
  it("an accepted message sets the capture's alarm", async () => {
    const w = worker();
    const reply = vi.fn();
    onMessage(w.api, msg, gmail(), reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    const [key] = [...w.session.data.keys()];
    expect(w.alarm).toHaveBeenCalledWith(key, { when: expect.any(Number) });
  });

  it("a capture's alarm removes every capture past ten minutes, and nothing else", async () => {
    const w = worker();
    const now = 1_800_000_000_000;
    w.session.data.set("token", "t".repeat(43));
    await writePending(w.session, { window: 1, source: "gmail", title: "old", text: "x", url: THREAD, at: now - PENDING_TTL_MS - 1 }, "old").written;
    await writePending(w.session, { window: 2, source: "selection", title: "older", text: "x", url: "https://wiki.example.com/", at: now - PENDING_TTL_MS - 60_000 }, "older").written;
    await writePending(w.session, { window: 1, source: "gmail", title: "new", text: "x", url: THREAD, at: now }, "new").written;
    await onAlarm(w.api, { name: "something-else" }, now);
    expect(w.session.data.size).toBe(4);
    await onAlarm(w.api, { name: "pending:new" }, now);
    expect([...w.session.data.keys()].sort()).toEqual(["pending:new", "token"]);
    expect(w.alarm).not.toHaveBeenCalled();
  });

  it("sets the alarm again, a minute on, when its prune failed", async () => {
    const w = worker();
    const now = 1_800_000_000_000;
    w.session.getKeys = () => Promise.reject(new Error("storage busy"));
    await onAlarm(w.api, { name: "pending:x" }, now);
    expect(w.alarm).toHaveBeenCalledWith("pending:x", { when: now + 60_000 });
  });
});
