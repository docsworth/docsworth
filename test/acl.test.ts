import { afterAll, describe, expect, it } from "vitest";
import { canSee, type Identity } from "../src/core/acl.js";
import { loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { loadRepo } from "../src/core/repo.js";
import { KnowledgeService } from "../src/core/service.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, NOW } from "./helpers.js";

// R12: the full matrix — every tool × every page × every identity. For each page an
// identity may not see, no serialized response (results, excluded, stale, list,
// content, snippets, error messages) may contain its id, title, path or description.

const acme = acmeOnGitHub();
afterAll(acme.cleanup);
const repo = loadRepo(acme.root);
const gh = new FakeGitHub("acme/knowledge", "acme", { tok: { login: "u", teams: [], push: true } }, acme.root);

const gitHubUser = (login: string, teams: string[]): Identity => ({ mode: "github", login, teams: new Set(teams), repoAccess: true, canWrite: true });
const IDENTITIES: [string, Identity][] = [
  ["local (internal only)", LOCAL_IDENTITY],
  ["no teams", gitHubUser("nina", [])],
  ["platform", gitHubUser("pat", ["platform"])],
  ["payments", gitHubUser("pia", ["payments"])],
  ["security", gitHubUser("sam", ["security"])],
  ["no repo access", { mode: "github", login: "eve", teams: new Set(["security", "payments", "platform"]), repoAccess: false, canWrite: true }],
];

function service(who: Identity) {
  const github = who.mode === "github" ? new GitHubClient("tok", { fetch: gh.fetch }) : null;
  return new KnowledgeService(acme.root, { get: async () => who, fresh: async () => who, github }, () => NOW);
}

const traces = (p: (typeof repo.pages)[number]) =>
  [p.id, p.title, p.path, p.path.slice("knowledge/".length), p.description].filter((s): s is string => Boolean(s));

function assertNoTrace(output: unknown, hidden: typeof repo.pages, context: string) {
  const text = JSON.stringify(output);
  for (const p of hidden)
    for (const t of traces(p)) if (text.includes(t)) throw new Error(`${context} leaked \`${t}\` of hidden page ${p.id}`);
}

async function settle(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    // Code and message both: the MCP response carries the code, so it must not differ either.
    return { error: `${(err as { code?: string }).code ?? "?"}: ${(err as Error).message}` };
  }
}

describe("ACL matrix", () => {
  expect(loadConfig(acme.root).github.repo).toBe("acme/knowledge");

  it.each(IDENTITIES)("%s: no tool leaks a page it cannot see", async (_name, who) => {
    const s = service(who);
    const hidden = repo.pages.filter((p) => !canSee(p, who));
    const visible = repo.pages.filter((p) => canSee(p, who));
    if (who.repoAccess) expect(visible.length).toBeGreaterThan(0);
    else expect(visible).toEqual([]);

    // Whole-repo views.
    assertNoTrace(await s.stale(), hidden, "stale()");
    assertNoTrace(await settle(() => s.list()), hidden, "list()");
    for (const type of ["runbook", "adr", "service", "guide", "policy"] as const) assertNoTrace(await s.list({ type }), hidden, `list(${type})`);
    for (const dir of ["runbooks", "services", "services/payments", "decisions", "onboarding"]) assertNoTrace(await settle(() => s.list({ path: dir })), hidden, `list(${dir})`);

    // Every visible page's content.
    for (const p of visible) assertNoTrace(await s.read({ id: p.id }), hidden, `read(${p.id})`);

    // Targeted probes at each hidden page, with and without include_stale.
    for (const p of hidden) {
      for (const query of [p.title, p.id, p.description ?? p.title, `${p.title} ${p.applies_to?.join(" ") ?? ""}`]) {
        assertNoTrace(await s.search({ query }), [p], `search(${query})`);
        assertNoTrace(await s.search({ query, include_stale: true }), [p], `search(${query}, include_stale)`);
      }
      const unknownRead = (await settle(() => s.read({ id: "zz-unknown" }))) as { error: string };
      const hiddenRead = (await settle(() => s.read({ id: p.id }))) as { error: string };
      expect(hiddenRead.error.replace(p.id, "X")).toBe(unknownRead.error.replace("zz-unknown", "X"));
      for (const [tool, call] of [
        ["propose_edit", (id: string) => s.proposeEdit({ id, content: "x", reason: "r" })],
        ["verify", (id: string) => s.verify({ id })],
      ] as const) {
        const a = (await settle(() => call(p.id))) as { error: string };
        const b = (await settle(() => call("zz-unknown"))) as { error: string };
        expect(a.error.replace(p.id, "X"), `${tool}(${p.id})`).toBe(b.error.replace("zz-unknown", "X"));
      }
    }
  });

  it("the matrix is not vacuous: each team identity sees a page others cannot", () => {
    const seen = (teams: string[]) => repo.pages.filter((p) => canSee(p, gitHubUser("x", teams))).map((p) => p.id);
    expect(seen(["security"])).toContain("rb-rotate-db-creds");
    expect(seen(["payments"])).toContain("svc-ledger");
    expect(seen([])).not.toContain("rb-rotate-db-creds");
    expect(seen([])).not.toContain("svc-ledger");
    expect(gh.violations).toEqual([]);
  });
});
