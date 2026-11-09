// Minimal GitHub REST client over fetch. Deliberately small: every call the server makes
// is listed here, which keeps the write path reviewable and lets tests inject a fake.

import { insecureUrl, urlForError } from "./url.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GitHubError extends Error {
  /** GitHub's rate limits: a 429, or a 403 that says so (primary or secondary limit). */
  readonly rateLimited: boolean;
  /** Seconds GitHub asked to wait (`retry-after`, or until `x-ratelimit-reset`), if it said. */
  readonly retryAfter: number | null;

  constructor(
    /** The HTTP status; 0 when GitHub didn't answer (a network error or a timeout). */
    readonly status: number,
    readonly method: string,
    readonly path: string,
    message: string,
    /** Response headers, e.g. `x-github-sso` on a 403 from an SSO-enforcing org. */
    readonly headers: Headers | null = null,
    now: number = Date.now(),
  ) {
    const limited =
      status === 429 ||
      // GitHub's secondary limits come as a 403 (or 429) with `retry-after`, its primary
      // limit with `x-ratelimit-remaining: 0`; the message says so too.
      (status === 403 && (headers?.get("x-ratelimit-remaining") === "0" || Boolean(headers?.has("retry-after")) || /rate limit/i.test(message)));
    const after = Number(headers?.get("retry-after"));
    const reset = Number(headers?.get("x-ratelimit-reset"));
    const wait = Number.isFinite(after) && headers?.has("retry-after") ? after : limited && Number.isFinite(reset) && reset > 0 ? Math.max(0, Math.ceil(reset - now / 1000)) : null;
    super(`GitHub ${method} ${path} → ${status || "no answer"}: ${message}${limited ? ` (rate limited${wait !== null ? `; retry in ${wait} s` : ""})` : ""}`);
    this.rateLimited = limited;
    this.retryAfter = wait;
  }
}

// Reads are retried on what passes (no answer, a 5xx, a rate limit GitHub says lifts
// within a few seconds); writes never are, since a retried POST could open a second PR.
const ATTEMPTS = 3;
const BACKOFF_MS = [500, 1500];
const MAX_WAIT_S = 10;
const TIMEOUT_MS = 30_000;

export interface RepoInfo {
  full_name: string;
  default_branch: string;
  private: boolean;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
  owner?: { login: string; id: number };
}
export interface TeamInfo {
  slug: string;
  organization: { login: string };
}
export interface ContentFile {
  sha: string;
  content: string;
  encoding: string;
  path: string;
}
export interface PullInfo {
  number: number;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

export class GitHubClient {
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    opts: { fetch?: FetchLike; baseUrl?: string; sleep?: (ms: number) => Promise<void>; now?: () => number; timeoutMs?: number } = {},
  ) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    // Also reached from DOCSWORTH_GITHUB_API_URL, which no config schema sees.
    const why = insecureUrl(this.baseUrl);
    if (why) throw new Error(`the GitHub API URL (${urlForError(this.baseUrl)}) ${why}`);
  }

  async request<T>(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<{ data: T; headers: Headers }> {
    const read = method === "GET" || method === "HEAD";
    // Serialized once, outside the retry: a body that can't be (a fault here) throws as is.
    const payload = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      let text: string;
      try {
        res = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept,
            "x-github-api-version": "2022-11-28",
            "user-agent": "docsworth",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        text = await res.text();
      } catch (cause) {
        // No answer: the connection failed (fetch's TypeError, or undici's "terminated" when
        // it drops while the body is read), or nothing came within the timeout. Anything
        // else is a fault here, not GitHub's, and isn't retried.
        const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
        if (!timedOut && !(cause instanceof TypeError)) throw cause;
        const err = new GitHubError(0, method, path, timedOut ? `no answer within ${this.timeoutMs / 1000} s` : `network error (${(cause as Error).message})`, null, this.now());
        if (read && attempt < ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1]!);
          continue;
        }
        throw err;
      }
      if (!res.ok) {
        let message = text.slice(0, 300);
        try {
          message = (JSON.parse(text) as { message?: string }).message ?? message;
        } catch {
          /* non-JSON error body */
        }
        const err = new GitHubError(res.status, method, path, message, res.headers, this.now());
        // A 5xx is retried on the backoff. A rate limit only when GitHub says it lifts
        // within 10 s: without a time, retrying soon prolongs it (GitHub asks for a minute).
        const wait = err.rateLimited ? (err.retryAfter !== null && err.retryAfter <= MAX_WAIT_S ? err.retryAfter * 1000 : null) : res.status >= 500 ? BACKOFF_MS[attempt - 1]! : null;
        if (read && wait !== null && attempt < ATTEMPTS) {
          await this.sleep(wait);
          continue;
        }
        throw err;
      }
      return { data: (text ? JSON.parse(text) : null) as T, headers: res.headers };
    }
  }

  private async get<T>(path: string): Promise<T> {
    return (await this.request<T>("GET", path)).data;
  }

  /** Follow `Link: rel="next"` pagination; `onHeaders` sees every page's headers. */
  async paginate<T>(path: string, onHeaders?: (h: Headers) => void): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next) {
      const { data, headers } = await this.request<T[]>("GET", next);
      onHeaders?.(headers);
      out.push(...data);
      const link = /<([^>]+)>;\s*rel="next"/.exec(headers.get("link") ?? "");
      next = link ? link[1]!.replace(this.baseUrl, "") : null;
    }
    return out;
  }

  getUser(): Promise<{ login: string }> {
    return this.get("/user");
  }
  getRepo(repo: string): Promise<RepoInfo> {
    return this.get(`/repos/${repo}`);
  }
  /**
   * The caller's teams, and the ids of orgs GitHub left out because the token isn't
   * authorized for their SAML SSO (`x-github-sso: partial-results; organizations=…`).
   */
  async listMyTeams(): Promise<{ teams: TeamInfo[]; ssoWithheldOrgIds: string[] }> {
    const withheld = new Set<string>();
    const teams = await this.paginate<TeamInfo>("/user/teams", (h) => {
      for (const id of parseSsoHeader(h.get("x-github-sso")).organizations) withheld.add(id);
    });
    return { teams, ssoWithheldOrgIds: [...withheld] };
  }
  /** Logins of a team's members (needs read:org, or members:read on a fine-grained token). */
  async listTeamMembers(org: string, team: string): Promise<string[]> {
    return (await this.paginate<{ login: string }>(`/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/members`)).map((m) => m.login);
  }
  /**
   * Does a team have write access to a repo? GitHub ignores a CODEOWNERS team without it.
   * true/false when GitHub shows the permission; null on a 404, which GitHub gives both
   * for "no access" and for a team this caller can't see, so it proves nothing.
   */
  async teamCanPush(org: string, team: string, repo: string): Promise<boolean | null> {
    try {
      const { data } = await this.request<{ permissions?: { push?: boolean } }>(
        "GET",
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/repos/${repo}`,
        undefined,
        "application/vnd.github.v3.repository+json",
      );
      return Boolean(data?.permissions?.push);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }
  /** A user's permission on a repo: admin, maintain, write, triage, read or none. */
  async getUserPermission(repo: string, login: string): Promise<string> {
    return (await this.get<{ permission: string }>(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`)).permission;
  }
  /** Ruleset rules that apply to a branch (readable with read access). */
  getBranchRules(repo: string, branch: string): Promise<{ type: string; parameters?: Record<string, unknown>; ruleset_id?: number }[]> {
    return this.get(`/repos/${repo}/rules/branches/${encodePath(branch)}`);
  }
  /** A ruleset, with `bypass_actors` when this token may see them (admins). */
  getRuleset(repo: string, id: number): Promise<{ bypass_actors?: { actor_type: string; bypass_mode?: string }[] }> {
    return this.get(`/repos/${repo}/rulesets/${id}`);
  }
  /** Classic branch protection (GitHub answers 403/404 to callers without admin). */
  getBranchProtection(repo: string, branch: string): Promise<{
    required_pull_request_reviews?: { require_code_owner_reviews?: boolean; bypass_pull_request_allowances?: { users?: unknown[]; teams?: unknown[]; apps?: unknown[] } };
    enforce_admins?: { enabled?: boolean };
  }> {
    return this.get(`/repos/${repo}/branches/${encodePath(branch)}/protection`);
  }
  getFile(repo: string, path: string, ref: string): Promise<ContentFile> {
    return this.get(`/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  }
  async getBranchSha(repo: string, branch: string): Promise<string> {
    return (await this.get<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodePath(branch)}`)).object.sha;
  }
  async createBranch(repo: string, branch: string, sha: string): Promise<void> {
    await this.request("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }
  async deleteBranch(repo: string, branch: string): Promise<void> {
    await this.request("DELETE", `/repos/${repo}/git/refs/heads/${encodePath(branch)}`);
  }
  /** Always pass `branch`: omitting it makes GitHub write to the default branch. */
  async putFile(repo: string, path: string, args: { message: string; content: string; sha: string | undefined; branch: string }): Promise<void> {
    await this.request("PUT", `/repos/${repo}/contents/${encodePath(path)}`, {
      message: args.message,
      content: Buffer.from(args.content, "utf8").toString("base64"),
      sha: args.sha,
      branch: args.branch,
    });
  }
  /** An open PR from `branch` into `base` in the same repo, if one exists. */
  async findPull(repo: string, branch: string, base: string): Promise<PullInfo | null> {
    const owner = repo.split("/")[0]!;
    const q = `head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}&state=open`;
    return (await this.get<PullInfo[]>(`/repos/${repo}/pulls?${q}`))[0] ?? null;
  }
  async createPull(repo: string, args: { title: string; head: string; base: string; body: string; draft?: boolean }): Promise<PullInfo> {
    return (await this.request<PullInfo>("POST", `/repos/${repo}/pulls`, args)).data;
  }
}

/** `required; url=https://…` or `partial-results; organizations=1,2`. */
export function parseSsoHeader(value: string | null): { required: boolean; url: string | null; organizations: string[] } {
  if (!value) return { required: false, url: null, organizations: [] };
  const parts = value.split(";").map((p) => p.trim());
  const field = (k: string) => parts.find((p) => p.startsWith(`${k}=`))?.slice(k.length + 1) ?? null;
  return {
    required: parts[0] === "required",
    url: field("url"),
    organizations: (field("organizations") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export function decodeContent(file: ContentFile): string {
  return Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8").toString("utf8");
}
