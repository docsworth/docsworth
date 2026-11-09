import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { stateDir } from "../src/core/audit-log.js";
import { TOKEN_FILE } from "../src/core/serve/token.js";
import { acmeOnGitHub, copyAcme } from "./helpers.js";

// The real `docsworth serve` entry point: argument parsing, identity, the token file, the
// listener and shutdown. The token goes to a temporary state dir. Node runs the CLI itself,
// with no npx, shell or tsx launcher in between, so SIGTERM reaches the server: through
// npx, this test hung on CI's Linux runner (Node 22.12) until it timed out, though it
// passed on macOS.

const CLI = ["--import", "tsx", "src/cli.ts", "--as-of", "2026-11-02", "serve"];

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function env() {
  const state = mkdtempSync(join(tmpdir(), "docsworth-state-"));
  cleanups.push(() => rmSync(state, { recursive: true, force: true }));
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", XDG_STATE_HOME: state, DOCSWORTH_NO_GH_CLI: "1" };
}

/** Starts serve and resolves with the URL it prints, or rejects with what it said instead. */
function start(dir: string, e: Record<string, string>, args: string[] = []): Promise<{ child: ChildProcess; url: URL; token: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...CLI, dir, "--port", "0", ...args], { env: e, stdio: ["ignore", "ignore", "pipe"] });
    cleanups.push(() => void child.kill("SIGKILL"));
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d;
      const m = / at (http:\/\/127\.0\.0\.1:\d+\/#t=([A-Za-z0-9_-]{43}))\n/.exec(stderr);
      if (m) done({ child, url: new URL(m[1]!), token: m[2]! });
    });
    child.on("exit", (code) => fail(new Error(`exited ${code}: ${stderr}`)));
  });
}

describe("docsworth serve (CLI)", () => {
  it("prints a URL whose token works, keeps the token in the state dir, and stops cleanly", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const e = env();
    const { child, url, token } = await start(acme.root, e);
    expect(url.hostname).toBe("127.0.0.1");

    const transport = new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "cli-test", version: "1" });
    await client.connect(transport);
    const caps = await client.callTool({ name: "ui_capabilities", arguments: {} });
    expect(caps.structuredContent).toMatchObject({ mode: "local", writes: false, writes_off: "writes need github.repo in .knowledge/config.yaml and a GitHub token" });
    await client.close();

    const file = join(stateDir(acme.root, { XDG_STATE_HOME: e.XDG_STATE_HOME }), TOKEN_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const printed = spawnSync(process.execPath, [...CLI, acme.root, "--print-token"], { env: e, encoding: "utf8" });
    expect(printed.stdout.trim()).toBe(token);

    const exited = new Promise<number | null>((r) => child.on("exit", r));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 60_000);

  it("refuses to start in GitHub mode without a token, before listening", async () => {
    const acme = acmeOnGitHub();
    cleanups.push(acme.cleanup);
    const e = env();
    const r = spawnSync(process.execPath, [...CLI, acme.root, "--port", "0"], { env: e, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("github.repo is acme/knowledge, so a GitHub token is required");
    expect(r.stderr).not.toContain("http://127.0.0.1");
  }, 60_000);

  it("refuses an extension id that isn't one", () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const r = spawnSync(process.execPath, [...CLI, acme.root, "--allow-extension", "not-an-id"], { env: env(), encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("expected an extension id: 32 letters a to p");
  }, 60_000);
});
