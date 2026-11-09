// A small Chrome DevTools Protocol client over --remote-debugging-pipe, for the end-to-end
// test: Chrome runs with a profile of its own and loads the extension over the protocol
// (Extensions.loadUnpacked), since branded Chrome no longer takes --load-extension.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/** A Chrome to drive: CHROME_PATH, or where Chrome or Chromium usually is. */
export function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p): p is string => Boolean(p) && existsSync(p!)) ?? null;
}

type Listener = (params: any, sessionId?: string) => void;

export class Chrome {
  private nextId = 0;
  private waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void; method: string }>();
  private listeners = new Map<string, Set<Listener>>();
  private buf = "";

  private constructor(
    private readonly proc: ChildProcess,
    /** The profile directory this run made, and the only thing its cleanup removes. */
    readonly profile: string,
  ) {
    (proc.stdio[4] as NodeJS.ReadableStream).on("data", (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const msg = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        if (msg.id !== undefined) {
          const w = this.waiting.get(msg.id);
          this.waiting.delete(msg.id);
          if (msg.error) w?.no(new Error(`${w.method}: ${msg.error.message}`));
          else w?.ok(msg.result);
        } else for (const l of this.listeners.get(msg.method) ?? []) l(msg.params, msg.sessionId);
      }
    });
    // A call Chrome can no longer answer fails now, naming its method, not at its timeout.
    proc.once("exit", () => {
      for (const w of this.waiting.values()) w.no(new Error(`${w.method}: Chrome exited`));
      this.waiting.clear();
    });
  }

  private get running(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  static launch(path: string): Chrome {
    const profile = mkdtempSync(join(tmpdir(), "docsworth-ext-e2e-"));
    const args = [
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      // No keychain or keyring prompt: a run with a fresh HOME (the public export's verify)
      // has no login keychain, and Chrome would wait on one.
      "--use-mock-keychain",
      "--password-store=basic",
      // CI's Linux runners can't give Chrome its sandbox.
      ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
      "about:blank",
    ];
    const proc = spawn(path, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    return new Chrome(proc, profile);
  }

  /** A protocol call; one Chrome doesn't answer within `ms` fails, naming its method. */
  send<T = any>(method: string, params: object = {}, sessionId?: string, ms = 20_000): Promise<T> {
    return new Promise((ok, no) => {
      if (!this.running) return no(new Error(`${method}: Chrome has exited`));
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        no(new Error(`${method}: Chrome didn't answer within ${ms} ms`));
      }, ms);
      const done = <F extends (v: any) => void>(f: F) => ((v: any) => (clearTimeout(timer), f(v))) as F;
      this.waiting.set(id, { ok: done(ok), no: done(no), method });
      (this.proc.stdio[3] as NodeJS.WritableStream).write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  on(method: string, l: Listener): void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(l);
  }

  /** Evaluates an expression and returns its value, awaiting a promise. Throws on an exception. */
  async eval<T = unknown>(sessionId: string, expression: string, contextId?: number, opts: { userGesture?: boolean } = {}): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}), ...opts }, sessionId);
    if (r.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  async targets(): Promise<{ targetId: string; type: string; url: string }[]> {
    return (await this.send("Target.getTargets")).targetInfos;
  }

  async attach(targetId: string): Promise<string> {
    return (await this.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  }

  /** Stops Chrome, then removes the profile it made: that exact directory, under the temp dir. */
  async close(): Promise<void> {
    if (this.running) {
      const exited = new Promise<void>((r) => this.proc.once("exit", () => r()));
      // Asked over the protocol, Chrome stops its helper processes before it exits. After a
      // SIGTERM, Linux Chrome's helpers go on writing into the profile for seconds after the
      // browser has gone, and removing it fails with ENOTEMPTY (in about one run in seven,
      // whether or not rmSync retries). The signal is the fallback when Chrome doesn't close.
      this.send("Browser.close").catch(() => {});
      let timer: NodeJS.Timeout | undefined;
      const closed = await Promise.race([exited.then(() => true), new Promise<false>((r) => (timer = setTimeout(r, 5_000, false)))]);
      clearTimeout(timer);
      if (!closed) {
        this.proc.kill();
        await exited;
      }
    }
    const base = realpathSync(tmpdir()) + sep;
    const at = realpathSync(this.profile);
    if (!at.startsWith(join(base, "docsworth-ext-e2e-"))) throw new Error(`refusing to remove ${at}: not a profile this test made`);
    rmSync(at, { recursive: true, force: true });
  }
}

/** Polls `check` until it returns something other than undefined, or fails after `ms`. */
export async function until<T>(what: string, check: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
