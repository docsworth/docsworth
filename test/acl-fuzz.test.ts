import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeHTML } from "entities";
import { afterAll, describe, expect, it } from "vitest";
import { canSee, type Identity, redactLinks } from "../src/core/acl.js";
import { GitHubClient } from "../src/core/github.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { loadRepo, type Page } from "../src/core/repo.js";
import { KnowledgeService } from "../src/core/service.js";
import { body, leaks, type Rng, rng } from "./acl-oracle.js";
import { FUZZ_IDENTITIES, NO_PAGES, fuzzRepo } from "./acl-fuzz-fixture.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, NOW } from "./helpers.js";

// The ACL promise, tested on inputs nobody wrote by hand.
//
// 1. Link redaction against CommonMark's reference parser: random pages reference random
//    pages in every form the generator knows (acl-oracle.ts), and no redacted text may
//    still reach a page its reader can't see. A redaction of a text that reaches only
//    visible pages is counted too: that's the cost of failing closed, and it stays rare.
// 2. Every tool, on random repos: random team ACLs, links and `supersedes`, and random
//    identities. No response may hold a hidden page's id, title, path or description,
//    read as a person would (character references, escapes and percent-encoding decoded).

describe("link redaction, fuzzed against commonmark.js", () => {
  const { repo, cleanup } = fuzzRepo();
  afterAll(cleanup);
  const all = [...repo.pages.map((p) => p.path), ...repo.invalid.map((p) => p.path), ...NO_PAGES];

  it.each([1, 2, 3])("seed %i: no redacted text reaches a hidden page", (seed) => {
    const r = rng(seed);
    let reaching = 0;
    let clean = 0;
    let overRedacted = 0;
    const missed: string[] = [];
    // 3,000 texts, about 1,500 of them reaching only visible pages: at the long run's rate
    // (about 2 in 1,000) 750 put the 0.5% bar within sampling noise.
    for (let i = 0; i < 3000; i++) {
      const who = FUZZ_IDENTITIES[Math.floor(r() * FUZZ_IDENTITIES.length)]!;
      const from = repo.pages[Math.floor(r() * repo.pages.length)]!.path;
      const onlyVisible = r() < 0.5;
      const targets = onlyVisible ? repo.pages.filter((p) => canSee(p, who)).map((p) => p.path) : all;
      const text = body(r, from, targets, repo.config.knowledge_root);
      const out = redactLinks(text, from, repo, who);
      if (leaks(text, from, repo, who).length) {
        reaching++;
        const left = leaks(out, from, repo, who);
        if (left.length && missed.length < 3) missed.push(`${from} as [${[...who.teams]}]:\n${text}\n→ ${left.join("; ")}`);
      } else if (onlyVisible) {
        clean++;
        if (out !== text) overRedacted++;
      }
    }
    expect(missed.join("\n---\n")).toBe("");
    expect(reaching, "the run reached hidden pages").toBeGreaterThan(150);
    expect(overRedacted / clean, `${overRedacted} of ${clean} texts reaching only visible pages were redacted`).toBeLessThan(0.005);
  });
});

/** A random repo: the acme example plus pages with random audiences, links and supersedes. */
function randomRepo(r: Rng) {
  const acme = acmeOnGitHub();
  const base = loadRepo(acme.root);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const dirs = ["knowledge", "knowledge/runbooks", "knowledge/security", "knowledge/services/ledger", "knowledge/fz"];
  const teams = ["internal", "internal", "platform", "payments", "security", "sre"];
  const extra = Array.from({ length: 12 }, (_, n) => ({
    path: `${pick(dirs)}/fz-${n}-${pick(["kestrel", "otter", "lynx"])}.md`,
    id: `fz-${n}x`,
    title: `Fuzz page ${n} ${pick(["kestrel", "otter", "lynx"])}`,
    description: `Fuzz description ${n} of a page`,
    acl: pick(teams),
  }));
  const ids = [...base.pages.map((p) => p.id), ...extra.map((p) => p.id)];
  const paths = [...base.pages.map((p) => p.path), ...base.invalid.map((p) => p.path), ...extra.map((p) => p.path)];
  for (const p of extra) {
    const verified = pick(["2026-10-20", "2026-01-05"]); // fresh, or past its SLA
    const supersedes = Array.from({ length: Math.floor(r() * 3) }, () => pick(ids));
    const abs = join(acme.root, p.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      `---\ntitle: ${p.title}\nid: ${p.id}\ntype: ${pick(["runbook", "guide"])}\nstatus: ${pick(["canonical", "canonical", "draft"])}\nowner_team: ${pick(teams.slice(2))}\nlast_verified: ${verified}\nreview_every: 90d\nacl: ${p.acl}\ndescription: ${p.description}\n${supersedes.length ? `supersedes: [${supersedes.join(", ")}]\n` : ""}---\n# ${p.title}\n\n${body(r, p.path, paths, "knowledge", 2 + Math.floor(r() * 4))}\n`,
    );
  }
  return acme;
}

const traces = (p: Page) => [p.id, p.title, p.path, p.path.slice("knowledge/".length), p.description].filter((s): s is string => Boolean(s));

/** Every string in a response, read as a person would. */
function readable(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    const text = decodeHTML(value).replace(/\\([!-/:-@[-`{-~])/g, "$1");
    out.push(text, text.replace(/(?:%[0-9a-f]{2})+/gi, (s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    }));
  } else if (value && typeof value === "object") for (const v of Object.values(value)) readable(v, out);
  return out;
}

async function settle(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    return { error: `${(err as { code?: string }).code ?? "?"}: ${(err as Error).message}` };
  }
}

describe("every tool, on random repos", () => {
  it.each([11, 12])("seed %i: no response holds a hidden page's id, title, path or description", async (seed) => {
    const r = rng(seed);
    const acme = randomRepo(r);
    try {
      const repo = loadRepo(acme.root);
      expect(repo.pages.filter((p) => p.id.startsWith("fz-")).length).toBe(12);
      const gh = new FakeGitHub("acme/knowledge", "acme", { tok: { login: "u", teams: [], push: true } }, acme.root);
      const identities: Identity[] = [LOCAL_IDENTITY, ...FUZZ_IDENTITIES.slice(1), { mode: "github", login: "sre", teams: new Set(["sre", "security"]), repoAccess: true, canWrite: true }];
      let hiddenSeen = 0;
      for (const who of identities) {
        const s = new KnowledgeService(acme.root, { get: async () => who, fresh: async () => who, github: who.mode === "github" ? new GitHubClient("tok", { fetch: gh.fetch }) : null }, () => NOW);
        const hidden = repo.pages.filter((p) => !canSee(p, who));
        const visible = repo.pages.filter((p) => canSee(p, who));
        hiddenSeen += hidden.length;
        const check = (what: string, response: unknown) => {
          const strings = readable(response);
          for (const p of hidden)
            for (const t of traces(p))
              if (strings.some((x) => x.includes(t))) throw new Error(`${what} as [${[...who.teams]}] holds \`${t}\` of hidden page ${p.id}`);
        };
        check("stale()", await s.stale());
        for (const path of ["", "runbooks", "security", "services", "services/ledger", "fz"]) check(`list(${path})`, await settle(() => s.list({ path })));
        for (const type of ["runbook", "guide", "adr", "service", "policy"] as const) check(`list(${type})`, await s.list({ type }));
        for (const p of visible) check(`read(${p.id})`, await s.read({ id: p.id }));
        for (const p of hidden) {
          for (const query of [p.title, p.id, p.description ?? p.title, "kestrel otter lynx fuzz page"]) {
            check(`search(${query})`, await s.search({ query }));
            check(`search(${query}, include_stale)`, await s.search({ query, include_stale: true }));
          }
          const unknown = (await settle(() => s.read({ id: "zz-unknown" }))) as { error: string };
          const read = (await settle(() => s.read({ id: p.id }))) as { error: string };
          expect(read.error.replace(p.id, "X")).toBe(unknown.error.replace("zz-unknown", "X"));
        }
      }
      expect(hiddenSeen, "the identities had pages hidden from them").toBeGreaterThan(20);
      expect(gh.violations).toEqual([]);
    } finally {
      acme.cleanup();
    }
  });
});
