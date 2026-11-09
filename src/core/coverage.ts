import { pageStatus } from "./gate.js";
import type { Page, Repo } from "./repo.js";
import { withinSla } from "./sla.js";

export interface CoverageRow {
  team: string;
  pages: number;
  owned: number;
  owned_pct: number;
  /** Pages subject to review: everything except deprecated pages. */
  reviewable: number;
  within_sla: number;
  within_sla_pct: number;
}

export interface Coverage {
  as_of: string;
  total: CoverageRow;
  teams: CoverageRow[];
}

/** Team bucket for pages whose frontmatter is too broken to name an owner. */
export const UNASSIGNED = "(unassigned)";

const pct = (n: number, d: number) => (d === 0 ? 100 : Math.round((n / d) * 1000) / 10);

function row(team: string, items: { owned: boolean; reviewable: boolean; within: boolean }[]): CoverageRow {
  const owned = items.filter((i) => i.owned).length;
  const reviewable = items.filter((i) => i.reviewable).length;
  const within = items.filter((i) => i.reviewable && i.within).length;
  return {
    team,
    pages: items.length,
    owned,
    owned_pct: pct(owned, items.length),
    reviewable,
    within_sla: within,
    within_sla_pct: pct(within, reviewable),
  };
}

/**
 * Ownership coverage (§4.3): % of pages team-owned and % verified within SLA, per team.
 * Invalid pages count as neither owned nor verified, so a broken page lowers coverage
 * instead of disappearing from it.
 */
export function computeCoverage(repo: Repo, now: Date): Coverage {
  const byTeam = new Map<string, { owned: boolean; reviewable: boolean; within: boolean }[]>();
  const add = (team: string, item: { owned: boolean; reviewable: boolean; within: boolean }) =>
    byTeam.set(team, [...(byTeam.get(team) ?? []), item]);

  for (const page of repo.pages as Page[]) {
    const s = pageStatus(page, repo, now);
    add(page.owner_team, { owned: s.owned, reviewable: page.status !== "deprecated", within: withinSla(s.sla.state) });
  }
  for (const _ of repo.invalid) add(UNASSIGNED, { owned: false, reviewable: true, within: false });

  const teams = [...byTeam.entries()].map(([team, items]) => row(team, items)).sort((a, b) => a.team.localeCompare(b.team));
  return { as_of: now.toISOString().slice(0, 10), total: row("total", [...byTeam.values()].flat()), teams };
}

export function formatCoverage(c: Coverage): string {
  const header = "team            pages  owned          within SLA";
  const fmt = (r: CoverageRow) =>
    `${r.team.padEnd(15)} ${String(r.pages).padStart(5)}  ${`${r.owned}/${r.pages}`.padStart(6)} ${`${r.owned_pct}%`.padStart(6)}  ${`${r.within_sla}/${r.reviewable}`.padStart(6)} ${`${r.within_sla_pct}%`.padStart(6)}`;
  return [`Ownership coverage as of ${c.as_of}`, header, ...c.teams.map(fmt), fmt(c.total)].join("\n");
}
