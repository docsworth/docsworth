import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Identity } from "../src/core/acl.js";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { loadRepo, type Repo } from "../src/core/repo.js";
import { acmeOnGitHub } from "./helpers.js";

// The acme example plus pages whose paths are hard to name: a space and parentheses, a
// non-ASCII letter, an astral one, a root-level team page, a directory with a space, and
// one that fails to load; and a visible page whose path ends with a hidden one's.
const EXTRA: Record<string, string | null> = {
  "knowledge/security/on call (old).md": "security",
  "knowledge/services/ledger/café.md": "payments",
  "knowledge/team-secret.md": "security",
  "knowledge/security/broken.md": null,
  "knowledge/team space/plans.md": "security",
  "knowledge/security/\u{1d504}.md": "security", // an astral letter: two UTF-16 code units
  "knowledge/security/日本.md": "security", // two non-ASCII letters in a row
  "knowledge/a b c d/notes.md": "security", // more spaces than the sweep reads back by words
  "knowledge/runbooks/a b c d/secret.md": "security", // the same, below the root's first level
  "knowledge/security/break_glass.md": "security", // an underscore between letters
  "knowledge/security/1. secret.md": "security", // a name that looks like a list marker
  // Visible, and its path ends with a hidden page's path under the root.
  "knowledge/team space/security/rotate-db-credentials.md": "internal",
};

export function fuzzRepo(): { repo: Repo; cleanup: () => void } {
  // On GitHub (`github.repo` set), so a GitHub URL into the repo is one the sweep can tell.
  const copy = acmeOnGitHub();
  let n = 0;
  for (const [path, acl] of Object.entries(EXTRA)) {
    const abs = join(copy.root, path);
    mkdirSync(dirname(abs), { recursive: true });
    n++;
    writeFileSync(
      abs,
      acl === null
        ? "---\ntitle: Broken page\n---\nNo valid frontmatter.\n"
        : `---\ntitle: Extra page ${n}\nid: extra-page-${n}\ntype: guide\nstatus: canonical\nowner_team: ${acl}\nlast_verified: 2026-10-20\nreview_every: 90d\nacl: ${acl}\n---\n# Extra ${n}\n`,
    );
  }
  return { repo: loadRepo(copy.root), cleanup: copy.cleanup };
}

const user = (login: string, teams: string[]): Identity => ({ mode: "github", login, teams: new Set(teams), repoAccess: true, canWrite: true });
/** Paths under the knowledge root that are no page: a link to one fails closed, as to a page that didn't load. */
export const NO_PAGES = ["knowledge/security/not-loaded.md", "knowledge/gone/away.md"];

export const FUZZ_IDENTITIES: Identity[] = [LOCAL_IDENTITY, user("nina", []), user("pia", ["payments"]), user("sam", ["security"]), user("pat", ["platform", "payments"])];
