import { describeOwnershipProblem, resolveTeamOwner } from "./codeowners.js";
import type { Page, Repo } from "./repo.js";
import { computeSla, type Sla, withinSla } from "./sla.js";

export interface PageStatus {
  sla: Sla;
  /** CODEOWNERS resolves to exactly one team of the org, and it equals owner_team. */
  owned: boolean;
  ownership_problem?: string;
  /** May an agent cite this page? canonical + within SLA + owned. Not configurable. */
  citable: boolean;
  /** Why it is not citable, phrased for an agent's answer ("excluded: …"). */
  gate_reason?: string;
}

/**
 * The citation gate. Hard-coded on purpose (spec R11): no config may widen it, because
 * a gate a team can switch off is the "rebuild Confluence with vectors" failure mode.
 */
export function pageStatus(page: Page, repo: Repo, now: Date): PageStatus {
  const sla = computeSla(page.last_verified, page.review_every, now, repo.config.sla.due_soon_days);
  const own = resolveTeamOwner(repo.codeowners, page.path, repo.config.github.org);
  const owned = own.ok && own.team === page.owner_team.toLowerCase();
  const ownership_problem = own.ok
    ? owned
      ? undefined
      : `owner_team is \`${page.owner_team}\` but CODEOWNERS assigns @${repo.config.github.org}/${own.team}`
    : describeOwnershipProblem(own.problem, repo.config.github.org);

  let gate_reason: string | undefined;
  if (page.status !== "canonical") gate_reason = `status is ${page.status}`;
  else if (!withinSla(sla.state))
    gate_reason =
      sla.state === "overdue" ? `past review date (due ${sla.due}), owned by ${page.owner_team}` : "never verified";
  else if (!owned) gate_reason = `ownership unresolved: ${ownership_problem}`;

  return { sla, owned, ownership_problem, citable: gate_reason === undefined, gate_reason };
}
