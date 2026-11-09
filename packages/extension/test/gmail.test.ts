import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TEXT_BYTES } from "../src/contract.js";
import { clickHandler, HOST_ATTR, mount, SELECTORS, threadContext } from "../src/content/adapter.js";

// R16: the Gmail adapter on Gmail-shaped fixtures. They prove the adapter's logic against the
// markup the selectors were written for, not that live Gmail still has it: the Gmail
// checklist in README.md is how that's checked, by a person signed in.

const EXT = process.env.DOCSWORTH_EXTENSION_ROOT!;
const THREAD = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQZ";
function load(name: string) {
  const html = readFileSync(join(EXT, "test/fixtures", name), "utf8");
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, "");
  return document;
}
afterEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
});

const button = () => document.querySelector(`[${HOST_ATTR}]`)!.shadowRoot!.querySelector("button")!;

describe("reading a thread", () => {
  it("takes the subject and each expanded message, by its sender's name, without addresses", () => {
    const ctx = threadContext(load("gmail-thread.html"), THREAD)!;
    expect(ctx.kind).toBe("gmail-context");
    expect(ctx.subject).toBe("Re: Payments worker stuck after the deploy SUBJECT_NONCE");
    expect(ctx.url).toBe(THREAD);
    expect(ctx.text).toMatch(/^From Ana Example:\n\nThe payments worker stopped draining the queue after Thursday's deploy\./);
    expect(ctx.text).toContain("kubectl rollout restart deploy/payments-worker");
    expect(ctx.text).toContain("\n\n---\n\nFrom Cy Example:\n\nIt happens when the deploy lands mid-batch.");
    expect(ctx.text).not.toContain("Ben Example"); // collapsed: no body in the page
    expect(ctx.text).not.toMatch(/@example\.com/);
  });

  it("falls back to the second selectors when Gmail's class names are gone", () => {
    const ctx = threadContext(load("gmail-thread-fallback.html"), THREAD)!;
    expect([ctx.subject, ctx.text]).toEqual(["Fallback subject", "From Dee Example:\n\nBody found by the fallback."]);
  });

  it("pins each selector to the fixture it was written against", () => {
    const doc = load("gmail-thread.html");
    for (const [what, list] of Object.entries(SELECTORS)) expect(doc.querySelector(list[0]), `${what}: ${list[0]}`).not.toBeNull();
    const fallback = load("gmail-thread-fallback.html");
    for (const [what, list] of Object.entries(SELECTORS)) {
      expect(fallback.querySelector(list[0]), `${what}: ${list[0]} shouldn't match the fallback fixture`).toBeNull();
      expect(list.slice(1).some((s) => fallback.querySelector(s)), `${what}: a fallback`).toBe(true);
    }
  });

  it("cuts a long thread to 64 KB", () => {
    const doc = load("gmail-thread.html");
    doc.querySelector("div.a3s")!.textContent = "é".repeat(MAX_TEXT_BYTES);
    expect(new TextEncoder().encode(threadContext(doc, THREAD)!.text).length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
  });

  it("reads nothing from the inbox, where no thread is open", () => {
    expect(threadContext(load("gmail-inbox.html"), THREAD)).toBeNull();
  });
});

describe("the button", () => {
  it("mounts once beside the subject, in its own shadow root", () => {
    const doc = load("gmail-thread.html");
    const host = mount(doc, () => {})!;
    expect(mount(doc, () => {})).toBe(host);
    expect(doc.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
    expect(host.previousElementSibling?.matches("h2.hP")).toBe(true);
    expect(button().textContent).toBe("Save to Docsworth");
  });

  it("mounts nothing where no thread is open", () => {
    expect(mount(load("gmail-inbox.html"), () => {})).toBeNull();
    expect(document.querySelector(`[${HOST_ATTR}]`)).toBeNull();
  });

  it("ignores a click a script dispatched, and sends the thread on a trusted one", async () => {
    const doc = load("gmail-thread.html");
    const send = vi.fn().mockResolvedValue({ ok: true });
    const onClick = clickHandler(doc, () => THREAD, send);
    mount(doc, onClick);
    button().click(); // what a page script can do: not trusted
    expect(send).not.toHaveBeenCalled();
    onClick({ isTrusted: true, currentTarget: button() } as unknown as MouseEvent);
    expect(send).toHaveBeenCalledTimes(1); // in the click's turn, not after an await
    expect(send.mock.calls[0]![0]).toEqual(threadContext(doc, THREAD));
    await vi.waitFor(() => expect(button().textContent).toBe("Opened in Docsworth"));
  });

  it("says when the worker refused", async () => {
    const doc = load("gmail-thread.html");
    const onClick = clickHandler(doc, () => THREAD, () => Promise.resolve({ ok: false, error: "not from Gmail" }));
    mount(doc, onClick);
    onClick({ isTrusted: true, currentTarget: button() } as unknown as MouseEvent);
    await vi.waitFor(() => expect(button().textContent).toBe("Couldn't open Docsworth"));
    expect(button().title).toBe("not from Gmail");
  });
});
