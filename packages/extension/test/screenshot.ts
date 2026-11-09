// Screenshots of the extension at work, for a person to look at: the Gmail-shaped fixture with
// its button, and the side panel after a trusted click. The same flow as chrome.e2e.test.ts,
// run by hand (not part of npm test):
//   npm run build -w @docsworth/extension && npx tsx packages/extension/test/screenshot.ts <out dir>
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyAcme } from "../../../test/helpers.js";
import { Chrome, findChrome, until } from "./cdp.js";

const EXT = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? "extension-screenshots");
mkdirSync(out, { recursive: true });
const path = findChrome();
if (!path) throw new Error("no Chrome found: set CHROME_PATH");

const chrome = Chrome.launch(path);
const acme = copyAcme();
try {
  const extId = (await chrome.send("Extensions.loadUnpacked", { path: join(EXT, "dist") })).id as string;
  const server = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--as-of", "2026-11-02", "serve", acme.root, "--port", "0", "--allow-extension", extId], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, DOCSWORTH_NO_GH_CLI: "1" } });
  const url = await new Promise<URL>((done) => {
    let err = "";
    server.stderr!.on("data", (d: Buffer) => {
      err += d;
      const m = / at (http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43})\n/.exec(err);
      if (m) done(new URL(m[1]!));
    });
  });
  try {
    const sw = await until("worker", async () => (await chrome.targets()).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`)));
    const worker = await chrome.attach(sw.targetId);
    await chrome.eval(worker, `chrome.storage.local.set({ server: ${JSON.stringify(url.origin)} }).then(() => chrome.storage.session.set({ token: ${JSON.stringify(url.hash.slice(3))} }))`);
    const fixture = readFileSync(join(EXT, "test/fixtures/gmail-thread.html"), "utf8").replace(" SUBJECT_NONCE", "");
    const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
    const page = await chrome.attach(targetId);
    chrome.on("Fetch.requestPaused", (p, s) => {
      if (s !== page) return;
      const doc = p.resourceType === "Document";
      void chrome.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: doc ? 200 : 404, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: Buffer.from(doc ? fixture : "").toString("base64") }, page);
    });
    await chrome.send("Fetch.enable", { patterns: [{ urlPattern: "https://mail.google.com/*" }] }, page);
    await chrome.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 2, mobile: false }, page);
    await chrome.send("Page.navigate", { url: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQZ" }, page);
    await until("button", async () => ((await chrome.eval(page, "!!document.querySelector('[data-docsworth]')")) ? true : undefined));
    const shot = async (session: string, file: string) => writeFileSync(join(out, file), Buffer.from((await chrome.send("Page.captureScreenshot", { format: "png" }, session)).data, "base64"));
    await shot(page, "gmail-button.png");
    const box = await chrome.eval<{ x: number; y: number }>(page, "(() => { const r = document.querySelector('[data-docsworth]').shadowRoot.querySelector('button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    for (const type of ["mousePressed", "mouseReleased"]) await chrome.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }, page);
    // The side panel opened (that's the flow under test). For the picture, the same page runs
    // in an ordinary tab at a panel's width: a headless side panel's own surface can't be sized.
    await until("panel", async () => (await chrome.targets()).find((t) => t.url === `chrome-extension://${extId}/sidepanel.html`));
    const { targetId: tabTarget } = await chrome.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const panel = await chrome.attach(tabTarget);
    await chrome.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 1500, deviceScaleFactor: 2, mobile: false }, panel);
    await chrome.send("Page.navigate", { url: `chrome-extension://${extId}/sidepanel.html` }, panel);
    // Leave this tab's window the same capture the click left the side panel, as the worker would.
    await until("panel page", async () => ((await chrome.eval(panel, "document.readyState === 'complete' && !!document.querySelector('.dw')")) ? true : undefined));
    await chrome.eval(panel, `chrome.windows.getCurrent().then((w) => chrome.storage.session.set({ "pending:shot": { window: w.id, source: "gmail", title: "Re: Payments worker stuck after the deploy", text: ${JSON.stringify("From Ana Example:\n\nThe payments worker stopped draining the queue after Thursday's deploy.\nRestarting the consumer group fixed it: kubectl rollout restart deploy/payments-worker.\n\n---\n\nFrom Cy Example:\n\nIt happens when the deploy lands mid-batch. Check the lag dashboard first.")}, url: "https://mail.google.com/mail/u/0/#inbox/FMfcgzQZ", at: Date.now() } }))`);
    await until("panel content", async () => {
      const t = await chrome.eval<string>(panel, "document.body.innerText");
      return t.includes("From Gmail") && t.includes("local mode") && !t.includes("Loading") ? t : undefined;
    }, 15_000);
    await shot(panel, "side-panel-capture.png");
    console.log(`wrote ${join(out, "gmail-button.png")} and ${join(out, "side-panel-capture.png")}`);
  } finally {
    server.kill("SIGTERM");
  }
} finally {
  await chrome.close();
  acme.cleanup();
}
