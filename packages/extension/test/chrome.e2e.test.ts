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
// A docs page at another origin, for saving a page and a selection (R2–R7 of capture-to-kb).
const ARTICLE_URL = "https://docs.example.com/guides/tls?utm_source=newsletter&lang=en";
const ARTICLE = readFileSync(join(EXT, "test/fixtures/article.html"), "utf8").replaceAll("NONCE", NONCE);

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
    // A cold Chrome on a CI runner took more than the default 20 s to answer this once.
    extId = (await chrome.send("Extensions.loadUnpacked", { path: join(EXT, "dist") }, undefined, 60_000)).id;

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
    // A worker that has only just started can answer before its extension APIs are bound
    // ("chrome is not defined", seen once in CI): wait for them.
    await until("the worker's chrome.storage", async () => ((await chrome.eval<boolean>(worker, "typeof chrome !== 'undefined' && !!chrome.storage")) ? true : undefined));
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

  describe("saving a page and a selection", () => {
    let article = "";
    let articleTab = "";
    const text = (session: string) => chrome.eval<string>(session, "document.body.innerText");
    const body = (session: string) => chrome.eval<string>(session, "[...document.querySelectorAll('textarea')].map((t) => t.value)[0] ?? ''");
    /** The page target's tab: Extensions.triggerAction takes a tab target, not a page. */
    const tabOf = async (url: string) => (await chrome.send("Target.getTargets", { filter: [{ type: "tab" }] })).targetInfos.find((t: { url: string }) => t.url.startsWith(url))?.targetId as string | undefined;
    const openPage = async (url: string, html: string) => {
      const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
      const session = await chrome.attach(targetId);
      chrome.on("Fetch.requestPaused", (p, sessionId) => {
        if (sessionId !== session) return;
        const isDoc = p.resourceType === "Document";
        void chrome.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: isDoc ? 200 : 404, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: Buffer.from(isDoc ? html : "").toString("base64") }, session);
      });
      await chrome.send("Fetch.enable", { patterns: [{ urlPattern: "https://docs.example.com/*" }] }, session);
      await chrome.send("Page.navigate", { url }, session);
      await until("the page to load", async () => ((await chrome.eval(session, "document.readyState")) === "complete" ? true : undefined));
      await chrome.send("Target.activateTarget", { targetId });
      return { session, targetId };
    };
    const panel = async () => chrome.attach((await until("the side panel", async () => (await panelTargets())[0]))!.targetId);
    const click = (session: string, label: string) => chrome.eval(session, `[...document.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(label)}).click(); true`);

    const opened: string[] = [];
    beforeAll(async () => {
      for (const t of await panelTargets()) await chrome.send("Target.closeTarget", { targetId: t.targetId });
      const a = await openPage(ARTICLE_URL, ARTICLE);
      article = a.session;
      opened.push(a.targetId);
      articleTab = (await until("the article's tab", () => tabOf("https://docs.example.com/guides/tls")))!;
    }, 30_000);

    // As found: no panel open, and none of these tabs. A panel the toolbar opened doesn't close
    // over the protocol (Target.closeTarget leaves it), so the worker closes it, as its X would.
    afterAll(async () => {
      await chrome.eval(worker, "chrome.windows.getAll().then((ws) => Promise.all(ws.map((w) => chrome.sidePanel.close({ windowId: w.id }).catch(() => undefined))))");
      for (const targetId of opened) await chrome.send("Target.closeTarget", { targetId }).catch(() => undefined);
      await until("the panel to close", async () => ((await panelTargets()).length ? undefined : true));
    });

    it("opens the panel from the worker on a toolbar click, which lets it read that tab", async () => {
      // Chrome's own click on the toolbar button, as a person's: it runs the worker's onAction.
      await chrome.send("Extensions.triggerAction", { id: extId, targetId: articleTab });
      const p = await panel();
      await until("the Save buttons", async () => ((await text(p)).includes("Save this page") ? true : undefined), 15_000);
      // Scrolled down, as a person reading it would be: what's off the page doesn't move with
      // the scroll, but a fixed box that's above the viewport stays there.
      expect(await chrome.eval(article, "scrollTo(0, 500), scrollY")).toBe(500);
      await click(p, "Save this page");
      const md = await until("the page's markdown in the draft", async () => {
        const b = await body(p);
        return b.includes(`VISIBLE-${NONCE}`) ? b : undefined;
      }, 15_000);
      // R6: its structure.
      expect(md).toContain('```sh\ncertbot renew --deploy-hook "systemctl reload envoy"\n```');
      expect(md).toContain("| Service | Port |\n| --- | --- |\n| edge-proxy | 443 |\n| admin | 9901 |");
      // A heading's anchor to itself is only text; a header block inside main stays; a web
      // component's code block, in its shadow root, is captured (MDN's pages are all three).
      expect(md).toContain("\n## Run the rotation\n");
      expect(md).toContain(`INTRO-${NONCE}: rotate before the window closes.`);
      expect(md).toContain(`\`\`\`http\nStrict-Transport-Security: SHADOW-${NONCE}\n\`\`\``);
      // R6, R14: the link and the source lose their tracking parameters.
      expect(md).toContain("[bastion guide](https://docs.example.com/guides/bastion?ref=docs)");
      expect(await chrome.eval(p, "[...document.querySelectorAll('input')].find((i) => i.type === 'url').value")).toBe("https://docs.example.com/guides/tls?lang=en");
      // R5: what's shown is kept, inline blocks under a font-size: 0 parent included...
      expect(md).toContain(`Gaps-closedVISIBLE-INLINE-${NONCE}`);
      // ...a closed <details>'s summary, an open one's content, a fixed box a transform holds...
      expect(md).toContain(`SUMMARY-${NONCE}`);
      expect(md).toContain(`OPEN-DETAILS-${NONCE}`);
      expect(md).toContain(`HELD-${NONCE}`);
      expect(md).toContain(`SLIDE-${NONCE}`);
      expect(md).toContain(`PICTURE-${NONCE}`);
      // ...and nothing the page hid from a person, nor its navigation (R7).
      for (const way of ["DISPLAY", "VISIBILITY", "OPACITY", "ATTR", "ARIA", "SRONLY", "CLIPRECT", "CLIPPATH", "OFFSCREEN", "ABOVE", "FONTSIZE", "CONTENTVIS", "CONTENTSVIS", "COLLAPSED", "FIXED", "FIXEDBELOW", "FIXEDLEFT", "FIXEDRIGHT", "TRANSLATE", "SCALE", "TEXTINDENT", "MARGIN", "INSCROLL", "ALT", "DETAILS", "DETAILSP", "SCRIPT", "TEMPLATE"])
        expect(md, way).not.toContain(`HIDDEN-${way}-${NONCE}`);
      for (const part of ["NAV-HEADER", "NAV-LINK", "FOOTER-ASIDE", "FOOTER"]) expect(md, part).not.toContain(`${part}-${NONCE}`);
      expect(await text(p)).toContain("From a page");
      // The panel searched for pages it may already be in, and offers to add it to each.
      await until("the matches", async () => ((await text(p)).includes("Add the capture here") || (await text(p)).includes("No citable page matched") ? true : undefined), 15_000);
    });

    it("saves the selection, cut at its edges, with its link", async () => {
      await chrome.eval(article, `(() => { const p = document.getElementById("first"); const r = document.createRange(); r.setStart(p.firstChild, p.firstChild.data.indexOf("Run it")); r.setEnd(p.lastChild, p.lastChild.data.indexOf(" first")); getSelection().removeAllRanges(); getSelection().addRange(r); return getSelection().toString().length; })()`);
      const p = await panel();
      await click(p, "Save the selection");
      const md = await until("the selection's markdown", async () => {
        const b = await body(p);
        return b.startsWith("Run it from a bastion host") ? b : undefined;
      }, 15_000);
      expect(md).toBe(`Run it from a bastion host with the platform team's credentials: VISIBLE-${NONCE}. See the [bastion guide](https://docs.example.com/guides/bastion?ref=docs)`);
    });

    it("reads no tab the person didn't click in, and says how to allow it", async () => {
      // Another tab of the same site: no toolbar or menu click there, so no activeTab.
      opened.push((await openPage("https://docs.example.com/other", "<!doctype html><title>Other</title><main><p>OTHER-TAB-TEXT</p></main>")).targetId);
      const p = await panel();
      await click(p, "Save this page");
      await until("the refusal", async () => ((await text(p)).includes("Docsworth can't read this tab yet") ? true : undefined), 15_000);
      expect(await body(p)).not.toContain("OTHER-TAB-TEXT");
    });

    it("keeps what a right-to-left page scrolls leftwards to", async () => {
      // A right-to-left page overflows to the left, before x = 0, and the person can scroll there.
      const rtl = await openPage("https://docs.example.com/rtl", `<!doctype html><html dir="rtl"><title>RTL</title><main><p>RTL-SHOWN</p><div style="width: 3000px; text-align: left">RTL-LEFT-${NONCE}</div></main></html>`);
      opened.push(rtl.targetId);
      expect(await chrome.eval(rtl.session, "document.querySelector('div').getBoundingClientRect().left")).toBeLessThan(-1000);
      await chrome.send("Extensions.triggerAction", { id: extId, targetId: (await until("the RTL tab", () => tabOf("https://docs.example.com/rtl")))! });
      const p = await panel();
      await click(p, "Save this page");
      const md = await until("the RTL page's markdown", async () => {
        const b = await body(p);
        return b.includes("RTL-SHOWN") ? b : undefined;
      }, 15_000);
      expect(md).toContain(`RTL-LEFT-${NONCE}`);
    });

    it("checks where things are drawn on a page whose root has no width", async () => {
      // The page's own root, at width 0 with its body still drawn, must not turn the checks of
      // where things are drawn off: they're what drops text placed off the page.
      const zero = await openPage("https://docs.example.com/zero", `<!doctype html><html style="width: 0"><title>Zero</title><body style="width: 760px"><main><p>ZERO-SHOWN</p><p>Shown, and <span style="position: absolute; left: -9999px">HIDDEN-ZEROROOT-${NONCE}</span> not.</p><h3 style="width: 200px; overflow: hidden; text-indent: -9999px">HIDDEN-ZEROINDENT-${NONCE}</h3></main></body></html>`);
      opened.push(zero.targetId);
      expect(await chrome.eval(zero.session, "[document.documentElement.getBoundingClientRect().width, document.body.getBoundingClientRect().width]")).toEqual([0, 760]);
      await chrome.send("Extensions.triggerAction", { id: extId, targetId: (await until("the zero-width tab", () => tabOf("https://docs.example.com/zero")))! });
      const p = await panel();
      await click(p, "Save this page");
      const md = await until("the zero-width page's markdown", async () => {
        const b = await body(p);
        return b.includes("ZERO-SHOWN") ? b : undefined;
      }, 15_000);
      expect(md).not.toContain(`HIDDEN-ZEROROOT-${NONCE}`);
      expect(md).not.toContain(`HIDDEN-ZEROINDENT-${NONCE}`);
    });
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
