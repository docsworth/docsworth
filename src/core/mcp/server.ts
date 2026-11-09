import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GitHubError } from "../github.js";
import { IdentityError } from "../identity.js";
import type { Identity } from "../acl.js";
import { toolRefusal } from "../policy.js";
import { PAGE_TYPES } from "../schema.js";
import { WRITE_TOOLS } from "../tool-registry.js";
import { type KnowledgeService, ToolError } from "../service.js";
import { PACKAGE_VERSION } from "../version.js";
import { INSTRUCTIONS, polishPrompt, readDescription, searchDescription } from "./text.js";

const idArg = z.string().min(1).describe("Stable page id, e.g. `rb-deploy-prod`");

function ok(value: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function fail(err: unknown): CallToolResult {
  let code = "internal";
  let message = "internal error";
  if (err instanceof ToolError) [code, message] = [err.code, err.message];
  else if (err instanceof IdentityError) [code, message] = ["unavailable", err.message];
  else if (err instanceof GitHubError) [code, message] = ["upstream", err.message];
  else process.stderr.write(`docsworth: ${(err as Error)?.stack ?? String(err)}\n`);
  const error = { error: { code, message } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error };
}

const run = (fn: () => Promise<object>) => fn().then(ok, fail);

/** Claude Code prompts on every call to a tool carrying this, whatever the permission mode. */
export const REQUIRES_USER_INTERACTION = "anthropic/requiresUserInteraction";

/**
 * The MCP server over a KnowledgeService. `who` is the identity this server instance
 * serves (one per stdio process, one per session in the remote server): tools the
 * policy refuses it are disabled, so they drop out of its tools/list. Calls are checked
 * again in the service against the policy in force at call time.
 */
/** How often a session re-checks the policy with no calls coming in (a disabled tool's calls never reach a handler). */
export const POLICY_RESYNC_MS = 15_000;

export function createMcpServer(
  service: KnowledgeService,
  opts: { who?: Identity; whoami?: () => Promise<Identity>; resyncMs?: number; /** `http`: also the web app's tools (`docsworth serve`). */ surface?: "stdio" | "http" } = {},
): McpServer {
  const server = new McpServer({ name: "docsworth", version: PACKAGE_VERSION }, { instructions: INSTRUCTIONS });
  const writeMeta = service.policy().require_human_approval ? { _meta: { [REQUIRES_USER_INTERACTION]: true } } : {};
  const registered = new Map<string, ReturnType<McpServer["registerTool"]>>();
  // Every tool is registered; the ones the policy refuses this identity are disabled, and
  // re-checked after each call so a policy change (config is re-read when it changes)
  // shows in tools/list. enable()/disable() send list_changed, so only toggle on a change.
  const enabled = new Map<string, boolean>();
  let approval = service.policy().require_human_approval;
  const sync = async () => {
    let who = opts.who;
    try {
      if (opts.whoami) who = await opts.whoami();
    } catch {
      /* identity unavailable now: keep the last list; calls are still checked */
    }
    const policy = service.policy();
    // The approval flag on the write tools follows the policy too.
    const meta = policy.require_human_approval;
    if (meta !== approval) {
      approval = meta;
      for (const name of WRITE_TOOLS) registered.get(name)?.update({ _meta: meta ? { [REQUIRES_USER_INTERACTION]: true } : {} });
    }
    for (const [name, tool] of registered) {
      // Without an identity only the global write switch can be applied.
      const refused = who ? toolRefusal(policy, service.org, name, who) : policy.writes === "disabled" && WRITE_TOOLS.has(name);
      const want = !refused;
      if (enabled.get(name) === want) continue;
      enabled.set(name, want);
      if (want) tool.enable();
      else tool.disable();
    }
  };
  const after = <T>(p: Promise<T>) => p.finally(() => sync().catch(() => {}));

  registered.set("search", server.registerTool(
    "search",
    {
      title: "Search knowledge",
      description: searchDescription(service.mirrorServed()),
      inputSchema: {
        query: z.string().min(1).describe("What you are looking for, in plain words"),
        type: z.enum(PAGE_TYPES).optional().describe("Only pages of this type"),
        owner_team: z.string().optional().describe("Only pages owned by this team slug"),
        applies_to: z.string().optional().describe("Only pages that apply to this, e.g. `service:payments`"),
        include_stale: z.boolean().optional().describe("Also return non-citable pages inline, labeled with `gate`"),
        limit: z.number().int().min(1).max(25).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => after(run(() => service.search(args))),
  ));

  registered.set("read", server.registerTool(
    "read",
    {
      title: "Read a page",
      description: readDescription(service.mirrorServed()),
      inputSchema: { id: idArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => after(run(() => service.read(args))),
  ));

  registered.set("list", server.registerTool(
    "list",
    {
      title: "List pages",
      description: "Navigate the knowledge tree from the root map (index.md) down: give a directory path relative to the knowledge root, or a page type. With no arguments, lists the root.",
      inputSchema: {
        path: z.string().optional().describe("Directory under the knowledge root, e.g. `runbooks` or `services/payments`"),
        type: z.enum(PAGE_TYPES).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => after(run(() => service.list(args))),
  ));

  registered.set("stale", server.registerTool(
    "stale",
    {
      title: "Stale or unowned pages",
      description: "Pages past their review SLA, never verified, or without a resolvable team owner, oldest due date first.",
      inputSchema: { owner_team: z.string().optional().describe("Only this team's pages") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => after(run(() => service.stale(args))),
  ));

  registered.set("propose_edit", server.registerTool(
    "propose_edit",
    {
      title: "Propose an edit (opens a PR)",
      description:
        "Propose a change to a page by opening a pull request against the knowledge repo for the owning team to review. Never writes to the default branch. Give one of: `edits` (exact old→new replacements, each `old` must match once), a new `body` (everything after the frontmatter, as `read` returns it; the frontmatter is kept), the full new `content`, frontmatter included, or `append` (a section added at the end of the page as it is now). id, owner_team, acl and last_verified cannot be changed here.",
      inputSchema: {
        id: idArg,
        edits: z
          .array(z.object({ old: z.string().min(1), new: z.string() }))
          .optional()
          .describe("Exact replacements, applied in order"),
        body: z.string().optional().describe("Full replacement body: the page as `read` returns it in `content`, edited. The frontmatter is kept as it is"),
        content: z.string().optional().describe("Full replacement file content, frontmatter included"),
        append: z.string().optional().describe("Markdown added at the end of the page as it is on the default branch; the rest of the page is left as it is"),
        reason: z.string().min(1).describe("Why this change is needed; goes in the PR description"),
        draft: z.boolean().optional().describe("Open as a draft PR"),
        polish: z
          .boolean()
          .optional()
          .describe(
            "A polish: restructure and reword only. The server refuses it if the frontmatter, any code block, inline code, link, URL, number with its unit, or count of not/never/must/should/only changes",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      ...writeMeta,
    },
    (args) => after(run(() => service.proposeEdit(args))),
  ));

  registered.set("verify", server.registerTool(
    "verify",
    {
      title: "Verify a page (owner only, opens a PR)",
      description: "For members of the page's owning team: confirm the page is still true by opening a PR that sets last_verified to today.",
      inputSchema: { id: idArg },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      ...writeMeta,
    },
    (args) => after(run(() => service.verify(args))),
  ));

  registered.set("draft_page", server.registerTool(
    "draft_page",
    {
      title: "Draft a new page (opens a PR)",
      description:
        "Create a new knowledge page as a draft pull request for its owning team to review. Never writes to the default branch. The page is `status: draft`, so it can't be cited until its owners make it canonical. The server picks its id and file name from the title. CODEOWNERS must assign `owner_team` where it lands: the type's directory (runbooks/, services/, guides/, policies/) or `dir`, or, where CODEOWNERS routes that directory by file name (`runbooks/payments-*`), a name starting `<owner_team>-`, which the server tries when the plain name is another team's.",
      inputSchema: {
        type: z.enum(["runbook", "service", "guide", "policy"]).describe("The page type; ADRs are written by hand"),
        title: z.string().min(1).describe("One line"),
        owner_team: z.string().min(1).describe("The team slug that owns the page, e.g. `platform`"),
        acl: z.string().optional().describe("`internal` (the default) or a team you're on"),
        dir: z.string().optional().describe("Directory under the knowledge root, e.g. `runbooks` or `services/payments`"),
        description: z.string().optional().describe("One line, used in search"),
        body: z.string().min(1).describe("The page's markdown, after the frontmatter"),
        source_url: z.string().optional().describe("Where the content came from (an http or https URL)"),
        reason: z.string().min(1).describe("Why this page is needed; goes in the PR description"),
        draft: z.boolean().optional().describe("Open as a draft PR (the default)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      ...writeMeta,
    },
    (args) => after(run(() => service.draftPage(args))),
  ));

  // The web app's views: only on `docsworth serve` sessions, never on an agent's stdio server.
  if (opts.surface === "http") {
    const view = { readOnlyHint: true, openWorldHint: false } as const;
    registered.set("ui_capabilities", server.registerTool(
      "ui_capabilities",
      { title: "Capabilities", description: "For the Docsworth web app: who is served, in which mode, and whether writes would work.", inputSchema: {}, annotations: view },
      () => after(run(() => service.uiCapabilities())),
    ));
    registered.set("ui_overview", server.registerTool(
      "ui_overview",
      { title: "Overview", description: "For the Docsworth web app: counts of the caller's visible pages, by team, with what is due soon and what is stale.", inputSchema: {}, annotations: view },
      () => after(run(() => service.uiOverview())),
    ));
    registered.set("ui_graph", server.registerTool(
      "ui_graph",
      {
        title: "Link graph",
        description: "For the Docsworth web app: the caller's visible pages and the links between them, or one team's.",
        inputSchema: { owner_team: z.string().optional().describe("Only this team's pages") },
        annotations: view,
      },
      (args) => after(run(() => service.uiGraph(args))),
    ));
    registered.set("ui_page", server.registerTool(
      "ui_page",
      {
        title: "Page",
        description: "For the Docsworth web app: a page as `read` shows it, with the ids of the visible pages it links to.",
        inputSchema: { id: idArg },
        annotations: view,
      },
      (args) => after(run(() => service.uiPage(args))),
    ));
  }

  // Shown in Claude Code as /Docsworth:polish. A prompt is only text for the agent; the
  // guard that matters runs in propose_edit, whatever the agent was told.
  server.registerPrompt(
    "polish",
    {
      title: "Polish a page",
      description: "Restructure and tighten a page, keeping its code, links, numbers and negations, and open a PR for its owners",
      argsSchema: { id: idArg },
    },
    ({ id }) => ({ messages: [{ role: "user", content: { type: "text", text: polishPrompt(id) } }] }),
  );

  // The first list, before any client can ask for it. Registered tools start enabled.
  for (const name of registered.keys()) enabled.set(name, true);
  const policy = service.policy();
  for (const [name, tool] of registered) {
    const refused = opts.who ? toolRefusal(policy, service.org, name, opts.who) : policy.writes === "disabled" && WRITE_TOOLS.has(name);
    if (refused) {
      tool.disable();
      enabled.set(name, false);
    }
  }
  // Calls to a disabled tool are refused by the SDK before any handler runs, so a session
  // with every tool disabled would never re-check. A timer keeps the list current anyway.
  const timer = setInterval(() => void sync().catch(() => {}), opts.resyncMs ?? POLICY_RESYNC_MS);
  timer.unref();
  const close = server.server.onclose;
  server.server.onclose = () => {
    clearInterval(timer);
    close?.();
  };
  return server;
}
