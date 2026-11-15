import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { HOST_API } from "../src/core/host.js";
import { PACKAGE_NAME, PUBLISHED_PACKAGE } from "../src/core/version.js";

// The CLI as a user gets it: built, packed by npm, and installed from that tarball into an
// empty project. Docsworth pro is a separate package under its own licence, so it's not
// there; stand-ins for it show how the CLI treats a pro that's broken or built for another
// CLI. Pro's own tests install the real one beside it.

// XDG_STATE_HOME is the per-worker state dir from test/setup-state.ts, so a child never
// writes to the real ~/.local/state.
const ENV = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DOCSWORTH_NO_GH_CLI: "1", XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? "" };
const notInstalled = (feature: string) => `docsworth: ${feature} is part of Docsworth pro, which isn't installed`;

describe("the files list", () => {
  it("leaves out pro even when a stale build left dist/pro behind", () => {
    // A tarball comes from whatever dist/ holds, and npm pack and npm publish don't run the
    // build that clears it. A throwaway package with this repo's real files list, and a
    // stand-in dist holding a pre-split dist/pro.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
    const dir = mkdtempSync(join(tmpdir(), "docsworth-files-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "files-probe", version: "0.0.0", files: pkg.files }));
      for (const f of ["dist/cli.js", "dist/core/host.js", "dist/pro/digest.js", "dist/pro/mirror/run.js"]) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), "");
      }
      const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: dir, encoding: "utf8" })) as Array<{ files: Array<{ path: string }> }>;
      const files = packed!.files.map((f) => f.path);
      expect(files).toContain("dist/cli.js");
      expect(files).toContain("dist/core/host.js");
      expect(files.filter((f) => f.startsWith("dist/pro/"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the packed CLI, installed from its tarball", () => {
  let work = "";
  let files: string[] = [];
  let project = "";
  let kb = "";
  const bin = () => join(project, "node_modules/.bin");
  const docsworth = (args: string[], input?: string) => spawnSync(join(bin(), "docsworth"), args, { encoding: "utf8", env: ENV, input });

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "docsworth-packed-"));
    execFileSync("npm", ["run", "build"], { stdio: "pipe" });
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], { encoding: "utf8" })) as Array<{ filename: string; files: Array<{ path: string }> }>;
    files = packed!.files.map((f) => f.path);
    project = join(work, "project");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "docsworth-user", private: true }));
    // Public dependencies only, from npm's cache where it has them.
    execFileSync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts", join(work, packed!.filename)], { cwd: project, stdio: "pipe" });
    kb = join(work, "kb");
    execFileSync("git", ["init", "-q", kb]);
    expect(docsworth(["init", kb, "--org", "acme", "--team", "platform", "--local"]).status).toBe(0);
  }, 300_000);
  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("carries the CLI and the host facade, and nothing of pro", () => {
    for (const f of ["dist/cli.js", "dist/core/host.js", "dist/core/host.d.ts", "package.json", "LICENSE"]) expect(files, f).toContain(f);
    expect(files.filter((f) => /(^|\/)pro(\/|$)|^packages\/|LICENSE\.md$|LICENSE-PRO/.test(f))).toEqual([]);
  });

  it("carries the built web app, and the installed `serve` serves it at /", async () => {
    // The view tests render the app from source; this is the build a user gets.
    expect(files).toContain("dist/web/index.html");
    expect(files.some((f) => /^dist\/web\/assets\/index-[\w-]+\.js$/.test(f))).toBe(true);
    expect(files.some((f) => /^dist\/web\/assets\/index-[\w-]+\.css$/.test(f))).toBe(true);
    const { spawn } = await import("node:child_process");
    const child = spawn(join(bin(), "docsworth"), ["serve", kb, "--port", "0"], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
    try {
      const url = await new Promise<URL>((done, fail) => {
        let err = "";
        child.stderr!.on("data", (d: Buffer) => {
          err += d;
          const m = / at (http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43})\n/.exec(err);
          if (m) done(new URL(m[1]!));
        });
        child.on("exit", (code) => fail(new Error(`serve exited ${code}: ${err}`)));
      });
      const index = await fetch(new URL("/", url));
      expect(index.status).toBe(200);
      const html = await index.text();
      const script = /<script type="module" crossorigin src="(\/assets\/[^"]+\.js)">/.exec(html)?.[1];
      const style = /<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+\.css)">/.exec(html)?.[1];
      expect(script, html).toBeTruthy();
      expect(style, html).toBeTruthy();
      const js = await fetch(new URL(script!, url));
      expect([js.status, js.headers.get("content-type")]).toEqual([200, "text/javascript; charset=utf-8"]);
      expect((await js.text()).length).toBeGreaterThan(10_000);
      expect((await fetch(new URL(style!, url))).status).toBe(200);
      // A client-side route gets the app too, so a reload or a shared link works.
      const route = await fetch(new URL("/p/guide-writing-pages", url));
      expect([route.status, await route.text()]).toEqual([200, html]);
    } finally {
      child.kill("SIGTERM");
    }
  }, 60_000);

  /** `serve` on the test repo: what `ui_capabilities` tells the web app about pro, and serve's stderr. */
  async function servedPro(): Promise<{ pro: string[]; panels: string[]; stderr: string }> {
    const { spawn } = await import("node:child_process");
    const child = spawn(join(bin(), "docsworth"), ["serve", kb, "--port", "0"], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    try {
      const url = await new Promise<URL>((done, fail) => {
        child.stderr!.on("data", (d: Buffer) => {
          stderr += d;
          const m = / at (http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43})\n/.exec(stderr);
          if (m) done(new URL(m[1]!));
        });
        child.on("exit", (code) => fail(new Error(`serve exited ${code}: ${stderr}`)));
      });
      const client = new Client({ name: "docsworth-web", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers: { authorization: `Bearer ${url.hash.slice(3)}` } } }));
      try {
        const r = await client.callTool({ name: "ui_capabilities", arguments: {} });
        const caps = r.structuredContent as { pro: string[]; pro_commands: string[] };
        return { pro: caps.pro_commands, panels: caps.pro, stderr };
      } finally {
        await client.close();
      }
    } finally {
      child.kill("SIGTERM");
    }
  }

  it("serve tells the web app pro isn't installed, and says nothing about it", async () => {
    const r = await servedPro();
    expect(r.pro).toEqual([]);
    expect(r.stderr).not.toMatch(/pro/i);
  }, 60_000);

  it("runs as every command package.json names, through the link npm installs", () => {
    // cli.ts only runs when started as cli.js or under its bin name. A rename or an alias
    // that missed that check would install a command that does nothing and exits 0.
    const bins = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).bin as Record<string, string>);
    expect(bins.length).toBeGreaterThan(0);
    for (const name of bins) {
      const r = spawnSync(join(bin(), name), ["lint", kb], { encoding: "utf8", env: ENV });
      expect({ name, status: r.status, stdout: r.stdout.trim() }).toEqual({ name, status: 0, stdout: "3 pages, 0 errors, 0 warnings" });
    }
  });

  it("runs the core commands", () => {
    for (const args of [["lint", kb], ["stale", kb], ["coverage", kb]]) {
      const r = docsworth(args);
      expect({ cmd: args[0], status: r.status, stderr: r.stderr }).toEqual({ cmd: args[0], status: 0, stderr: "" });
    }
  });

  it("every pro command exits 2 and names the missing feature", () => {
    const commands: Array<[string, string[]]> = [
      ["coverage --html", ["coverage", kb, "--html", join(kb, "x.html")]],
      ["digest", ["digest", kb]],
      ["compile", ["compile", kb]],
      ["mirror", ["mirror", kb]],
      ["mirror-purge", ["mirror-purge", kb]],
      ["promote", ["promote", "mirror:confluence:ENG:1", kb, "--owner-team", "platform"]],
      ["bench", ["bench", "run", kb]],
      ["bench", ["bench", "score", kb]],
      ["audit", ["audit", kb, "--out", join(kb, "audit")]],
      ["access-review", ["access-review", kb]],
      ["usage-report", ["usage-report", kb]],
    ];
    for (const [feature, args] of commands) {
      const r = docsworth(args);
      expect({ args: args.join(" "), status: r.status, stderr: r.stderr.trim() }).toEqual({ args: args.join(" "), status: 2, stderr: notInstalled(feature) });
    }
  });

  it("passes every step of the workflow `init --ci` writes, run as CI runs it, without pro", () => {
    // A knowledge repo's CI fetches this package through npx, so pro is never there: a step
    // that needs pro fails every push and every PR. Found by running the workflow in a new
    // GitHub repo, where `compile` exited 2 on both (2026-11-15).
    const repo = join(work, "kb-ci");
    execFileSync("git", ["init", "-q", repo]);
    expect(docsworth(["init", repo, "--org", "acme", "--team", "platform", "--ci"]).status).toBe(0);
    const wf = parseYaml(readFileSync(join(repo, ".github/workflows/knowledge.yml"), "utf8")) as { jobs: Record<string, { steps: { run?: string }[] }> };
    const runs = Object.values(wf.jobs).flatMap((j) => j.steps.flatMap((st) => (st.run ? [st.run] : [])));
    expect(runs.length).toBeGreaterThan(0);
    const npx = `npx -y "${PUBLISHED_PACKAGE}" `;
    for (const run of runs) {
      // Each step is one `docsworth` command, run in the checkout; any other step would need
      // its own stand-in here before it could ship.
      expect({ run, docsworthStep: run.startsWith(npx) && !run.includes("\n") }).toEqual({ run, docsworthStep: true });
      const r = spawnSync(join(bin(), "docsworth"), run.slice(npx.length).split(" "), { cwd: repo, encoding: "utf8", env: ENV });
      expect({ run, status: r.status, stderr: r.stderr.trim() }).toEqual({ run, status: 0, stderr: "" });
    }
  });

  /** Talk to the installed `docsworth mcp` over stdio, the way Claude Code does. */
  async function serve(repo: string): Promise<{ tools: string[]; stderr: string }> {
    const transport = new StdioClientTransport({ command: join(bin(), "docsworth"), args: ["mcp", repo], env: ENV, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: "docsworth-packed", version: "0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    return { tools, stderr };
  }

  /** A copy of the test repo with this YAML appended to its config. */
  function withConfig(yaml: string): string {
    const repo = mkdtempSync(join(tmpdir(), "docsworth-packed-sink-"));
    cpSync(kb, repo, { recursive: true });
    appendFileSync(join(repo, ".knowledge/config.yaml"), yaml);
    return repo;
  }
  const SINK = "audit_http:\n  url_env: DOCSWORTH_AUDIT_URL\n";
  const WARNING = `docsworth: audit collector disabled for this run: ${notInstalled("audit_http").slice("docsworth: ".length)}`;

  it("serves MCP", async () => {
    expect((await serve(kb)).tools).toContain("search");
  });

  it("an optional audit_http sink (required absent or false) warns once and serves without it", async () => {
    for (const yaml of [SINK, `${SINK}  required: false\n`]) {
      const repo = withConfig(yaml);
      try {
        const r = await serve(repo);
        expect(r.tools).toContain("search");
        expect({ yaml, warnings: r.stderr.split(WARNING).length - 1 }).toEqual({ yaml, warnings: 1 });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it("anything but a plainly optional sink refuses to start (fail closed)", () => {
    const cases = [
      `${SINK}  required: true\n`, // required
      `${SINK}  required: "yes"\n`, // malformed required
      `${SINK}  required: null\n`,
      `${SINK}  required: 0\n`,
      "audit_http: 0\n", // not an object
      "audit_http:\n  required: false\n", // no url_env, so not a sink pro would accept
    ];
    for (const yaml of cases) {
      const repo = withConfig(yaml);
      try {
        const r = docsworth(["mcp", repo], "");
        expect({ yaml, status: r.status, stderr: r.stderr.trim() }).toEqual({ yaml, status: 2, stderr: notInstalled("audit_http") });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  describe("with a stand-in pro installed where the real one goes", () => {
    const proDir = () => join(project, "node_modules/@docsworth-pro/pro");
    function standIn(files: Record<string, string>, dir = proDir()): void {
      const manifest = { name: "@docsworth-pro/pro", version: "0.0.0", type: "module", exports: { "./host-api": "./host-api.js", "./commands": "./commands.js", "./package.json": "./package.json" } };
      for (const [f, content] of Object.entries({ "package.json": JSON.stringify(manifest), ...files })) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), content);
      }
    }
    afterEach(() => rmSync(join(project, "node_modules/@docsworth-pro"), { recursive: true, force: true }));

    it("refuses a pro built for another host API, or one that doesn't load, by name", () => {
      const cases: Array<[string, string]> = [
        ["export const PRO_HOST_API = 999;\n", `it was built for host API 999, and this CLI has ${HOST_API}; install versions that match`],
        ['throw new Error("pro is broken");\n', "it doesn't load: pro is broken"],
      ];
      for (const [hostApi, why] of cases) {
        standIn({ "host-api.js": hostApi, "commands.js": "export const commands = {};\n" });
        for (const [feature, args] of [["mirror", ["mirror", kb]], ["digest", ["digest", kb]]] as const) {
          const r = docsworth([...args]);
          expect({ args: args.join(" "), status: r.status, stderr: r.stderr.trim() }).toEqual({
            args: args.join(" "),
            status: 2,
            stderr: `docsworth: ${feature} needs Docsworth pro, which is installed but can't be used: ${why}`,
          });
        }
      }
    });

    it("a file missing inside an installed pro is a real error, not 'pro isn't installed'", () => {
      standIn({ "host-api.js": `export const PRO_HOST_API = ${HOST_API};\n`, "commands.js": 'import "./mirror/http.js";\nexport const commands = {};\n' });
      const r = docsworth(["mirror", kb]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("ERR_MODULE_NOT_FOUND");
      expect(r.stderr).toContain("mirror/http.js");
      expect(r.stderr).not.toContain("isn't installed");
    });

    it("serve tells the web app pro's commands when pro loads, each one a command of the CLI", async () => {
      standIn({ "host-api.js": `export const PRO_HOST_API = ${HOST_API};\n`, "commands.js": "export const commands = {};\n" });
      const r = await servedPro();
      expect(r.pro).toEqual(["digest", "coverage --html", "compile", "audit", "access-review", "usage-report", "mirror", "promote", "bench"]);
      expect(r.panels).toEqual([]); // `pro` stays the panels pro supplies, and there are none yet
      expect(r.stderr).not.toMatch(/pro/i);
      const help = docsworth(["--help"]).stdout;
      for (const name of r.pro) expect(help, name).toMatch(new RegExp(`^  ${name.split(" ")[0]} `, "m"));
      expect(docsworth(["coverage", "--help"]).stdout).toContain("--html <file>");
    }, 60_000);

    it("a pro that's installed but can't be used: serve says why once, and runs without it", async () => {
      const cases: Array<[Record<string, string>, string]> = [
        [{ "host-api.js": "export const PRO_HOST_API = 999;\n", "commands.js": "export const commands = {};\n" }, `it was built for host API 999, and this CLI has ${HOST_API}; install versions that match`],
        // A file missing inside pro fails a pro command outright (below); serve doesn't need pro.
        [{ "host-api.js": `export const PRO_HOST_API = ${HOST_API};\n`, "commands.js": 'import "./mirror/http.js";\nexport const commands = {};\n' }, "it doesn't load: Cannot find module "],
      ];
      for (const [files, why] of cases) {
        standIn(files);
        const r = await servedPro();
        expect(r.pro).toEqual([]);
        const said = r.stderr.split("\n").filter((l) => /pro/i.test(l));
        expect(said).toHaveLength(1);
        expect(said[0]).toContain(`docsworth: Docsworth pro is installed but can't be used, so the web app shows it as not installed: ${why}`);
        rmSync(join(project, "node_modules/@docsworth-pro"), { recursive: true, force: true });
      }
    }, 120_000);

    it("a pro that can't find the CLI by name, as in Docsworth's own repository, is refused in one line", () => {
      // Pro imports the CLI's facade by package name. In Docsworth's own repository the CLI is
      // the root package, so pro is linked beside it but nothing installs the CLI under that
      // name. The same layout: the installed CLI copied out as a root package, its
      // dependencies beside it, and pro, but no node_modules/@docsworth/cli.
      const usesFacade = { "host-api.js": `export const PRO_HOST_API = ${HOST_API};\n`, "commands.js": 'import { HOST_API } from "@docsworth/cli/host";\nexport const commands = { digest: async () => console.log(`stand-in digest, host API ${HOST_API}`) };\n' };
      // Control: installed beside the CLI, as a user installs them, the facade resolves.
      standIn(usesFacade);
      const beside = docsworth(["digest", kb]);
      expect({ status: beside.status, stdout: beside.stdout.trim() }).toEqual({ status: 0, stdout: `stand-in digest, host API ${HOST_API}` });

      const root = mkdtempSync(join(work, "root-cli-"));
      try {
        const cli = join(project, "node_modules/@docsworth/cli");
        cpSync(join(cli, "dist"), join(root, "dist"), { recursive: true });
        cpSync(join(cli, "package.json"), join(root, "package.json"));
        mkdirSync(join(root, "node_modules"));
        for (const dep of readdirSync(join(project, "node_modules"))) {
          if (![".bin", "@docsworth", "@docsworth-pro"].includes(dep)) symlinkSync(join(project, "node_modules", dep), join(root, "node_modules", dep));
        }
        standIn(usesFacade, join(root, "node_modules/@docsworth-pro/pro"));
        const r = spawnSync(process.execPath, [join(root, "dist/cli.js"), "digest", kb], { encoding: "utf8", env: ENV });
        expect({ status: r.status, stderr: r.stderr.trim() }).toEqual({
          status: 2,
          stderr: `docsworth: digest needs Docsworth pro, which is installed but can't be used: it can't find ${PACKAGE_NAME}, the CLI it runs in. Install the two side by side; in Docsworth's own repository, run the CLI as \`npm run docsworth\``,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("an installed pro missing its own host API is broken, not missing", () => {
      // The handshake's module can't be found, as when pro isn't installed at all; but pro's
      // package is there, so it's pro that's broken, and the CLI says so.
      standIn({ "commands.js": "export const commands = {};\n" });
      const r = docsworth(["digest", kb]);
      expect(r.status).toBe(2);
      expect(r.stderr.trim()).toMatch(/^docsworth: digest needs Docsworth pro, which is installed but can't be used: it doesn't load: Cannot find module '.+[\\/]@docsworth-pro[\\/]pro[\\/]host-api\.js'/);
    });
  });
});

// Every dependency package.json names resolves in the lockfile, as `npm ci` requires. One
// already installed through another package keeps its entry there, so naming it changes
// only the root's list (merge gate, PR 13): domino came through turndown and entities
// through commonmark before the ACL oracle named them.
describe("package-lock.json", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> };

  it.each(Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }))("resolves %s", (name, range) => {
    const entry = lock.packages[`node_modules/${name}`];
    expect(entry, `${name} has no entry in package-lock.json`).toBeDefined();
    // An exact pin resolves to exactly that version.
    if (/^\d+\.\d+\.\d+$/.test(range)) expect(entry!.version).toBe(range);
    const root = lock.packages[""]!;
    expect({ ...root.dependencies, ...root.devDependencies }[name]).toBe(range);
  });
});
