import { type ChildProcess, spawn } from "node:child_process";
import { DocsworthClient } from "@docsworth/ui";
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadRepo } from "../../../src/core/repo.js";
import { copyAcme } from "../../../test/helpers.js";
import { App } from "../src/app.js";
import { reloadOnNewToken, takeToken } from "../src/auth.js";

// R13: each view, rendered with happy-dom, against the real `docsworth serve` CLI on a copy
// of examples/acme in local mode, over HTTP. The server runs as its own process, as it does
// for a browser (inside this test environment, happy-dom's Request and Response would
// replace the ones the server's transport needs). Nothing is faked between the app and the
// server: the client, transport, ACL and gate are the real ones.

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

/** Renders the app at `path`, as a tab of the server's origin, and waits for `text`. */
async function open(path: string, text: string | RegExp) {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(`${origin}${path}`);
  container = document.createElement("div");
  document.body.appendChild(container);
  render(<App client={new DocsworthClient({ url: origin, token: TOKEN })} />, container);
  await vi.waitFor(() => expect(container.textContent).toMatch(text), { timeout: 8000 });
  return container;
}

/** No page the viewer can't see may be named anywhere in what the app shows. */
function assertNoHiddenPage(root: HTMLElement) {
  expect(hidden.length).toBeGreaterThan(0);
  const html = root.innerHTML;
  for (const p of hidden) for (const needle of [p.id, p.title, p.path]) expect(html, `${p.id}: ${needle}`).not.toContain(needle);
}

describe("web app views against a real serve (R13)", () => {
  it("overview: counts, teams, due soon, stale, and the pro note", async () => {
    const root = await open("/", "Knowledge overview");
    await vi.waitFor(() => expect(root.textContent).toContain("Refund failures"));
    expect(root.querySelectorAll(".dw-tile")).toHaveLength(4);
    expect(root.querySelector(".dw-tile b")?.textContent).toBe("21"); // 24 pages, 3 of them team-only
    expect(root.textContent).toContain("Joining on-call");
    expect(root.textContent).toContain("Scale the Kubernetes cluster");
    expect(root.textContent).toContain("part of Docsworth pro");
    expect([...root.querySelectorAll(".dw-table th[scope=row]")].map((th) => th.textContent)).toEqual(expect.arrayContaining(["payments", "platform", "devex"]));
    assertNoHiddenPage(root);
  });

  it("search: citable results, then what the gate left out and why", async () => {
    const root = await open("/search?q=deploy%20to%20production", "Deploy to production");
    await vi.waitFor(() => expect(root.textContent).toContain("Matched, but not citable"));
    expect(root.textContent).toContain("Deploy with Jenkins (legacy)");
    expect(root.querySelector(".dw-results a")?.getAttribute("href")).toBe("/p/rb-deploy-prod");
    // Snippets read as text, not markdown.
    expect(root.querySelector(".dw-result p")?.textContent).not.toMatch(/\]\(|^#/);
    assertNoHiddenPage(root);
  });

  it("page: rendered safely, links routed in-app, the hidden link shown as a placeholder, adding explained", async () => {
    const root = await open("/p/svc-payments", "Payments API");
    await vi.waitFor(() => expect(root.querySelector(".dw-prose")).not.toBeNull());
    expect(root.querySelector(".dw-prose")?.textContent).toContain("[restricted page]");
    // The title shows once: the body's own "# Payments API" is dropped.
    expect([...root.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Payments API"]);
    expect([...root.querySelectorAll(".dw-prose a")].map((a) => a.getAttribute("href"))).toContain("/p/adr-0001");
    (root.querySelector("button.secondary") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(root.textContent).toContain("Adding is off here: writes need github.repo in .knowledge/config.yaml and a GitHub token."));
    assertNoHiddenPage(root);
  });

  it("page: an id that isn't there, or is hidden, reads the same", async () => {
    const missing = await open("/p/no-such-page", "no page with id `no-such-page`");
    render(null, missing);
    missing.remove();
    const hiddenOne = await open("/p/rb-rotate-db-creds", "no page with id `rb-rotate-db-creds`");
    expect(hiddenOne.textContent).not.toContain("Rotate database credentials");
  });

  it("team: that team's visible pages only", async () => {
    const root = await open("/t/payments", "pages owned by this team");
    await vi.waitFor(() => expect(root.textContent).toContain("Refund failures"));
    expect(root.textContent).not.toContain("Ledger service");
    assertNoHiddenPage(root);
  });

  it("graph: a node per visible page, none hidden", async () => {
    const root = await open("/graph", "Link graph");
    await vi.waitFor(() => expect(root.querySelectorAll("svg circle[data-id]").length).toBe(21));
    assertNoHiddenPage(root);
  });

  it("capture: owners offered, and why drafting is off in local mode", async () => {
    const root = await open("/capture", "Capture a page");
    await vi.waitFor(() => expect(root.textContent).toContain("Drafting is off here: writes need github.repo"));
    const owners = [...root.querySelectorAll("select")[1]!.querySelectorAll("option")].map((o) => o.textContent);
    expect(owners).toEqual(["devex", "payments", "platform", "security", "sre"]);
    await vi.waitFor(() => expect((root.querySelectorAll("select")[1] as HTMLSelectElement).value).toBe("devex"));
    expect((root.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("settings: mode, repository and writes", async () => {
    const root = await open("/settings", "Settings");
    await vi.waitFor(() => expect(root.textContent).toContain("local: internal pages only, no writes"));
  });

  it("a view whose session ended says so and reloads, so a new session reads it again", async () => {
    // The server forgets a session (idle, or restarted); a new one wouldn't carry this tab's
    // taint, so the client refuses and the app reloads instead (packages/ui/src/client.ts).
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    try {
      let session = "";
      (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(`${origin}/`);
      container = document.createElement("div");
      document.body.appendChild(container);
      render(<App client={new DocsworthClient({ url: origin, token: TOKEN, onSession: (id) => (session = id) })} />, container);
      await vi.waitFor(() => expect(container.textContent).toContain("Refund failures"), { timeout: 8000 });
      const ended = await fetch(new URL("/mcp", origin), { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": session } });
      expect(ended.ok).toBe(true);
      expect(reload).not.toHaveBeenCalled();
      [...container.querySelectorAll<HTMLAnchorElement>(".dw-nav a")].find((a) => a.textContent === "Graph")!.click();
      await vi.waitFor(() => expect(container.textContent).toContain("This tab's session with docsworth serve ended"), { timeout: 8000 });
      expect(reload).toHaveBeenCalled();
    } finally {
      reload.mockRestore();
    }
  });

  it("a wrong token shows how to get the right one", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    render(<App client={new DocsworthClient({ url: origin, token: "x".repeat(43) })} />, container);
    await vi.waitFor(() => expect(container.textContent).toContain("The server didn't accept this tab's token."));
  });
});

describe("token handoff", () => {
  it("takes the token out of the URL, keeps it for the tab, and starts a fresh session for a new token", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as Storage;
    const replaced: string[] = [];
    const history = { replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url) };
    store.set("docsworth-session", "old-session");
    store.set("docsworth-token", "a".repeat(43));
    expect(takeToken({ hash: `#t=${"b".repeat(43)}`, pathname: "/p/x", search: "?q=1" }, storage, history)).toBe("b".repeat(43));
    expect(replaced).toEqual(["/p/x?q=1"]);
    expect(store.get("docsworth-token")).toBe("b".repeat(43));
    expect(store.has("docsworth-session")).toBe(false);
    // Later loads read it back; a fragment that isn't a token is ignored.
    expect(takeToken({ hash: "#t=short", pathname: "/", search: "" }, storage, history)).toBe("b".repeat(43));
    expect(replaced).toHaveLength(1);
  });

  it("reloads a tab when a token arrives in its fragment, and not for any other fragment", () => {
    const listeners: (() => void)[] = [];
    const location = { hash: "", reload: vi.fn() };
    reloadOnNewToken({ addEventListener: ((_: string, fn: () => void) => void listeners.push(fn)) as Window["addEventListener"], location });
    location.hash = "#section";
    listeners.forEach((fn) => fn());
    expect(location.reload).not.toHaveBeenCalled();
    location.hash = `#t=${"c".repeat(43)}`;
    listeners.forEach((fn) => fn());
    expect(location.reload).toHaveBeenCalledOnce();
  });
});
