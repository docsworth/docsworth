import { randomBytes } from "node:crypto";
import { splitFrontmatter } from "./frontmatter.js";
import { decodeContent, type GitHubClient, GitHubError } from "./github.js";

export interface Edit {
  old: string;
  new: string;
}

export class WriteError extends Error {}

/**
 * Fields an agent may not change through propose_edit. last_verified goes through the
 * owner-only `verify`; changing owner_team, id or acl through an agent PR would let a
 * page change hands or widen its audience in a diff reviewers may skim.
 */
export const PROTECTED_FIELDS = ["id", "owner_team", "acl", "last_verified"] as const;

/** Apply exact replacements in order; each `old` must occur exactly once. */
export function applyEdits(text: string, edits: Edit[]): string {
  if (edits.length === 0) throw new WriteError("no edits given");
  return edits.reduce((acc, e, i) => {
    if (!e.old) throw new WriteError(`edit ${i + 1}: \`old\` is empty`);
    const first = acc.indexOf(e.old);
    if (first === -1) throw new WriteError(`edit ${i + 1}: \`old\` text not found in the current page`);
    if (acc.indexOf(e.old, first + 1) !== -1) throw new WriteError(`edit ${i + 1}: \`old\` text matches more than once; include more context`);
    return acc.slice(0, first) + e.new + acc.slice(first + e.old.length);
  }, text);
}

export function assertProtectedFieldsUnchanged(before: string, after: string): void {
  const a = splitFrontmatter(before).data ?? {};
  const b = splitFrontmatter(after).data;
  if (!b) throw new WriteError("the edited page no longer has valid frontmatter");
  for (const f of PROTECTED_FIELDS) {
    if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
      const hint = f === "last_verified" ? "; owners bump it with the verify tool" : "";
      throw new WriteError(`propose_edit may not change \`${f}\`${hint}`);
    }
  }
}

/**
 * Replace everything after the frontmatter block, keeping the block byte for byte. `read`
 * returns a page's body without its frontmatter, so an agent edits the body and the
 * frontmatter (owner, ACL, review date) never passes through it.
 */
export function replaceBody(text: string, body: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) throw new WriteError("page has no frontmatter block");
  // The body as given. Only a block that ends the file needs a line break before it.
  return m[0] + (m[0].endsWith("\n") || body === "" ? "" : "\n") + body;
}

/** Set last_verified in the frontmatter block, leaving every other byte alone. */
export function setLastVerified(text: string, date: string): string {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(text);
  if (!m) throw new WriteError("page has no frontmatter block");
  const fm = /^last_verified:.*$/m.test(m[2]!)
    ? m[2]!.replace(/^last_verified:.*$/m, `last_verified: ${date}`)
    : `${m[2]}\nlast_verified: ${date}`;
  return m[1] + fm + m[3] + text.slice(m[0].length);
}

export interface PrRequest {
  repo: string;
  baseBranch: string;
  verb: "propose" | "verify" | "draft";
  pageId: string;
  path: string;
  transform: (current: string) => string;
  commitMessage: string;
  title: string;
  /** A function when the body depends on what the transform found. */
  body: string | (() => string);
  draft?: boolean;
  /** Injected for tests; defaults to now. */
  timestamp?: Date;
  /** Create a new file (promote): refuse if it already exists, PUT without a sha. */
  create?: boolean;
}

export interface PrResult {
  number: number;
  url: string;
  branch: string;
}

/**
 * A fresh branch for one proposal. The second-resolution timestamp alone collided when
 * two agents proposed on the same page in the same second (GitHub: "Reference already
 * exists"), so a random suffix follows it.
 */
export function branchName(verb: string, pageId: string, at: Date, nonce = randomBytes(3).toString("hex")): string {
  const ts = at.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  return `docsworth/${verb}/${pageId}-${ts}-${nonce}`;
}

/**
 * The only write path: read the file at the default branch, transform it, create a new
 * branch, commit to that branch (explicitly), open a PR. Nothing ever targets the
 * default branch; if a step after branch creation fails, the branch is removed.
 */
export async function openPagePr(gh: GitHubClient, req: PrRequest): Promise<PrResult> {
  const branch = branchName(req.verb, req.pageId, req.timestamp ?? new Date());
  if (branch === req.baseBranch || !branch.startsWith("docsworth/")) throw new WriteError(`refusing to write to ${branch}`);

  let file: { sha: string | undefined; before: string };
  if (req.create) {
    const exists = await gh.getFile(req.repo, req.path, req.baseBranch).then(
      () => true,
      (err: unknown) => (err instanceof GitHubError && err.status === 404 ? false : Promise.reject(err)),
    );
    if (exists) throw new WriteError(`${req.path} already exists on ${req.baseBranch}`);
    file = { sha: undefined, before: "" };
  } else {
    const current = await gh.getFile(req.repo, req.path, req.baseBranch);
    file = { sha: current.sha, before: decodeContent(current) };
  }
  const after = req.transform(file.before);
  if (after === file.before) throw new WriteError("the change is empty");

  const baseSha = await gh.getBranchSha(req.repo, req.baseBranch);
  await gh.createBranch(req.repo, branch, baseSha);
  try {
    await gh.putFile(req.repo, req.path, { message: req.commitMessage, content: after, sha: file.sha, branch });
    const pr = await gh.createPull(req.repo, { title: req.title, head: branch, base: req.baseBranch, body: typeof req.body === "function" ? req.body() : req.body, draft: req.draft });
    return { number: pr.number, url: pr.html_url, branch };
  } catch (err) {
    // The PR may exist even though its response was lost (timeout, reset): never delete
    // the head branch of a live PR. Only clean up when GitHub confirms there is none.
    const existing = await gh.findPull(req.repo, branch, req.baseBranch).catch(() => undefined);
    if (existing) return { number: existing.number, url: existing.html_url, branch };
    if (existing === undefined) throw new WriteError(`${(err as Error).message}; branch ${branch} was kept because its PR state is unknown`);
    const cleanup = await gh.deleteBranch(req.repo, branch).then(() => null, (e: unknown) => e as Error);
    if (cleanup) throw new WriteError(`${(err as Error).message}; also failed to delete branch ${branch}: ${cleanup.message}`);
    throw err;
  }
}
