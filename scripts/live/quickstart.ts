// R23: from an empty repo to the first cited answer in under 5 minutes, timed. Uses the
// local build in place of the published package (not out yet) and --plugin-dir in place
// of the marketplace install; both differences are noted in the output.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { check, done } from "./env.js";
import { READ_TOOLS, runClaude } from "./claude.js";

const BUDGET_S = 300;
const dir = mkdtempSync(join(tmpdir(), "docsworth-quickstart-"));
try {
  const t0 = Date.now();
  execFileSync("git", ["-C", dir, "init", "-q"]);
  const docsworth = (...a: string[]) => execFileSync(resolve("dist/cli.js"), a, { encoding: "utf8" });
  console.log(docsworth("init", dir, "--org", "acme", "--team", "platform", "--local").trim());
  const lint = docsworth("lint", dir).trim();
  console.log(lint);
  check("init produces a lint-clean repo", /0 errors/.test(lint));

  const run = await runClaude(dir, "How do I add a page to our knowledge base? Answer in two sentences and cite the knowledge page id you used.", { allowedTools: READ_TOOLS });
  const total = (Date.now() - t0) / 1000;
  console.log(`\nClaude (${run.seconds}s, tools: ${run.toolCalls.map((t) => t.name.replace("mcp__plugin_docsworth_docsworth__", "")).join(", ")}):\n${run.result}\n`);
  check("the answer used the Docsworth tools", run.toolCalls.some((t) => t.name.startsWith("mcp__plugin_docsworth")));
  check("the answer cites guide-writing-pages", run.result.includes("guide-writing-pages"));
  check(`init → first cited answer in under ${BUDGET_S / 60} minutes`, total < BUDGET_S, `${total.toFixed(1)} s, excluding npm download and marketplace install`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
done();
