import { describe, expect, it, vi } from "vitest";
import { MAX_TEXT_BYTES, PENDING_TTL_MS } from "../src/contract.js";
import { writePending } from "../src/pending.js";
import { MENU, onAlarm, onMenuClick, onMessage, type WorkerApi } from "../src/worker.js";
import { FakeArea } from "./fake-chrome.js";

// R15 at the worker's own boundary: a refused message opens no panel and stores nothing; an
// accepted one does both. (contract.test.ts covers each refusal's reason.)

const OWN = "abcdefghijklmnopabcdefghijklmnop";
const THREAD = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQZ";

function worker() {
  const session = new FakeArea();
  const open = vi.fn().mockResolvedValue(undefined);
  const alarm = vi.fn().mockResolvedValue(undefined);
  const api = { runtime: { id: OWN }, sidePanel: { open }, storage: { session }, alarms: { create: alarm } } as unknown as WorkerApi;
  return { api, open, session, alarm };
}
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
