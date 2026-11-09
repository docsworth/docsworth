#!/usr/bin/env node
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { actorOf, createAuditLog, type AuditLog, stateDir } from "./core/audit-log.js";
import { type Config, CONFIG_PATH, ConfigError, loadConfig } from "./core/config.js";
import { computeCoverage, formatCoverage } from "./core/coverage.js";
import { parseDate } from "./core/duration.js";
import { IdentityProvider } from "./core/identity.js";
import { githubRemote, initRepo } from "./core/init.js";
import { formatDiagnostics, lintRepo } from "./core/lint.js";
import { auditTransport } from "./core/mcp/audit-transport.js";
import { createMcpServer } from "./core/mcp/server.js";
import { policySummary } from "./core/policy.js";
import { loadRepo } from "./core/repo.js";
import { EXTENSION_ID } from "./core/serve/auth.js";
import { DEFAULT_PORT, startServer } from "./core/serve/server.js";
import { loadToken } from "./core/serve/token.js";
import { KnowledgeService } from "./core/service.js";
import { listStale } from "./core/stale.js";
import { PACKAGE_VERSION } from "./core/version.js";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
// Pro loads lazily through `pro()` below; the CLI knows it only by core's contract.
import { isUserError } from "./core/errors.js";
import { type CommandContext, HOST_API, type ProCommands } from "./core/host.js";
import type { PageType } from "./core/schema.js";

const program = new Command()
  .name("docsworth")
  .description("Agent-ready knowledge: team-owned pages, review SLAs, a citation gate for agents.")
  .version(PACKAGE_VERSION)
  .option("--as-of <date>", "evaluate SLAs as of YYYY-MM-DD instead of today", (v) => {
    if (!parseDate(v)) throw new InvalidArgumentError("expected YYYY-MM-DD");
    return v;
  });

/** "Now" for every SLA computation; --as-of pins it for reproducible reports. */
export function now(): Date {
  const asOf = program.opts<{ asOf?: string }>().asOf;
  return asOf ? parseDate(asOf)! : new Date();
}

const repoAt = (dir: string | undefined) => loadRepo(resolve(dir ?? "."));

/**
 * The change happened but its outcome isn't in a required log: say so, and exit 3 (done,
 * audit degraded) so automation can tell it from success (0) and failure (2).
 */
export const EXIT_AUDIT_DEGRADED = 3;
function auditDegraded(err: unknown, what: string): void {
  console.error(`docsworth: ${(err as Error).message} (${what}; exit ${EXIT_AUDIT_DEGRADED}: the audit outcome wasn't recorded)`);
  process.exitCode = EXIT_AUDIT_DEGRADED;
}

/** Who ran a local CLI command, for audit events that have no GitHub identity. */
const cliActor = () => ({ login: userInfo().username, mode: "local" as const, teams: [] as string[] });


/**
 * Docsworth pro is its own package (LICENSE.md in it), installed beside this one: globally
 * next to the global CLI, or in the same project. The CLI finds it by name, like any
 * dependency, and knows it only by core's contract (src/core/host.ts).
 */
const PRO_PACKAGE = "@docsworth-pro/pro";

/** True when pro isn't installed at all. A file missing *inside* an installed pro is a real error. */
function isMissingPro(err: unknown): boolean {
  if ((err as NodeJS.ErrnoException)?.code !== "ERR_MODULE_NOT_FOUND") return false;
  try {
    import.meta.resolve(`${PRO_PACKAGE}/package.json`);
    return false; // pro is there, so what's missing is inside it
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND";
  }
}

/** "Pro isn't installed." Only pro() throws it; it prints like any ConfigError. */
class ProMissing extends ConfigError {}
/** Pro is installed but can't be used: it doesn't load, or it was built for another CLI. */
class ProUnusable extends ConfigError {}

/**
 * Whether pro can be used, decided once: missing, unusable (why), or ok. Pro declares the
 * version of core's contract it was built for (src/core/host.ts, HOST_API); one built for
 * another is refused here, by name, rather than failing somewhere inside a command.
 */
let proState: Promise<{ missing: true } | { unusable: string } | { ok: true }> | undefined;
const proStatus = () =>
  (proState ??= (import(`${PRO_PACKAGE}/host-api`) as Promise<{ PRO_HOST_API: unknown }>).then(
    ({ PRO_HOST_API }): { unusable: string } | { ok: true } =>
      PRO_HOST_API === HOST_API ? { ok: true } : { unusable: `it was built for host API ${String(PRO_HOST_API)}, and this CLI has ${HOST_API}; install versions that match` },
    (err): { missing: true } | { unusable: string } => (isMissingPro(err) ? { missing: true } : { unusable: `it doesn't load: ${(err as Error).message}` }),
  ));

/**
 * Pro is a separate package, so the core CLI runs without it and a pro command says what's
 * missing. Once pro is known to be usable, a failure loading a module of it is pro's own: a
 * file missing inside it is a real error, reported as it is.
 */
async function pro<T>(feature: string, load: () => Promise<T>): Promise<T> {
  const state = await proStatus();
  if ("missing" in state) throw new ProMissing(`${feature} is part of Docsworth pro, which isn't installed`);
  if ("unusable" in state) throw new ProUnusable(`${feature} needs Docsworth pro, which is installed but can't be used: ${state.unusable}`);
  return load();
}

/** Pro's commands (src/core/host.ts, ProCommands), once pro is known to be usable. */
const proCommands = (feature: string): Promise<ProCommands> =>
  pro(feature, async () => ((await import(`${PRO_PACKAGE}/commands`)) as { commands: ProCommands }).commands);

/**
 * Without pro, an audit_http block can't be fully validated, so only the plainly optional
 * shape counts as optional: an object naming its `url_env`, with `required` absent or false.
 * Anything else (required, malformed `required`, a non-object, no `url_env`) is treated as
 * required, which fails closed as httpSinkFromRepo does for a required or invalid block.
 */
function isOptionalSink(block: unknown): boolean {
  // A non-object has no url_env string, so the url_env test below already rejects it.
  const { url_env, required } = Object(block) as { url_env?: unknown; required?: unknown };
  return typeof url_env === "string" && url_env.length > 0 && (required === undefined || required === false);
}

/**
 * The pro HTTP audit sink, if `audit_http` is configured. Without pro the sink can't be set
 * up, which is handled as httpSinkFromRepo handles any sink that can't start: fatal when
 * required, otherwise a warning and no sink.
 */
async function httpSink(root: string) {
  const file = join(root, CONFIG_PATH);
  const raw = existsSync(file) ? (parseYaml(readFileSync(file, "utf8"), { schema: "core" }) as Record<string, unknown> | null) : null;
  const block = raw?.audit_http;
  if (block === undefined || block === null) return null;
  let commands: ProCommands;
  try {
    commands = await proCommands("audit_http");
  } catch (err) {
    if (!(err instanceof ProMissing) || !isOptionalSink(block)) throw err;
    process.stderr.write(`docsworth: audit collector disabled for this run: ${err.message}\n`);
    return null;
  }
  return commands.httpSinkFromRepo(root);
}

/** The audit log for this repo: the core file sink plus the pro HTTP sink, if configured. */
async function openAuditLog(root: string, config: Config): Promise<AuditLog | null> {
  const http = await httpSink(root);
  return createAuditLog(root, config, http ? [http] : [], { now });
}

/** What pro's commands get from this CLI (src/core/host.ts, CommandContext). */
const ctx: CommandContext = { now, repoAt, cliActor, openAuditLog, auditDegraded, requireEnv };

program
  .command("init")
  .description("scaffold a knowledge repo here: config, CODEOWNERS, root map and a writing guide (never overwrites)")
  .argument("[dir]", "repo root", ".")
  .option("--org <org>", "GitHub org owning the teams (default: from the origin remote)")
  .option("--team <team>", "team that owns knowledge/ to start with", "docs")
  .option("--repo <owner/name>", "GitHub repo; enables GitHub ACLs and PR tools (default: from the origin remote)")
  .option("--local", "do not set github.repo even if a GitHub remote exists")
  .option("--ci", "also add .github/workflows/knowledge.yml")
  .action((dir: string, opts: { org?: string; team: string; repo?: string; local?: boolean; ci?: boolean }) => {
    const root = resolve(dir);
    const remote = githubRemote(root);
    const org = opts.org ?? remote?.owner;
    if (!org) throw new ConfigError("no GitHub remote found; pass --org <org>");
    const repo = opts.local ? undefined : (opts.repo ?? (remote ? `${remote.owner}/${remote.name}` : undefined));
    const r = initRepo(root, { org, team: opts.team, repo, ci: opts.ci, now: now() });
    for (const f of r.created) console.log(`created  ${f}`);
    for (const f of r.skipped) console.log(`exists   ${f}`);
    for (const h of r.hints) console.log(`hint     ${h}`);
    console.log(`\nNext: docsworth lint ${dir === "." ? "." : dir}, then install the Claude Code plugin (see README).`);
  });

program
  .command("lint")
  .description("validate frontmatter, CODEOWNERS ownership and links; exits 1 on errors")
  .argument("[dir]", "knowledge repo root", ".")
  .option("--json", "machine-readable output")
  .action((dir: string, opts: { json?: boolean }) => {
    const result = lintRepo(repoAt(dir), now());
    console.log(opts.json ? JSON.stringify(result, null, 2) : formatDiagnostics(result));
    process.exitCode = result.errors > 0 ? 1 : 0;
  });

program
  .command("stale")
  .description("pages past their review SLA or without a team owner")
  .argument("[dir]", "knowledge repo root", ".")
  .option("--owner-team <team>", "only this team's pages")
  .option("--json", "machine-readable output")
  .action((dir: string, opts: { ownerTeam?: string; json?: boolean }) => {
    const repo = repoAt(dir);
    const stale = listStale(repo.pages, repo, now(), opts.ownerTeam);
    if (opts.json) return console.log(JSON.stringify(stale, null, 2));
    for (const s of stale) console.log(`${s.reason.padEnd(10)} ${s.id.padEnd(30)} @${s.owner_team.padEnd(10)} ${s.detail}`);
    console.log(`${stale.length} stale or unowned pages`);
  });

program
  .command("coverage")
  .description("ownership coverage: % of pages team-owned and % verified within SLA, by team")
  .argument("[dir]", "knowledge repo root", ".")
  .option("--json", "machine-readable output")
  .option("--html <file>", "also write a static dashboard")
  .action(async (dir: string, opts: { json?: boolean; html?: string }) => {
    const repo = repoAt(dir);
    const c = computeCoverage(repo, now());
    console.log(opts.json ? JSON.stringify(c, null, 2) : formatCoverage(c));
    if (opts.html) await (await proCommands("coverage --html")).coverageHtml(ctx, c, repo, opts.html);
  });

program
  .command("digest")
  .description("weekly owner digest per team: due, overdue, most read by agents; prints unless --send")
  .argument("[dir]", "knowledge repo root", ".")
  .option("--team <team>", "only this team")
  .option("--send", "post to Slack (webhook from digest.slack_webhook_env / team_webhooks)")
  .option("--json", "machine-readable output")
  .action(async (dir: string, opts: { team?: string; send?: boolean; json?: boolean }) => (await proCommands("digest")).digest(ctx, dir, opts));

program
  .command("compile")
  .description("compile canonical runbooks into SKILL.md files")
  .argument("[dir]", "knowledge repo root", ".")
  .option("--out <dir>", "output directory (default: skills.out_dir from config)")
  .option("--check", "exit 1 if compiled skills drifted from their source pages")
  .option("--mark-stale", "with --check: mark drifted skills stale in place")
  .option("--dry-run", "report what would compile without writing")
  .option("--include-restricted", "also compile runbooks whose acl is not internal")
  .action(async (dir: string, opts: { out?: string; check?: boolean; markStale?: boolean; dryRun?: boolean; includeRestricted?: boolean }) => (await proCommands("compile")).compile(ctx, dir, opts));

program
  .command("mcp")
  .description("serve the knowledge repo to agents over MCP (stdio)")
  .argument("[dir]", "knowledge repo root (default: DOCSWORTH_KNOWLEDGE_DIR, else the current directory)")
  .action(async (dir: string | undefined) => {
    // The plugin launcher passes the repo in the environment: on Windows its command line
    // goes through cmd.exe, which would split a path at a space.
    const root = resolve(dir ?? (process.env.DOCSWORTH_KNOWLEDGE_DIR || "."));
    const config = loadConfig(root);
    const identity = IdentityProvider.fromEnv(config);
    // Fail closed: in GitHub mode, prove the caller's identity before serving anything.
    const who = await identity.fresh();
    const audit = await openAuditLog(root, config);
    // A required audit log that can't record the start refuses to serve at all.
    await audit?.emit({ kind: "server_start", actor: actorOf(who), detail: { config_sha256: configHash(root), mode: who.mode, policy: policySummary(config.policy) } });
    const service = new KnowledgeService(root, identity, now);
    service.watch();
    const stdio = new StdioServerTransport();
    const transport = audit ? auditTransport(stdio, audit, () => identity.get(), {
            includeQueries: config.audit_log.include_queries,
            initialActor: actorOf(who),
            known: () => service.knownValues(),
            snapshot: () => service.snapshot(),
          }) : stdio;
    // The fs watcher keeps the event loop alive. When the client goes away, close it and
    // let in-flight responses drain; the process then exits on its own.
    process.stdin.once("end", () => {
      service.close();
      // The same details as server_start, for the config in force at the end; a stop the
      // log can't take is said on stderr rather than lost silently.
      void audit
        ?.emit({ kind: "server_stop", actor: actorOf(who), snapshot: service.snapshot(), detail: { config_sha256: configHash(root), mode: who.mode, policy: policySummary(service.policy()) } })
        .catch((err: unknown) => process.stderr.write(`docsworth: couldn't record server_stop: ${(err as Error).message}\n`))
        .then(() => audit.flush());
    });
    await createMcpServer(service, { who, whoami: () => identity.get() }).connect(transport);
    process.stderr.write(`docsworth: serving ${root} (${who.mode}${who.login ? ` as ${who.login}` : ""}) over stdio\n`);
  });

program
  .command("serve")
  .description("serve the knowledge repo to the Docsworth web app and browser extension (MCP over HTTP, on 127.0.0.1 only)")
  .argument("[dir]", "knowledge repo root (default: DOCSWORTH_KNOWLEDGE_DIR, else the current directory)")
  .option("--port <n>", "port on 127.0.0.1", (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new InvalidArgumentError("expected a port number");
    return n;
  }, DEFAULT_PORT)
  .option("--allow-extension <id>", "let this browser extension (its 32-letter id) call the server; repeatable", (v: string, prev: string[]) => {
    if (!EXTENSION_ID.test(v)) throw new InvalidArgumentError("expected an extension id: 32 letters a to p");
    return [...prev, v];
  }, [] as string[])
  .option("--rotate-token", "replace the access token first (pair the extension again afterwards)")
  .option("--print-token", "print the access token, for pairing the extension, and exit")
  .action(async (dir: string | undefined, opts: { port: number; allowExtension: string[]; rotateToken?: boolean; printToken?: boolean }) => {
    const root = resolve(dir ?? (process.env.DOCSWORTH_KNOWLEDGE_DIR || "."));
    const config = loadConfig(root);
    // In this user's state directory, outside the repo: it can't be committed.
    const tokenDir = stateDir(root);
    if (opts.printToken) {
      console.log(loadToken(tokenDir, { rotate: opts.rotateToken }));
      return;
    }
    const identity = IdentityProvider.fromEnv(config);
    // Fail closed, as `mcp` does: in GitHub mode, prove the identity before listening.
    const who = await identity.fresh();
    const audit = await openAuditLog(root, config);
    await audit?.emit({ kind: "server_start", actor: actorOf(who), detail: { config_sha256: configHash(root), mode: who.mode, policy: policySummary(config.policy), transport: "http" } });
    const token = loadToken(tokenDir, { rotate: opts.rotateToken });
    // The built web app sits next to the built CLI (dist/web); from source there is none.
    const web = join(dirname(fileURLToPath(import.meta.url)), "web");
    const serving = await startServer({
      root,
      knowledgeRoot: config.knowledge_root,
      identity,
      who,
      audit,
      includeQueries: config.audit_log.include_queries,
      now,
      port: opts.port,
      token,
      extensions: new Set(opts.allowExtension),
      webRoot: existsSync(join(web, "index.html")) ? web : null,
    }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") throw new ConfigError(`port ${opts.port} is in use; pick another with --port`);
      throw err;
    });
    // The URL carries the token in its fragment, which the browser never sends to a server.
    process.stderr.write(`docsworth: serving ${root} (${who.mode}${who.login ? ` as ${who.login}` : ""}) at ${serving.url}\n`);
    const stop = async () => {
      await serving.close();
      await audit
        ?.emit({ kind: "server_stop", actor: actorOf(who), detail: { config_sha256: configHash(root), mode: who.mode, policy: policySummary(config.policy), transport: "http" } })
        .catch((err: unknown) => process.stderr.write(`docsworth: couldn't record server_stop: ${(err as Error).message}\n`));
      await audit?.flush();
      process.exit(0);
    };
    for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => void stop());
  });

function configHash(root: string): string {
  return createHash("sha256").update(readFileSync(join(root, ".knowledge/config.yaml"))).digest("hex");
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new ConfigError(`${name} is not set (see .env.example)`);
  return v;
}

program
  .command("mirror")
  .description("read-only mirror of Confluence/Notion into .knowledge/mirror, scored for freshness and ownership")
  .argument("[dir]", "knowledge repo root", ".")
  .option("--source <name>", "only the source with this name")
  .action(async (dir: string, opts: { source?: string }) => (await proCommands("mirror")).mirror(ctx, dir, opts));

program
  .command("mirror-purge")
  .description("delete the local mirror cache (all sources, or one); idempotent and audited")
  .argument("[dir]", "knowledge repo root", ".")
  .option("--source <kind>", "only this source, as in mirror ids: confluence or notion")
  .action(async (dir: string, opts: { source?: string }) => (await proCommands("mirror-purge")).mirrorPurge(ctx, dir, opts));

program
  .command("promote")
  .description("open a PR copying a mirrored page into knowledge/ with frontmatter pre-filled")
  .argument("<mirror-id>", "e.g. mirror:confluence:ENG:12345")
  .argument("[dir]", "knowledge repo root", ".")
  .requiredOption("--owner-team <team>", "team that will own the page (must match CODEOWNERS for its path)")
  .option("--type <type>", "runbook | service | guide | policy", "runbook")
  .option("--id <id>", "page id (default: derived from the title)")
  .option("--dir <dir>", "directory under the knowledge root")
  .option("--dry-run", "print the page instead of opening a PR")
  .action(async (mirrorId: string, dir: string, opts: { ownerTeam: string; type: PageType; id?: string; dir?: string; dryRun?: boolean }) => (await proCommands("promote")).promote(ctx, mirrorId, dir, opts));

const bench = program.command("bench").description("citation-accuracy benchmark: diy vs ungated vs gated");

bench
  .command("run")
  .description("answer a question set with Claude under each configuration (spends API credits)")
  .argument("[dir]", "knowledge repo root", ".")
  .option("--questions <file>", "questions YAML (default: <dir>/questions.yaml)")
  .option("--out <dir>", "results directory (default: bench-results/<date>)")
  .option("--systems <list>", "comma-separated subset of diy,ungated,gated (default: all)")
  .option("--model <model>", "Claude model", process.env.DOCSWORTH_BENCH_MODEL || "claude-opus-5-5")
  .option("--limit <n>", "only the first n questions", (v) => Number(v))
  .option("--concurrency <n>", "parallel runs", (v) => Number(v), 4)
  .option("--label <text>", "what this run is", "harness validation only")
  .action(async (dir: string, opts: { questions?: string; out?: string; systems?: string; model: string; limit?: number; concurrency: number; label: string }) => (await proCommands("bench")).benchRun(ctx, dir, opts));

bench
  .command("score")
  .description("owner-graded answer correctness from a filled-in grading.csv")
  .argument("<results-dir>")
  .action(async (dir: string) => (await proCommands("bench")).benchScore(ctx, dir));

program
  .command("audit")
  .description("audit report: ownership coverage, stale and overlapping pages, DIY accuracy score")
  .argument("[dir]", "knowledge repo root", ".")
  .option("--bench <results-dir>", "include a bench run's metrics")
  .option("--out <dir>", "write audit.md and audit.html here", ".")
  .option("--title <text>", "report title", "Knowledge readiness audit")
  .action(async (dir: string, opts: { bench?: string; out: string; title: string }) => (await proCommands("audit")).audit(ctx, dir, opts));

program
  .command("access-review")
  .description("who can see, verify and approve what: per page, per team, and with --members per person")
  .argument("[dir]", "knowledge repo root", ".")
  .option("--members", "list each team's members through GitHub (your token decides what you see)")
  .option("--format <md|csv>", "markdown report, or CSV of pages (or people, with --members)", "md")
  .action(async (dir: string, opts: { members?: boolean; format: string }) => (await proCommands("access-review")).accessReview(ctx, dir, opts));

program
  .command("usage-report")
  .description("what agents asked for, from the audit log: by tool and team, outcomes, top and excluded pages")
  .argument("[dir]", "knowledge repo root", ".")
  .option("--since <period>", "how far back, e.g. 7d, 4w, 3m", "30d")
  .option("--audit-dir <dir>", "read audit files from here instead of the configured directory")
  .action(async (dir: string, opts: { since: string; auditDir?: string }) => (await proCommands("usage-report")).usageReport(ctx, dir, opts));

export { program };

const isMain = process.argv[1] && /(?:cli\.(?:ts|js)|docsworth)$/.test(process.argv[1]);
if (isMain) {
  program.parseAsync().catch(async (err: unknown) => {
    if (isUserError(err)) {
      console.error(`docsworth: ${(err as Error).message}`);
      // Exit 3 if the failure also left a change its required audit log doesn't show.
      process.exit(process.exitCode === EXIT_AUDIT_DEGRADED ? EXIT_AUDIT_DEGRADED : 2);
    }
    throw err;
  });
}
