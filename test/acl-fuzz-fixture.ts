import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// For routes (the owner's decision, 2026-11-13): the same, on a docs site at `site_url`, with
// pages a slug or id moves, number prefixes, a dotted file name, a category index, routes two
// pages share, and repo paths outside the knowledge root. `null` is a page that fails to load.
const SITE_URL = "https://docs.example.com/docs/";
const ROUTE_PAGES: Record<string, { acl: string | null; fm?: string }> = {
  "knowledge/guides/index.md": { acl: "internal", fm: "id: guides" },
  "knowledge/guides/intro.md": { acl: "internal", fm: "id: intro" },
  "knowledge/guides/setup.md": { acl: "internal", fm: "id: setup" },
  "knowledge/guides/faq.md": { acl: "internal", fm: "id: faq" },
  "knowledge/guides/intro/faq.md": { acl: "security", fm: "id: intro-faq\nslug: faq" },
  "knowledge/handbook-page.md": { acl: "internal", fm: "id: handbook" },
  "knowledge/next.md": { acl: "internal", fm: "id: next\nslug: /setup" },
  "knowledge/setup.md": { acl: "security", fm: "id: setup-legacy\nslug: /legacy" },
  "knowledge/guides/moved-src.md": { acl: "internal", fm: "id: moved-src\nslug: /moved/intro" },
  "knowledge/x/secret-page.md": { acl: "security", fm: "id: secret-page\nslug: /moved/secret" },
  "knowledge/sec/hsm.md": { acl: "security", fm: "id: hsm" },
  "knowledge/sec/02-keys.md": { acl: "security", fm: "id: keys" },
  "knowledge/sec/2.0-plan.md": { acl: "security", fm: "id: plan-2" },
  "knowledge/old/vault-notes.md": { acl: "security", fm: "id: vault-notes\nslug: /vault" },
  "knowledge/old/setup-old.md": { acl: "security", fm: "id: setup-old\nslug: /guides/setup(old)" },
  "knowledge/old/underscore.md": { acl: "security", fm: "id: underscore\nslug: /handbook_" },
  "knowledge/shared.md": { acl: "internal", fm: "id: shared" },
  "knowledge/sec/shared-copy.md": { acl: "security", fm: "id: shared-copy\nslug: /shared" },
  "knowledge/team.md": { acl: "internal", fm: "id: team" },
  // Category indexes by their names as written (a real Docusaurus build, 2026-11-13).
  "knowledge/04-other/other.md": { acl: "security", fm: "id: other" },
  "knowledge/05-same/05-same.md": { acl: "internal", fm: "id: same" },
  "knowledge/06-idx/01-index.md": { acl: "security", fm: "id: index" },
  "knowledge/broken-team.md": { acl: null, fm: "slug: /team" },
  "knowledge/broken-route.md": { acl: null, fm: "slug: /broken-route" },
};
/** Paths outside the knowledge root a link may name: a directory, a file, and one beside a hidden slug. */
export const REPO_PATHS = ["src", "Makefile", "vault"];
/** Routes no page has: a link to one fails closed. */
export const NO_ROUTES = ["guides/gone", "gone", "sec"];

export function routeRepo(): { repo: Repo; cleanup: () => void } {
  const copy = acmeOnGitHub();
  const cfg = join(copy.root, ".knowledge/config.yaml");
  writeFileSync(cfg, `${readFileSync(cfg, "utf8").trimEnd()}\nsite_url: ${SITE_URL}\n`);
  for (const [path, { acl, fm }] of Object.entries(ROUTE_PAGES)) {
    const abs = join(copy.root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      acl === null
        ? `---\ntitle: Broken page\n${fm}\n---\nNo valid frontmatter.\n`
        : `---\ntitle: Route page\n${fm}\ntype: guide\nstatus: canonical\nowner_team: ${acl === "internal" ? "platform" : acl}\nlast_verified: 2026-10-20\nreview_every: 90d\nacl: ${acl}\n---\n# Route page\n`,
    );
  }
  for (const [path, text] of [["src/index.ts", "export {};\n"], ["Makefile", "all:\n"], ["vault/README.md", "# vault\n"]]) {
    mkdirSync(dirname(join(copy.root, path!)), { recursive: true });
    writeFileSync(join(copy.root, path!), text!);
  }
  return { repo: loadRepo(copy.root), cleanup: copy.cleanup };
}
