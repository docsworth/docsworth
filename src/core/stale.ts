import { pageStatus } from "./gate.js";
import type { Page, Repo } from "./repo.js";
import type { SlaState } from "./sla.js";

export interface StaleEntry {
  id: string;
  title: string;
  path: string;
  owner_team: string;
  status: Page["status"];
  reason: "overdue" | "unverified" | "unowned";
  due: string | null;
  detail: string;
}

const daysAgo = (n: number) => `${n} ${n === 1 ? "day" : "days"} ago`;

/**
 * Pages past their SLA or without a resolvable team owner (§4.2 `stale`). Deprecated
 * pages are retired and never reported. Callers pass an ACL-filtered page list.
 */
export function listStale(pages: Page[], repo: Repo, now: Date, ownerTeam?: string): StaleEntry[] {
  const out: StaleEntry[] = [];
  for (const page of pages) {
    if (page.status === "deprecated") continue;
    if (ownerTeam && page.owner_team !== ownerTeam) continue;
    const s = pageStatus(page, repo, now);
    const base = { id: page.id, title: page.title, path: page.path, owner_team: page.owner_team, status: page.status, due: s.sla.due };
    if (!s.owned) out.push({ ...base, reason: "unowned", detail: s.ownership_problem ?? "unowned" });
    else if (s.sla.state === "overdue")
      out.push({ ...base, reason: "overdue", detail: `due ${s.sla.due}, ${daysAgo(-(s.sla.days_until_due ?? 0))}` });
    else if (s.sla.state === "unverified") out.push({ ...base, reason: "unverified", detail: "no valid last_verified" });
  }
  return out.sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
}

export interface DraftEntry {
  id: string;
  title: string;
  path: string;
  owner_team: string;
  /** When the content last changed: a draft's `last_verified`, which adopt takes from history. */
  changed: string;
  sla_state: SlaState;
}

/**
 * The verify queue (`docsworth drafts`): every draft, newest content first, then by path.
 * Only loaded pages: a draft whose frontmatter is invalid is a lint error, not an entry.
 * Callers pass an ACL-filtered page list.
 */
export function listDrafts(pages: Page[], repo: Repo, now: Date, ownerTeam?: string): DraftEntry[] {
  return pages
    .filter((p) => p.status === "draft" && (!ownerTeam || p.owner_team === ownerTeam))
    .map((p) => ({ id: p.id, title: p.title, path: p.path, owner_team: p.owner_team, changed: p.last_verified, sla_state: pageStatus(p, repo, now).sla.state }))
    .sort((a, b) => b.changed.localeCompare(a.changed) || a.path.localeCompare(b.path));
}
