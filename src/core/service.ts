import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, posix } from "node:path";
import { canSee, type Identity, redactLinks, RESTRICTED, visibleMirror, visiblePages } from "./acl.js";
import { stateDir } from "./audit-log.js";
import { type MirrorPage, redactHiddenLinks, redactMirror, servedMirror, stillOwned } from "./mirror-view.js";
import { CODEOWNERS_LOCATIONS } from "./codeowners.js";
import { CONFIG_PATH } from "./config.js";
import { formatDate, utcToday } from "./duration.js";
import { pageStatus } from "./gate.js";
import { polishChanges, polishSummary } from "./polish.js";
import { MIRRORED_NOTE, NOT_CITABLE_NOTE } from "./mcp/text.js";
import { buildNewPage, NEW_PAGE_PREFIX, type NewPageType, slugify } from "./new-page.js";
import { type Policy, toolRefusal } from "./policy.js";
import { WRITE_TOOLS } from "./tool-registry.js";
import type { GitHubClient } from "./github.js";
import { extractLinks, loadRepo, type Page, type Repo, resolveLink } from "./repo.js";
import { ACL_INTERNAL, PAGE_TYPES, type PageType } from "./schema.js";
import { splitFrontmatter } from "./frontmatter.js";
import { SearchIndex, snippet } from "./search.js";
import { listStale, type StaleEntry } from "./stale.js";
import { applyEdits, assertProtectedFieldsUnchanged, type Edit, openPagePr, replaceBody, setLastVerified, WriteError } from "./writes.js";

export type ToolErrorCode = "not_found" | "forbidden" | "invalid" | "unavailable";
const count = (text: string, needle: string) => text.split(needle).length - 1;

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What the service needs from identity resolution (IdentityProvider, or a test fake). */
export interface IdentitySource {
  get(): Promise<Identity>;
  fresh(): Promise<Identity>;
  readonly github: GitHubClient | null;
}

export interface PageSummary {
  id: string;
  title: string;
  path: string;
  type: PageType;
  status: Page["status"];
  owner_team: string;
  last_verified: string;
  due: string | null;
  sla_state: string;
  citable: boolean;
}

export interface SearchResult extends PageSummary {
  snippet: string;
  score: number;
  /** Present only with include_stale: why this page is not citable. */
  gate?: string;
}
/** A mirrored wiki page that matched: context for the agent, never a citation. */
export interface MirroredHit {
  id: string;
  title: string;
  source: string;
  source_url: string;
  owner_team: string | null;
  last_edited: string;
  citable: false;
  snippet: string;
}
export interface Excluded {
  id: string;
  title: string;
  owner_team: string;
  reason: string;
}

/**
 * The six knowledge tools as plain functions. The MCP server is a thin wrapper, and the
 * ACL matrix test exercises this class directly, so there is one code path to audit.
 *
 * Invariant: every page a method touches comes from `visiblePages(repo, identity)`.
 * Unknown ids and ids the caller cannot see raise the same not_found error.
 */
/** How long after starting a watcher to reload once anyway. A write 500 ms after a restart
 *  was always reported (20 of 20); this leaves room on a loaded machine. */
export const WATCH_SETTLE_MS = 2000;

/** A draft_page body's limit, and how many fresh names it tries before giving up. */
export const DRAFT_MAX_CHARS = 512 * 1024;
export const DRAFT_NAME_ATTEMPTS = 3;

/** At most this many mirrored pages per search: context, not a second result list. */
export const MIRROR_LIMIT = 3;

/** Stand-in identity for policy checks that don't depend on who is asking. */
const LOCAL_IDENTITY_FOR_POLICY: Identity = { mode: "local", login: null, teams: new Set(), repoAccess: true, canWrite: false };

// Where a mirrored page is read from when its links are resolved: outside the knowledge root.
const MIRROR_ORIGIN = ".knowledge/mirror";

export class KnowledgeService {
  private repo!: Repo;
  private index!: SearchIndex;
  private dirty = false;
  /** mtimes of the non-page inputs (config, CODEOWNERS) the loaded repo was built from. */
  private inputs = "";
  private watcher: FSWatcher | null = null;
  private watchedDir: string | null = null;
  private settle: NodeJS.Timeout | null = null;
  private defaultBranch: string | null = null;

  /** Mirrored pages, when mirror.serve is on; one search index per audience (views). */
  private mirror: MirrorPage[] = [];
  private readonly mirrorViews = new Map<string, { pages: MirrorPage[]; origin: MirrorPage[]; hidden: MirrorPage[]; index: SearchIndex }>();

  /** Team ACLs whose content this session has seen (write-path taint check). */
  private readonly tainted = new Set<string>();

  /** The random end of a drafted page's id and file name (replaced in tests). */
  private draftSuffix = () => randomBytes(6).toString("hex");

  constructor(
    private readonly root: string,
    private readonly identity: IdentitySource,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.reload();
  }

  reload(): void {
    this.repo = loadRepo(this.root);
    this.snap = null; // recomputed on first use, so it always names what is being served
    // Index bodies with links to non-internal pages already redacted, so a team page's
    // title in a public page's link text can't surface through ranking or snippets.
    const publicView: Identity = { mode: "local", login: null, teams: new Set(), repoAccess: true, canWrite: false };
    this.mirror = this.repo.config.mirror.serve ? servedMirror(this.root, this.repo.config.mirror.out_dir) : [];
    // Links to mirrored pages outside the public view are redacted from the index too.
    const teamMirror = this.mirror.filter((m) => !canSee(m, publicView));
    this.index = new SearchIndex(
      this.repo.pages.map((p) => ({
        title: p.title,
        headings: p.headings,
        description: p.description,
        body: redactHiddenLinks(redactLinks(p.body, p.path, this.repo, publicView), teamMirror, RESTRICTED),
        keywords: [p.id, ...(p.applies_to ?? [])],
      })),
    );
    this.mirrorViews.clear();
    this.dirty = false;
    this.inputs = this.inputsStamp();
    // Config may have changed: forget the cached branch, follow a moved knowledge root.
    this.defaultBranch = null;
    if (this.watcher && this.watchedDir !== join(this.root, this.repo.config.knowledge_root)) {
      this.close();
      this.watch();
    }
  }

  /** Config and CODEOWNERS live outside the watched knowledge root; stat them per call. */
  private inputsStamp(): string {
    const stamp = (abs: string) => {
      try {
        return statSync(abs).mtimeMs;
      } catch {
        return 0;
      }
    };
    // A mirror run rewrites its ownership records, so their directory's mtime changes.
    const mirror = this.repo?.config.mirror.serve ? [stamp(join(stateDir(this.root), "mirror"))] : [];
    return [...[CONFIG_PATH, ...CODEOWNERS_LOCATIONS].map((rel) => stamp(join(this.root, rel))), ...mirror].join("|");
  }

  /**
   * The mirrored pages `who` may see, each with links to the ones they can't see
   * redacted (and to repo pages they can't see: a wiki page can link to one by its URL),
   * and a search index over exactly that view: ranking, snippets and counts never draw on
   * a page outside it. One per audience (the caller's teams), rebuilt on reload.
   */
  private mirrorView(who: Identity) {
    const pages = visibleMirror(this.mirror, who);
    const key = `${who.repoAccess}|${[...who.teams].map((t) => t.toLowerCase()).sort().join(",")}`;
    let view = this.mirrorViews.get(key);
    if (!view) {
      const seen = new Set(pages);
      const hidden = this.mirror.filter((m) => !seen.has(m));
      // Read from outside the knowledge root, so only a URL or a full path names a repo page.
      const redacted = pages.map((m) => ({ ...m, markdown: redactLinks(redactMirror(m, hidden, RESTRICTED), `${MIRROR_ORIGIN}/${m.id}.md`, this.repo, who) }));
      view = { pages: redacted, origin: pages, hidden, index: new SearchIndex(redacted.map((m) => ({ title: m.title, body: m.markdown, keywords: [m.id] }))) };
      this.mirrorViews.set(key, view);
    }
    return view;
  }

  /** Reload on the next call. `docsworth serve` runs one watcher for all its sessions' services. */
  invalidate(): void {
    this.dirty = true;
  }

  /** Mark the index dirty on any change under the knowledge root. */
  watch(): void {
    if (this.watcher) return;
    this.watchedDir = join(this.root, this.repo.config.knowledge_root);
    this.watcher = watch(this.watchedDir, { recursive: true }, () => {
      this.dirty = true;
    });
    // macOS drops events for changes made while a new watch stream is still starting
    // (3 of 20 writes made right after a restart were never reported). Reload once the
    // stream has had time to start, so a page changed in that window is not served stale.
    this.settle = setTimeout(() => (this.dirty = true), WATCH_SETTLE_MS);
    this.settle.unref();
  }
  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.settle) clearTimeout(this.settle);
    this.settle = null;
  }

  private current(): Repo {
    if (this.dirty || this.inputsStamp() !== this.inputs) this.reload();
    return this.repo;
  }

  private snap: { commit: string | null; dirty: boolean | null; content_sha256: string } | null = null;

  /**
   * The knowledge actually being served: the checkout's HEAD and whether the served files
   * differ from it, plus a hash of the loaded config, ownership and pages. Refreshed after
   * every reload, so an audit event names the snapshot its answer came from.
   */
  snapshot(): { commit: string | null; dirty: boolean | null; content_sha256: string } {
    const repo = this.current();
    if (this.snap) return this.snap;
    const h = createHash("sha256");
    h.update(JSON.stringify(repo.config));
    h.update(JSON.stringify(repo.codeowners.rules.map((r) => [r.pattern, r.owners.map((o) => o.raw)])));
    for (const p of [...repo.pages].sort((a, b) => a.path.localeCompare(b.path))) h.update(`${p.path}\0${JSON.stringify(p)}\0`);
    for (const m of this.mirror) h.update(`${m.id}\0${JSON.stringify(m)}\0`);
    const head = spawnSync("git", ["-C", this.root, "rev-parse", "HEAD"], { encoding: "utf8" });
    const status = head.status === 0 ? spawnSync("git", ["-C", this.root, "status", "--porcelain", "--", repo.config.knowledge_root, CONFIG_PATH, ...CODEOWNERS_LOCATIONS], { encoding: "utf8" }) : null;
    this.snap = {
      commit: head.status === 0 ? head.stdout.trim() : null,
      dirty: status && status.status === 0 ? status.stdout.trim().length > 0 : null,
      content_sha256: h.digest("hex"),
    };
    return this.snap;
  }

  /** Every page id, team and applies_to tag the repo uses: what an audited argument may record. */
  knownValues(): { ids: Set<string>; teams: Set<string>; tags: Set<string> } {
    const repo = this.current();
    return {
      ids: new Set([...repo.pages.map((p) => p.id), ...this.mirror.map((m) => m.id)]),
      teams: new Set([
        ...repo.pages.flatMap((p) => [p.owner_team, p.acl]),
        ...this.mirror.flatMap((m) => [m.acl, ...(m.owner_team ? [m.owner_team] : [])]),
        // Teams CODEOWNERS names in this org: a new page's owner may have no page yet.
        ...repo.codeowners.rules.flatMap((r) => r.owners.filter((o) => o.kind === "team" && o.org?.toLowerCase() === repo.config.github.org).map((o) => o.team!.toLowerCase())),
      ]),
      tags: new Set(repo.pages.flatMap((p) => p.applies_to ?? [])),
    };
  }

  /** Whether mirrored pages are served (mirror.serve). */
  mirrorServed(): boolean {
    return this.current().config.mirror.serve;
  }

  /** The org policy in force now (config is re-read when it changes). */
  policy(): Policy {
    return this.current().config.policy;
  }
  get org(): string {
    return this.repo.config.github.org;
  }

  /** Policy gate, checked on every call, before any page is resolved. */
  private permit(tool: string, who: Identity): void {
    const why = toolRefusal(this.current().config.policy, this.repo.config.github.org, tool, who);
    if (why) throw new ToolError("forbidden", why);
  }

  private summary(page: Page): PageSummary {
    const s = pageStatus(page, this.repo, this.now());
    return {
      id: page.id,
      title: page.title,
      path: page.path,
      type: page.type,
      status: page.status,
      owner_team: page.owner_team,
      last_verified: page.last_verified,
      due: s.sla.due,
      sla_state: s.sla.state,
      citable: s.citable,
    };
  }

  private resolve(id: unknown, who: Identity): Page {
    const page = typeof id === "string" ? this.current().byId.get(id) : undefined;
    if (!page || !canSee(page, who)) throw new ToolError("not_found", `no page with id \`${String(id)}\``);
    return page;
  }

  /** Any restricted page represented in a response (content, snippet or just its title)
   *  taints the session for the write-path check. */
  private taint(pages: Iterable<Pick<Page, "acl">>): void {
    for (const p of pages) if (p.acl !== ACL_INTERNAL) this.tainted.add(p.acl);
  }

  private noteRead(tool: string, pages: Page[]): void {
    this.taint(pages);
    if (!this.repo.config.usage_log || pages.length === 0) return;
    const file = join(this.root, ".knowledge/usage.jsonl");
    try {
      mkdirSync(dirname(file), { recursive: true });
      // Page ids and the tool only: queries can carry sensitive text and are never logged.
      appendFileSync(file, `${JSON.stringify({ ts: this.now().toISOString(), tool, ids: pages.map((p) => p.id) })}\n`);
    } catch {
      /* usage logging is best-effort and must never fail a read */
    }
  }

  async search(args: {
    query: string;
    type?: PageType;
    owner_team?: string;
    applies_to?: string;
    include_stale?: boolean;
    limit?: number;
  }): Promise<{ results: SearchResult[]; excluded: Excluded[]; mirrored?: MirroredHit[]; note?: string }> {
    if (!args.query?.trim()) throw new ToolError("invalid", "query is empty");
    const who = await this.identity.get();
    this.permit("search", who);
    const repo = this.current();
    const includeStale = Boolean(args.include_stale) && repo.config.policy.include_stale !== "denied";
    const limit = Math.min(Math.max(args.limit ?? 8, 1), 25);
    const now = this.now();

    const visible = new Set(visiblePages(repo, who));
    const accept = (i: number) => {
      const p = repo.pages[i]!;
      return (
        visible.has(p) &&
        (!args.type || p.type === args.type) &&
        (!args.owner_team || p.owner_team === args.owner_team) &&
        (!args.applies_to || (p.applies_to ?? []).includes(args.applies_to))
      );
    };

    const results: SearchResult[] = [];
    const excluded: Excluded[] = [];
    for (const hit of this.index.search(args.query, limit * 3, accept)) {
      const page = repo.pages[hit.index]!;
      const status = pageStatus(page, repo, now);
      if (!status.citable && !includeStale) {
        if (excluded.length < 5) excluded.push({ id: page.id, title: page.title, owner_team: page.owner_team, reason: status.gate_reason! });
        continue;
      }
      if (results.length >= limit) continue;
      results.push({
        ...this.summary(page),
        snippet: snippet(this.pageText(page, who), args.query),
        score: hit.score,
        ...(status.citable ? {} : { gate: status.gate_reason }),
      });
    }
    // Mirrored pages, from this caller's view only, in a list of their own: never in
    // `results`, never citable. Filters on page type and owner don't apply to them.
    const mirrored: MirroredHit[] = [];
    if (this.mirror.length && !args.type && !args.applies_to) {
      const view = this.mirrorView(who);
      for (const hit of view.index.search(args.query, MIRROR_LIMIT * 3, (i) => !args.owner_team || view.pages[i]!.owner_team === args.owner_team)) {
        if (mirrored.length >= MIRROR_LIMIT) break;
        // Served from memory, so checked against its file first: one edited or deleted
        // since loading is dropped, and the mirror reloaded on the next call.
        if (!stillOwned(view.origin[hit.index]!)) {
          this.dirty = true;
          continue;
        }
        const m = view.pages[hit.index]!;
        mirrored.push({ id: m.id, title: m.title, source: m.source, source_url: m.url, owner_team: m.owner_team, last_edited: m.last_edited, citable: false, snippet: snippet(m.markdown, args.query) });
      }
      this.taint(mirrored.map((h) => view.pages.find((m) => m.id === h.id)!));
    }
    this.noteRead("search", results.map((r) => repo.byId.get(r.id)!));
    this.taint(excluded.map((e) => repo.byId.get(e.id)!));
    const notes = [...(excluded.length ? [NOT_CITABLE_NOTE] : []), ...(mirrored.length ? [MIRRORED_NOTE] : [])];
    return { results, excluded, ...(mirrored.length ? { mirrored } : {}), ...(notes.length ? { note: notes.join(" ") } : {}) };
  }

  async read(args: { id: string }) {
    return this.readAs("read", args, true);
  }

  /** read() for `tool`: the same view; only an agent's `read` goes in the usage log. */
  private async readAs(tool: string, args: { id: string }, usage: boolean) {
    return (await this.readWith(tool, args, usage)).shown;
  }

  /**
   * `readAs`, with what it read: the page, the caller and the repo, from the one look at the
   * repo after the only await. A caller that builds more of its answer from these (ui_page's
   * links) answers from that same look, as `read` does: a reload after it can't mix in.
   */
  private async readWith(tool: string, args: { id: string }, usage: boolean) {
    const who = await this.identity.get();
    this.permit(tool, who);
    if (typeof args.id === "string" && args.id.startsWith("mirror:")) return { kind: "mirror" as const, shown: this.readMirror(args.id, who) };
    const page = this.resolve(args.id, who);
    const repo = this.repo;
    const s = pageStatus(page, this.repo, this.now());
    const flags = [
      ...(s.sla.state === "overdue" ? ["past_sla"] : []),
      ...(s.sla.state === "due_soon" ? ["due_soon"] : []),
      ...(page.status !== "canonical" ? [page.status] : []),
      ...(!s.owned ? ["unowned"] : []),
    ];
    if (usage) this.noteRead("read", [page]);
    else this.taint([page]);
    const shown = {
      ...this.summary(page),
      review_every: page.review_every,
      acl: page.acl,
      // Only ids the caller could look up: a hidden page's id would name it, and so would
      // the id of a page that didn't load (its ACL can't be read). A mirrored page's id
      // can't be here: `supersedes` holds canonical ids, which can't hold the `:` every
      // mirror id has (schema.ts `ID`), so a page that names one doesn't load at all.
      supersedes: (page.supersedes ?? []).filter((id) => {
        const p = this.repo.byId.get(id);
        return p ? canSee(p, who) : !this.repo.invalid.some((i) => i.id === id);
      }),
      applies_to: page.applies_to ?? [],
      flags,
      ...(s.citable ? {} : { gate_reason: s.gate_reason }),
      content: this.pageText(page, who),
    };
    return { kind: "page" as const, shown, page, who, repo };
  }

  /** A repo page's text as `who` may see it: links to pages, or mirrored pages, they can't see redacted. */
  private pageText(page: Page, who: Identity, body = page.body): string {
    const text = redactLinks(body, page.path, this.repo, who);
    return this.mirror.length ? redactHiddenLinks(text, this.mirrorView(who).hidden, RESTRICTED) : text;
  }

  /** A mirrored page, as context: never citable. Hidden and unknown ids read the same. */
  private readMirror(id: string, who: Identity) {
    this.current();
    const view = this.mirror.length ? this.mirrorView(who) : undefined;
    const at = view ? view.pages.findIndex((p) => p.id === id) : -1;
    const m = at >= 0 ? view!.pages[at] : undefined;
    // Changed since loading: don't serve it, and reload on the next call.
    const changed = Boolean(m) && !stillOwned(view!.origin[at]!);
    if (changed) this.dirty = true;
    if (!m || changed) throw new ToolError("not_found", `no page with id \`${id}\``);
    this.taint([m]);
    return {
      id: m.id,
      title: m.title,
      source: m.source,
      space: m.space,
      source_url: m.url,
      owner_team: m.owner_team,
      last_edited: m.last_edited,
      acl: m.acl,
      citable: false,
      flags: ["mirrored"],
      gate_reason: `mirrored from ${m.source === "confluence" ? "Confluence" : "Notion"}: a copy of the old wiki, not a verified page`,
      content: m.markdown,
    };
  }

  async list(args: { path?: string; type?: PageType } = {}) {
    const who = await this.identity.get();
    this.permit("list", who);
    const repo = this.current();
    const visible = visiblePages(repo, who);
    if (args.type) {
      if (!PAGE_TYPES.includes(args.type)) throw new ToolError("invalid", `unknown type \`${args.type}\``);
      const pages = visible.filter((p) => p.type === args.type);
      this.taint(pages);
      return { type: args.type, pages: pages.map((p) => this.summary(p)) };
    }

    const root = repo.config.knowledge_root;
    const rel = posix.normalize((args.path ?? "").replace(/^\/+|\/+$/g, "") || ".");
    if (rel.startsWith("..")) throw new ToolError("invalid", "path must stay inside the knowledge root");
    const dir = rel === "." ? root : `${root}/${rel}`;

    const inDir = visible.filter((p) => posix.dirname(p.path) === dir);
    // Only directories that contain at least one visible page, so a team-only
    // directory's existence is not revealed.
    const dirs = [
      ...new Set(
        visible
          .filter((p) => p.path.startsWith(`${dir}/`) && posix.dirname(p.path) !== dir)
          .map((p) => p.path.slice(dir.length + 1).split("/")[0]!),
      ),
    ].sort();
    const index = inDir.find((p) => posix.basename(p.path) === "index.md");
    if (!index && inDir.length === 0 && dirs.length === 0) throw new ToolError("not_found", `no directory \`${rel}\``);
    this.taint(inDir);
    return {
      path: rel,
      index: index ? this.summary(index) : null,
      pages: inDir.filter((p) => p !== index).map((p) => this.summary(p)),
      dirs: dirs.map((d) => (rel === "." ? d : `${rel}/${d}`)),
    };
  }

  async stale(args: { owner_team?: string } = {}): Promise<{ pages: StaleEntry[] }> {
    const who = await this.identity.get();
    this.permit("stale", who);
    const repo = this.current();
    const pages = listStale(visiblePages(repo, who), repo, this.now(), args.owner_team);
    this.taint(pages.map((p) => repo.byId.get(p.id)!));
    return { pages };
  }

  // The web app's views (HTTP sessions only; tool-registry.ts). Each answers to the `list`
  // policy, works over visiblePages like every read, and taints the session with exactly
  // the restricted pages its response names, as `list` does.

  /** Who is served and whether writes would work, for the app's header and settings. */
  async uiCapabilities(opts: { pro?: string[] } = {}) {
    const who = await this.identity.get();
    this.permit("ui_capabilities", who);
    const repo = this.current();
    const config = repo.config;
    // Owners the app can offer: teams of pages the caller sees, and the teams CODEOWNERS
    // names (it is part of the repository). Names only, never a page: nothing is tainted.
    const teams = [
      ...new Set([
        ...visiblePages(repo, who).map((p) => p.owner_team),
        ...repo.codeowners.rules.flatMap((r) => r.owners.filter((o) => o.kind === "team" && o.org?.toLowerCase() === config.github.org).map((o) => o.team!.toLowerCase())),
      ]),
    ].sort();
    // The write tools the policy lets this identity call (each also needs what follows).
    const allowed = [...WRITE_TOOLS].filter((t) => !toolRefusal(config.policy, config.github.org, t, who)).sort();
    const writesOff =
      config.policy.writes === "disabled"
        ? "writes are disabled by policy (policy.writes in .knowledge/config.yaml)"
        : who.mode !== "github" || !config.github.repo
          ? "writes need github.repo in .knowledge/config.yaml and a GitHub token"
          : !who.canWrite
            ? `your token has no push access to ${config.github.repo}`
            : allowed.length === 0
              ? "the policy allows you none of the write tools"
              : null;
    return {
      mode: who.mode,
      login: who.login,
      org: config.github.org,
      repo: config.github.repo ?? null,
      writes: writesOff === null,
      write_tools: writesOff === null ? allowed : [],
      teams,
      ...(writesOff ? { writes_off: writesOff } : {}),
      pro: opts.pro ?? [],
    };
  }

  /** Counts over the caller's visible pages, by team, with what is due soon and what is stale. */
  async uiOverview() {
    const who = await this.identity.get();
    this.permit("ui_overview", who);
    const repo = this.current();
    const visible = visiblePages(repo, who);
    const pages = visible.map((p) => ({ page: p, s: this.summary(p) }));
    const tally = (xs: typeof pages) => ({
      pages: xs.length,
      citable: xs.filter((x) => x.s.citable).length,
      overdue: xs.filter((x) => x.s.sla_state === "overdue").length,
      due_soon: xs.filter((x) => x.s.sla_state === "due_soon").length,
    });
    const dueSoon = pages.filter((x) => x.s.sla_state === "due_soon").sort((a, b) => (a.s.due ?? "").localeCompare(b.s.due ?? ""));
    const stale = listStale(visible, repo, this.now());
    this.taint([...dueSoon.map((x) => x.page), ...stale.map((e) => repo.byId.get(e.id)!)]);
    return {
      as_of: formatDate(utcToday(this.now())),
      totals: { ...tally(pages), draft: pages.filter((x) => x.s.status === "draft").length, deprecated: pages.filter((x) => x.s.status === "deprecated").length },
      teams: [...new Set(pages.map((x) => x.s.owner_team))].sort().map((team) => ({ team, ...tally(pages.filter((x) => x.s.owner_team === team)) })),
      due_soon: dueSoon.map((x) => x.s),
      stale,
    };
  }

  /**
   * A page as `read` shows it, with `links`: the repo path and id of each visible page it
   * links to, so the app can route those links. Taints the session with the page and those.
   */
  async uiPage(args: { id: string }) {
    const r = await this.readWith("ui_page", args, false);
    if (r.kind === "mirror") return { ...r.shown, links: {} }; // a mirrored page links to no repo page
    // The links come from the look at the repo the read took, with its caller: the links in
    // what the caller is shown, never a later look that a reload could have changed.
    const { shown, page, who, repo } = r;
    // The links in what the caller is shown: redaction can drop a whole line, and a link to
    // a visible page on it with it, which then names nothing and taints nothing.
    const linked = new Map<string, Page>();
    for (const link of extractLinks(shown.content)) {
      const target = repo.byPath.get(resolveLink(page.path, link));
      if (target && target !== page && canSee(target, who)) linked.set(target.path, target);
    }
    this.taint(linked.values());
    return { ...shown, links: Object.fromEntries([...linked].map(([path, p]) => [path, p.id])) };
  }

  /**
   * Visible pages and the links between them. A link to a page the caller can't see is no
   * edge; `has_restricted_links` says a page has one, exactly as its `read` text shows a
   * placeholder for it, so the graph reveals nothing `read` doesn't.
   */
  async uiGraph(args: { owner_team?: string } = {}) {
    const who = await this.identity.get();
    this.permit("ui_graph", who);
    const repo = this.current();
    // One team's pages, for its page in the app: only those are named, so only those taint.
    const visible = visiblePages(repo, who).filter((p) => !args.owner_team || p.owner_team === args.owner_team);
    const seen = new Set(visible);
    const edges = new Map<string, { from: string; to: string }>();
    for (const p of visible)
      for (const link of p.links) {
        const target = repo.byPath.get(resolveLink(p.path, link));
        if (target && target !== p && seen.has(target)) edges.set(`${p.id}\0${target.id}`, { from: p.id, to: target.id });
      }
    this.taint(visible);
    return {
      nodes: visible.map((p) => ({ ...this.summary(p), has_restricted_links: this.pageText(p, who).includes(RESTRICTED) })),
      edges: [...edges.values()],
    };
  }

  /** What every write needs first: the policy, a live identity, a GitHub repo. */
  private async writeIdentity(tool: string) {
    // A global switch needs no identity: refuse before GitHub is asked anything.
    if (this.current().config.policy.writes === "disabled") this.permit(tool, LOCAL_IDENTITY_FOR_POLICY);
    const who = await this.identity.fresh();
    this.permit(tool, who);
    const gh = this.identity.github;
    const repoSlug = this.current().config.github.repo;
    if (who.mode !== "github" || !gh || !repoSlug)
      throw new ToolError("unavailable", "writes need github.repo in .knowledge/config.yaml and a GitHub token");
    return { who, gh, repoSlug };
  }

  private async pushContext(who: Identity, gh: GitHubClient, repoSlug: string) {
    if (!who.canWrite) throw new ToolError("forbidden", `your token has no push access to ${repoSlug}`);
    this.defaultBranch ??= this.repo.config.github.default_branch ?? (await gh.getRepo(repoSlug)).default_branch;
    return this.defaultBranch;
  }

  /** Common preamble for writes to a page: live identity, visibility, a GitHub repo. */
  private async writeContext(tool: string, id: string) {
    const { who, gh, repoSlug } = await this.writeIdentity(tool);
    const page = this.resolve(id, who);
    const base = await this.pushContext(who, gh, repoSlug);
    return { who, gh, repoSlug, page, base };
  }

  /** The same for a write that creates a page: no id to resolve. */
  private async newWriteContext(tool: string) {
    const { who, gh, repoSlug } = await this.writeIdentity(tool);
    const base = await this.pushContext(who, gh, repoSlug);
    return { who, gh, repoSlug, base };
  }

  /** The taint check: a session that saw team-only pages writes only into pages with that audience. */
  private refuseLeak(tool: string, acl: string, what: string): void {
    const leaking = [...this.tainted].filter((a) => a !== acl);
    if (leaking.length)
      throw new ToolError(
        "forbidden",
        `this session read pages restricted to ${leaking.map((a) => `@${this.repo.config.github.org}/${a}`).join(", ")}; ${tool} can only ${what} (this ${tool === "draft_page" ? "one would be" : "page is"} \`${acl}\`)`,
      );
  }

  async proposeEdit(args: { id: string; edits?: Edit[]; body?: string; content?: string; append?: string; reason: string; draft?: boolean; polish?: boolean }) {
    if (!args.reason?.trim()) throw new ToolError("invalid", "a reason is required");
    if ((args.edits ? 1 : 0) + (args.body !== undefined ? 1 : 0) + (args.content !== undefined ? 1 : 0) + (args.append !== undefined ? 1 : 0) !== 1)
      throw new ToolError("invalid", "give exactly one of `edits`, `body`, `content` or `append`");
    if (args.append !== undefined) {
      if (!args.append.trim()) throw new ToolError("invalid", "`append` is empty");
      if (args.polish) throw new ToolError("invalid", "an `append` adds text, so it can't be a polish");
      // In `read`, the placeholder stands where a link the caller can't see is; written
      // into the page it would read as one.
      if (args.append.includes(RESTRICTED)) throw new ToolError("invalid", `\`append\` contains \`${RESTRICTED}\`, which \`read\` shows in place of a link you can't see; leave it out`);
    }
    const { who, gh, repoSlug, page, base } = await this.writeContext("propose_edit", args.id);

    // Taint check: once this session has seen a team-only page, refuse to write into a
    // page with a different (broader) audience, which could carry that content out.
    this.refuseLeak("propose_edit", page.acl, "target pages with the same audience");

    let checked: string | undefined;
    const pr = await openPagePr(gh, {
      repo: repoSlug,
      baseBranch: base,
      verb: "propose",
      pageId: page.id,
      path: page.path,
      transform: (current) => {
        // A link the caller can't see shows in `read` as a placeholder. Checked before
        // anything is applied, so neither a refusal nor whether an edit matched can tell
        // the caller anything about it. On such a page only `edits` are taken: a whole
        // new body or file written from the redacted view would overwrite or drop those
        // links, and a polish refusal would name them.
        const currentBody = splitFrontmatter(current).body;
        // As `read` shows it: links to hidden repo pages and, when the mirror is served,
        // to hidden mirrored pages.
        // An append adds to the page as it is on the default branch: the caller's view of
        // the rest, redacted or stale, never goes back into it.
        if (args.append !== undefined) return `${current.replace(/\s*$/, "")}\n\n${args.append.trim()}\n`;
        const hidesLinks = this.pageText(page, who, currentBody) !== currentBody;
        if (hidesLinks && (args.polish || !args.edits))
          throw new ToolError(
            "invalid",
            `this page links to pages you can't see (\`${RESTRICTED}\` in \`read\`), so ${args.polish ? "it can't be polished from your view" : "a whole new `body` or `content` written from your view would overwrite or drop those links"}; propose specific changes with \`edits\` instead`,
          );
        let next: string;
        try {
          next = args.edits ? applyEdits(current, args.edits) : args.body !== undefined ? replaceBody(current, args.body) : args.content!;
          assertProtectedFieldsUnchanged(current, next);
        } catch (err) {
          throw new ToolError("invalid", (err as Error).message);
        }
        // An edit that writes the placeholder would leave it where a reader expects a link.
        // Each edit's own text is checked: a total could balance a literal one removed.
        if (hidesLinks && (args.edits!.some((e) => e.new.includes(RESTRICTED)) || count(next, RESTRICTED) > count(current, RESTRICTED)))
          throw new ToolError("invalid", `the proposal contains \`${RESTRICTED}\`, which \`read\` shows in place of a link you can't see; writing it would replace that link. Leave those parts out: use \`edits\` and change only the text around them`);
        // A polish keeps the frontmatter byte for byte and every link target, so the page
        // stays as valid as it was: lint's page checks read only those.
        if (args.polish) {
          const changes = polishChanges(current, next);
          if (changes.length)
            throw new ToolError("invalid", `a polish must not change what the page says, but this one ${changes.slice(0, 8).join("; ")}${changes.length > 8 ? `; and ${changes.length - 8} more` : ""}. Keep those as they are, or propose it as an ordinary edit`);
          checked = polishSummary(current);
        }
        return next;
      },
      commitMessage: `docs(${page.id}): ${args.polish ? "polish" : args.append !== undefined ? "proposed addition" : "proposed edit"}\n\n${args.reason.trim()}`,
      title: args.polish ? `polish(${page.id}): ${page.title}` : args.append !== undefined ? `Proposed addition: ${page.title}` : `Proposed edit: ${page.title}`,
      body: () => [
        `**Page:** \`${page.id}\` (${page.path}), owned by @${this.repo.config.github.org}/${page.owner_team}`,
        "",
        "**Reason given by the agent:**",
        "",
        args.reason.trim(),
        ...(checked
          ? [
              "",
              "**Polish guard:** " + checked + ".",
              "The guard compares structure only. It can't tell when a reworded sentence now means something else, so please read the diff before approving.",
            ]
          : []),
        "",
        `_Opened by Docsworth \`propose_edit\` on behalf of @${who.login}. Nothing merges without owner review._`,
      ].join("\n"),
      draft: args.draft,
    });
    return { pr_url: pr.url, pr_number: pr.number, branch: pr.branch };
  }

  /**
   * A new page, as a draft PR. The server picks its id and file name, each ending in 12
   * random hex digits: a caller-chosen name could be aimed at a hidden page, and "already
   * exists" would then say it is there. The title still sets the slug, so CODEOWNERS
   * rules that match file names (`runbooks/payments-*`) still apply.
   */
  async draftPage(args: {
    type: NewPageType;
    title: string;
    owner_team: string;
    acl?: string;
    dir?: string;
    description?: string;
    body: string;
    source_url?: string;
    reason: string;
    draft?: boolean;
  }) {
    if (!args.reason?.trim()) throw new ToolError("invalid", "a reason is required");
    const oneLine = (v: string | undefined, name: string, max: number) => {
      if (v === undefined) return;
      if (!v.trim() || v.length > max || /[\u0000-\u001f\u007f\u2028\u2029]/.test(v)) throw new ToolError("invalid", `\`${name}\` must be one line of 1 to ${max} characters`);
    };
    oneLine(args.title, "title", 200);
    oneLine(args.description, "description", 280);
    if (!(args.type in NEW_PAGE_PREFIX)) throw new ToolError("invalid", "`type` must be runbook, service, guide or policy; ADRs are written by hand");
    if (!args.body?.trim()) throw new ToolError("invalid", "`body` is empty");
    if (args.body.length > DRAFT_MAX_CHARS) throw new ToolError("invalid", `\`body\` is over ${DRAFT_MAX_CHARS / 1024} KB`);
    let source: string | undefined;
    if (args.source_url !== undefined) {
      const url = URL.canParse(args.source_url) ? new URL(args.source_url) : null;
      if (!url || !/^https?:$/.test(url.protocol) || url.href.length > 2000 || /[\s<>]/.test(url.href)) throw new ToolError("invalid", "`source_url` must be an http or https URL");
      source = url.href;
    }
    const { who, gh, repoSlug, base } = await this.newWriteContext("draft_page");
    const repo = this.current();
    const acl = args.acl ?? ACL_INTERNAL;
    if (acl !== ACL_INTERNAL && !who.teams.has(acl.toLowerCase()))
      throw new ToolError("forbidden", `a new page's \`acl\` must be \`internal\` or a team you're on, not \`${acl}\``);
    this.refuseLeak("draft_page", acl, "create pages with the same audience");

    const today = formatDate(utcToday(this.now()));
    const slug = slugify(args.title).slice(0, 40).replace(/-+$/, "") || "page";
    const body = `${source ? `> Captured from <${source}> on ${today}. Review it before merging.\n\n` : ""}${args.body.replace(/\s*$/, "")}\n`;
    // Where CODEOWNERS routes by file name (`runbooks/payments-*`), a name the directory's
    // own rule gives to another team is tried again as `<owner_team>-<slug>-<hex>`. Still
    // server-named, and the owner check in buildNewPage decides, as for the plain name.
    const teamPrefix = slugify(args.owner_team);
    for (let attempt = 0; attempt < DRAFT_NAME_ATTEMPTS; attempt++) {
      const suffix = this.draftSuffix();
      const build = (stem: string) =>
        buildNewPage(repo, {
          type: args.type,
          title: args.title,
          id: `${NEW_PAGE_PREFIX[args.type]}-${stem}`,
          slug: stem,
          ownerTeam: args.owner_team,
          status: "draft",
          dir: args.dir,
          acl,
          description: args.description,
          body,
          now: this.now(),
        });
      const plain = build(`${slug}-${suffix}`);
      const mismatch = !plain.ok && plain.problem.kind === "owner_mismatch" ? plain.problem : null;
      const built = mismatch ? build(`${teamPrefix}-${slug}-${suffix}`) : plain;
      if (!built.ok) {
        const p = built.problem;
        // A name already in use: pick another, and never say which.
        if (p.kind === "id_taken" || p.kind === "path_taken") continue;
        if (p.kind === "bad_dir") throw new ToolError("invalid", `\`dir\` must be a relative path under ${repo.config.knowledge_root}/ without . or .. segments`);
        if (p.kind === "owner_mismatch") {
          // Name the directory the page would go in (a service gets its own directory under
          // it), the team its rule gives it to, and the prefix that was tried there.
          const { assigned, path } = mismatch ?? p;
          const where = args.type === "service" && args.dir === undefined ? posix.dirname(posix.dirname(path)) : posix.dirname(path);
          const org = repo.config.github.org;
          throw new ToolError(
            "invalid",
            `CODEOWNERS ${assigned ? `assigns @${org}/${assigned}` : "assigns no single team"} there (${where}/) and doesn't give @${org}/${args.owner_team} \`${where}/${teamPrefix}-*\`; give a \`dir\` that @${org}/${args.owner_team} owns`,
          );
        }
        throw new ToolError("invalid", p.kind === "invalid" ? `the page would not lint: ${p.issues.join("; ")}` : "ADRs are written by hand");
      }
      try {
        const pr = await openPagePr(gh, {
          repo: repoSlug,
          baseBranch: base,
          verb: "draft",
          pageId: built.id,
          path: built.path,
          create: true,
          transform: () => built.content,
          commitMessage: `docs(${built.id}): draft\n\n${args.reason.trim()}`,
          title: `Draft: ${args.title}`,
          body: [
            `**New page:** \`${built.id}\` (${built.path}), owned by @${repo.config.github.org}/${args.owner_team}${acl === ACL_INTERNAL ? "" : `, visible to @${repo.config.github.org}/${acl}`}`,
            "",
            "**Reason given:**",
            "",
            args.reason.trim(),
            ...(source ? ["", `**Source:** <${source}>`] : []),
            "",
            `_Opened by Docsworth \`draft_page\` on behalf of @${who.login}. The page is \`status: draft\`, so it can't be cited until its owners make it canonical. Rename its id and file before merging if you like._`,
          ].join("\n"),
          draft: args.draft ?? true,
        });
        return { id: built.id, path: built.path, pr_url: pr.url, pr_number: pr.number, branch: pr.branch };
      } catch (err) {
        if (err instanceof WriteError && err.message === `${built.path} already exists on ${base}`) continue;
        throw err;
      }
    }
    throw new ToolError("unavailable", "couldn't find a free name for the new page; try again");
  }

  async verify(args: { id: string }) {
    const { who, gh, repoSlug, page, base } = await this.writeContext("verify", args.id);
    if (!who.teams.has(page.owner_team.toLowerCase()))
      throw new ToolError("forbidden", `only members of @${this.repo.config.github.org}/${page.owner_team} can verify \`${page.id}\``);
    const today = formatDate(utcToday(this.now()));
    const pr = await openPagePr(gh, {
      repo: repoSlug,
      baseBranch: base,
      verb: "verify",
      pageId: page.id,
      path: page.path,
      transform: (current) => setLastVerified(current, today),
      commitMessage: `docs(${page.id}): verified ${today}`,
      title: `Verify: ${page.title} (${today})`,
      body: `@${who.login} (@${this.repo.config.github.org}/${page.owner_team}) verified \`${page.id}\` on ${today} via Docsworth \`verify\`.`,
    });
    return { pr_url: pr.url, pr_number: pr.number, branch: pr.branch, last_verified: today };
  }
}
