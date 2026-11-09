import { type ChildProcess, spawn } from "node:child_process";
import { DocsworthClient, DocsworthError } from "@docsworth/ui";
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadRepo } from "../../../src/core/repo.js";
import { copyAcme } from "../../../test/helpers.js";
import { type Pending, PENDING_TTL_MS } from "../src/contract.js";
import { donePending, takePending, type Taken, writePending } from "../src/pending.js";
import { explain, Options } from "../src/options/app.js";
import { Panel, type PanelEnv, viewFor } from "../src/panel/app.js";
import { FakeArea } from "./fake-chrome.js";

// The side panel and the options page, rendered with happy-dom against the real `docsworth
// serve` CLI on a copy of examples/acme in local mode, as the web app's view tests are. The
// page sits at the server's origin: happy-dom gives a chrome-extension:// page the opaque
// origin "null", so the extension's own Origin check and CORS are proven in a real Chrome,
// by chrome.e2e.test.ts, which also delivers captures the way the worker does.

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
let origin = "";
let TOKEN = "";
let hidden: { id: string; title: string; path: string }[] = [];

beforeAll(async () => {
  const acme = copyAcme();
  hidden = loadRepo(acme.root).pages.filter((p) => p.acl !== "internal");
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--as-of", "2026-11-02", "serve", acme.root, "--port", "0"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? "", DOCSWORTH_NO_GH_CLI: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = await new Promise<URL>((done, fail) => {
    let err = "";
    child.stderr!.on("data", (d: Buffer) => {
      err += d;
      const m = / at (http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43})\n/.exec(err);
      if (m) done(new URL(m[1]!));
    });
    child.on("exit", (code) => fail(new Error(`serve exited ${code}: ${err}`)));
  });
  origin = url.origin;
  TOKEN = url.hash.slice(3);
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(`${origin}/`);
  return async () => {
    await new Promise<void>((r) => {
      child.once("exit", () => r());
      child.kill("SIGTERM");
    });
    acme.cleanup();
  };
}, 30_000);

let container: HTMLElement;
afterEach(() => {
  render(null, container);
  container.remove();
});

/** A client that records which tools it called, around the real one. */
function recording() {
  const client = new DocsworthClient({ url: origin, token: TOKEN, name: "docsworth-extension" });
  const tools: string[] = [];
  const call = client.call.bind(client);
  client.call = ((tool: string, args?: Record<string, unknown>) => (tools.push(tool), call(tool, args))) as typeof client.call;
  return { client, tools };
}

let pushed = 0;
/**
 * Renders the panel; `push` delivers captures, once the panel listens, as the worker's writes
 * would, and returns the keys they were given.
 */
function panel(over: Partial<PanelEnv> = {}) {
  let deliver: ((batch: Taken[]) => void) | null = null;
  let drop: ((keys: string[]) => void) | null = null;
  const env: PanelEnv = {
    client: null,
    captures: (cb, gone) => ((deliver = cb), (drop = gone), () => {}),
    done: vi.fn(),
    openOptions: vi.fn(),
    newSession: vi.fn(),
    extensionId: EXT_ID,
    ...over,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  render(<Panel env={env} />, container);
  const push = async (batch: Pending[]) => {
    await vi.waitFor(() => expect(deliver).not.toBeNull());
    const taken = batch.map((capture) => ({ key: `pending:${++pushed}`, capture }));
    deliver!(taken);
    return taken.map((t) => t.key);
  };
  /** Their records were removed: the alarm's prune, or the token forgotten. */
  const gone = (keys: string[]) => drop!(keys);
  return { root: container, env, push, gone };
}

const capture = (over: Partial<Pending> = {}): Pending => ({ window: 1, source: "gmail", title: "Re: Payments worker stuck after the deploy", text: "Restarting the consumer group fixed it.", url: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQZ", at: Date.now(), ...over });
const input = (root: HTMLElement, label: string) => [...root.querySelectorAll("label")].find((l) => l.textContent?.startsWith(label))!.querySelector("input, textarea") as HTMLInputElement;

function assertNoHiddenPage(root: HTMLElement) {
  expect(hidden.length).toBeGreaterThan(0);
  for (const p of hidden) for (const needle of [p.id, p.title, p.path]) expect(root.innerHTML, `${p.id}: ${needle}`).not.toContain(needle);
}

describe("the side panel against a real serve", () => {
  it("asks to connect when there's no token", () => {
    const { root, env } = panel();
    expect(root.textContent).toContain("Not connected to docsworth serve yet.");
    root.querySelector("button")!.click();
    expect(env.openOptions).toHaveBeenCalled();
  });

  it("searches, and opens a page with its links routed in the panel", async () => {
    const { client } = recording();
    const { root } = panel({ client });
    await vi.waitFor(() => expect(root.textContent).toContain("local mode"));
    const box = root.querySelector<HTMLInputElement>("input[type=search]")!;
    box.value = "deploy to production";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0)); // the box re-renders with what was typed
    box.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(root.querySelector(".dw-result a")).not.toBeNull(), { timeout: 8000 });
    (root.querySelector(".dw-result a") as HTMLAnchorElement).click();
    await vi.waitFor(() => expect(root.querySelector(".dw-prose")).not.toBeNull(), { timeout: 8000 });
    expect(root.textContent).toContain("Suggest an addition");
    assertNoHiddenPage(root);
  });

  it("shows a Gmail capture with the pages it may already be in, and a draft filled from it, writing nothing", async () => {
    const { client, tools } = recording();
    const { root, push } = panel({ client });
    await vi.waitFor(() => expect(root.textContent).toContain("local mode"));
    await push([capture()]);
    await vi.waitFor(() => expect(root.textContent).toContain("From Gmail"));
    expect(input(root, "Title").value).toBe("Re: Payments worker stuck after the deploy");
    expect(input(root, "Body").value).toBe("Restarting the consumer group fixed it.");
    expect(input(root, "Source").value).toBe(""); // a mailbox's address means nothing to anyone else
    expect(input(root, "Why it's needed").value).toBe("Written down from an email thread");
    await vi.waitFor(() => expect(tools).toContain("search"), { timeout: 8000 });
    expect(root.textContent).toContain("everyone who can read the repository can read it");
    expect(root.textContent).toContain("Drafting is off here"); // local mode: no writes
    expect(tools).not.toContain("draft_page");
    assertNoHiddenPage(root);
  });

  it("puts a page's address in as the source of a selection", async () => {
    const { client } = recording();
    const { root, push } = panel({ client });
    await push([capture({ source: "selection", title: "", text: "Rotate the TLS certificates every 60 days.\nMore.", url: "https://wiki.example.com/tls" })]);
    await vi.waitFor(() => expect(root.textContent).toContain("From a page"));
    expect(input(root, "Title").value).toBe("Rotate the TLS certificates every 60 days.");
    expect(input(root, "Source").value).toBe("https://wiki.example.com/tls");
  });

  it("keeps a draft on screen when another capture arrives, behind a notice", async () => {
    const { client } = recording();
    const { root, push } = panel({ client });
    await push([capture({ title: "First thread" })]);
    await vi.waitFor(() => expect(input(root, "Title").value).toBe("First thread"));
    const title = input(root, "Title");
    title.value = "First thread, edited";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    await push([capture({ title: "Second thread" }), capture({ title: "Third thread" })]);
    await vi.waitFor(() => expect(root.textContent).toContain("2 more captures are waiting."));
    expect(input(root, "Title").value).toBe("First thread, edited");
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Open the next one")!.click();
    await vi.waitFor(() => expect(input(root, "Title").value).toBe("Second thread"));
    expect(root.textContent).toContain("Another capture is waiting.");
  });

  it("keeps a capture until the panel is done with it, so a reloaded panel shows it again", async () => {
    // The store and the pulls main.tsx wires to chrome.storage.session, over an in-memory area.
    const area = new FakeArea();
    await writePending(area, capture({ title: "Kept through a reload" }), "a").written;
    const stored = (): Partial<PanelEnv> => {
      const seen = new Set<string>();
      return { captures: (cb) => (void takePending(area, 1, Date.now(), seen).then((b) => b.length && cb(b)), () => {}), done: (key) => void donePending(area, key) };
    };
    const reload = () => {
      render(null, container);
      container.remove();
    };
    const first = panel({ client: recording().client, ...stored() });
    await vi.waitFor(() => expect(input(first.root, "Title").value).toBe("Kept through a reload"));
    reload(); // "Start a new session", another token, or the panel closed and opened again
    const second = panel({ client: recording().client, ...stored() });
    await vi.waitFor(() => expect(input(second.root, "Title").value).toBe("Kept through a reload"));
    (second.root.querySelector(".dw-brand") as HTMLAnchorElement).click(); // leaving it is being done with it
    await vi.waitFor(() => expect(area.data.size).toBe(0));
    reload();
    const third = panel({ client: recording().client, ...stored() });
    await vi.waitFor(() => expect(third.root.textContent).toContain("Search your team's pages"));
    expect(third.root.textContent).not.toContain("From Gmail");
  });

  it("leaves captures stored, untaken, through a connection error, and says so", async () => {
    const area = new FakeArea();
    await writePending(area, capture(), "a").written;
    const client = new DocsworthClient({ url: origin, token: TOKEN });
    client.call = () => Promise.reject(new TypeError("Failed to fetch"));
    const { root, env } = panel({ client, captures: (cb) => (void takePending(area, 1, Date.now(), new Set()).then((b) => b.length && cb(b)), () => {}) });
    await vi.waitFor(() => expect(root.textContent).toContain("A capture sent here is kept for ten minutes"));
    await new Promise((r) => setTimeout(r, 50));
    expect(area.reads).toEqual([]); // nothing taken into the panel's memory while it can't connect
    expect(area.data.has("pending:a")).toBe(true);
    expect(root.textContent).not.toContain("From Gmail");
    expect(env.done).not.toHaveBeenCalled();
  });

  it("never shows a capture that's past its ten minutes when it arrives", async () => {
    const { root, push } = panel({ client: recording().client });
    await vi.waitFor(() => expect(root.textContent).toContain("local mode"));
    await push([capture({ title: "Too old", at: Date.now() - PENDING_TTL_MS - 1000 })]);
    await new Promise((r) => setTimeout(r, 100));
    expect(root.textContent).toContain("Search your team's pages");
    expect(root.textContent).not.toContain("From Gmail");
  });

  it("never shows a capture past its ten minutes, though it was waiting", async () => {
    const { root, push } = panel({ client: recording().client });
    await push([capture({ title: "On screen" }), capture({ title: "Expires while waiting", at: Date.now() - PENDING_TTL_MS + 300 }), capture({ title: "Fresh" })]);
    await vi.waitFor(() => expect(root.textContent).toContain("2 more captures are waiting."));
    await new Promise((r) => setTimeout(r, 400)); // its time is up; no removal event has come
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Open the next one")!.click();
    await vi.waitFor(() => expect(input(root, "Title").value).toBe("Fresh"));
    expect(root.textContent).not.toContain("waiting.");
  });

  it("is done with a capture when its draft is a PR, or when it opens the next one", async () => {
    const { client } = recording();
    const call = client.call.bind(client);
    client.call = (async (tool: string, args?: Record<string, unknown>) => {
      if (tool === "ui_capabilities") return { ...(await call<Record<string, unknown>>(tool, args)), writes: true, write_tools: ["draft_page"] };
      if (tool === "draft_page") return { pr_url: "https://github.com/acme/kb/pull/7", pr_number: 7, branch: "docsworth/draft/x", id: "rb-x", path: "knowledge/runbooks/rb-x.md" };
      return call(tool, args);
    }) as typeof client.call;
    const { root, env, push } = panel({ client });
    await vi.waitFor(() => expect(root.textContent).toContain("local mode"));
    const [first, second] = await push([capture({ title: "First thread" }), capture({ title: "Second thread" })]);
    await vi.waitFor(() => expect(input(root, "Title").value).toBe("First thread"));
    await vi.waitFor(() => expect((root.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(false));
    expect(env.done).not.toHaveBeenCalled();
    root.querySelector("form.dw-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(env.done).toHaveBeenCalledWith(first));
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Open the next one")!.click();
    await vi.waitFor(() => expect(input(root, "Title").value).toBe("Second thread"));
    expect(env.done).not.toHaveBeenCalledWith(second); // still on screen
    (root.querySelector(".dw-brand") as HTMLAnchorElement).click();
    await vi.waitFor(() => expect(env.done).toHaveBeenCalledWith(second));
  });

  it("is done with the capture on screen when it opens the next one, with no draft", async () => {
    const { root, env, push } = panel({ client: recording().client });
    const [first, second] = await push([capture({ title: "First thread" }), capture({ title: "Second thread" })]);
    await vi.waitFor(() => expect(input(root, "Title").value).toBe("First thread"));
    expect(env.done).not.toHaveBeenCalled();
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Open the next one")!.click();
    await vi.waitFor(() => expect(input(root, "Title").value).toBe("Second thread"));
    expect(env.done).toHaveBeenCalledWith(first);
    expect(env.done).not.toHaveBeenCalledWith(second);
  });

  it("keeps the capture when its draft fails", async () => {
    const { client } = recording();
    const call = client.call.bind(client);
    client.call = (async (tool: string, args?: Record<string, unknown>) => {
      if (tool === "ui_capabilities") return { ...(await call<Record<string, unknown>>(tool, args)), writes: true, write_tools: ["draft_page"] };
      if (tool === "draft_page") throw new DocsworthError("owner_mismatch", "CODEOWNERS gives knowledge/runbooks/x.md to another team");
      return call(tool, args);
    }) as typeof client.call;
    const { root, env, push } = panel({ client });
    await vi.waitFor(() => expect(root.textContent).toContain("local mode"));
    await push([capture()]);
    await vi.waitFor(() => expect((root.querySelector("button[type=submit]") as HTMLButtonElement | null)?.disabled).toBe(false));
    root.querySelector("form.dw-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(root.textContent).toContain("CODEOWNERS gives knowledge/runbooks/x.md to another team"));
    expect(env.done).not.toHaveBeenCalled();
  });

  it("drops a waiting capture whose record is gone, and keeps the draft on screen", async () => {
    const { root, push, gone } = panel({ client: recording().client });
    const [first, second] = await push([capture({ title: "On screen" }), capture({ title: "Expired" }), capture({ title: "Still waiting" })]);
    await vi.waitFor(() => expect(root.textContent).toContain("2 more captures are waiting."));
    gone([second!, first!]); // the alarm pruned the second; the first's record went too, but it's being written
    await vi.waitFor(() => expect(root.textContent).toContain("Another capture is waiting."));
    expect(input(root, "Title").value).toBe("On screen");
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Open the next one")!.click();
    await vi.waitFor(() => expect(input(root, "Title").value).toBe("Still waiting"));
    expect(root.textContent).not.toContain("waiting.");
  });

  it("says how to start the server for this extension when it refuses the extension's origin", async () => {
    const client = new DocsworthClient({ url: origin, token: TOKEN });
    client.call = () => Promise.reject(new DocsworthError("forbidden", "requests from this origin are not allowed; an extension must be allowed with --allow-extension"));
    const { root } = panel({ client });
    await vi.waitFor(() => expect(root.textContent).toContain(`docsworth serve --allow-extension ${EXT_ID}`));
  });

  it("routes the shared components' links", () => {
    expect(viewFor("/p/rb-deploy-prod")).toEqual({ name: "page", id: "rb-deploy-prod" });
    expect(viewFor("/t/platform")).toEqual({ name: "team", team: "platform" });
    expect(viewFor("/search?q=a%20b")).toEqual({ name: "search", q: "a b" });
    expect(viewFor("/graph")).toBeNull();
  });
});

describe("the options page against a real serve", () => {
  function options(save = vi.fn().mockResolvedValue(undefined)) {
    container = document.createElement("div");
    document.body.appendChild(container);
    render(<Options env={{ extensionId: EXT_ID, server: "", connected: false, save }} />, container);
    return { root: container, save };
  }
  const paste = async (root: HTMLElement, value: string) => {
    const field = input(root, "Link or token");
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(false));
    root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };

  it("connects with the printed link, saves the server and token, and clears the field", async () => {
    const { root, save } = options();
    expect(root.textContent).toContain(`docsworth serve --allow-extension ${EXT_ID}`);
    await paste(root, `${origin}/#t=${TOKEN}`);
    await vi.waitFor(() => expect(root.textContent).toContain("Connected to"), { timeout: 8000 });
    expect(save).toHaveBeenCalledWith(origin, TOKEN);
    expect(input(root, "Link or token").value).toBe("");
    expect(input(root, "Link or token").type).toBe("password");
  });

  it("closes the test's session before it saves anything", async () => {
    const order: string[] = [];
    const save = vi.fn(async () => void order.push("save"));
    container = document.createElement("div");
    document.body.appendChild(container);
    const client = (url: string, token: string) => {
      const c = new DocsworthClient({ url, token });
      const close = c.close.bind(c);
      c.close = async () => (await close(), void order.push("close"));
      return c;
    };
    render(<Options env={{ extensionId: EXT_ID, server: "", connected: false, save, client }} />, container);
    await paste(container, `${origin}/#t=${TOKEN}`);
    await vi.waitFor(() => expect(container.textContent).toContain("Connected to"), { timeout: 8000 });
    expect(order).toEqual(["close", "save"]);
  });

  it("closes the test's session before it says the test failed", async () => {
    const seen: boolean[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    const client = (url: string, token: string) => {
      const c = new DocsworthClient({ url, token });
      c.call = () => Promise.reject(new DocsworthError("unauthorized", "no"));
      c.close = async () => {
        await new Promise((r) => setTimeout(r, 30));
        seen.push(container.textContent!.includes("didn't accept")); // shown before the close finished?
      };
      return c;
    };
    render(<Options env={{ extensionId: EXT_ID, server: origin, connected: false, save: vi.fn(), client }} />, container);
    await paste(container, "x".repeat(43));
    await vi.waitFor(() => expect(container.textContent).toContain("The server didn't accept that token."));
    expect(seen).toEqual([false]);
  });

  it("saves nothing when the server refuses the token", async () => {
    const { root, save } = options();
    input(root, "Server").value = origin;
    input(root, "Server").dispatchEvent(new Event("input", { bubbles: true }));
    await paste(root, "x".repeat(43));
    await vi.waitFor(() => expect(root.textContent).toContain("The server didn't accept that token."), { timeout: 8000 });
    expect(save).not.toHaveBeenCalled();
  });

  it("explains each way a connection fails", () => {
    expect(explain(new DocsworthError("forbidden", "x"), origin, EXT_ID)).toBe(`The server doesn't answer this extension yet. Start it with: docsworth serve --allow-extension ${EXT_ID}`);
    expect(explain(new TypeError("Failed to fetch"), "http://127.0.0.1:1", EXT_ID)).toBe("No docsworth serve answered at http://127.0.0.1:1. Is it running, on that port?");
  });
});
