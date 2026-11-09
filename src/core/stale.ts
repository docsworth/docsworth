import { pageStatus } from "./gate.js";
import type { Page, Repo } from "./repo.js";

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
      out.push({ ...base, reason: "overdue", detail: `due ${s.sla.due}, ${-(s.sla.days_until_due ?? 0)} days ago` });
    else if (s.sla.state === "unverified") out.push({ ...base, reason: "unverified", detail: "no valid last_verified" });
  }
  return out.sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
}
