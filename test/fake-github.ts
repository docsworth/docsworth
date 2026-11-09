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
}

/** The fake org's numeric id, as in `x-github-sso: partial-results; organizations=…`. */
export const FAKE_ORG_ID = 4242;

interface FileRec {
  content: string;
  sha: string;
}

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
  readonly pulls: { number: number; title: string; head: string; base: string; body: string; draft?: boolean }[] = [];
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
    if (seedDir) for (const [path, content] of walk(seedDir)) main.set(path, { content, sha: sha(content) });
    this.branches.set(this.defaultBranch, main);
  }

  file(path: string, branch = this.defaultBranch): string | undefined {
    return this.branches.get(branch)?.get(path)?.content;
  }

  /** fetch-compatible entry point. */
  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const { status, json, headers } = this.handle((init.method ?? "GET").toUpperCase(), u.pathname, u.searchParams, auth.replace(/^Bearer /, ""), body);
    return new Response(json === undefined ? "" : JSON.stringify(json), { status, headers: { "content-type": "application/json", ...headers } });
  };

  private handle(method: string, path: string, q: URLSearchParams, token: string, body?: Record<string, unknown>): { status: number; json?: unknown; headers?: Record<string, string> } {
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
        files.set(filePath, { content, sha: sha(content) });
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
      this.pulls.push({ number, title: String(body?.title), head, base: String(body?.base), body: String(body?.body), draft: body?.draft as boolean | undefined });
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
