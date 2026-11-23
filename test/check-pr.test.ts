import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { GitHubClient } from "../src/core/github.js";
import { IdentityProvider } from "../src/core/identity.js";
import { lintRepo } from "../src/core/lint.js";
import { isPage, loadRepo, parsePage } from "../src/core/repo.js";
import { KnowledgeService, ToolError } from "../src/core/service.js";
import { toolSpec } from "../src/core/tool-registry.js";
import { branchName, DOCSWORTH_BRANCH } from "../src/core/writes.js";
import { FakeGitHub } from "./fake-github.js";
import { acmeOnGitHub, NOW } from "./helpers.js";

let acme: ReturnType<typeof acmeOnGitHub>;
let gh: FakeGitHub;
beforeEach(() => {
  acme = acmeOnGitHub();
  gh = new FakeGitHub(
    "acme/knowledge",
    "acme",
    {
      alice: { login: "alice", teams: ["platform"], push: true },
      sam: { login: "sam", teams: ["security"], push: true },
      viewer: { login: "viewer", teams: ["platform"], push: false },
      // A fine-grained token with Pull requests: read but no Contents: read.
      prreader: { login: "prreader", teams: ["platform"], push: false, noContents: true },
      // One without Pull requests: read.
      nopulls: { login: "nopulls", teams: ["platform"], push: false, noPulls: true },
    },
    acme.root,
  );
});
afterEach(() => {
  acme.cleanup();
  expect(gh.violations).toEqual([]);
});

const service = (token: string) =>
  new KnowledgeService(acme.root, new IdentityProvider(loadConfig(acme.root), new GitHubClient(token, { fetch: gh.fetch, sleep: async () => {} })), () => NOW);

const DEPLOY = "knowledge/runbooks/deploy-production.md";
const ROTATE = "knowledge/security/rotate-db-credentials.md";
const BRANCH = (verb = "propose", id = "rb-deploy-prod") => `docsworth/${verb}/${id}-20261102T090000-abc123`;
const onDisk = (path: string) => readFileSync(join(acme.root, path), "utf8");
/** A page's text with one frontmatter line changed (or added). */
const withLine = (text: string, field: string, value: string) =>
  new RegExp(`^${field}:.*$`, "m").test(text) ? text.replace(new RegExp(`^${field}:.*$`, "m"), `${field}: ${value}`) : text.replace(/^---\n/, `---\n${field}: ${value}\n`);

const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
/** The one refusal: the same code and message as a number with no PR at all. */
async function expectNotFound(p: Promise<unknown>, n: number) {
  const e = await rejection(p);
  expect(e).toBeInstanceOf(ToolError);
  expect(e).toMatchObject({ code: "not_found", message: `no Docsworth pull request #${n}` });
}

const SAM_DRAFT = {
  type: "runbook",
  title: "Rotate HSM keys",
  owner_team: "security",
  acl: "security",
  dir: "security",
  body: "# Rotate HSM keys\n\n## Steps\n\n1. Ask the HSM.\n",
  reason: "From the audit.",
} as const;

describe("check_pr: a PR Docsworth opened, as the caller may see it", () => {
  it("reports an open propose_edit PR with its page, then the reviews, then the merge", async () => {
    const r = await service("alice").proposeEdit({ id: "rb-deploy-prod", edits: [{ old: "for at least 30 minutes", new: "for at least 45 minutes" }], reason: "r" });
    const s = service("alice");
    const open = await s.checkPr({ pr_number: r.pr_number });
    expect(open).toMatchObject({
      pr_number: r.pr_number,
      pr_url: r.pr_url,
      kind: "propose",
      state: "open",
      draft: false,
      merged_at: null,
      reviews: { approved: 0, changes_requested: 0 },
      pages: [{ id: "rb-deploy-prod", title: "Deploy to production", path: DEPLOY, owner_team: "platform", change: "modified", on_default: true }],
    });
    expect(open.note).toMatch(/waiting for review by @acme\/platform/);
    expect(open).not.toHaveProperty("title");

    // The latest review per reviewer; a dismissal clears it; comments and a deleted account don't count.
    gh.review(r.pr_number, { id: 1, login: "bob" }, "APPROVED");
    gh.review(r.pr_number, { id: 2, login: "carol" }, "CHANGES_REQUESTED");
    gh.review(r.pr_number, { id: 3, login: "dave" }, "CHANGES_REQUESTED");
    gh.review(r.pr_number, { id: 3, login: "dave" }, "DISMISSED");
    gh.review(r.pr_number, { id: 1, login: "bob" }, "COMMENTED");
    gh.review(r.pr_number, null, "APPROVED");
    const reviewed = await s.checkPr({ pr_number: r.pr_number });
    expect(reviewed.reviews).toEqual({ approved: 1, changes_requested: 1 });
    expect(reviewed.note).toMatch(/changes were requested/i);

    gh.merge(r.pr_number);
    const merged = await s.checkPr({ pr_number: r.pr_number });
    expect(merged).toMatchObject({ state: "merged", merged_at: "2026-11-02T12:00:00Z" });
    expect(merged.note).toMatch(/merged/i);
  });

  it("reports a closed PR as closed, not merged", async () => {
    const r = await service("alice").proposeEdit({ id: "rb-deploy-prod", append: "## Notes\n\nMore.", reason: "r" });
    gh.closePull(r.pr_number);
    const closed = await service("alice").checkPr({ pr_number: r.pr_number });
    expect(closed).toMatchObject({ state: "closed", merged_at: null, closed_at: "2026-11-02T12:00:00Z" });
    expect(closed.note).toMatch(/closed without merging/i);
  });

  it("names the kind of each Docsworth write, from PRs opened through the real tools", async () => {
    const v = await service("alice").verify({ id: "rb-deploy-prod" });
    const d = await service("alice").draftPage({ type: "runbook", title: "Drain a Kafka partition", owner_team: "platform", body: "# Drain\n\n## Steps\n\n1. Pause.\n", reason: "r" });
    const s = service("alice");
    expect(await s.checkPr({ pr_number: v.pr_number })).toMatchObject({ kind: "verify", pages: [{ id: "rb-deploy-prod", change: "modified", on_default: true }] });
    const draft = await s.checkPr({ pr_number: d.pr_number });
    expect(draft).toMatchObject({ kind: "draft", draft: true, pages: [{ id: d.id, title: "Drain a Kafka partition", path: d.path, owner_team: "platform", change: "added", on_default: false }] });
    expect(draft.note).toMatch(/still a draft/i);
  });

  it("works for a caller without push access", async () => {
    const r = await service("alice").proposeEdit({ id: "rb-deploy-prod", append: "## Notes\n\nMore.", reason: "r" });
    expect(await service("viewer").checkPr({ pr_number: r.pr_number })).toMatchObject({ state: "open", pages: [{ id: "rb-deploy-prod" }] });
  });

  it("recognises every branch name openPagePr builds", () => {
    for (const verb of ["propose", "verify", "draft"]) expect(branchName(verb, "rb-a-b-c", NOW)).toMatch(DOCSWORTH_BRANCH);
    expect("docsworth/propose/rb-x").not.toMatch(DOCSWORTH_BRANCH);
    expect("feature/rb-x-20261102T090000-abc123").not.toMatch(DOCSWORTH_BRANCH);
  });
});

describe("check_pr: hidden and unknown give one not_found", () => {
  const modifiedDeploy = () => onDisk(DEPLOY).replace("30 minutes", "45 minutes");

  it("for a number with no PR", async () => {
    await expectNotFound(service("alice").checkPr({ pr_number: 99 }), 99);
  });

  it.each([
    ["a branch Docsworth didn't name", { head: "feature/faster-deploys" }],
    ["a fork", { head: BRANCH(), headRepoId: 999 }],
    ["a deleted fork (no head repo)", { head: BRANCH(), headRepoId: null }],
    ["another base branch", { head: BRANCH(), base: "release" }],
    ["more than 20 changed files", { head: BRANCH(), changedFiles: 21 }],
    ["a files list GitHub says goes on", { head: BRANCH(), moreFiles: true }],
  ])("for %s", async (_, shape) => {
    const n = gh.rawPull({ files: [{ filename: DEPLOY, status: "modified", content: modifiedDeploy() }], ...shape });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for changed_files of 0, even with a valid file listed (a push between the two calls)", async () => {
    const n = gh.rawPull({ head: BRANCH(), files: [{ filename: DEPLOY, status: "modified", content: modifiedDeploy() }], changedFiles: 0 });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for an empty files list, whatever changed_files said", async () => {
    const n = gh.rawPull({ head: BRANCH(), files: [], changedFiles: 1 });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for a file whose sha isn't a git object id", async () => {
    // Never fetched. The fake would serve it, and as a valid internal page, so only the check refuses it.
    const sha = "zz-not-a-git-object-id";
    gh.blobs.set(sha, withLine(onDisk(DEPLOY), "id", "rb-new-page"));
    const n = gh.rawPull({ head: BRANCH("draft", "rb-new-page"), files: [{ filename: "knowledge/runbooks/new-page.md", status: "added", sha }] });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for a fetched files list over the cap, whatever changed_files said", async () => {
    // Each file a valid internal page, so only the cap stands in the way.
    const files = Array.from({ length: 21 }, (_, i) => ({ filename: `knowledge/runbooks/x-${i}.md`, status: "added", content: withLine(onDisk(DEPLOY), "id", `rb-x-${i}`) }));
    const n = gh.rawPull({ head: BRANCH(), files, changedFiles: 1 });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it.each(["removed", "renamed", "copied", "changed", "unchanged"])("for a %s file", async (status) => {
    const n = gh.rawPull({ head: BRANCH(), files: [{ filename: DEPLOY, status, content: modifiedDeploy(), ...(status === "renamed" || status === "copied" ? { previous_filename: ROTATE } : {}) }] });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it.each([
    ["outside the knowledge root", "README.md"],
    ["not markdown", "knowledge/runbooks/new-page.txt"],
    ["with a .. segment", "knowledge/runbooks/../../new-page.md"],
  ])("for a file %s, even one that is a valid internal page", async (_, filename) => {
    // Added, with a valid internal head, so only the path check stands in the way.
    const n = gh.rawPull({ head: BRANCH("draft", "rb-new-page"), files: [{ filename, status: "added", content: withLine(onDisk(DEPLOY), "id", "rb-new-page") }] });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for a restricted page Docsworth itself proposed an edit to", async () => {
    const r = await service("sam").proposeEdit({ id: "rb-rotate-db-creds", append: "## Notes\n\nMore.", reason: "r" });
    await expectNotFound(service("alice").checkPr({ pr_number: r.pr_number }), r.pr_number);
    expect(await service("sam").checkPr({ pr_number: r.pr_number })).toMatchObject({ pages: [{ id: "rb-rotate-db-creds" }] });
  });

  it("for a restricted page on the default branch, even when the head says it's internal", async () => {
    // A branch named for a visible page, touching a hidden one whose head widens its acl.
    const n = gh.rawPull({ head: BRANCH(), files: [{ filename: ROTATE, status: "modified", content: withLine(onDisk(ROTATE), "acl", "internal") }] });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for a restricted draft_page, which exists only on its branch", async () => {
    const d = await service("sam").draftPage(SAM_DRAFT);
    await expectNotFound(service("alice").checkPr({ pr_number: d.pr_number }), d.pr_number);
    expect(await service("sam").checkPr({ pr_number: d.pr_number })).toMatchObject({ pages: [{ id: d.id, change: "added", on_default: false }] });
  });

  it("for an added path where a restricted page now sits on the default branch, with an internal head", async () => {
    const n = gh.rawPull({ head: BRANCH("draft", "rb-rotate-db-creds"), files: [{ filename: ROTATE, status: "added", content: withLine(onDisk(ROTATE), "acl", "internal") }] });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for an added path already on the default branch under another id", async () => {
    const n = gh.rawPull({ head: BRANCH("draft"), files: [{ filename: DEPLOY, status: "added", content: withLine(onDisk(DEPLOY), "id", "rb-something-else") }] });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for an added path where the default branch has an invalid page, with a valid internal head", async () => {
    const broken = "knowledge/security/broken.md";
    writeFileSync(join(acme.root, broken), withLine(onDisk(ROTATE), "status", "bogus").replace("id: rb-rotate-db-creds", "id: rb-broken"));
    const head = withLine(withLine(onDisk(ROTATE), "acl", "internal"), "id", "rb-broken");
    const n = gh.rawPull({ head: BRANCH("draft", "rb-broken"), files: [{ filename: broken, status: "added", content: head }] });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for a head that isn't a valid page (a symlink's blob is its target path)", async () => {
    const n = gh.rawPull({ head: BRANCH("draft"), files: [{ filename: "knowledge/runbooks/link.md", status: "added", content: "../security/rotate-db-credentials.md" }] });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for a head that changes the page's id", async () => {
    const n = gh.rawPull({ head: BRANCH(), files: [{ filename: DEPLOY, status: "modified", content: withLine(onDisk(DEPLOY), "id", "rb-something-else") }] });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for a gitlink, whose sha is a commit, not a blob", async () => {
    const n = gh.rawPull({ head: BRANCH("draft"), files: [{ filename: "knowledge/runbooks/sub.md", status: "added", sha: "a".repeat(40) }] });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for a head blob over 1 MB", async () => {
    const big = `${withLine(onDisk(DEPLOY), "id", "rb-big")}\n${"x".repeat(1_100_000)}\n`;
    const n = gh.rawPull({ head: BRANCH("draft", "rb-big"), files: [{ filename: "knowledge/runbooks/big.md", status: "added", content: big }] });
    await expectNotFound(service("alice").checkPr({ pr_number: n }), n);
  });

  it("for a token that can read PRs but not contents, on a restricted draft and on a visible one alike", async () => {
    const d = await service("sam").draftPage(SAM_DRAFT);
    const r = await service("alice").proposeEdit({ id: "rb-deploy-prod", append: "## Notes\n\nMore.", reason: "r" });
    await expectNotFound(service("prreader").checkPr({ pr_number: d.pr_number }), d.pr_number);
    await expectNotFound(service("prreader").checkPr({ pr_number: r.pr_number }), r.pr_number);
  });

  it("leaves the session untainted when a later file is refused after an earlier one passed", async () => {
    // sam can see the first page (restricted to security); the second file is a removal.
    const n = gh.rawPull({
      head: BRANCH("propose", "rb-rotate-db-creds"),
      files: [
        { filename: ROTATE, status: "modified", content: onDisk(ROTATE).replace("## When to use", "## When to use it") },
        { filename: DEPLOY, status: "removed", content: onDisk(DEPLOY) },
      ],
    });
    const sam = service("sam");
    await expectNotFound(sam.checkPr({ pr_number: n }), n);
    await expect(sam.draftPage({ ...SAM_DRAFT, title: "Something internal", acl: "internal" })).resolves.toMatchObject({ pr_number: expect.any(Number) });
  });

  it("leaves the session untainted, so a later write can't tell", async () => {
    const d = await service("sam").draftPage(SAM_DRAFT);
    const alice = service("alice");
    await expectNotFound(alice.checkPr({ pr_number: d.pr_number }), d.pr_number);
    await expect(alice.proposeEdit({ id: "rb-deploy-prod", append: "## Notes\n\nMore.", reason: "r" })).resolves.toMatchObject({ pr_number: expect.any(Number) });
  });
});

describe("check_pr: what it costs and what it records", () => {
  it("taints the session with a restricted page it showed", async () => {
    const d = await service("sam").draftPage(SAM_DRAFT);
    const sam = service("sam");
    await sam.checkPr({ pr_number: d.pr_number });
    await expect(sam.draftPage({ ...SAM_DRAFT, title: "Something internal", acl: "internal" })).rejects.toMatchObject({
      code: "forbidden",
      message: "this session read pages restricted to @acme/security; draft_page can only create pages with the same audience (this one would be `internal`)",
    });
  });

  it("records only page ids that came from the default branch, never a head's claim, and no pr_url", async () => {
    const r = await service("alice").proposeEdit({ id: "rb-deploy-prod", append: "## Notes\n\nMore.", reason: "r" });
    const spec = toolSpec("check_pr")!;
    expect(spec.returned((await service("alice").checkPr({ pr_number: r.pr_number })) as never)).toEqual({ returned: ["rb-deploy-prod"] });

    // A head (merged on GitHub, not yet pulled here) claiming a hidden page's id.
    const n = gh.rawPull({ head: BRANCH("draft", "rb-new"), files: [{ filename: "knowledge/runbooks/new.md", status: "added", content: withLine(withLine(onDisk(ROTATE), "acl", "internal"), "owner_team", "platform") }] });
    const claimed = await service("alice").checkPr({ pr_number: n });
    expect(claimed.pages).toMatchObject([{ id: "rb-rotate-db-creds", on_default: false }]);
    expect(spec.returned(claimed as never)).toEqual({ returned: [] });

    expect(spec.auditFields).toEqual(["pr_number"]);
  });
});

describe("check_pr: errors", () => {
  it("is unavailable without GitHub, the same for every number", async () => {
    const local = new KnowledgeService(join(acme.root), { get: async () => (await import("../src/core/identity.js")).LOCAL_IDENTITY, fresh: async () => (await import("../src/core/identity.js")).LOCAL_IDENTITY, github: null }, () => NOW);
    await expect(local.checkPr({ pr_number: 1 })).rejects.toMatchObject({ code: "unavailable", message: "check_pr needs github.repo in .knowledge/config.yaml and a GitHub token" });
  });

  it("says which permission a token lacks when it can't read PRs at all", async () => {
    await expect(service("nopulls").checkPr({ pr_number: 1 })).rejects.toMatchObject({
      code: "unavailable",
      message: "your token can't read pull requests in acme/knowledge: grant it Pull requests: read",
    });
  });

  it("keeps a rate-limited 403 on the PR a rate limit, not a missing permission", async () => {
    gh.pullError = { status: 403, json: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } };
    const e = await rejection(service("alice").checkPr({ pr_number: 1 }));
    expect(e).not.toMatchObject({ message: expect.stringContaining("Pull requests: read") });
  });

  it.each([
    ["a rate limit", { status: 403, json: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } }],
    ["a 5xx", { status: 502, json: { message: "Bad Gateway" } }],
  ])("answers %s after the PR with a fixed message that names no path or sha", async (_, error) => {
    const d = await service("sam").draftPage(SAM_DRAFT);
    gh.blobError = error;
    const e = (await rejection(service("alice").checkPr({ pr_number: d.pr_number }))) as ToolError;
    expect(e).toBeInstanceOf(ToolError);
    expect(e.code).toBe("unavailable");
    expect(e.message).toMatch(new RegExp(`^GitHub didn't answer while checking #${d.pr_number}; try again`));
    expect(e.message).not.toMatch(/blobs|\/repos\/|[0-9a-f]{40}/);
  });

  it("is refused where the policy lets the caller read nothing", async () => {
    const cfg = join(acme.root, ".knowledge/config.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf8")}\npolicy:\n  tools:\n    read:\n      teams: [security]\n`);
    await expect(service("alice").checkPr({ pr_number: 1 })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("retiring a page through propose_edit", () => {
  it("edits the status line to deprecated: it lints clean, isn't citable, search excludes it, stale drops it", async () => {
    const r = await service("alice").proposeEdit({ id: "rb-deploy-prod", edits: [{ old: "status: canonical", new: "status: deprecated" }], reason: "Replaced by the new pipeline." });
    const text = gh.file(DEPLOY, r.branch)!;
    const page = parsePage(DEPLOY, text);
    expect(isPage(page) && page.status).toBe("deprecated");

    writeFileSync(join(acme.root, DEPLOY), text);
    const repo = loadRepo(acme.root);
    expect(lintRepo(repo, NOW).diagnostics.filter((d) => d.path === DEPLOY && d.severity === "error")).toEqual([]);
    const s = service("alice");
    expect(await s.read({ id: "rb-deploy-prod" })).toMatchObject({ citable: false });
    const found = await s.search({ query: "deploy to production shipyard canary" });
    expect(found.excluded?.map((p: { id: string }) => p.id)).toContain("rb-deploy-prod");
    expect((await s.stale()).pages.map((p) => p.id)).not.toContain("rb-deploy-prod");
  });
});
