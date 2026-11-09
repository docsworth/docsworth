import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, copyAcme } from "./helpers.js";
import { ALL_SPACES, ENG_PAGE, SEC_PAGE, serveMirror, writeMirror } from "./mirror-helpers.js";

// Spawns the real `docsworth mcp` entry point and talks to it with the SDK client — the same
// path Claude Code uses — so this covers argument parsing, transport and the wrapper.

const CLI = ["tsx", "src/cli.ts", "--as-of", "2026-11-02", "mcp"];
const BASE_ENV = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DOCSWORTH_NO_GH_CLI: "1" };

/** Async on purpose: the fake GitHub server lives in this process and must keep serving. */
function runCli(dir: string, env: Record<string, string>): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", [...CLI, dir], { env: { ...BASE_ENV, ...env }, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (status) => resolve({ status, stderr }));
    child.stdin.end();
  });
}

async function connect(dir: string | undefined, env: Record<string, string> = {}, cwd?: string) {
  const client = new Client({ name: "docsworth-e2e", version: "0" });
  // In another cwd, tsx and the CLI by absolute path: npx there would look for tsx elsewhere.
  const [command, cli] = cwd === undefined ? ["npx", CLI] : [resolve("node_modules/.bin/tsx"), [resolve(CLI[1]!), ...CLI.slice(2)]];
  const args = dir === undefined ? cli : [...cli, dir];
  await client.connect(new StdioClientTransport({ command, args, cwd, env: { ...BASE_ENV, ...env }, stderr: "ignore" }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: r.structuredContent as Record<string, any>, text: (r.content as { text: string }[])[0]!.text };
  };
  return { client, call };
}

describe("docsworth mcp (local-only repo)", () => {
  const acme = copyAcme();
  let s: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => (s = await connect(acme.root)));
  afterAll(async () => {
    await s.client.close();
    acme.cleanup();
  });

  it("exposes exactly the seven tools, read tools annotated read-only", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["draft_page", "list", "propose_edit", "read", "search", "stale", "verify"]);
    for (const t of tools.filter((t) => ["search", "read", "list", "stale"].includes(t.name))) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "search")?.description).toMatch(/untrusted data/);
  });

  it("offers the polish prompt, which steers to propose_edit with polish: true", async () => {
    const { prompts } = await s.client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["polish"]);
    expect(prompts[0]?.arguments).toEqual([expect.objectContaining({ name: "id", required: true })]);
    const r = await s.client.getPrompt({ name: "polish", arguments: { id: "rb-deploy-prod" } });
    const text = (r.messages[0]?.content as { text: string }).text;
    expect(text).toMatch(/Call `read` with id `rb-deploy-prod`/);
    expect(text).toMatch(/Call `propose_edit` with id `rb-deploy-prod`, `polish: true`/);
    const { tools } = await s.client.listTools();
    const schema = tools.find((t) => t.name === "propose_edit")?.inputSchema as { properties: Record<string, { type: string }> };
    expect(schema.properties.polish?.type).toBe("boolean");
  });

  it("states the citation rules in the server instructions", () => {
    // Cite only what was read: every bad citation in bench rounds baseline and v1 was a page the agent never opened.
    expect(s.client.getInstructions()).toMatch(/only after opening it with `read` and seeing `citable: true`/);
    expect(s.client.getInstructions()).toMatch(/A search snippet shows where to look, not what the page says, so read every page you cite/);
    // Eligible is not the same as cited: without this, agents cite every search hit (bench round v1).
    expect(s.client.getInstructions()).toMatch(/Being allowed to cite a page is not a reason to cite it/);
    // A decline cites nothing: all 8 wrong v2 runs on the training gate set cited the nearest page (bench round v3).
    expect(s.client.getInstructions()).toMatch(/Answer each part of the question from the citable pages that support it\. If no citable page answers a part, say so and cite nothing for that part\. A page that is only near the topic is not a source: you may point to it by title, but do not cite it or rely on its content\./);
  });

  it("search: gate applied, structured JSON in both content and structuredContent", async () => {
    const r = await s.call("search", { query: "scale the kubernetes cluster" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual(r.data);
    expect(r.data.excluded.map((e: { id: string }) => e.id)).toContain("rb-scale-cluster");
    expect(r.data.results.every((x: { citable: boolean }) => x.citable)).toBe(true);
  });

  it("read: page text only in `content`, metadata alongside", async () => {
    const r = await s.call("read", { id: "rb-scale-cluster" });
    expect(Object.keys(r.data)).toEqual(expect.arrayContaining(["id", "owner_team", "due", "flags", "content"]));
    expect(r.data.flags).toEqual(["past_sla"]);
    const { content, ...meta } = r.data;
    expect(content).toMatch(/autoscaler/);
    expect(JSON.stringify(meta)).not.toMatch(/autoscaler/);
  });

  it("list and stale", async () => {
    expect((await s.call("list")).data.index.id).toBe("index");
    expect((await s.call("list", { path: "runbooks" })).data.pages.length).toBeGreaterThan(5);
    expect((await s.call("stale")).data.pages.map((p: { id: string }) => p.id)).toEqual(["onb-on-call", "rb-scale-cluster"]);
  });

  it("errors are structured; hidden == unknown; writes unavailable without GitHub", async () => {
    const hidden = await s.call("read", { id: "rb-rotate-db-creds" });
    const unknown = await s.call("read", { id: "zzz" });
    expect(hidden).toMatchObject({ isError: true, data: { error: { code: "not_found" } } });
    expect(hidden.data.error.message.replace("rb-rotate-db-creds", "X")).toBe(unknown.data.error.message.replace("zzz", "X"));
    const write = await s.call("propose_edit", { id: "rb-deploy-prod", content: "x", reason: "r" });
    expect(write.data.error.code).toBe("unavailable");
  });
});

describe("docsworth mcp without a dir", () => {
  // The plugin launcher passes the repo in DOCSWORTH_KNOWLEDGE_DIR, not on the command line.
  it("serves the repo DOCSWORTH_KNOWLEDGE_DIR names, an argument over it, and else the current directory", async () => {
    const full = copyAcme();
    const gone = copyAcme();
    rmSync(join(gone.root, "knowledge/runbooks/scale-k8s-cluster.md"));
    const found = async (dir: string | undefined, env: string | undefined, cwd?: string) => {
      const s = await connect(dir, env === undefined ? {} : { DOCSWORTH_KNOWLEDGE_DIR: env }, cwd);
      const r = await s.call("read", { id: "rb-scale-cluster" });
      await s.client.close();
      return !r.isError && r.data.id === "rb-scale-cluster";
    };
    try {
      expect([await found(undefined, full.root), await found(undefined, gone.root), await found(full.root, gone.root)]).toEqual([true, false, true]);
      expect([await found(undefined, undefined, full.root), await found(undefined, undefined, gone.root)]).toEqual([true, false]);
    } finally {
      full.cleanup();
      gone.cleanup();
    }
  });
});

describe("docsworth mcp with mirror.serve (v0.2 L2)", () => {
  const acme = copyAcme();
  let s: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    await writeMirror(acme.root, ALL_SPACES);
    serveMirror(acme.root);
    // The child reads the ownership records from this test's state directory.
    s = await connect(acme.root, { XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? "" });
  });
  afterAll(async () => {
    await s.client.close();
    acme.cleanup();
  });

  it("lists mirrored pages apart from results, says so in the descriptions, and reads them as non-citable", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.find((t) => t.name === "search")?.description).toMatch(/listed under `mirrored`: context only, never citable\.$/);
    expect(tools.find((t) => t.name === "read")?.description).toMatch(/A `mirror:` id reads a mirrored wiki page/);
    const r = await s.call("search", { query: "deploy checklist canary jenkins" });
    expect(r.data.mirrored.map((m: { id: string }) => m.id)).toContain(ENG_PAGE.id);
    expect(r.data.results.some((p: { id: string }) => p.id.startsWith("mirror:"))).toBe(false);
    const page = await s.call("read", { id: ENG_PAGE.id });
    expect(page.data).toMatchObject({ citable: false, flags: ["mirrored"] });
    expect(page.data.content).not.toContain(SEC_PAGE.title); // local mode sees no security space
    const hidden = await s.call("read", { id: SEC_PAGE.id });
    expect(hidden.data.error.code).toBe("not_found");
  });
});

describe("docsworth mcp (GitHub-backed repo, fake GitHub over HTTP)", () => {
  const acme = acmeOnGitHub();
  const gh = new FakeGitHub(
    "acme/knowledge",
    "acme",
    { alice: { login: "alice", teams: ["platform"], push: true }, nobody: { login: "nobody", teams: [], push: true, access: false } },
    acme.root,
  );
  let url = "";
  let s: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    url = await gh.listen();
    s = await connect(acme.root, { GITHUB_TOKEN: "alice", DOCSWORTH_GITHUB_API_URL: url });
  });
  afterAll(async () => {
    await s.client.close();
    await gh.close();
    acme.cleanup();
  });

  it("propose_edit opens a PR; verify is owner-checked; main never written", async () => {
    const pr = await s.call("propose_edit", { id: "rb-rollback-deploy", edits: [{ old: "within 5 minutes", new: "within 10 minutes" }], reason: "observed in INC-42" });
    expect(pr.isError).toBe(false);
    expect(pr.data.pr_url).toMatch(/\/pull\/1$/);
    const v = await s.call("verify", { id: "svc-payments" });
    expect(v.data.error).toEqual({ code: "forbidden", message: "only members of @acme/payments can verify `svc-payments`" });
    expect(gh.violations).toEqual([]);
  });

  it("refuses to start when the token cannot see the repo (fail closed)", async () => {
    const r = await runCli(acme.root, { GITHUB_TOKEN: "nobody", DOCSWORTH_GITHUB_API_URL: url });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no access to acme\/knowledge/);
  });

  it("refuses to start with no token at all", async () => {
    const r = await runCli(acme.root, {});
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/a GitHub token is required/);
  });
});
