import { afterEach, describe, expect, it } from "vitest";
import { computeCoverage } from "../src/core/coverage.js";
import { loadRepo } from "../src/core/repo.js";
import { listStale } from "../src/core/stale.js";
import { ACME, INDEX, makeRepo, NOW, page } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

/*
 * Hand count of examples/acme as of 2026-11-02 (due_soon_days 14), page by page.
 * "reviewable" excludes deprecated pages; overdue = today > last_verified + review_every.
 *
 * devex     index, glossary, onb-backend, onb-on-call(overdue 2026-05-30)        4 pages, 3/4 in SLA
 * payments  svc-payments, svc-ledger(overdue 2026-08-30), refund, webhook, chargeback(draft)
 *                                                                                5 pages, 4/5 in SLA
 * platform  deploy, rollback, tls, scale(overdue 2026-10-30), postgres, hotfix, flush-cdn,
 *           deploy-legacy(deprecated, not reviewable), adr-0001..0003           11 pages, 9/10 in SLA
 * security  pol-secrets, rb-rotate-db-creds                                     2 pages, 2/2 in SLA
 * sre       incident-response, escalation                                       2 pages, 2/2 in SLA
 * total                                                                         24 pages, 20/23 in SLA
 * Every page's CODEOWNERS team matches owner_team: 24/24 owned.
 *
 * This count was done by reading the files, not by running the code; AGENTS.md says
 * the dates and this table move together. It proves the arithmetic only — §4.3's
 * acceptance (within 2% on a design partner's repo) is still open.
 */
const HAND_COUNT = {
  devex: { pages: 4, owned: 4, reviewable: 4, within: 3 },
  payments: { pages: 5, owned: 5, reviewable: 5, within: 4 },
  platform: { pages: 11, owned: 11, reviewable: 10, within: 9 },
  security: { pages: 2, owned: 2, reviewable: 2, within: 2 },
  sre: { pages: 2, owned: 2, reviewable: 2, within: 2 },
  total: { pages: 24, owned: 24, reviewable: 23, within: 20 },
};

describe("coverage: R7 against the hand count", () => {
  const c = computeCoverage(loadRepo(ACME), NOW);
  const rows = Object.fromEntries([...c.teams, c.total].map((r) => [r.team, r]));

  it.each(Object.entries(HAND_COUNT))("%s matches within 2 percentage points", (team, want) => {
    const got = rows[team]!;
    expect(got).toMatchObject({ pages: want.pages, owned: want.owned, reviewable: want.reviewable, within_sla: want.within });
    expect(Math.abs(got.within_sla_pct - (100 * want.within) / want.reviewable)).toBeLessThanOrEqual(2);
    expect(Math.abs(got.owned_pct - (100 * want.owned) / want.pages)).toBeLessThanOrEqual(2);
  });

  it("has no teams beyond the hand count", () => {
    expect(c.teams.map((t) => t.team).sort()).toEqual(["devex", "payments", "platform", "security", "sre"]);
  });
});

describe("coverage: unowned and invalid pages", () => {
  it("counts mismatched owners as unowned and invalid pages as unassigned", () => {
    const repo = makeRepo({
      ...INDEX,
      "knowledge/ok.md": page({ id: "ok" }),
      "knowledge/wrong-team.md": page({ id: "wrong", owner_team: "payments" }),
      "knowledge/broken.md": page({ id: "broken", type: "nope" }),
    });
    cleanups.push(repo.cleanup);
    const c = computeCoverage(repo, NOW);
    expect(c.total).toMatchObject({ pages: 4, owned: 2, within_sla: 3, reviewable: 4 });
    expect(c.teams.find((t) => t.team === "(unassigned)")).toMatchObject({ pages: 1, owned: 0 });
    expect(c.teams.find((t) => t.team === "payments")).toMatchObject({ pages: 1, owned: 0 });
  });
});

describe("stale", () => {
  const repo = loadRepo(ACME);

  it("lists overdue pages oldest-due first, skipping deprecated ones", () => {
    expect(listStale(repo.pages, repo, NOW).map((s) => s.id)).toEqual(["onb-on-call", "svc-ledger", "rb-scale-cluster"]);
  });

  it("filters by owner team", () => {
    expect(listStale(repo.pages, repo, NOW, "platform").map((s) => s.id)).toEqual(["rb-scale-cluster"]);
  });

  it("reports unowned pages", () => {
    const r = makeRepo({ ...INDEX, "knowledge/x.md": page({ id: "x", owner_team: "payments" }) });
    cleanups.push(r.cleanup);
    expect(listStale(r.pages, r, NOW)).toMatchObject([{ id: "x", reason: "unowned" }]);
  });
});
