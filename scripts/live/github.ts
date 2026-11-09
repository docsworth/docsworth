// Live GitHub check (spec R12, R13): real identity, real teams API, real PRs.
// Creates the private scratch repo DOCSWORTH_LIVE_GITHUB_REPO
// if it does not exist, seeds it with examples/acme, then drives the real `docsworth mcp`.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GitHubClient, GitHubError } from "../../src/core/github.js";
import { resolveToken } from "../../src/core/identity.js";
import { check, done, loadEnv, scratchRepo } from "./env.js";

loadEnv();
const token = resolveToken();
if (!token) {
  console.log("SKIPPED: no GitHub token (GITHUB_TOKEN, GH_TOKEN or `gh auth login`)");
  process.exit(0);
}
const repo = scratchRepo();
const [owner, name] = repo.split("/") as [string, string];
const gh = new GitHubClient(token);
const CLI = resolve("src/cli.ts");
const GH_CREDS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

async function ensureScratchRepo(): Promise<string> {
  try {
    await gh.getRepo(repo);
    return "reused";
  } catch (err) {
    if (!(err instanceof GitHubError) || err.status !== 404) throw err;
  }
  const me = await gh.getUser();
  if (me.login.toLowerCase() !== owner.toLowerCase()) throw new Error(`refusing to create ${repo}: it is not under your account (${me.login})`);
  await gh.request("POST", "/user/repos", { name, private: true, description: "Docsworth live-test scratch repo (safe to delete)", auto_init: false });
  return "created";
}

function seed(dir: string): void {
  // Push the acme example as the scratch repo's main branch. HTTPS with gh as a one-off
  // credential helper: same identity as the token, no global git config change, and the
  // token never appears in process arguments.
  const src = mkdtempSync(join(tmpdir(), "docsworth-seed-"));
  cpSync("examples/acme", src, { recursive: true, filter: (p) => !/\.knowledge\/(mirror|usage)/.test(p) });
  const cfg = join(src, ".knowledge/config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace("# repo: acme/knowledge", `repo: ${repo}`));
  const git = (...a: string[]) => execFileSync("git", ["-C", src, ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=Docsworth live test", "-c", "user.email=docsworth@users.noreply.github.com", "commit", "-q", "-m", "Seed from Docsworth examples/acme");
  git(...GH_CREDS, "push", "-q", `https://github.com/${repo}.git`, "main");
  cpSync(src, dir, { recursive: true });
  rmSync(src, { recursive: true, force: true });
}

async function connect(dir: string) {
  const client = new Client({ name: "docsworth-live", version: "0" });
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GITHUB_TOKEN: token! };
  await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", CLI, "mcp", dir], env, stderr: "ignore" }));
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name: tool, arguments: args });
    return { isError: Boolean(r.isError), data: r.structuredContent as Record<string, any> };
  };
  return { client, call };
}

const status = await ensureScratchRepo();
console.log(`scratch repo ${repo}: ${status}`);
const work = mkdtempSync(join(tmpdir(), "docsworth-live-"));
try {
  const info = await gh.getRepo(repo);
  const empty = await gh.getBranchSha(repo, info.default_branch || "main").then(() => false, () => true);
  if (empty) seed(work);
  else {
    execFileSync("git", [...GH_CREDS, "clone", "-q", `https://github.com/${repo}.git`, work], { stdio: "pipe" });
  }

  const { client, call } = await connect(work);
  try {
    const search = await call("search", { query: "roll back a deploy" });
    check("search over the scratch repo in GitHub mode", !search.isError && search.data.results.some((r: { id: string }) => r.id === "rb-rollback-deploy"));

    const hidden = await call("read", { id: "rb-rotate-db-creds" });
    const unknown = await call("read", { id: "zz-unknown" });
    check(
      "team-ACL page hidden (real /user/teams: not in @acme/security)",
      hidden.isError && hidden.data.error.message.replace("rb-rotate-db-creds", "X") === unknown.data.error.message.replace("zz-unknown", "X"),
    );

    const stamp = new Date().toISOString().slice(0, 19);
    const pr = await call("propose_edit", {
      id: "rb-rollback-deploy",
      edits: [{ old: "within 5 minutes", new: "within 5 minutes (live check " + stamp + ")" }],
      reason: "Docsworth live check: propose_edit opens a PR and never touches main.",
      draft: true,
    });
    check("propose_edit opened a real PR", !pr.isError && /\/pull\/\d+$/.test(pr.data.pr_url ?? ""), pr.data.pr_url ?? JSON.stringify(pr.data));
    if (!pr.isError) {
      const main = await gh.getFile(repo, "knowledge/runbooks/rollback-deploy.md", info.default_branch || "main");
      check("main unchanged after propose_edit", !Buffer.from(main.content, "base64").toString("utf8").includes("live check"));
    }

    const verify = await call("verify", { id: "svc-payments" });
    check("verify refused for a non-member of the owner team", verify.isError && verify.data.error.code === "forbidden", verify.data.error?.message);
  } finally {
    await client.close();
  }

  // Promote (R18) is pro's, checked by `npm run live:promote -w @docsworth-pro/pro`.

  // Fail closed: a repo the token cannot see stops the server at startup.
  const cfg = join(work, ".knowledge/config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace(`repo: ${repo}`, `repo: ${owner}/docsworth-does-not-exist-${Date.now()}`));
  const r = spawnSync("npx", ["tsx", CLI, "mcp", work], { env: { ...process.env, GITHUB_TOKEN: token }, encoding: "utf8", input: "" });
  check("startup refused for a repo the token cannot see", r.status === 2 && /no access to/.test(r.stderr), r.stderr.trim().split("\n").pop());
} finally {
  rmSync(work, { recursive: true, force: true });
}
done();
