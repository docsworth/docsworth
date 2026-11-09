// v0.2 L1: the polish-page skill, run by a real headless Claude Code on six acme pages
// in the scratch repo. For each page it reports whether a polish PR opened and every
// refusal the guard gave on the way, verbatim, so each one can be judged by a person:
// a refusal of a change that kept the facts is a false reject. Target: at most 1 in 6.
// The PRs are left open for their diffs to be read, then closed (never merged).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveToken } from "../../src/core/identity.js";
import { check, done, loadEnv, scratchRepo } from "./env.js";
import { READ_TOOLS, runClaude, TOOL } from "./claude.js";

loadEnv();
const token = resolveToken();
if (!token) {
  console.log("SKIPPED: no GitHub token");
  process.exit(0);
}
const repo = scratchRepo();
const pages = (process.env.PAGES ?? "rb-deploy-prod,rb-payments-refund-failures,rb-sre-incident-response,rb-scale-cluster,adr-0002,onb-on-call").split(",");
const prs = () =>
  JSON.parse(execFileSync("gh", ["pr", "list", "--repo", repo, "--state", "all", "--limit", "200", "--json", "number,title,url"], { encoding: "utf8" })) as {
    number: number;
    title: string;
    url: string;
  }[];

// The MCP server needs a git checkout of the scratch repo to read from.
const dir = mkdtempSync(join(tmpdir(), "docsworth-polish-"));
execFileSync("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "clone", "-q", `https://github.com/${repo}.git`, dir]);

let opened = 0;
let refusals = 0;
for (const id of pages) {
  const before = new Set(prs().map((p) => p.number));
  const run = await runClaude(dir, `Use the Docsworth polish-page skill on \`${id}\`. Its owners say it's hard to follow: restructure and tighten it.`, {
    env: { GITHUB_TOKEN: token },
    allowedTools: [...READ_TOOLS, TOOL("propose_edit")],
  });
  const calls = run.toolCalls.filter((t) => t.name === TOOL("propose_edit"));
  const pr = prs().find((p) => !before.has(p.number) && p.title.startsWith(`polish(${id}):`));
  console.log(`\n${id}: ${run.subtype}, ${run.seconds}s, ${calls.length} propose_edit call(s)${run.denials.length ? `, denied: ${run.denials.map((d) => d.tool_name).join(", ")}` : ""}`);
  for (const c of calls) {
    const res = run.toolResults.get(c.id);
    if (c.input.polish !== true) console.log(`  WITHOUT polish: true: ${JSON.stringify({ ...c.input, content: undefined }).slice(0, 200)}`);
    if (res?.isError || /"error"/.test(res?.text ?? "")) {
      refusals++;
      console.log(`  REFUSED: ${res?.text}`);
      // What was sent, so the refusal can be judged: which arguments, and how the text began.
      const sent = (c.input.body ?? c.input.content ?? "") as string;
      console.log(`    sent ${Object.keys(c.input).sort().join(", ")}; text began: ${JSON.stringify(sent.slice(0, 160))}`);
    }
  }
  check(`${id}: polish PR opened`, Boolean(pr), pr ? pr.url : run.result.slice(-300));
  if (pr) opened++;
}
console.log(`\n${opened}/${pages.length} polish PRs opened; ${refusals} refusal(s) to judge. Read each PR's diff, then close it: gh pr close <n> --repo ${repo} --delete-branch`);
rmSync(dir, { recursive: true, force: true });
done();
