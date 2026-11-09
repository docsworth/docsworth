import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Identity } from "./acl.js";
import type { Config } from "./config.js";
import { UserError } from "./errors.js";
import { PACKAGE_VERSION } from "./version.js";

// The audit log: one JSON line per event, attributed to a person. What it records, and
// what it never records, is this contract (docs/enterprise/data-inventory.md lists the stores):
//   - tool calls at the JSON-RPC boundary (see mcp/audit-transport.ts), write intents,
//     server start/stop, mirror runs, purges and promotes
//   - never tokens, page content, or a hidden page's id/title/path (except an id the
//     caller typed), and never query text unless `include_queries` is set
// Tamper resistance comes from shipping events to a SIEM (the pro HTTP sink); the local
// file only makes deletions within a run visible as gaps in `seq`.

export type AuditKind = "tool_call" | "tool_intent" | "server_start" | "server_stop" | "auth_failure" | "mirror_run" | "mirror_purge" | "promote";

export interface AuditActor {
  login: string | null;
  mode: Identity["mode"];
  teams: string[];
}

export interface AuditEvent {
  v: 1;
  ts: string;
  /** Increases by one per event within a session; a gap means a line was removed. */
  seq: number;
  kind: AuditKind;
  session: string;
  server: { version: string; repo: string | null; commit: string | null };
  /** The knowledge actually served for this event (HEAD, local changes, content hash). */
  snapshot?: { commit: string | null; dirty: boolean | null; content_sha256: string };
  actor?: AuditActor;
  client?: { name: string; version: string };
  tool?: string;
  /** Allowlisted, non-content arguments only (see mcp/audit-transport.ts). */
  args?: Record<string, string | number | boolean>;
  outcome?: "ok" | "denied" | "error";
  code?: string;
  /** Ids from the final, ACL-filtered response only. */
  returned?: string[];
  excluded?: string[];
  pr_url?: string;
  detail?: Record<string, unknown>;
}

export type AuditInput = Omit<AuditEvent, "v" | "ts" | "seq" | "session" | "server">;

export interface AuditSink {
  readonly name: string;
  /** A required sink that cannot take an event fails the audited operation (fail closed). */
  readonly required: boolean;
  /** Events allowed to wait for this sink. Past it, new events are refused (required) or dropped. */
  readonly maxQueue?: number;
  write(event: AuditEvent, line: string): Promise<void>;
}

export class AuditUnavailable extends UserError {
  /** The event that a required sink couldn't take (other sinks may have it). */
  seq?: number;
  /** Required sinks that did record it, and optional sinks it was queued on: the ones a correction must reach. */
  accepted?: { required: AuditSink[]; optional: AuditSink[] };
}

/**
 * The person behind a call. GitHub mode: their login. Local mode has no GitHub identity,
 * so the OS user who runs the server is named instead (mode `local` says which it is).
 */
/**
 * A value can pass its shape check and still be a credential (a token pasted as a path).
 * Known token formats, and long high-entropy runs (mixed case plus digits), become
 * "<redacted>". This is a heuristic: it catches the common shapes, not every secret.
 */
const TOKEN_PREFIX = /(gh[pousr]_[A-Za-z0-9]|github_pat_|glpat-|xox[abprs]-|\bsk-[A-Za-z0-9]|AKIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{10}|eyJ[A-Za-z0-9_-]{8,}\.)/;
const HIGH_ENTROPY = /[A-Za-z0-9+/_=-]{24,}/g;
export function looksSecret(s: string): boolean {
  if (TOKEN_PREFIX.test(s)) return true;
  return (s.match(HIGH_ENTROPY) ?? []).some((run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run));
}
export const redactSecret = (s: string) => (looksSecret(s) ? "<redacted>" : s);

/** Every caller-influenced string in an event, redacted if it looks like a secret. Applied in emit, so no producer can skip it. */
function scrub(input: AuditInput): AuditInput {
  const deep = (v: unknown): unknown =>
    typeof v === "string" ? redactSecret(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
  return deep(input) as AuditInput;
}

export function actorOf(who: Identity): AuditActor {
  return { login: who.login ?? localUser(), mode: who.mode, teams: [...who.teams].sort() };
}

function localUser(): string | null {
  try {
    return userInfo().username || null;
  } catch {
    return null; // no passwd entry (some containers); recorded as unknown
  }
}

export class AuditLog {
  private seq = 0;
  private readonly chains = new Map<AuditSink, Promise<void>>();
  /** Events queued per sink and not yet written: the bound a slow collector can't exceed. */
  private readonly depth = new Map<AuditSink, number>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly sinks: AuditSink[],
    readonly base: { session: string; server: AuditEvent["server"] },
    private readonly clock: () => Date = () => new Date(),
    private readonly log: (msg: string) => void = (m) => process.stderr.write(`docsworth: ${m}\n`),
  ) {}

  /**
   * Queue an event on every sink, in `seq` order per sink. Resolves with its `seq` once
   * every required sink has it; rejects with AuditUnavailable (carrying the `seq`) if one
   * cannot take it. Optional sinks are written in the background and only warn (once per
   * sink) on failure.
   */
  emit(input: AuditInput, opts: { only?: { required: AuditSink[]; optional: AuditSink[] } } = {}): Promise<number> {
    const event: AuditEvent = { v: 1, ts: this.clock().toISOString(), seq: ++this.seq, session: this.base.session, server: this.base.server, ...scrub(input) };
    const line = JSON.stringify(event);
    // A correction (`only`) goes just to the sinks that took the event it corrects. To a
    // required sink that already wrote that event it isn't bounded by the queue: there's at
    // most one per write it follows, so it can't grow without limit. Optional sinks keep the bound.
    const targets = opts.only ? [...opts.only.required, ...opts.only.optional] : this.sinks;
    const unbounded = new Set(opts.only?.required ?? []);
    const required: { sink: AuditSink; done: Promise<void> }[] = [];
    const optional: AuditSink[] = [];
    for (const sink of targets) {
      const queued = this.depth.get(sink) ?? 0;
      if (!unbounded.has(sink) && sink.maxQueue !== undefined && queued >= sink.maxQueue) {
        const full = new Error(`queue is full (${sink.maxQueue} events waiting)`);
        if (sink.required) required.push({ sink, done: Promise.reject(full) });
        else this.warnOnce(sink.name, full);
        continue;
      }
      this.depth.set(sink, queued + 1);
      const write = (this.chains.get(sink) ?? Promise.resolve())
        .then(() => sink.write(event, line))
        .finally(() => this.depth.set(sink, (this.depth.get(sink) ?? 1) - 1));
      // A failed write must not poison the events queued after it.
      this.chains.set(
        sink,
        write.catch(() => {}),
      );
      if (sink.required) required.push({ sink, done: write });
      else {
        optional.push(sink);
        write.catch((err: unknown) => this.warnOnce(sink.name, err));
      }
    }
    // Wait for every required sink, not just the first failure, so the error can say which
    // ones did record the event.
    return Promise.allSettled(required.map((r) => r.done)).then((results) => {
      const failed = results.findIndex((r) => r.status === "rejected");
      if (failed === -1) return event.seq;
      const reason = (results[failed] as PromiseRejectedResult).reason as Error;
      const err = new AuditUnavailable(`the audit log (${required[failed]!.sink.name}) could not record this call: ${reason.message}`);
      err.seq = event.seq;
      err.accepted = { required: required.filter((_, i) => results[i]!.status === "fulfilled").map((r) => r.sink), optional };
      throw err;
    });
  }


  /** Wait for every queued write, required or not (shutdown, tests). */
  async flush(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  private warnOnce(name: string, err: unknown): void {
    if (this.warned.has(name)) return;
    this.warned.add(name);
    this.log(`audit sink ${name} is failing (${(err as Error).message}); events to it are being dropped`);
  }
}

/** `$XDG_STATE_HOME/docsworth/<repo>-<hash>/audit`, outside the checkout so it can't be committed. */
/**
 * This user's state for this checkout: `$XDG_STATE_HOME/docsworth/<repo>-<hash>`. Outside
 * the repo on purpose: nothing in it can be committed, or forged by a checkout.
 */
export function stateDir(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const abs = resolve(repoRoot);
  return join(state, "docsworth", `${basename(abs)}-${createHash("sha256").update(abs).digest("hex").slice(0, 8)}`);
}

export function defaultAuditDir(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(repoRoot, env), "audit");
}

const DAY_FILE = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** writeSync may write fewer bytes than asked; loop until every byte is down. */
export function writeAll(fd: number, text: string, write: (fd: number, buf: Buffer, off: number, len: number) => number = writeSync): void {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = write(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error("write made no progress");
    off += n;
  }
}

/** Marks a directory as Docsworth's audit directory, so only it is chmodded and pruned. */
export const AUDIT_MARKER = ".docsworth-audit";

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Daily JSON-lines files (`audit-YYYY-MM-DD.jsonl`), directory 0700 and files 0600. A
 * symlinked directory or file is refused, so the log can't be redirected elsewhere.
 */
export class FileSink implements AuditSink {
  readonly name = "file";

  constructor(
    readonly dir: string,
    readonly required: boolean,
    retentionDays: number,
    now: Date,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) throw new AuditUnavailable(`audit directory ${dir} is a symlink; refusing to write through it`);
    if (!st.isDirectory()) throw new AuditUnavailable(`audit directory ${dir} is not a directory`);
    // Only a directory of its own is ever chmodded or pruned: new or empty, holding only
    // audit files, or already marked. Anything else (say $HOME) is refused untouched.
    const marker = join(dir, AUDIT_MARKER);
    if (lstatExists(marker)) {
      if (!lstatSync(marker).isFile()) throw new AuditUnavailable(`${marker} is a symlink or directory, not the marker Docsworth writes`);
    } else {
      const foreign = readdirSync(dir).filter((e) => !DAY_FILE.test(e));
      if (foreign.length)
        throw new AuditUnavailable(`audit_log.dir ${dir} holds ${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ", …" : ""} and isn't a Docsworth audit directory (no ${AUDIT_MARKER}); use a directory of its own`);
      const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
    }
    // `mode` only applies to directories mkdir creates; tighten one that already existed.
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    this.prune(retentionDays, now);
  }

  async write(event: AuditEvent, line: string): Promise<void> {
    const file = join(this.dir, `audit-${event.ts.slice(0, 10)}.jsonl`);
    // O_NOFOLLOW: a symlink planted at the file's path makes the open fail.
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      // The open mode only applies to a file it creates; tighten one that already existed.
      if ((fstatSync(fd).mode & 0o077) !== 0) fchmodSync(fd, 0o600);
      writeAll(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
  }

  /** Delete daily files older than the retention window. */
  private prune(days: number, now: Date): void {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
    for (const name of readdirSync(this.dir)) {
      const m = DAY_FILE.exec(name);
      if (m && m[1]! < cutoff) unlinkSync(join(this.dir, name));
    }
  }
}

/** The configured audit directory, refusing one inside the checkout unless git ignores it. */
/** A path's canonical form, even before it exists: its nearest existing ancestor resolved through symlinks, plus the rest. */
function canonical(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(canonical(parent), basename(abs));
}

export function resolveAuditDir(repoRoot: string, configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const dir = !configured ? defaultAuditDir(repoRoot, env) : isAbsolute(configured) ? configured : resolve(repoRoot, configured);
  // Canonical on both sides: a path that looks outside the checkout but runs through a
  // symlink into it is inside, and must pass the same git-ignore check.
  const rel = relative(canonical(repoRoot), canonical(dir));
  // Inside the checkout (the root itself included): one `git add -A` away from being
  // committed, unless ignored. This covers a default under an XDG_STATE_HOME in the repo.
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel); // `..audit` is inside
  if (!outside) {
    const label = configured ?? dir;
    // Ask about a file the sink would write, which works before the directory exists.
    const r = spawnSync("git", ["-C", repoRoot, "check-ignore", "-q", join(rel, "audit-2000-01-01.jsonl")], { encoding: "utf8" });
    if (r.status === 0) {
      // Ignoring doesn't untrack: files already committed there would keep being changed
      // and committed. Refuse a directory that holds any tracked file.
      const tracked = spawnSync("git", ["-C", repoRoot, "ls-files", "--", rel || "."], { encoding: "utf8" });
      if (tracked.status !== 0 || tracked.stdout.trim())
        throw new AuditUnavailable(`audit_log.dir ${label} is ignored by git but already holds tracked files (${tracked.stdout.trim().split("\n")[0] || "git couldn't say"}); untrack them with \`git rm --cached\` or use a path outside the checkout`);
      return dir;
    }
    if (r.status === 1) throw new AuditUnavailable(`audit_log.dir ${label} is inside the repository and not ignored by git; add it to .gitignore or use a path outside the checkout`);
    // git couldn't answer. Allow only when git positively says this isn't a repository;
    // a missing git, a "dubious ownership" refusal or anything else is refused.
    const tree = spawnSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
    const notARepo = !tree.error && tree.status === 128 && /not a git repository/i.test(tree.stderr);
    if (!notARepo) throw new AuditUnavailable(`couldn't confirm that audit_log.dir ${label} is ignored by git (${(r.error?.message ?? r.stderr ?? "no answer").trim() || "no answer"}); use a path outside the checkout`);
  }
  return dir;
}

/** The knowledge repo's HEAD commit, if it is a git checkout. */
export function headCommit(repoRoot: string): string | null {
  const r = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Build the core audit log from config: the file sink when `audit_log.enabled`, plus any
 * sinks the caller adds (the pro HTTP sink). Returns null when there is nothing to write to.
 */
export function createAuditLog(
  repoRoot: string,
  config: Config,
  extraSinks: AuditSink[] = [],
  opts: { now?: () => Date; env?: NodeJS.ProcessEnv; log?: (msg: string) => void } = {},
): AuditLog | null {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => process.stderr.write(`docsworth: ${m}\n`));
  const sinks: AuditSink[] = [...extraSinks];
  if (config.audit_log.enabled) {
    try {
      const dir = resolveAuditDir(repoRoot, config.audit_log.dir, opts.env);
      sinks.unshift(new FileSink(dir, config.audit_log.required, config.audit_log.retention_days, now()));
    } catch (err) {
      // Required: refuse to run unaudited. Optional (best effort): say so, and go on.
      if (config.audit_log.required) throw err;
      log(`audit log disabled for this run: ${(err as Error).message}`);
    }
  }
  if (sinks.length === 0) return null;
  return new AuditLog(sinks, { session: randomUUID(), server: { version: PACKAGE_VERSION, repo: config.github.repo ?? null, commit: headCommit(repoRoot) } }, now);
}
