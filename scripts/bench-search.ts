// R15: search p95 under 500 ms on 5,000 pages, measured end to end through
// KnowledgeService.search (ACL filter + BM25 + gate + redaction), on pages loaded from
// disk by the real loader. Exits 1 if the budget is missed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { KnowledgeService } from "../src/core/service.js";

const PAGES = Number(process.env.PAGES ?? 5000);
const QUERIES = 300;
const BUDGET_MS = 500;

const vocab =
  "deploy rollback canary kubernetes postgres ledger refund webhook incident escalation certificate rotation backup restore latency error budget alert queue consumer replica shard migration schema index cache cdn dns load balancer ingress secret vault token oncall pager postmortem runbook service owner team review release hotfix feature flag kill switch quota throttle retry idempotency timeout".split(
    " ",
  );
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const words = (n: number) => Array.from({ length: n }, () => vocab[Math.floor(rand() * vocab.length)]).join(" ");

const root = mkdtempSync(join(tmpdir(), "docsworth-bench-"));
try {
  mkdirSync(join(root, ".knowledge"), { recursive: true });
  writeFileSync(join(root, ".knowledge/config.yaml"), "format: 1\ngithub:\n  org: acme\n");
  writeFileSync(join(root, "CODEOWNERS"), "/knowledge/ @acme/platform\n");
  const teams = ["platform", "payments", "sre", "security"];
  for (let i = 0; i < PAGES; i++) {
    const dir = join(root, "knowledge", `area-${i % 50}`);
    mkdirSync(dir, { recursive: true });
    const acl = i % 10 === 0 ? teams[i % 4] : "internal";
    const verified = i % 7 === 0 ? "2025-01-01" : "2026-10-01";
    writeFileSync(
      join(dir, `page-${i}.md`),
      `---\ntitle: ${words(5)}\nid: page-${i}\ntype: runbook\nstatus: ${i % 13 === 0 ? "draft" : "canonical"}\nowner_team: platform\nlast_verified: ${verified}\nreview_every: 90d\nacl: ${acl}\n---\n# ${words(4)}\n\n${words(220)}\n\n## Steps\n${words(120)}\n`,
    );
  }

  const t0 = performance.now();
  const svc = new KnowledgeService(root, { get: async () => LOCAL_IDENTITY, fresh: async () => LOCAL_IDENTITY, github: null }, () => new Date("2026-11-02"));
  const loadMs = performance.now() - t0;

  const times: number[] = [];
  for (let q = 0; q < QUERIES; q++) {
    const query = words(2 + (q % 4));
    const start = performance.now();
    await svc.search({ query, limit: 10 });
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p = (x: number) => times[Math.min(times.length - 1, Math.floor(x * times.length))]!;
  const p95 = p(0.95);
  console.log(
    `${PAGES} pages (load + index ${loadMs.toFixed(0)} ms), ${QUERIES} queries: p50 ${p(0.5).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${times.at(-1)!.toFixed(1)} ms; budget p95 < ${BUDGET_MS} ms → ${p95 < BUDGET_MS ? "PASS" : "FAIL"}`,
  );
  process.exitCode = p95 < BUDGET_MS ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
