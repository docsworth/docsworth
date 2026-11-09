import { stringify } from "yaml";
import { resolveTeamOwner } from "./codeowners.js";
import { formatDate, utcToday } from "./duration.js";
import { isPage, parsePage, type Repo } from "./repo.js";
import { ACL_INTERNAL, type PageType } from "./schema.js";

// A new page, built so that it lints where it lands: a path under the knowledge root that
// CODEOWNERS assigns to the owning team, frontmatter serialized by the YAML library (a
// title can't add keys), and the result parsed back as a page before anything is written.
// Pro's promote and core's draft_page both build pages here. It reports a problem rather
// than throwing, so each caller says it in its own words (a CLI flag, a tool argument) and
// decides which problems to keep to itself.

export type NewPageType = Exclude<PageType, "adr">;
/** Id prefixes by type, as the example repo uses them. */
export const NEW_PAGE_PREFIX: Readonly<Record<NewPageType, string>> = { runbook: "rb", service: "svc", guide: "guide", policy: "pol" };
/** Where each type goes under the knowledge root, unless a directory is given. */
export const NEW_PAGE_DIR: Readonly<Record<NewPageType, string>> = { runbook: "runbooks", service: "services", guide: "guides", policy: "policies" };

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";
}

export interface NewPageInput {
  type: PageType;
  title: string;
  id: string;
  /** The file name's stem: `<dir>/<slug>.md`, or `<dir>/<slug>/index.md` for a service in its default directory. */
  slug: string;
  ownerTeam: string;
  status: "canonical" | "draft";
  /** A directory under the knowledge root; the type's default when absent. */
  dir?: string;
  acl?: string;
  description?: string;
  reviewEvery?: string;
  body: string;
  now: Date;
}

export type NewPageProblem =
  | { kind: "adr" }
  | { kind: "bad_dir" }
  | { kind: "id_taken"; path: string }
  | { kind: "path_taken"; path: string }
  | { kind: "owner_mismatch"; path: string; assigned: string | null }
  | { kind: "invalid"; issues: string[] };

export type NewPage = { ok: true; path: string; id: string; content: string } | { ok: false; problem: NewPageProblem };

export function buildNewPage(repo: Repo, input: NewPageInput): NewPage {
  const fail = (problem: NewPageProblem): NewPage => ({ ok: false, problem });
  if (input.type === "adr") return fail({ kind: "adr" });
  const type = input.type;
  const taken = repo.byId.get(input.id);
  if (taken) return fail({ kind: "id_taken", path: taken.path });
  const root = repo.config.knowledge_root;
  const dir = (input.dir ?? NEW_PAGE_DIR[type]).replace(/\/+$/g, "");
  // The target must stay under the knowledge root: no absolute paths, backslashes or dot segments.
  if (!dir || dir.startsWith("/") || dir.includes("\\") || dir.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return fail({ kind: "bad_dir" });
  const path = type === "service" && input.dir === undefined ? `${root}/${dir}/${input.slug}/index.md` : `${root}/${dir}/${input.slug}.md`;
  if (repo.byPath.has(path)) return fail({ kind: "path_taken", path });

  // The page must pass lint where it lands: CODEOWNERS has to assign this team there.
  const own = resolveTeamOwner(repo.codeowners, path, repo.config.github.org);
  if (!own.ok || own.team !== input.ownerTeam) return fail({ kind: "owner_mismatch", path, assigned: own.ok ? own.team : null });

  const fm = {
    title: input.title,
    id: input.id,
    type,
    status: input.status,
    owner_team: input.ownerTeam,
    last_verified: formatDate(utcToday(input.now)),
    review_every: input.reviewEvery ?? "90d",
    ...(input.acl && input.acl !== ACL_INTERNAL ? { acl: input.acl } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  const content = `---\n${stringify(fm)}---\n${input.body}`;
  const parsed = parsePage(path, content);
  if (!isPage(parsed)) return fail({ kind: "invalid", issues: parsed.issues.map((i) => i.message) });
  return { ok: true, path, id: input.id, content };
}
