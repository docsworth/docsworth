// Install the packed tarball the way a customer would, and drive it: the bin answers,
// `init` makes a repo that lints clean, and the plugin's MCP launcher serves it (tools,
// the polish prompt, a citable search hit), and `serve` serves the web app and /mcp.
// CI runs it on every PR after `npm pack`.
//   npx tsx scripts/smoke-install.ts <package.tgz>
// Name-proof: the bin, the launcher and the environment variables come from
// package.json and plugin/.mcp.json, and both the old and new variable prefixes are set.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Exactly one tarball: a glob that matched two would test one and leave the other unseen.
if (process.argv.length !== 3) throw new Error(`usage: smoke-install.ts <package.tgz> (got ${process.argv.length - 2} arguments)`);
const tgz = resolve(process.argv[2]!);
const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string; bin: Record<string, string> };
const [binName] = Object.keys(pkg.bin);

let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

const dir = mkdtempSync(join(tmpdir(), "akb-smoke-"));
let serve: ChildProcess | undefined;
try {
  const prefix = join(dir, "prefix");
  const kb = join(dir, "kb");
  execFileSync("mkdir", ["-p", prefix, kb]);
  execFileSync("npm", ["init", "-y"], { cwd: prefix, stdio: "ignore" });
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tgz], { cwd: prefix, stdio: "ignore" });
  const bin = join(prefix, "node_modules/.bin", binName!);
  const run = (args: string[], cwd = kb) => execFileSync(bin, args, { cwd, encoding: "utf8", env: { ...process.env, DOCSWORTH_NO_GH_CLI: "1" } });

  const version = run(["--version"], prefix).trim();
  check(`the ${binName} bin answers --version with ${pkg.version}`, version === pkg.version, version);
  // Pro is a separate package: nothing of it may come with the CLI, built or as source.
  const installed = execFileSync("find", [join(prefix, "node_modules"), "(", "-path", "*/dist/pro/*", "-o", "-path", "*/@docsworth-pro/*", "-o", "-path", "*/@docsworth/cli/packages/*", ")", "-print", "-quit"], { encoding: "utf8" }).trim();
  check("the installed CLI carries nothing of pro", installed === "", installed);
  execFileSync("git", ["init", "-q"], { cwd: kb });
  run(["init", ".", "--org", "acme-example"]);
  const lint = run(["lint", "."]);
  check("init makes a repo that lints clean", / 0 errors/.test(lint), lint.trim().split("\n").at(-1));

  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  for (const p of ["AKB", "DOCSWORTH"]) Object.assign(env, { [`${p}_BIN`]: bin, [`${p}_KNOWLEDGE_DIR`]: kb, [`${p}_NO_GH_CLI`]: "1" });
  // The plugin as the package ships it: its own .mcp.json, command and arguments, with
  // ${CLAUDE_PLUGIN_ROOT} pointing into the installed package.
  const plugin = join(prefix, "node_modules", pkg.name, "plugin");
  const mcp = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args?: string[] }> };
  const [server] = Object.values(mcp.mcpServers);
  const args = (server!.args ?? []).map((a) => a.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin));
  const client = new Client({ name: "smoke-install", version: "1" });
  await client.connect(new StdioClientTransport({ command: server!.command, args, env, stderr: "pipe" }));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  // Exactly these: a tool the public package shouldn't serve fails it as surely as a missing one.
  check("the packaged plugin's launcher serves the seven tools, and only them", tools.join(",") === "draft_page,list,propose_edit,read,search,stale,verify", tools.join(", "));
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  check("and the polish prompt, and only it", prompts.join(",") === "polish", prompts.join(", "));
  const search = await client.callTool({ name: "search", arguments: { query: "how do I add a page" } });
  const hit = (search.structuredContent as { results: { id: string; citable: boolean }[] }).results[0];
  check("search finds a citable page", Boolean(hit?.citable), hit?.id);
  await client.close();

  // `serve`, as a customer starts it from the install. Without dist/web it still starts
  // and serves /mcp alone, so a tarball that lost the web app would otherwise ship quietly.
  serve = spawn(bin, ["serve", kb, "--port", "0"], {
    env: { PATH: env.PATH!, HOME: env.HOME!, XDG_STATE_HOME: join(dir, "state"), DOCSWORTH_NO_GH_CLI: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = await new Promise<URL>((ok, fail) => {
    let err = "";
    const timer = setTimeout(() => fail(new Error("serve printed no URL in 30 s")), 30_000);
    serve!.stderr!.on("data", (d: Buffer) => {
      err += d;
      const m = / at (http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43})\n/.exec(err);
      if (m) {
        clearTimeout(timer);
        ok(new URL(m[1]!));
      }
    });
    serve!.on("close", (code) => {
      clearTimeout(timer);
      fail(new Error(`serve exited ${code}: ${err.replace(/#t=\S+/g, "#t=<token>")}`));
    });
  });
  const timeout = () => AbortSignal.timeout(15_000);
  const index = await fetch(new URL("/", url), { signal: timeout() });
  const script = /<script type="module"[^>]* src="(\/assets\/[^"]+\.js)"/.exec(await index.text())?.[1];
  const asset = script ? await fetch(new URL(script, url), { signal: timeout() }) : undefined;
  check("serve serves the web app from the install", index.ok && asset?.ok === true && /javascript/.test(asset.headers.get("content-type") ?? ""), `GET / ${index.status}, ${script ?? "no app script"} ${asset?.status ?? ""}`);
  // A well-formed initialize, as any MCP client sends it, without the token and with
  // another one of the same shape.
  const initialize = (auth: Record<string, string>) =>
    fetch(new URL("/mcp", url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-install", version: "1" } } }),
      signal: timeout(),
    });
  const anonymous = await initialize({});
  const wrong = await initialize({ authorization: `Bearer ${url.hash.slice(3).replace(/^./, (c) => (c === "A" ? "B" : "A"))}` });
  const http = new Client({ name: "smoke-install", version: "1" });
  await http.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers: { authorization: `Bearer ${url.hash.slice(3)}` } } }));
  const caps = (await http.callTool({ name: "ui_capabilities", arguments: {} })).structuredContent as { mode?: string } | undefined;
  await http.close();
  check("and /mcp answers the tab's token, and only it", anonymous.status === 401 && wrong.status === 401 && caps?.mode === "local", `${anonymous.status} without, ${wrong.status} with another, mode ${caps?.mode} with it`);
} finally {
  if (serve && serve.exitCode === null && serve.signalCode === null) {
    const exited = new Promise((r) => serve!.once("exit", r));
    serve.kill("SIGTERM");
    const kill = setTimeout(() => serve!.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(kill);
  }
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nclean install: all checks passed");
process.exit(failed ? 1 : 0);
