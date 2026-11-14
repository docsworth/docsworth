import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuditEvent, AuditLog, type AuditSink } from "../src/core/audit-log.js";
import { loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityProvider, LOCAL_IDENTITY } from "../src/core/identity.js";
import { lintRepo } from "../src/core/lint.js";
import { loadRepo } from "../src/core/repo.js";
import { startServer } from "../src/core/serve/server.js";
import { KnowledgeService, type ToolError } from "../src/core/service.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, fixedIdentity, INDEX, makeRepo, NOW, page } from "./helpers.js";

// ui_overview's list_limit: a big repo's overview lists the first stale and due-soon pages
// and says how many there are. Only the pages it returns are named, so only those taint the
// session (docs/security-model.md, "Each view asks only for what it shows").

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const local = (root: string) => new KnowledgeService(root, fixedIdentity(LOCAL_IDENTITY), () => NOW);

describe("ui_overview with list_limit", () => {
  // 30 overdue pages (due 2026-07-02 + i days) and 12 due soon (due 2026-11-03 + i days).
  const big = () => {
    const files: Record<string, string> = { ...INDEX };
    for (let i = 0; i < 30; i++) files[`knowledge/old-${i}.md`] = page({ id: `old-${i}`, title: `Old ${i}`, last_verified: new Date(Date.UTC(2026, 3, 3 + i)).toISOString().slice(0, 10) });
    for (let i = 0; i < 12; i++) files[`knowledge/soon-${i}.md`] = page({ id: `soon-${i}`, title: `Soon ${i}`, last_verified: new Date(Date.UTC(2026, 7, 5 + i)).toISOString().slice(0, 10) });
    const r = makeRepo(files);
    cleanups.push(r.cleanup);
    return r.root;
  };

  it("returns the first of each list, the most pressing first, with how many there are", async () => {
    const root = big();
    const all = await local(root).uiOverview();
    expect(all.stale).toHaveLength(30);
    expect(all.due_soon).toHaveLength(12);
    const o = await local(root).uiOverview({ list_limit: 5 });
    expect(o.stale.map((s) => s.id)).toEqual(all.stale.slice(0, 5).map((s) => s.id));
    expect(o.stale[0]!.id).toBe("old-0"); // due longest ago
    expect(o.due_soon.map((s) => s.id)).toEqual(all.due_soon.slice(0, 5).map((s) => s.id));
    expect(o.due_soon[0]!.id).toBe("soon-0"); // due soonest
    expect(o.stale_total).toBe(30);
    expect(o.due_soon_total).toBe(12);
    // The counts above the lists don't change with the limit.
    expect(o.totals).toEqual(all.totals);
    expect(o.teams).toEqual(all.teams);
    expect(all.stale_total).toBe(30);
  });

  describe("taint", () => {
    let acme: ReturnType<typeof acmeOnGitHub>;
    let gh: FakeGitHub;
    beforeEach(() => {
      acme = acmeOnGitHub();
      gh = new FakeGitHub("acme/knowledge", "acme", { sam: { login: "sam", teams: ["security"], push: true } }, acme.root);
      // The security policy, overdue by one day: last in the stale list, after the internal pages.
      const p = join(acme.root, "knowledge/security/index.md");
      writeFileSync(p, readFileSync(p, "utf8").replace("last_verified: 2026-10-01\nreview_every: 1y", "last_verified: 2026-08-03\nreview_every: 90d"));
    });
    afterEach(() => {
      acme.cleanup();
      expect(gh.violations).toEqual([]);
    });
    const sam = () => new KnowledgeService(acme.root, new IdentityProvider(loadConfig(acme.root), new GitHubClient("sam", { fetch: gh.fetch })), () => NOW);
    const DRAFT = { type: "runbook", title: "Drain a Kafka partition", owner_team: "platform", body: "# Drain a Kafka partition\n\n## Steps\n\n1. Pause the consumer.\n", reason: "From the INC-412 thread." } as const;
    const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as ToolError);

    it("is only the pages returned: one left out by the limit doesn't count as read", async () => {
      const full = await sam().uiOverview();
      const at = full.stale.findIndex((s) => s.id === "pol-secrets");
      expect(at).toBe(full.stale.length - 1);
      expect(at).toBeGreaterThan(0);
      const limited = sam();
      expect((await limited.uiOverview({ list_limit: at })).stale.map((s) => s.id)).not.toContain("pol-secrets");
      expect(await rejection(limited.draftPage(DRAFT))).toBeUndefined();
      const whole = sam();
      await whole.uiOverview({ list_limit: at + 1 });
      expect(await rejection(whole.draftPage(DRAFT))).toMatchObject({
        code: "forbidden",
        message: "this session read pages restricted to @acme/security; draft_page can only create pages with the same audience (this one would be `internal`)",
      });
    });
  });

  it("is audited with the limit asked for and the pages returned", async () => {
    const root = big();
    const events: AuditEvent[] = [];
    const sink: AuditSink = { name: "memory", required: true, write: async (e) => void events.push(e) };
    const audit = new AuditLog([sink], { session: "s", server: { version: "test", repo: null, commit: null } }, () => NOW, () => {});
    const token = "t".repeat(43);
    const s = await startServer({ root, identity: fixedIdentity(LOCAL_IDENTITY), who: LOCAL_IDENTITY, audit, includeQueries: false, now: () => NOW, port: 0, token, extensions: new Set(), webRoot: null, log: () => {} });
    try {
      const c = new Client({ name: "docsworth-web", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const r = (await c.callTool({ name: "ui_overview", arguments: { list_limit: 3 } })).structuredContent as { due_soon: { id: string }[]; stale: { id: string }[] };
      const ids = [...r.due_soon, ...r.stale].map((x) => x.id);
      expect(ids).toHaveLength(6);
      expect(events.find((e) => e.kind === "tool_call" && e.tool === "ui_overview")).toMatchObject({ outcome: "ok", args: { list_limit: 3 }, returned: ids });
      expect((await c.callTool({ name: "ui_overview", arguments: { list_limit: 0 } })).isError).toBe(true);
      await c.close();
    } finally {
      await s.close();
    }
  });

  it("counts the files it couldn't read as pages, naming none of them (the owner's call, 2026-11-12)", async () => {
    const r = makeRepo({
      ...INDEX,
      "knowledge/fine.md": page({ id: "fine", title: "Fine" }),
      // Broken frontmatter, on a page meant for one team only: counted all the same.
      "knowledge/broken-secret.md": "---\ntitle: [Payroll keys unclosed\nid: payroll-keys\nacl: security\n---\nThe payroll signing key.\n",
      "knowledge/no-frontmatter.md": "Just notes, no frontmatter.\n",
      // A dot-directory (an editor's, say) is skipped by the loader and by lint alike.
      "knowledge/.obsidian/workspace.md": "editor state\n",
    });
    cleanups.push(r.cleanup);
    const o = await local(r.root).uiOverview();
    expect(o.skipped_files).toBe(2);
    const text = JSON.stringify(o);
    for (const trace of ["broken-secret", "no-frontmatter", "payroll-keys", "Payroll", "signing key", "Just notes"]) expect(text).not.toContain(trace);
    expect(o.totals.pages).toBe(2); // index and fine
    // The note sends people to lint: it lists exactly these files, and no others.
    const repo = loadRepo(r.root);
    const lintErrors = lintRepo(repo, NOW).diagnostics.filter((d) => d.severity === "error" && d.rule === "frontmatter").map((d) => d.path);
    expect(new Set(lintErrors)).toEqual(new Set(["knowledge/broken-secret.md", "knowledge/no-frontmatter.md"]));
    const clean = makeRepo({ ...INDEX });
    cleanups.push(clean.cleanup);
    expect((await local(clean.root).uiOverview()).skipped_files).toBe(0);
  });
});

