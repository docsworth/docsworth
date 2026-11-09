// @vitest-environment node
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyAcme } from "../../../test/helpers.js";
import { PENDING_TTL_MS } from "../src/contract.js";
import { Chrome, findChrome, until } from "./cdp.js";

// R15 and the handoff, in a real Chrome: the built extension, a fresh profile, and the real
// `docsworth serve` allowing the extension's origin. A Gmail-shaped fixture is served at
// https://mail.google.com by request interception, so this proves the extension's mechanics
// against Gmail's origin, not that live Gmail still has the fixture's markup (README.md's
// Gmail checklist is for that). A nonce made here reaches the panel only by the real path:
// the page, the content script, the worker, storage.session, the panel.

const EXT = process.env.DOCSWORTH_EXTENSION_ROOT!;
const CHROME = findChrome();
if (!CHROME && process.env.CI) throw new Error("CI needs a Chrome for the extension's end-to-end test: set CHROME_PATH");
if (!CHROME) console.warn("chrome.e2e.test.ts: skipped, no Chrome found (set CHROME_PATH)");

const NONCE = `nonce-${randomUUID().slice(0, 8)}`;
const SUBJECT = `Re: Payments worker stuck after the deploy ${NONCE}`;
const THREAD = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQZ";
const FIXTURE = readFileSync(join(EXT, "test/fixtures/gmail-thread.html"), "utf8").replace("SUBJECT_NONCE", NONCE);

describe.skipIf(!CHROME)("the extension in a real Chrome", () => {
  let chrome: Chrome;
  let serve: ChildProcess;
  let acme: ReturnType<typeof copyAcme>;
  let extId = "";
  let origin = "";
  let token = "";
  let worker = "";
  let page = "";
  let isolated = 0;

  beforeAll(async () => {
    const built = spawnSync("npm", ["run", "build"], { cwd: EXT, encoding: "utf8" });
    if (built.status !== 0) throw new Error(`the extension didn't build:\n${built.stdout}${built.stderr}`);

    chrome = Chrome.launch(CHROME!);
    extId = (await chrome.send("Extensions.loadUnpacked", { path: join(EXT, "dist") })).id;

    acme = copyAcme();
    serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--as-of", "2026-11-02", "serve", acme.root, "--port", "0", "--allow-extension", extId], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? "", DOCSWORTH_NO_GH_CLI: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const url = await new Promise<URL>((done, fail) => {
      let err = "";
      serve.stderr!.on("data", (d: Buffer) => {
        err += d;
        const m = / at (http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43})\n/.exec(err);
        if (m) done(new URL(m[1]!));
      });
      serve.on("exit", (code) => fail(new Error(`serve exited ${code}: ${err}`)));
    });
    origin = url.origin;
    token = url.hash.slice(3);

    // Connect the extension as its options page would: the address to local, the token to session.
    const sw = await until("the extension's worker", async () => (await chrome.targets()).find((t) => t.type === "service_worker" && t.url === `chrome-extension://${extId}/background.js`));
    worker = await chrome.attach(sw.targetId);
    await chrome.eval(worker, `chrome.storage.local.set({ server: ${JSON.stringify(origin)} }).then(() => chrome.storage.session.set({ token: ${JSON.stringify(token)} }))`);

    // The Gmail-shaped page, served at Gmail's origin.
    const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
    page = await chrome.attach(targetId);
    chrome.on("Fetch.requestPaused", (p, sessionId) => {
      if (sessionId !== page) return;
      const isDoc = p.resourceType === "Document";
      void chrome.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: isDoc ? 200 : 404, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: Buffer.from(isDoc ? FIXTURE : "").toString("base64") }, page);
    });
    chrome.on("Runtime.executionContextCreated", (p, sessionId) => {
      if (sessionId === page && p.context.auxData?.type === "isolated" && p.context.origin === `chrome-extension://${extId}`) isolated = p.context.id;
    });
    await chrome.send("Fetch.enable", { patterns: [{ urlPattern: "https://mail.google.com/*" }] }, page);
    await chrome.send("Runtime.enable", {}, page);
    await chrome.send("Page.navigate", { url: THREAD }, page);
    await until("the Gmail button", async () => ((await chrome.eval(page, "!!document.querySelector('[data-docsworth]')")) ? true : undefined));
  }, 60_000);

  afterAll(async () => {
    await chrome?.close();
    if (serve && serve.exitCode === null) {
      await new Promise<void>((r) => {
        serve.once("exit", () => r());
        serve.kill("SIGTERM");
      });
    }
    acme?.cleanup();
  });

  const panelTargets = async () => (await chrome.targets()).filter((t) => t.url === `chrome-extension://${extId}/sidepanel.html`);
  const sessionKeys = async () => Object.keys(await chrome.eval<Record<string, unknown>>(worker, "chrome.storage.session.get(null)"));

  it("keeps the token out of the content script's reach, in its own world", async () => {
    // First, that this is the content script's world: it has the extension's id and sees the button.
    expect(isolated).toBeGreaterThan(0);
    expect(await chrome.eval(page, "[chrome.runtime.id, !!document.querySelector('[data-docsworth]')]", isolated)).toEqual([extId, true]);
    expect(await chrome.eval(page, "chrome.storage.session.get(null).then(() => 'read', (e) => e.message)", isolated)).toBe("Access to storage is not allowed from this context.");
    // It can read storage.local, so the token must never be there: only the address is.
    expect(await chrome.eval(page, "chrome.storage.local.get(null)", isolated)).toEqual({ server: origin });
    // And the page's own scripts have no extension API at all.
    expect(await chrome.eval(page, "typeof chrome === 'undefined' || typeof chrome.storage")).not.toBe("object");
  });

  it("opens nothing on a click a page script dispatched, even while a user gesture is live", async () => {
    // userGesture: the page has a live activation, as when a script clicks during a person's click.
    // Without the trusted-click check, that would open the panel; Chrome alone wouldn't stop it.
    await chrome.eval(page, "document.querySelector('[data-docsworth]').shadowRoot.querySelector('button').click()", undefined, { userGesture: true });
    await new Promise((r) => setTimeout(r, 1000));
    expect(await panelTargets()).toEqual([]);
    expect((await sessionKeys()).filter((k) => k.startsWith("pending:"))).toEqual([]);
  });

  it("opens the side panel on a trusted click, with the thread in a draft and related pages from the server", async () => {
    const box = await chrome.eval<{ x: number; y: number }>(page, "(() => { const r = document.querySelector('[data-docsworth]').shadowRoot.querySelector('button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    for (const type of ["mousePressed", "mouseReleased"]) await chrome.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }, page);
    const [target] = await until("the side panel", async () => ((await panelTargets()).length ? await panelTargets() : undefined));
    const panel = await chrome.attach(target!.targetId);
    const titles = await until("the draft's title", async () => {
      const values = await chrome.eval<string[]>(panel, "[...document.querySelectorAll('input')].map((i) => i.value)");
      return values.includes(SUBJECT) ? values : undefined;
    });
    expect(titles).toContain(SUBJECT);
    // The panel called the server from the extension's origin: the capabilities and a search answered.
    await until("the server's answers", async () => {
      const text = await chrome.eval<string>(panel, "document.body.innerText");
      return text.includes("local mode") && /Already written down\?[\s\S]*(No citable page matched|\w)/.test(text) && !text.includes("Loading") ? text : undefined;
    }, 15_000);
    expect(await chrome.eval(page, "document.querySelector('[data-docsworth]').shadowRoot.querySelector('button').textContent")).toBe("Opened in Docsworth");
  });

  it("keeps the capture while it's on screen, with an alarm for its time limit, and the panel's session under its window", async () => {
    const keys = await sessionKeys();
    const pending = keys.filter((k) => k.startsWith("pending:"));
    expect(pending).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith("session:"))).toHaveLength(1);
    expect(keys).toContain("token");
    const alarms = await chrome.eval<{ name: string; scheduledTime: number }[]>(worker, "chrome.alarms.getAll()");
    expect(alarms.map((a) => a.name)).toEqual(pending);
    const at = await chrome.eval<number>(worker, `chrome.storage.session.get(${JSON.stringify(pending[0])}).then((r) => Object.values(r)[0].at)`);
    expect(alarms[0]!.scheduledTime).toBe(at + PENDING_TTL_MS + 1000);
  });

  it("gives the capture again to a reloaded panel, and lets it go once the panel moves on", async () => {
    const [target] = await panelTargets();
    const panel = await chrome.attach(target!.targetId);
    // A reload, as "Start a new session" or another token does: the draft comes back.
    await chrome.eval(panel, "document.body.innerHTML = ''; setTimeout(() => location.reload(), 0); true");
    await until("the draft after the reload", async () => {
      const values = await chrome.eval<string[]>(panel, "[...document.querySelectorAll('input')].map((i) => i.value)").catch((): string[] => []);
      return values.includes(SUBJECT) ? values : undefined;
    }, 15_000);
    // Moving on to another view is being done with it.
    await chrome.eval(panel, "document.querySelector('.dw-brand').click(); true");
    await until("the capture to be let go", async () => ((await sessionKeys()).some((k) => k.startsWith("pending:")) ? undefined : true));
  });

  it("drops a waiting capture from the panel when its record is removed, and keeps the one on screen", async () => {
    const [target] = await panelTargets();
    const panel = await chrome.attach(target!.targetId);
    const windowId = await chrome.eval<number>(panel, "chrome.windows.getCurrent().then((w) => w.id)");
    const write = (id: string, title: string) =>
      chrome.eval(worker, `chrome.storage.session.set({ ${JSON.stringify(`pending:${id}`)}: ${JSON.stringify({ window: windowId, source: "selection", title, text: `${title}.`, url: "https://wiki.example.com/x", at: Date.now() })} })`);
    const text = () => chrome.eval<string>(panel, "document.body.innerText");
    await write("on-screen", "On screen");
    await until("the first capture on screen", async () => ((await text()).includes("From a page") ? true : undefined));
    await write("waiting", "Waiting");
    await until("the waiting notice", async () => ((await text()).includes("Another capture is waiting.") ? true : undefined));
    // Its record goes (the alarm's prune does this): so does the notice, and the draft stays.
    await chrome.eval(worker, `chrome.storage.session.remove(["pending:waiting", "pending:on-screen"])`);
    await until("the notice to go", async () => ((await text()).includes("waiting.") ? undefined : true));
    expect(await chrome.eval<string[]>(panel, "[...document.querySelectorAll('input')].map((i) => i.value)")).toContain("On screen");
  });

  it("removes a capture past its time when its alarm fires, and leaves the token", async () => {
    // Only the alarm may remove it here: an open panel's pull prunes stale captures too, and
    // would on the write's change event, so the panel is closed first.
    for (const t of await panelTargets()) await chrome.send("Target.closeTarget", { targetId: t.targetId });
    await until("the panel to close", async () => ((await panelTargets()).length ? undefined : true));
    // A capture made eleven minutes ago, in another window, and its alarm due shortly: Chrome
    // fires an unpacked extension's alarm without the 30-second minimum.
    const stale = { window: 999_999, source: "gmail", title: "stale", text: "x", url: "https://mail.google.com/mail/u/0/", at: Date.now() - PENDING_TTL_MS - 60_000 };
    await chrome.eval(worker, `chrome.storage.session.set({ "pending:stale": ${JSON.stringify(stale)} }).then(() => chrome.alarms.create("pending:stale", { when: Date.now() + 1500 }))`);
    expect(await sessionKeys()).toContain("pending:stale");
    await until("the alarm's prune", async () => ((await sessionKeys()).includes("pending:stale") ? undefined : true), 15_000);
    expect(await sessionKeys()).toContain("token");
  });
});
