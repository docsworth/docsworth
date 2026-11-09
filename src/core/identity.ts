import { spawnSync } from "node:child_process";
import type { Identity } from "./acl.js";
import { UserError } from "./errors.js";
import type { Config } from "./config.js";
import { GitHubClient, GitHubError, parseSsoHeader } from "./github.js";

export class IdentityError extends UserError {}

/** GITHUB_TOKEN → GH_TOKEN → `gh auth token`, so the 5-minute quickstart needs no setup. */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  if (env.DOCSWORTH_NO_GH_CLI) return null;
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 });
  const token = gh.status === 0 ? gh.stdout.trim() : "";
  return token || null;
}

export const LOCAL_IDENTITY: Identity = { mode: "local", login: null, teams: new Set(), repoAccess: true, canWrite: false };

/**
 * GitHub App installation tokens (`ghs_`) act for an app, not a person, so they can't
 * carry anyone's team ACLs or attribute an audit event. Personal tokens (classic or
 * fine-grained), OAuth tokens (`gh auth token`) and GitHub App *user* tokens are fine.
 */
export function refuseInstallationToken(token: string): void {
  if (token.startsWith("ghs_"))
    throw new IdentityError("this is a GitHub App installation token, which acts for no person; use your own token (`gh auth token`, a personal access token, or a GitHub App user token)");
}

/**
 * Resolves and caches the caller's identity.
 *
 *  - github.repo set + token: identity from GitHub, cached for 5 minutes. Failure is
 *    fatal (fail closed): a silent fallback would hide that ACLs are not being checked.
 *  - github.repo set, no token: refuse. GitHub is the ACL authority for this repo.
 *  - no github.repo: local-only repo; filesystem access is the authority, so the caller
 *    sees `internal` pages, never team pages, and cannot write.
 */
export class IdentityProvider {
  private cached: { identity: Identity; at: number } | null = null;
  /** policy.identity_cache_seconds: the window in which a removed member can still read. */
  private readonly ttlMs: number;

  constructor(
    private readonly config: Config,
    readonly github: GitHubClient | null,
    private readonly clock: () => number = Date.now,
    private readonly log: (msg: string) => void = (m) => process.stderr.write(`docsworth: ${m}\n`),
  ) {
    this.ttlMs = config.policy.identity_cache_seconds * 1000;
    if (config.github.repo && !github) {
      throw new IdentityError(
        `github.repo is ${config.github.repo}, so a GitHub token is required (set GITHUB_TOKEN or run \`gh auth login\`)`,
      );
    }
  }

  static fromEnv(
    config: Config,
    env: NodeJS.ProcessEnv = process.env,
    clientOpts: ConstructorParameters<typeof GitHubClient>[1] = {},
  ): IdentityProvider {
    const token = config.github.repo ? resolveToken(env) : null;
    if (token) refuseInstallationToken(token);
    const baseUrl = env.DOCSWORTH_GITHUB_API_URL || config.github.api_url;
    return new IdentityProvider(config, token ? new GitHubClient(token, { baseUrl, ...clientOpts }) : null);
  }

  /** Cached identity for reads. */
  async get(): Promise<Identity> {
    if (!this.github) return LOCAL_IDENTITY;
    if (this.cached && this.clock() - this.cached.at < this.ttlMs) return this.cached.identity;
    return this.fresh();
  }

  /** Re-resolve from GitHub now (writes always do this). */
  async fresh(): Promise<Identity> {
    if (!this.github) return LOCAL_IDENTITY;
    const repo = this.config.github.repo!;
    try {
      const [user, info] = await Promise.all([this.github.getUser(), this.github.getRepo(repo)]);
      let teams: string[] = [];
      try {
        const mine = await this.github.listMyTeams();
        teams = mine.teams.filter((t) => t.organization.login.toLowerCase() === this.config.github.org).map((t) => t.slug.toLowerCase());
        const org = this.config.github.org;
        // GitHub leaves out teams of orgs whose SSO this token isn't authorized for. Say so
        // only when that is the configured org (known when it owns the repo).
        const ownerIsOrg = info.owner?.login.toLowerCase() === org;
        if (mine.ssoWithheldOrgIds.length && (!ownerIsOrg || mine.ssoWithheldOrgIds.includes(String(info.owner!.id))))
          this.log(
            ownerIsOrg
              ? `this token isn't authorized for ${org}'s SAML SSO, so GitHub withheld its teams; team-ACL pages stay hidden until you authorize it`
              : `GitHub withheld teams of org id(s) ${mine.ssoWithheldOrgIds.join(", ")} (SAML SSO not authorized for this token); if one is ${org}, team-ACL pages stay hidden`,
          );
      } catch (err) {
        // A rate limit isn't a missing scope: an identity with no teams would hide team
        // pages for the whole cache window and blame the token.
        if (!(err instanceof GitHubError) || err.status !== 403 || err.rateLimited) throw err;
        // SSO first: a 403 that carries `x-github-sso: required` isn't a missing scope.
        // Rethrown, it fails closed below with the authorization link.
        if (parseSsoHeader(err.headers?.get("x-github-sso") ?? null).required) throw err;
        this.log("token lacks read:org; team-ACL pages will stay hidden");
      }
      const identity: Identity = {
        mode: "github",
        login: user.login,
        teams: new Set(teams),
        repoAccess: true,
        canWrite: Boolean(info.permissions?.push),
      };
      this.cached = { identity, at: this.clock() };
      return identity;
    } catch (err) {
      this.cached = null;
      const sso = err instanceof GitHubError ? parseSsoHeader(err.headers?.get("x-github-sso") ?? null) : null;
      if (sso?.required)
        throw new IdentityError(
          `this token isn't authorized for ${this.config.github.org}'s SAML single sign-on${sso.url ? `; authorize it at ${sso.url} (the link expires in an hour)` : ""}, or use a fine-grained or GitHub App token`,
        );
      // A rate limit is a 403 too, and isn't "no access": say what it is and when it lifts.
      if (err instanceof GitHubError && err.rateLimited)
        throw new IdentityError(`GitHub's rate limit for this token is reached${err.retryAfter !== null ? `; it lifts in ${Math.ceil(err.retryAfter / 60)} min` : ""}, so access can't be checked until then`);
      if (err instanceof GitHubError && err.status === 403 && /not accessible by integration/i.test(err.message) && err.path === "/user")
        throw new IdentityError("this token can't identify a person (GitHub App installation token?); use your own token");
      if (err instanceof GitHubError && (err.status === 404 || err.status === 403))
        throw new IdentityError(`no access to ${repo} with this token (GitHub said ${err.status})`);
      if (err instanceof GitHubError && err.status === 401) throw new IdentityError("GitHub rejected the token (401)");
      throw new IdentityError(`could not resolve identity from GitHub: ${(err as Error).message}`);
    }
  }
}
