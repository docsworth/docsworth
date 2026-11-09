/**
 * Everything Docsworth pro may use of core, and nothing else. Pro imports core only through
 * this file, which a test holds to the list below: pro is another package, and this is the
 * one entry point the CLI exports to it.
 *
 * HOST_API is the contract's version. Pro declares the version it was built for, and the
 * CLI refuses a pro built for another, with a message naming both, rather than failing
 * somewhere inside a command. The check is equality, so raise it whenever the contract
 * changes at all: a name here added, removed or changed in meaning, or what the CLI and
 * pro expect of each other (ProCommands, CommandContext, pro's entry points).
 * 2: pro's commands behind ProCommands, and the names they use (pro-split step 2).
 * 3: buildNewPage, NEW_PAGE_PREFIX and slugify: promote builds its page with core's builder,
 *    which draft_page shares.
 */
import type { AuditActor, AuditLog, AuditSink } from "./audit-log.js";
import type { Config } from "./config.js";
import type { Coverage } from "./coverage.js";
import type { MirrorPage } from "./mirror-view.js";
import type { Repo } from "./repo.js";
import type { PageType } from "./schema.js";

export const HOST_API = 3;

export { canSee, type Identity, visiblePages } from "./acl.js";
export { type AuditActor, type AuditEvent, type AuditLog, type AuditSink, actorOf, resolveAuditDir, writeAll } from "./audit-log.js";
export { matchRule, resolveTeamOwner } from "./codeowners.js";
export { type Config, CONFIG_PATH, ConfigError } from "./config.js";
export { computeCoverage, type Coverage, type CoverageRow } from "./coverage.js";
export { formatDate, parseDuration, subtractDuration, utcToday } from "./duration.js";
export { isUserError, UserError } from "./errors.js";
export { splitFrontmatter } from "./frontmatter.js";
export { pageStatus } from "./gate.js";
export { type FetchLike, type GitHubClient, GitHubError } from "./github.js";
export { IdentityProvider, LOCAL_IDENTITY, resolveToken } from "./identity.js";
export { INSTRUCTIONS, readDescription, searchDescription } from "./mcp/text.js";
export { buildNewPage, NEW_PAGE_PREFIX, slugify } from "./new-page.js";
export {
  canonicalDir,
  loadMirror,
  lstatExists,
  MIRROR_SOURCES,
  type MirrorPage,
  type MirrorSource,
  mirrorRecordPath,
  ownedFiles,
  ownedSpaceFiles,
  readOwned,
  sha256,
} from "./mirror-view.js";
export { isPage, type Page, parsePage, type Repo, resolveLink } from "./repo.js";
export { ACL_INTERNAL, type PageType } from "./schema.js";
export { SearchIndex, snippet, tokenize } from "./search.js";
export { KnowledgeService, ToolError } from "./service.js";
export { listStale, type StaleEntry } from "./stale.js";
export { insecureUrl, urlForError } from "./url.js";
export { openPagePr, type PrResult } from "./writes.js";

// The contract's own types: what the CLI expects of pro, owned here so the CLI never
// imports a pro type.

/** A source of mirrored pages (Confluence, Notion): pro's connectors implement it. */
export interface Connector {
  readonly source: MirrorPage["source"];
  readonly space: string;
  pages(): AsyncIterable<MirrorPage>;
  /** Pages the token can see but which carry read restrictions (never mirrored). */
  readonly skippedRestricted: string[];
  readonly requestCount: number;
}

/** The systems the benchmark compares. */
export type SystemName = "diy" | "ungated" | "gated";

/** What a pro command gets from the CLI that runs it. */
export interface CommandContext {
  /** "Now" for every SLA computation (`--as-of` pins it). */
  now(): Date;
  repoAt(dir: string | undefined): Repo;
  /** Who ran a local command, for audit events with no GitHub identity. */
  cliActor(): AuditActor;
  /** The repo's audit log: the core file sink, plus pro's HTTP sink if configured. */
  openAuditLog(root: string, config: Config): Promise<AuditLog | null>;
  /** The change happened but its outcome isn't in a required log: say so, exit 3. */
  auditDegraded(err: unknown, what: string): void;
  /** An environment variable the command can't run without (a ConfigError if unset). */
  requireEnv(name: string): string;
}

/**
 * Pro's commands. The CLI defines each one (its name, arguments, options and help, so help
 * reads the same without pro) and calls these for what it does.
 */
export interface ProCommands {
  /** `coverage --html`: the dashboard for coverage the CLI computed. */
  coverageHtml(ctx: CommandContext, coverage: Coverage, repo: Repo, file: string): Promise<void>;
  digest(ctx: CommandContext, dir: string, opts: { team?: string; send?: boolean; json?: boolean }): Promise<void>;
  compile(ctx: CommandContext, dir: string, opts: { out?: string; check?: boolean; markStale?: boolean; dryRun?: boolean; includeRestricted?: boolean }): Promise<void>;
  mirror(ctx: CommandContext, dir: string, opts: { source?: string }): Promise<void>;
  mirrorPurge(ctx: CommandContext, dir: string, opts: { source?: string }): Promise<void>;
  promote(ctx: CommandContext, mirrorId: string, dir: string, opts: { ownerTeam: string; type: PageType; id?: string; dir?: string; dryRun?: boolean }): Promise<void>;
  benchRun(ctx: CommandContext, dir: string, opts: { questions?: string; out?: string; systems?: string; model: string; limit?: number; concurrency: number; label: string }): Promise<void>;
  benchScore(ctx: CommandContext, dir: string): Promise<void>;
  audit(ctx: CommandContext, dir: string, opts: { bench?: string; out: string; title: string }): Promise<void>;
  accessReview(ctx: CommandContext, dir: string, opts: { members?: boolean; format: string }): Promise<void>;
  usageReport(ctx: CommandContext, dir: string, opts: { since: string; auditDir?: string }): Promise<void>;
  /** The HTTP audit sink, if `audit_http` is configured (null if it isn't). */
  httpSinkFromRepo(root: string): Promise<AuditSink | null>;
}
