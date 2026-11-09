// Live check for `docsworth serve`: the real CLI, over HTTP,
// against the real GitHub scratch repo that `live:github` seeds. It opens a draft_page PR
// and an append PR, checks that they target new docsworth/ branches and leave main as it
// was, then closes both and deletes their branches: scratch PRs are never merged.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GitHubClient } from "../../src/core/github.js";
import { resolveToken } from "../../src/core/identity.js";
import { check, done, loadEnv, scratchRepo } from "./env.js";

loadEnv();
const token = resolveToken();
if (!token) {
  console.log("SKIPPED: no GitHub token (GITHUB_TOKEN, GH_TOKEN or `gh auth login`)");
  process.exit(0);
}
const repo = scratchRepo();
const gh = new GitHubClient(token);
const GH_CREDS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

const mainSha = await gh.getBranchSha(repo, "main").catch(() => null);
if (!mainSha) {
  console.log(`SKIPPED: ${repo} has no main branch yet; run \`npm run live:github\` first, which seeds it`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "docsworth-live-serve-"));
const state = mkdtempSync(join(tmpdir(), "docsworth-live-state-"));
let child: ChildProcess | undefined;
const opened: { number: number; branch: string }[] = [];
try {
  execFileSync("git", [...GH_CREDS, "clone", "-q", `https://github.com/${repo}.git`, work], { stdio: "pipe" });
  // The real entry point, as a person starts it. The token stays in the environment.
  child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "serve", work, "--port", "0"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GITHUB_TOKEN: token, XDG_STATE_HOME: state },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = await new Promise<URL>((ok, fail) => {
    let err = "";
    child!.stderr!.on("data", (d: Buffer) => {
      err += d;
      const m = / at (http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43})\n/.exec(err);
      if (m) ok(new URL(m[1]!));
    });
    child!.on("close", (code) => fail(new Error(`serve exited ${code}: ${err.replace(/#t=\S+/g, "#t=<token>")}`)));
  });
  check("serve starts in GitHub mode and prints its URL", url.hostname === "127.0.0.1", url.origin);

  const transport = new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers: { authorization: `Bearer ${url.hash.slice(3)}` } } });
  const client = new Client({ name: "docsworth-live-serve", version: "0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), data: r.structuredContent as Record<string, any> };
  };

  const caps = await call("ui_capabilities");
  check("ui_capabilities says writes work", caps.data?.writes === true && caps.data?.mode === "github", JSON.stringify({ mode: caps.data?.mode, writes: caps.data?.writes, writes_off: caps.data?.writes_off }));

  const draft = await call("draft_page", {
    type: "runbook",
    title: "Live serve check",
    owner_team: "platform",
    body: "# Live serve check\n\nOpened by `npm run live:serve`. Safe to close.\n",
    source_url: "https://example.com/live-serve",
    reason: "live:serve check (closed by the script)",
  });
  if (!draft.isError) opened.push({ number: draft.data.pr_number, branch: draft.data.branch });
  check("draft_page opened a draft PR on a docsworth/draft/ branch", !draft.isError && /^docsworth\/draft\/rb-live-serve-check-[0-9a-f]{12}-/.test(draft.data.branch), draft.isError ? JSON.stringify(draft.data.error) : draft.data.pr_url);

  const append = await call("propose_edit", { id: "rb-deploy-prod", append: "## Live serve check\n\nAdded by `npm run live:serve`. Safe to close.", reason: "live:serve check (closed by the script)" });
  if (!append.isError) opened.push({ number: append.data.pr_number, branch: append.data.branch });
  check("propose_edit append opened a PR on a docsworth/propose/ branch", !append.isError && /^docsworth\/propose\/rb-deploy-prod-/.test(append.data.branch), append.isError ? JSON.stringify(append.data.error) : append.data.pr_url);

  if (!draft.isError) {
    const { data: pr } = await gh.request<{ draft: boolean; base: { ref: string }; head: { ref: string } }>("GET", `/repos/${repo}/pulls/${draft.data.pr_number}`);
    check("the draft PR is a draft against main", pr.draft === true && pr.base.ref === "main" && pr.head.ref === draft.data.branch);
  }
  check("main is where it was", (await gh.getBranchSha(repo, "main")) === mainSha);
  await client.close();
} finally {
  child?.kill("SIGTERM");
  // Scratch PRs are never merged: close each and delete its branch.
  for (const pr of opened) {
    await gh.request("PATCH", `/repos/${repo}/pulls/${pr.number}`, { state: "closed" }).catch((e: Error) => console.log(`could not close #${pr.number}: ${e.message}`));
    await gh.deleteBranch(repo, pr.branch).catch((e: Error) => console.log(`could not delete ${pr.branch}: ${e.message}`));
  }
  if (opened.length) console.log(`closed ${opened.map((p) => `#${p.number}`).join(", ")} and deleted their branches`);
  rmSync(work, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
done();
