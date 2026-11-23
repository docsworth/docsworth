import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, relative, sep } from "node:path";

export interface FakeUser {
  login: string;
  /** Team slugs in the repo's org. */
  teams: string[];
  push: boolean;
  /** false → GET /repos/:repo answers 404, as GitHub does for repos you cannot see. */
  access?: boolean;
  /** true → GET /user/teams answers 403 (token without read:org). */
  noReadOrg?: boolean;
  /**
   * SAML SSO not authorized for this token. `required`: repo calls answer 403 with
   * `x-github-sso: required; url=…`. `partial`: /user/teams omits the org's teams and
   * says so in `x-github-sso: partial-results; organizations=<org id>`.
   */
  sso?: "required" | "partial" | "teams-required";
  /** true → the PR endpoints answer 403 (a fine-grained token without Pull requests: read). */
  noPulls?: boolean;
  /** true → contents and blobs answer 403 (a fine-grained token without Contents: read). */
  noContents?: boolean;
}

/** The fake org's numeric id, as in `x-github-sso: partial-results; organizations=…`. */
export const FAKE_ORG_ID = 4242;
/** The fake repo's numeric id: a PR's base repo, and its head repo unless it's a fork. */
export const FAKE_REPO_ID = 777;

interface FileRec {
  content: string;
  sha: string;
}

/** A file in a PR's diff, as GET …/pulls/:n/files lists it. */
export interface FakePullFile {
  filename: string;
  status: string;
  sha: string;
  previous_filename?: string;
}

export interface FakePull {
  number: number;
  title: string;
  head: string;
  base: string;
  body: string;
  draft?: boolean;
  state: "open" | "closed";
  merged_at: string | null;
  closed_at: string | null;
  /** The default branch when the PR was opened: its merge base, what the head is diffed against. */
  baseFiles: Map<string, FileRec>;
  /** The head's files, kept when it merges, since its branch may then be deleted. */
  headFiles?: Map<string, FileRec>;
  /** null: the fork it came from was deleted. */
  headRepoId: number | null;
  /** Set by rawPull: the diff as given, not computed. */
  files?: FakePullFile[];
  /** Set by rawPull: `changed_files` as given. */
  changedFiles?: number;
  /** Set by rawPull: the files list says there's a next page, however long it is. */
  moreFiles?: boolean;
  reviews: { user: { id: number; login: string } | null; state: string }[];
}

/** A rawPull file: its content (stored as a blob), or a bare sha (a gitlink, say). */
export type RawPullFile = { filename: string; status: string; previous_filename?: string } & ({ content: string } | { sha: string });

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

/**
 * An in-memory GitHub REST API covering exactly the endpoints Docsworth calls. It is
 * also the R13 enforcement point in tests: any mutation that does not carry an
 * explicit, non-default branch, or that targets a branch this session did not create,
 * is recorded in `violations` (and, like real GitHub, a branch-less PUT lands on main).
 */
export class FakeGitHub {
  readonly defaultBranch = "main";
  readonly branches = new Map<string, Map<string, FileRec>>();
  readonly createdBranches = new Set<string>();
  readonly pulls: FakePull[] = [];
  /** Every file content ever stored, by blob sha, as GET …/git/blobs/:sha serves them. */
  readonly blobs = new Map<string, string>();
  /** When set, GET …/git/blobs/:sha answers this instead (a rate limit, a 5xx). */
  blobError: { status: number; json: unknown; headers?: Record<string, string> } | null = null;
  /** When set, GET …/pulls/:n answers this instead. */
  pullError: { status: number; json: unknown; headers?: Record<string, string> } | null = null;
  readonly violations: string[] = [];
  readonly requests: { method: string; path: string; body?: unknown }[] = [];
  /** Ruleset rules returned for the default branch, or the error GitHub gives instead. */
  branchRules: { type: string; parameters?: Record<string, unknown>; ruleset_id?: number }[] = [];
  /** Rulesets by id, as GET /repos/:repo/rulesets/:id returns them. */
  readonly rulesets = new Map<number, Record<string, unknown>>();
  rulesError: { status: number; json: unknown } | null = null;
  /** Classic protection: a body (admin view), or the status GitHub gives non-admins. */
  protection: { status: number; json: unknown } = { status: 404, json: { message: "Branch not protected" } };
  /** Teams whose member list answers 404 (e.g. a secret team the token can't see). */
  readonly hiddenTeams = new Set<string>();
  /** When set, GET …/collaborators/:login/permission answers 403 (token can't see it). */
  permissionsHidden = false;
  /** Team → write access on the repo (default true); "hidden" answers 403. */
  readonly teamWrite = new Map<string, boolean | "hidden" | "notfound">();
  private server: Server | null = null;

  constructor(
    readonly repo: string,
    readonly org: string,
    public users: Record<string, FakeUser>,
    seedDir?: string,
  ) {
    const main = new Map<string, FileRec>();
    if (seedDir) for (const [path, content] of walk(seedDir)) main.set(path, this.rec(content));
    this.branches.set(this.defaultBranch, main);
  }

  file(path: string, branch = this.defaultBranch): string | undefined {
    return this.branches.get(branch)?.get(path)?.content;
  }

  /** A file record, its content stored as a blob. */
  private rec(content: string): FileRec {
    const s = sha(content);
    this.blobs.set(s, content);
    return { content, sha: s };
  }

  /** Set a file on a branch directly, as a person pushing would (not through Docsworth). */
  push(branch: string, path: string, content: string | null): void {
    const files = this.branches.get(branch);
    if (!files) throw new Error(`fake: no branch ${branch}`);
    if (content === null) files.delete(path);
    else files.set(path, this.rec(content));
  }

  /** Merge a PR: its diff lands on the default branch, and its branch is deleted. */
  merge(n: number, at = "2026-11-02T12:00:00Z"): void {
    const pr = this.pull(n);
    const head = this.headFilesOf(pr);
    const main = this.branches.get(this.defaultBranch)!;
    for (const f of this.diff(pr)) {
      if (f.status === "removed") main.delete(f.filename);
      else main.set(f.filename, head.get(f.filename)!);
    }
    pr.headFiles = head;
    this.branches.delete(pr.head);
    Object.assign(pr, { state: "closed", merged_at: at, closed_at: at });
  }

  closePull(n: number, at = "2026-11-02T12:00:00Z"): void {
    Object.assign(this.pull(n), { state: "closed", closed_at: at });
  }

  review(n: number, user: { id: number; login: string } | null, state: string): void {
    this.pull(n).reviews.push({ user, state });
  }

  /**
   * A PR built by hand, as anyone with push (or a fork) could open one: its branch, diff,
   * head repo and `changed_files` are as given, not as Docsworth would make them.
   */
  rawPull(args: { head: string; base?: string; files: RawPullFile[]; headRepoId?: number | null; changedFiles?: number; moreFiles?: boolean; draft?: boolean }): number {
    const number = this.pulls.length + 1;
    const files = args.files.map((f) => ({
      filename: f.filename,
      status: f.status,
      sha: "content" in f ? this.rec(f.content).sha : f.sha,
      ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
    }));
    this.pulls.push({
      number,
      title: `Raw ${number}`,
      head: args.head,
      base: args.base ?? this.defaultBranch,
      body: "",
      draft: args.draft,
      state: "open",
      merged_at: null,
      closed_at: null,
      baseFiles: new Map(this.branches.get(this.defaultBranch)),
      headRepoId: args.headRepoId === undefined ? FAKE_REPO_ID : args.headRepoId,
      files,
      changedFiles: args.changedFiles ?? files.length,
      moreFiles: args.moreFiles,
      reviews: [],
    });
    return number;
  }

  private pull(n: number): FakePull {
    const pr = this.pulls.find((p) => p.number === n);
    if (!pr) throw new Error(`fake: no PR #${n}`);
    return pr;
  }

  private headFilesOf(pr: FakePull): Map<string, FileRec> {
    return this.branches.get(pr.head) ?? pr.headFiles ?? new Map();
  }

  /** A PR's diff: as given (rawPull), or its head against the merge base. */
  private diff(pr: FakePull): FakePullFile[] {
    if (pr.files) return pr.files;
    const head = this.headFilesOf(pr);
    const out: FakePullFile[] = [];
    for (const [filename, rec] of head) {
      const before = pr.baseFiles.get(filename);
      if (!before) out.push({ filename, status: "added", sha: rec.sha });
      else if (before.sha !== rec.sha) out.push({ filename, status: "modified", sha: rec.sha });
    }
    for (const [filename, rec] of pr.baseFiles) if (!head.has(filename)) out.push({ filename, status: "removed", sha: rec.sha });
    return out.sort((a, b) => a.filename.localeCompare(b.filename));
  }

  /** fetch-compatible entry point. */
  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const h = new Headers(init.headers);
    const auth = h.get("authorization") ?? "";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const { status, json, raw, headers } = this.handle((init.method ?? "GET").toUpperCase(), u.pathname, u.searchParams, auth.replace(/^Bearer /, ""), body, h.get("accept") ?? "");
    if (raw !== undefined) return new Response(raw, { status, headers: { "content-type": "application/vnd.github.raw", ...headers } });
    return new Response(json === undefined ? "" : JSON.stringify(json), { status, headers: { "content-type": "application/json", ...headers } });
  };

  private handle(
    method: string,
    path: string,
    q: URLSearchParams,
    token: string,
    body?: Record<string, unknown>,
    accept = "",
  ): { status: number; json?: unknown; raw?: string; headers?: Record<string, string> } {
    this.requests.push({ method, path, body });
    const user = this.users[token];
    if (!user) return { status: 401, json: { message: "Bad credentials" } };
    const repoPrefix = `/repos/${this.repo}`;

    if (method === "GET" && path === "/user") return { status: 200, json: { login: user.login } };
    if (method === "GET" && path === "/user/teams") {
      if (user.noReadOrg) return { status: 403, json: { message: "Resource not accessible by integration" } };
      if (user.sso === "partial") return { status: 200, json: [], headers: { "x-github-sso": `partial-results; organizations=${FAKE_ORG_ID}` } };
      if (user.sso === "teams-required")
        return { status: 403, json: { message: "Resource protected by organization SAML enforcement." }, headers: { "x-github-sso": `required; url=https://github.com/orgs/${this.org}/sso?authorization_request=TEAMS456` } };
      return { status: 200, json: user.teams.map((slug) => ({ slug, organization: { login: this.org } })) };
    }
    const teamRepo = new RegExp(`^/orgs/${this.org}/teams/([^/]+)/repos/${this.repo}$`).exec(path);
    if (method === "GET" && teamRepo) {
      const w = this.teamWrite.get(decodeURIComponent(teamRepo[1]!)) ?? true;
      if (w === "hidden") return { status: 403, json: { message: "Must have admin rights" } };
      if (w === "notfound") return { status: 404, json: { message: "Not Found" } };
      return { status: 200, json: { full_name: this.repo, permissions: { pull: true, push: w } } };
    }
    const members = new RegExp(`^/orgs/${this.org}/teams/([^/]+)/members$`).exec(path);
    if (method === "GET" && members) {
      const slug = decodeURIComponent(members[1]!);
      if (this.hiddenTeams.has(slug)) return { status: 404, json: { message: "Not Found" } };
      return { status: 200, json: Object.values(this.users).filter((u) => u.teams.includes(slug)).map((u) => ({ login: u.login })) };
    }
    if (user.sso === "required" && path.startsWith(`/repos/${this.repo}`))
      return {
        status: 403,
        json: { message: "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization." },
        headers: { "x-github-sso": `required; url=https://github.com/orgs/${this.org}/sso?authorization_request=FAKE123` },
      };
    if (!path.startsWith(repoPrefix) || user.access === false) return { status: 404, json: { message: "Not Found" } };
    const rest = decodeURIComponent(path.slice(repoPrefix.length));

    if (method === "GET" && rest === "")
      return { status: 200, json: { full_name: this.repo, default_branch: this.defaultBranch, private: true, permissions: { pull: true, push: user.push }, owner: { login: this.org, id: FAKE_ORG_ID } } };

    const perm = /^\/collaborators\/([^/]+)\/permission$/.exec(rest);
    if (method === "GET" && perm) {
      if (this.permissionsHidden) return { status: 403, json: { message: "Must have push access to view repository collaborators." } };
      const who = Object.values(this.users).find((u) => u.login === perm[1]);
      return { status: 200, json: { permission: who?.access === false ? "none" : who?.push ? "write" : "read" } };
    }
    if (method === "GET" && rest === `/rules/branches/${this.defaultBranch}`) return this.rulesError ?? { status: 200, json: this.branchRules };
    if (method === "GET" && rest === `/branches/${this.defaultBranch}/protection`) return this.protection;
    const ruleset = /^\/rulesets\/(\d+)$/.exec(rest);
    if (method === "GET" && ruleset) {
      const r = this.rulesets.get(Number(ruleset[1]));
      return r ? { status: 200, json: r } : { status: 404, json: { message: "Not Found" } };
    }

    if (user.noContents && (rest.startsWith("/contents/") || rest.startsWith("/git/blobs/")))
      return { status: 403, json: { message: "Resource not accessible by personal access token" } };
    if (user.noPulls && rest.startsWith("/pulls")) return { status: 403, json: { message: "Resource not accessible by personal access token" } };

    const blob = /^\/git\/blobs\/([^/]+)$/.exec(rest);
    if (method === "GET" && blob) {
      if (this.blobError) return this.blobError;
      const content = this.blobs.get(blob[1]!);
      // GitHub refuses a sha that isn't a blob (a gitlink's commit, say).
      if (content === undefined) return { status: 404, json: { message: "Not Found" } };
      if (accept.includes("raw")) return { status: 200, raw: content };
      return { status: 200, json: { sha: blob[1], size: Buffer.byteLength(content), encoding: "base64", content: Buffer.from(content).toString("base64") } };
    }

    const pullRoute = /^\/pulls\/(\d+)(\/files|\/reviews)?$/.exec(rest);
    if (method === "GET" && pullRoute) {
      if (!pullRoute[2] && this.pullError) return this.pullError;
      const pr = this.pulls.find((p) => p.number === Number(pullRoute[1]));
      if (!pr) return { status: 404, json: { message: "Not Found" } };
      if (pullRoute[2] === "/files") {
        const files = this.diff(pr);
        const per = Number(q.get("per_page") ?? 30);
        const more = files.length > per || Boolean(pr.moreFiles);
        return {
          status: 200,
          json: files.slice(0, per),
          headers: more ? { link: `<https://api.github.com${path}?per_page=${per}&page=2>; rel="next"` } : {},
        };
      }
      if (pullRoute[2] === "/reviews") return { status: 200, json: pr.reviews };
      return {
        status: 200,
        json: {
          number: pr.number,
          html_url: `https://github.com/${this.repo}/pull/${pr.number}`,
          title: pr.title,
          state: pr.state,
          merged_at: pr.merged_at,
          closed_at: pr.closed_at,
          updated_at: pr.closed_at ?? "2026-11-02T09:00:00Z",
          draft: Boolean(pr.draft),
          changed_files: pr.changedFiles ?? this.diff(pr).length,
          head: { ref: pr.head, sha: sha(`head:${pr.number}`), repo: pr.headRepoId === null ? null : { id: pr.headRepoId } },
          base: { ref: pr.base, repo: { id: FAKE_REPO_ID } },
        },
      };
    }

    if (rest.startsWith("/contents/")) {
      const filePath = rest.slice("/contents/".length);
      if (method === "GET") {
        const rec = this.branches.get(q.get("ref") ?? this.defaultBranch)?.get(filePath);
        if (!rec) return { status: 404, json: { message: "Not Found" } };
        return { status: 200, json: { path: filePath, sha: rec.sha, encoding: "base64", content: Buffer.from(rec.content).toString("base64") } };
      }
      if (method === "PUT") {
        if (!user.push) return { status: 403, json: { message: "Must have push access" } };
        const branch = typeof body?.branch === "string" ? body.branch : this.defaultBranch;
        if (body?.branch === undefined) this.violations.push(`PUT ${filePath} without an explicit branch (GitHub writes to ${this.defaultBranch})`);
        if (branch === this.defaultBranch) this.violations.push(`PUT ${filePath} targets the default branch`);
        else if (!this.createdBranches.has(branch)) this.violations.push(`PUT ${filePath} targets ${branch}, which this flow did not create`);
        const files = this.branches.get(branch);
        if (!files) return { status: 404, json: { message: "Branch not found" } };
        const current = files.get(filePath);
        if (current && current.sha !== body?.sha) return { status: 409, json: { message: "sha does not match" } };
        const content = Buffer.from(String(body?.content), "base64").toString("utf8");
        files.set(filePath, this.rec(content));
        return { status: 200, json: { content: { path: filePath } } };
      }
    }

    if (method === "GET" && rest.startsWith("/git/ref/heads/")) {
      const branch = rest.slice("/git/ref/heads/".length);
      if (!this.branches.has(branch)) return { status: 404, json: { message: "Not Found" } };
      return { status: 200, json: { object: { sha: sha(branch) } } };
    }
    if (method === "POST" && rest === "/git/refs") {
      if (!user.push) return { status: 403, json: { message: "Must have push access" } };
      const ref = String(body?.ref ?? "");
      const branch = ref.replace(/^refs\/heads\//, "");
      if (branch === this.defaultBranch) this.violations.push("POST refs re-creates the default branch");
      if (this.branches.has(branch)) return { status: 422, json: { message: "Reference already exists" } };
      this.branches.set(branch, new Map(this.branches.get(this.defaultBranch)));
      this.createdBranches.add(branch);
      return { status: 201, json: { ref } };
    }
    if (method === "DELETE" && rest.startsWith("/git/refs/heads/")) {
      const branch = rest.slice("/git/refs/heads/".length);
      if (branch === this.defaultBranch) this.violations.push("DELETE of the default branch");
      this.branches.delete(branch);
      return { status: 204 };
    }
    if (method === "GET" && rest === "/pulls") {
      const head = (q.get("head") ?? "").split(":")[1];
      return { status: 200, json: this.pulls.filter((p) => p.head === head && p.base === q.get("base")).map((p) => ({ number: p.number, html_url: `https://github.com/${this.repo}/pull/${p.number}`, head: { ref: p.head }, base: { ref: p.base } })) };
    }
    if (method === "POST" && rest === "/pulls") {
      const head = String(body?.head);
      if (!this.createdBranches.has(head)) this.violations.push(`PR head ${head} was not created by this flow`);
      if (body?.base !== this.defaultBranch) this.violations.push(`PR base is ${String(body?.base)}`);
      const number = this.pulls.length + 1;
      this.pulls.push({
        number,
        title: String(body?.title),
        head,
        base: String(body?.base),
        body: String(body?.body),
        draft: body?.draft as boolean | undefined,
        state: "open",
        merged_at: null,
        closed_at: null,
        baseFiles: new Map(this.branches.get(this.defaultBranch)),
        headRepoId: FAKE_REPO_ID,
        reviews: [],
      });
      return { status: 201, json: { number, html_url: `https://github.com/${this.repo}/pull/${number}`, head: { ref: head }, base: { ref: body?.base } } };
    }
    return { status: 404, json: { message: `fake: no route for ${method} ${path}` } };
  }

  /** Serve over HTTP for tests that spawn a real `docsworth mcp` process. */
  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", async () => {
        const r = await this.fetch(`http://fake${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: raw || undefined });
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(await r.text());
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address();
    return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

function* walk(root: string, dir = root): Generator<[string, string]> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) yield* walk(root, abs);
    else yield [relative(root, abs).split(sep).join("/"), readFileSync(abs, "utf8")];
  }
}
