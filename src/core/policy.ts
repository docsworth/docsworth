import type { Identity } from "./acl.js";
import type { Config } from "./config.js";
import { toolSpec } from "./tool-registry.js";

// The org policy (`policy:` in .knowledge/config.yaml). Roles are derived, not stored:
//   reader       has access to the knowledge repo
//   contributor  has push access, and the policy allows propose_edit for one of their teams
//   owner        is on a page's owner team, so may verify it
//   admin        is on `policy.admins`, the team CODEOWNERS makes approve config changes
// On a laptop (stdio) the policy steers agents; a user who edits their own clone can
// change it. GitHub still enforces every write. Central enforcement is the remote server.

export type Policy = Config["policy"];

/**
 * Why `who` may not call `tool` under `policy`, or null when they may. A tool answers to
 * its registry entry's `policy` name (tool-registry.ts); a name that is no tool is refused.
 */
export function toolRefusal(policy: Policy, org: string, tool: string, who: Identity): string | null {
  const spec = toolSpec(tool);
  if (!spec) return `no tool called \`${tool}\``;
  if (spec.write && policy.writes === "disabled") return "writes are disabled by policy (policy.writes in .knowledge/config.yaml)";
  const rule = policy.tools[spec.policy];
  if (!rule) return null;
  if (rule.teams.some((t) => who.teams.has(t))) return null;
  const what = spec.policy === tool ? `\`${tool}\`` : `\`${spec.policy}\` (which \`${tool}\` answers to)`;
  return rule.teams.length ? `policy allows ${what} only for ${rule.teams.map((t) => `@${org}/${t}`).join(", ")}` : `policy disables ${what} for everyone`;
}

/** A short, content-free summary for the audit log's server_start event. */
export function policySummary(policy: Policy): Record<string, unknown> {
  return {
    admins: policy.admins ?? null,
    writes: policy.writes,
    restricted_tools: Object.keys(policy.tools).sort(),
    require_human_approval: policy.require_human_approval,
    include_stale: policy.include_stale,
    identity_cache_seconds: policy.identity_cache_seconds,
  };
}
