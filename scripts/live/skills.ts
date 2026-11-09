// R22: one headless Claude Code scenario per plugin skill, against the scratch repo.
//   draft-runbook          → calls draft_page: a draft PR on a docsworth/draft/ branch with a new runbook
//   update-after-incident  → calls propose_edit on the affected runbook → PR
//   verify-page            → calls verify; the scratch account is on no @acme team, so the
//                            expected outcome is the owner refusal, reported to the user
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
const prs = () =>
  JSON.parse(execFileSync("gh", ["pr", "list", "--repo", repo, "--state", "all", "--limit", "100", "--json", "number,headRefName,title,isDraft"], { encoding: "utf8" })) as {
    number: number;
    headRefName: string;
    title: string;
    isDraft: boolean;
  }[];

// Any `docsworth/` branch already on the repo, whether its PR is open or was closed without
// deleting it, can make a skill find "its" work already there and stop to ask, which
// reads as a failure. Say so up front; whether to remove them is the operator's call.
const existing = execFileSync("gh", ["api", `repos/${repo}/branches`, "--paginate", "--jq", ".[].name"], { encoding: "utf8" })
  .split("\n")
  .filter((n) => n.startsWith("docsworth/"));
if (existing.length) console.log(`WARN  ${existing.length} docsworth/ branch(es) already on ${repo} (${existing.slice(0, 3).join(", ")}${existing.length > 3 ? ", …" : ""}); a scenario may find one and stop. If they're from earlier live runs, close their PRs with --delete-branch first.`);

const dir = mkdtempSync(join(tmpdir(), "docsworth-skills-"));
try {
  execFileSync("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "clone", "-q", `https://github.com/${repo}.git`, dir]);
  // Every scenario writes through the MCP tools, which open PRs with GITHUB_TOKEN: no git push.
  const env = { GITHUB_TOKEN: token };
  const only = (process.env.SCENARIOS ?? "draft,update,verify").split(",");
  const report = (name: string, r: { subtype: string; seconds: number; denials: { tool_name: string; tool_input: unknown }[]; toolCalls: { name: string; input: Record<string, unknown> }[] }) => {
    console.log(`  ${name}: ${r.subtype}, ${r.seconds}s, ${r.toolCalls.length} tool calls${r.denials.length ? `, ${r.denials.length} denied: ${r.denials.map((d) => `${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 120)}`).join(" | ")}` : ""}`);
  };

  if (only.includes("draft")) {
  // 1. draft-runbook
  const before = new Set(prs().map((p) => p.number));
  const draft = await runClaude(
    dir,
    [
      "Use the Docsworth draft-runbook skill to turn this incident note into a runbook and open it as a draft PR.",
      "",
      "INC-77, 2026-10-29, SEV2. KafkaConsumerLag fired for the payments-events consumer group for 25 minutes. Responders ran `kafkactl describe group payments-consumers` and saw partition 7 stuck on a poison message at offset 88121. They moved it to the dead-letter topic with `kafkactl dlq move payments-events 7 88121` and lag cleared within 6 minutes. They had also scaled the consumer with `kubectl -n payments scale deploy/payments-consumer --replicas=12`, and scaled it back to 6 an hour later. Checks used: `kafkactl describe group payments-consumers` shows lag under 1000 on every partition. The payments team owns the consumer.",
    ].join("\n"),
    { env, allowedTools: [...READ_TOOLS, TOOL("draft_page")] },
  );
  const newDraft = prs().find((p) => !before.has(p.number) && p.headRefName.startsWith("docsworth/draft/"));
  check("draft-runbook opened a draft PR on a docsworth/draft/ branch", Boolean(newDraft?.isDraft), newDraft ? `#${newDraft.number} ${newDraft.headRefName}` : draft.result.slice(-300));
  if (newDraft) {
    const files = execFileSync("gh", ["pr", "view", String(newDraft.number), "--repo", repo, "--json", "files", "--jq", ".files[].path"], { encoding: "utf8" }).trim();
    check("the drafted runbook lands where CODEOWNERS routes payments runbooks", /knowledge\/runbooks\/payments-/.test(files), files);
  }
  report("draft-runbook", draft);
  }

  if (only.includes("update")) {
  // 2. update-after-incident
  const before2 = new Set(prs().map((p) => p.number));
  const update = await runClaude(
    dir,
    [
      "Use the Docsworth update-after-incident skill on this postmortem: find the affected runbook and propose the corrections.",
      "",
      "Postmortem INC-81 (2026-10-30, refunds). The RefundFailureRate alert now fires at more than 3% of refunds failing over 15 minutes; it was raised from 2% in September, so any runbook that says 2% is wrong. During the incident `payctl refunds retry <refund-id>` failed for EU cards until responders added `--psp adyen`. Everything else in the refund runbook worked as written.",
    ].join("\n"),
    { env, allowedTools: [...READ_TOOLS, TOOL("propose_edit")] },
  );
  check("update-after-incident called propose_edit", update.toolCalls.some((t) => t.name === TOOL("propose_edit")));
  const newEdit = prs().find((p) => !before2.has(p.number) && p.headRefName.startsWith("docsworth/propose/rb-payments-refund-failures"));
  check("…on the refund runbook, as a PR", Boolean(newEdit), newEdit ? `#${newEdit.number}` : update.result.slice(-300));
  report("update-after-incident", update);
  }

  if (only.includes("verify")) {
  // 3. verify-page
  const verify = await runClaude(
    dir,
    "Use the Docsworth verify-page skill on rb-rotate-tls. I'm the page owner on the platform team, and we've already gone through it together: the cert-manager commands, the alert name, the checks and the rollback are all still correct and nothing needs to change. Please verify it now.",
    { env, allowedTools: [...READ_TOOLS, TOOL("verify")] },
  );
  check("verify-page called verify", verify.toolCalls.some((t) => t.name === TOOL("verify")));
  check("…and reported the owner refusal (scratch account is on no @acme team)", /@acme\/platform|platform team|not (a )?member|only members/i.test(verify.result), verify.result.slice(0, 300));
  report("verify-page", verify);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
done();
