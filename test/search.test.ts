import { afterAll, describe, expect, it } from "vitest";
import type { Identity } from "../src/core/acl.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { KnowledgeService } from "../src/core/service.js";
import { copyAcme, fixedIdentity, INDEX, makeRepo, NOW, page } from "./helpers.js";

// A copy, because acme has usage_log on and reads append to .knowledge/usage.jsonl.
const acme = copyAcme();
afterAll(acme.cleanup);
const service = (who: Identity = LOCAL_IDENTITY) => new KnowledgeService(acme.root, fixedIdentity(who), () => NOW);

describe("search: R11 citation gate", () => {
  it("returns canonical in-SLA pages and lists deprecated matches as excluded", async () => {
    const r = await service().search({ query: "deploy to production Jenkins" });
    expect(r.results.map((x) => x.id)).toContain("rb-deploy-prod");
    expect(r.results.map((x) => x.id)).not.toContain("rb-deploy-legacy");
    expect(r.excluded).toContainEqual({ id: "rb-deploy-legacy", title: "Deploy with Jenkins (legacy)", owner_team: "platform", reason: "status is deprecated" });
    expect(r.note).toMatch(/not citable/);
  });

  it("excludes overdue pages with the due date and owner", async () => {
    const r = await service().search({ query: "scale kubernetes cluster nodes" });
    expect(r.results.map((x) => x.id)).not.toContain("rb-scale-cluster");
    expect(r.excluded.find((e) => e.id === "rb-scale-cluster")?.reason).toBe("past review date (due 2026-10-30), owned by platform");
  });

  it("excludes drafts", async () => {
    const r = await service().search({ query: "chargeback dispute evidence" });
    expect(r.results.map((x) => x.id)).not.toContain("rb-payments-chargeback");
    expect(r.excluded.map((e) => e.id)).toContain("rb-payments-chargeback");
  });

  it("with include_stale returns gated pages inline, labeled", async () => {
    const r = await service().search({ query: "scale kubernetes cluster nodes", include_stale: true });
    const hit = r.results.find((x) => x.id === "rb-scale-cluster");
    expect(hit).toMatchObject({ citable: false, sla_state: "overdue", gate: "past review date (due 2026-10-30), owned by platform" });
    expect(r.excluded).toEqual([]);
  });

  it("marks due_soon pages citable", async () => {
    const r = await service().search({ query: "TLS certificate reissue" });
    expect(r.results[0]).toMatchObject({ id: "rb-rotate-tls", sla_state: "due_soon", citable: true });
  });

  it("applies type, owner_team and applies_to filters", async () => {
    const s = service();
    expect((await s.search({ query: "deploy", type: "adr" })).results.every((x) => x.type === "adr")).toBe(true);
    expect((await s.search({ query: "refund", owner_team: "platform" })).results.every((x) => x.owner_team === "platform")).toBe(true);
    const svc = await s.search({ query: "deploy", applies_to: "service:payments" });
    expect(svc.results.map((x) => x.id)).toContain("rb-deploy-prod");
    expect(svc.results.map((x) => x.id)).not.toContain("rb-rollback-deploy");
  });

  it("rejects an empty query", async () => {
    await expect(service().search({ query: "  " })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("search and read: link redaction", () => {
  it("hides team-only pages' titles inside visible pages", async () => {
    const page = await service().read({ id: "index" });
    expect(page.content).not.toMatch(/rotate-db-credentials|Rotate database credentials|Secrets handling policy|security\/index/);
    expect(page.content).toMatch(/\[restricted page\]/);
    // ...while the team itself still sees the real links.
    const sec = await service({ ...LOCAL_IDENTITY, teams: new Set(["security"]) }).read({ id: "index" });
    expect(sec.content).toMatch(/\[Rotate database credentials\]\(security\/rotate-db-credentials\.md\)/);
  });

  it("redacts hidden-page links inside search snippets", async () => {
    const repo = makeRepo({
      ...INDEX,
      "knowledge/ops.md": page({ id: "ops", title: "Ops notes" }, "On-call ops notes: see [HSM key ceremony](hsm.md) first.\n"),
      "knowledge/hsm.md": page({ id: "hsm", title: "HSM key ceremony", acl: "security" }),
    });
    try {
      const r = await new KnowledgeService(repo.root, fixedIdentity(LOCAL_IDENTITY), () => NOW).search({ query: "on-call ops notes" });
      expect(r.results.find((x) => x.id === "ops")?.snippet).toBe("On-call ops notes: see [restricted page] first.");
    } finally {
      repo.cleanup();
    }
  });

  it("does not rank a public page on words that only appear in a hidden page's link", async () => {
    // "credentials" occurs in visible pages only inside links to security-only pages;
    // a hit here would tell the caller the index links to something about credentials.
    const r = await service().search({ query: "credentials", include_stale: true });
    expect(r.results).toEqual([]);
    expect(r.excluded).toEqual([]);
  });

  it("cannot surface a team page's title through public link text", async () => {
    const r = await service().search({ query: "rotate database credentials vault", include_stale: true });
    expect(JSON.stringify(r)).not.toMatch(/rotate-db-cred|Rotate database credentials|pol-secrets/i);
  });
});

describe("read", () => {
  it("flags a page past its SLA but still returns it", async () => {
    const page = await service().read({ id: "rb-scale-cluster" });
    expect(page).toMatchObject({ citable: false, flags: ["past_sla"], gate_reason: "past review date (due 2026-10-30), owned by platform" });
    expect(page.content).toMatch(/cluster autoscaler/);
  });

  it("returns metadata and content as separate fields", async () => {
    const page = await service().read({ id: "rb-deploy-prod" });
    expect(page).toMatchObject({ id: "rb-deploy-prod", owner_team: "platform", due: "2027-01-13", sla_state: "fresh", flags: [], supersedes: ["rb-deploy-legacy"] });
    expect(page.content.startsWith("# Deploy to production")).toBe(true);
  });

  it("gives identical errors for unknown and hidden ids", async () => {
    const unknown = await service().read({ id: "no-such-page" }).catch((e: Error) => e.message);
    const hidden = await service().read({ id: "rb-rotate-db-creds" }).catch((e: Error) => e.message);
    expect(unknown).toBe("no page with id `no-such-page`");
    expect(hidden).toBe("no page with id `rb-rotate-db-creds`");
  });
});

describe("list", () => {
  it("starts at the root map and only reveals directories with visible pages", async () => {
    const root = await service().list();
    expect(root.index?.id).toBe("index");
    expect(root.dirs).toEqual(["decisions", "onboarding", "runbooks", "services"]);
    const sec = await service({ ...LOCAL_IDENTITY, teams: new Set(["security"]) }).list();
    expect(sec.dirs).toContain("security");
  });

  it("walks down into nested directories", async () => {
    const s = service();
    const services = await s.list({ path: "services" });
    expect(services.dirs).toEqual(["services/payments"]); // ledger is acl: payments
    const payments = await s.list({ path: "services/payments" });
    expect(payments.index?.id).toBe("svc-payments");
  });

  it("lists by type", async () => {
    const r = await service().list({ type: "adr" });
    expect(r.pages?.map((p) => p.id)).toEqual(["adr-0001", "adr-0002", "adr-0003"]);
  });

  it("refuses paths outside the knowledge root and unknown/hidden directories", async () => {
    await expect(service().list({ path: "../.." })).rejects.toMatchObject({ code: "invalid" });
    await expect(service().list({ path: "security" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("stale", () => {
  it("returns overdue pages filtered by owner team and ACL", async () => {
    expect((await service().stale()).pages.map((p) => p.id)).toEqual(["onb-on-call", "rb-scale-cluster"]);
    const payments = await service({ ...LOCAL_IDENTITY, teams: new Set(["payments"]) }).stale({ owner_team: "payments" });
    expect(payments.pages.map((p) => p.id)).toEqual(["svc-ledger"]);
  });
});
