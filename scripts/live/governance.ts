// Live, read-only governance checks (v0.2 G2-G4) against real GitHub: the calls identity
// relies on, made with the operator's own token. Writes
// nothing. Prints an observation per check, so "couldn't look" stays distinct from "no".
import { ConfigSchema } from "../../src/core/config.js";
import { GitHubClient, GitHubError } from "../../src/core/github.js";
import { IdentityProvider, resolveToken } from "../../src/core/identity.js";
import { check, done, loadEnv, scratchRepo } from "./env.js";

loadEnv();
const token = resolveToken();
if (!token) {
  console.log("SKIPPED: no GitHub token (GITHUB_TOKEN, GH_TOKEN or `gh auth login`)");
  process.exit(0);
}
const repo = scratchRepo();
const org = (process.env.DOCSWORTH_LIVE_GITHUB_ORG || repo.split("/")[0]!).toLowerCase();
const gh = new GitHubClient(token);

async function identity(label: string, tok: string) {
  const logs: string[] = [];
  const cfg = ConfigSchema.parse({ github: { org, repo } });
  const who = await new IdentityProvider(cfg, new GitHubClient(tok), Date.now, (m) => logs.push(m)).fresh();
  check(`${label}: identity resolves`, who.mode === "github" && Boolean(who.login), `${who.login}, ${who.teams.size} team(s) in ${org}${logs.length ? `; warnings: ${logs.join(" | ")}` : ""}`);
}

await identity("operator token", token);

const mine = await gh.listMyTeams();
check("GET /user/teams accepted", Array.isArray(mine.teams), `${mine.teams.length} team(s) in all orgs; SSO-withheld org ids: ${mine.ssoWithheldOrgIds.join(", ") || "none"}`);

// The code-owner review check behind the access review is pro's: `npm run live:access-review -w @docsworth-pro/pro`.

const team = process.env.DOCSWORTH_LIVE_GITHUB_TEAM;
if (!team || !process.env.DOCSWORTH_LIVE_GITHUB_ORG) console.log("SKIPPED: team members (set DOCSWORTH_LIVE_GITHUB_ORG and DOCSWORTH_LIVE_GITHUB_TEAM)");
else {
  try {
    const members = await gh.listTeamMembers(org, team);
    check(`GET /orgs/${org}/teams/${team}/members accepted`, members.length > 0, `${members.length} member(s)`);
  } catch (err) {
    check(`GET /orgs/${org}/teams/${team}/members accepted`, false, err instanceof GitHubError ? `GitHub said ${err.status}: ${err.message}` : String(err));
  }
}

const fine = process.env.GITHUB_TOKEN_FINE;
if (!fine) console.log("SKIPPED: fine-grained token (set GITHUB_TOKEN_FINE to a token whose resource owner is the org)");
else await identity("fine-grained token", fine);

done();
